import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { changeEvents, releases } from "@/db/schema";
import type { ReviewStatus } from "@/lib/ai/review-draft";

type ChangeItemRow = typeof changeEvents.$inferSelect;
type ReleaseRow = typeof releases.$inferSelect;

/**
 * The root connection or a transaction handle. Drizzle's transaction type isn't
 * assignable to the db type (it has no `$client`), so helpers that callers need
 * to run inside a transaction have to accept the union explicitly.
 */
type Executor = typeof defaultDb | Parameters<Parameters<(typeof defaultDb)["transaction"]>[0]>[0];

export async function getPendingChangeItems(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<ChangeItemRow[]> {
  return database
    .select()
    .from(changeEvents)
    .where(and(eq(changeEvents.tenantId, tenantId), eq(changeEvents.status, "pending")))
    .orderBy(changeEvents.createdAt);
}

/**
 * Pending items eligible for a generation batch: excludes items the enricher
 * classified as non-user-facing (`user_facing = false`). Keeps `true` and
 * `null` — a null means "not yet enriched" and is treated as user-facing so a
 * classifier gap never silently drops a change.
 */
export async function getBatchableChangeItems(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<ChangeItemRow[]> {
  return database
    .select()
    .from(changeEvents)
    .where(
      and(
        eq(changeEvents.tenantId, tenantId),
        eq(changeEvents.status, "pending"),
        or(isNull(changeEvents.userFacing), eq(changeEvents.userFacing, true))
      )
    )
    .orderBy(changeEvents.createdAt);
}

/**
 * The tracked-list query for the Pending page: pending items (actionable) plus
 * ignored ones (merge/empty commits, shown dimmed for transparency). Excludes
 * batched/excluded. Generation uses getBatchableChangeItems, which is pending-only.
 */
export async function getTrackedChangeItems(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<ChangeItemRow[]> {
  return database
    .select()
    .from(changeEvents)
    .where(and(eq(changeEvents.tenantId, tenantId), inArray(changeEvents.status, ["pending", "ignored"])))
    .orderBy(changeEvents.createdAt);
}

export type DraftInput = { title: string; body: string };

export async function claimBatchAndCreateUpdate(
  input: {
    tenantId: string;
    changeItemIds: string[];
    draft: DraftInput;
    review?: { status: ReviewStatus; issues: string[] };
  },
  database: typeof defaultDb = defaultDb
): Promise<ReleaseRow | null> {
  return database.transaction(async (tx) => {
    const claimed = await tx
      .update(changeEvents)
      .set({ status: "batched" })
      .where(and(inArray(changeEvents.id, input.changeItemIds), eq(changeEvents.status, "pending")))
      .returning({ id: changeEvents.id });

    if (claimed.length === 0) return null;

    const claimedIds = claimed.map((c) => c.id);

    const [update] = await tx
      .insert(releases)
      .values({
        tenantId: input.tenantId,
        title: input.draft.title,
        body: input.draft.body,
        sourceItems: claimedIds,
        ...(input.review
          ? { reviewStatus: input.review.status, reviewIssues: input.review.issues, reviewedAt: new Date() }
          : {}),
      })
      .returning();

    await tx.update(changeEvents).set({ updateId: update.id }).where(inArray(changeEvents.id, claimedIds));

    return update;
  });
}

/**
 * The exact inverse of `claimBatchAndCreateUpdate`'s claim: returns an update's
 * change items to the pending pool and clears their `updateId`.
 *
 * Load-bearing for deletion: `change_events.update_id` has no ON DELETE clause,
 * so Postgres rejects deleting an update that still owns items. It also matters
 * for rejection, which otherwise strands the items in `batched` with a dangling
 * `updateId` — invisible to `getTrackedChangeItems`, so those commits would
 * silently never be announced.
 */
export async function releaseBatchForUpdate(
  updateId: string,
  database: Executor = defaultDb
): Promise<number> {
  const released = await database
    .update(changeEvents)
    .set({ status: "pending", updateId: null })
    .where(eq(changeEvents.updateId, updateId))
    .returning({ id: changeEvents.id });
  return released.length;
}

/**
 * The distinct, non-null `suggestedCategory` values across a batch of change items,
 * in first-seen order. Feeds category-aware example selection.
 */
export function batchCategories(items: { suggestedCategory: string | null }[]): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    if (item.suggestedCategory !== null) seen.add(item.suggestedCategory);
  }
  return [...seen];
}
