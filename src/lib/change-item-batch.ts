import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { changeItems, updates } from "../db/schema";
import type { ReviewStatus } from "@/lib/ai/review-draft";

type ChangeItemRow = typeof changeItems.$inferSelect;
type UpdateRow = typeof updates.$inferSelect;

export async function getPendingChangeItems(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<ChangeItemRow[]> {
  return database
    .select()
    .from(changeItems)
    .where(and(eq(changeItems.tenantId, tenantId), eq(changeItems.status, "pending")))
    .orderBy(changeItems.createdAt);
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
    .from(changeItems)
    .where(
      and(
        eq(changeItems.tenantId, tenantId),
        eq(changeItems.status, "pending"),
        or(isNull(changeItems.userFacing), eq(changeItems.userFacing, true))
      )
    )
    .orderBy(changeItems.createdAt);
}

export type DraftInput = { title: string; body: string; category: "new" | "improved" | "fixed" };

export async function claimBatchAndCreateUpdate(
  input: {
    tenantId: string;
    changeItemIds: string[];
    draft: DraftInput;
    review?: { status: ReviewStatus; issues: string[] };
  },
  database: typeof defaultDb = defaultDb
): Promise<UpdateRow | null> {
  return database.transaction(async (tx) => {
    const claimed = await tx
      .update(changeItems)
      .set({ status: "batched" })
      .where(and(inArray(changeItems.id, input.changeItemIds), eq(changeItems.status, "pending")))
      .returning({ id: changeItems.id });

    if (claimed.length === 0) return null;

    const claimedIds = claimed.map((c) => c.id);

    const [update] = await tx
      .insert(updates)
      .values({
        tenantId: input.tenantId,
        title: input.draft.title,
        body: input.draft.body,
        category: input.draft.category,
        sourceItems: claimedIds,
        ...(input.review
          ? { reviewStatus: input.review.status, reviewIssues: input.review.issues, reviewedAt: new Date() }
          : {}),
      })
      .returning();

    await tx.update(changeItems).set({ updateId: update.id }).where(inArray(changeItems.id, claimedIds));

    return update;
  });
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
