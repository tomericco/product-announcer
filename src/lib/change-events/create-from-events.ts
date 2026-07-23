import { and, eq, inArray } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { atomicUpdates, changeEvents } from "@/db/schema";
import { refreshAtomicUpdates } from "@/lib/ai/regenerate-atomic-summary";
import { seedFromEvent, cleanupOrTouch } from "./reassign";

type Database = typeof defaultDb;

export type CreateFromEventsInput = {
  tenantId: string;
  userId: string;
  eventIds: string[];
  /**
   * Must be `true` to proceed when moving the selected events out of their
   * source atomic updates would leave one or more of those (open) source
   * atomic updates with zero change events. Without it, a would-empty batch
   * performs NO mutation and comes back as `needsConfirmation` listing every
   * source that would be emptied, so the UI can warn the user before any of
   * them is silently dissolved (same gate as `reassignChangeEvent`).
   */
  confirmEmptyDeletion?: boolean;
};

type CreateFromEventsDeps = {
  database?: Database;
  refresh?: (database: Database, tenantId: string, atomicUpdateIds: string[]) => Promise<void>;
};

export type CreateFromEventsSuccess = {
  ok: true;
  atomicUpdateId: string;
  /** Source (open) atomic updates that were emptied by the move and deleted. */
  deletedAtomicUpdates?: { id: string; title: string }[];
};

export type CreateFromEventsRejection = { ok: false; reason: string };

export type CreateFromEventsNeedsConfirmation = {
  ok: false;
  reason: "needs_confirmation";
  needsConfirmation: true;
  emptiedAtomicUpdates: { id: string; title: string; inDraft: boolean }[];
};

export type CreateFromEventsResult =
  | CreateFromEventsSuccess
  | CreateFromEventsRejection
  | CreateFromEventsNeedsConfirmation;

/**
 * Batched sibling of `reassignChangeEvent({ target: { kind: "new" } })`: takes
 * a set of change events and moves ALL of them into ONE brand-new open atomic
 * update, in a single transaction. Reuses `seedFromEvent` and `cleanupOrTouch`
 * from `reassign.ts` rather than duplicating their logic.
 *
 * A single `now` timestamp is captured for the whole transaction and used to
 * deterministically bump `updatedAt` on every affected still-open atomic
 * update (the new one, and any surviving source). This is what fires a draft
 * release's catch-up "evidence delta" reliably — it must not depend on the
 * best-effort, freeze-skippable summary regen below.
 *
 * Summary regeneration runs best-effort AFTER the transaction commits: a
 * regen failure must never undo or fail an already-committed create, so it's
 * caught and logged instead of thrown.
 *
 * If moving the events out of their open source atomic update(s) would leave
 * any of them with zero change events, those sources are NOT silently
 * deleted: unless `confirmEmptyDeletion` is `true`, the transaction performs
 * no mutation and returns `needsConfirmation` listing every atomic update
 * that would be emptied, so the UI can warn the user first. Any selected
 * event whose current atomic update is `released` freezes the whole batch
 * (all-or-nothing) — you cannot move an event out of a published update.
 */
export async function createAtomicUpdateFromEvents(
  input: CreateFromEventsInput,
  deps: CreateFromEventsDeps = {}
): Promise<CreateFromEventsResult> {
  const database = deps.database ?? defaultDb;
  const refresh = deps.refresh ?? refreshAtomicUpdates;
  // `userId` is part of the contract (mirrors `ReassignInput`, and is
  // available for a future audit trail) but this algorithm has no `detach`
  // branch, so — unlike `reassignChangeEvent` — nothing here needs it.
  const { tenantId, eventIds, confirmEmptyDeletion } = input;

  type TxOutcome =
    | { ok: true; atomicUpdateId: string; affectedIds: string[]; deletedAtomicUpdates: { id: string; title: string }[] }
    | CreateFromEventsRejection
    | CreateFromEventsNeedsConfirmation;

  const outcome = await database.transaction(async (tx): Promise<TxOutcome> => {
    const now = new Date();

    const requestedIds = Array.from(new Set(eventIds));
    if (requestedIds.length === 0) {
      return { ok: false, reason: "No change events selected." };
    }

    const events = await tx
      .select()
      .from(changeEvents)
      .where(and(inArray(changeEvents.id, requestedIds), eq(changeEvents.tenantId, tenantId)));

    if (events.length < requestedIds.length) {
      return { ok: false, reason: "One or more change events were not found." };
    }

    const sourceAtomicUpdateIds = Array.from(
      new Set(events.map((e) => e.atomicUpdateId).filter((id): id is string => id !== null))
    );

    const sourceAtomics =
      sourceAtomicUpdateIds.length > 0
        ? await tx
            .select({
              id: atomicUpdates.id,
              status: atomicUpdates.status,
              title: atomicUpdates.title,
              releaseId: atomicUpdates.releaseId,
            })
            .from(atomicUpdates)
            .where(and(inArray(atomicUpdates.id, sourceAtomicUpdateIds), eq(atomicUpdates.tenantId, tenantId)))
        : [];

    const sourceById = new Map(sourceAtomics.map((s) => [s.id, s]));

    const releasedSource = sourceAtomics.find((s) => s.status === "released");
    if (releasedSource) {
      return {
        ok: false,
        reason: `Cannot move an event out of the published atomic update "${releasedSource.title}".`,
      };
    }

    const eventIdSet = new Set(events.map((e) => e.id));
    const openSourceIds = sourceAtomics.filter((s) => s.status === "open").map((s) => s.id);

    const emptiedAtomicUpdates: { id: string; title: string; inDraft: boolean }[] = [];
    for (const sourceId of openSourceIds) {
      const remaining = await tx
        .select({ id: changeEvents.id })
        .from(changeEvents)
        .where(eq(changeEvents.atomicUpdateId, sourceId));
      const remainingOutsideBatch = remaining.filter((r) => !eventIdSet.has(r.id));

      if (remainingOutsideBatch.length === 0) {
        const source = sourceById.get(sourceId)!;
        emptiedAtomicUpdates.push({ id: source.id, title: source.title, inDraft: source.releaseId !== null });
      }
    }

    if (emptiedAtomicUpdates.length > 0 && confirmEmptyDeletion !== true) {
      return {
        ok: false,
        reason: "needs_confirmation",
        needsConfirmation: true,
        emptiedAtomicUpdates,
      };
    }

    const seed = seedFromEvent(events[0]);
    const [created] = await tx
      .insert(atomicUpdates)
      .values({
        tenantId,
        title: seed.title,
        summary: seed.summary,
        category: seed.category,
        updatedAt: now,
      })
      .returning({ id: atomicUpdates.id });
    const newAtomicUpdateId = created.id;

    await tx
      .update(changeEvents)
      .set({ atomicUpdateId: newAtomicUpdateId, status: "pending", excludedAt: null, excludedBy: null })
      .where(and(inArray(changeEvents.id, requestedIds), eq(changeEvents.tenantId, tenantId)));

    const affectedIds: string[] = [newAtomicUpdateId];
    const deletedAtomicUpdates: { id: string; title: string }[] = [];

    for (const sourceId of openSourceIds) {
      const { survived } = await cleanupOrTouch(tx, tenantId, sourceId, now);
      if (survived) {
        affectedIds.push(sourceId);
      } else {
        const source = sourceById.get(sourceId)!;
        deletedAtomicUpdates.push({ id: source.id, title: source.title });
      }
    }

    return { ok: true, atomicUpdateId: newAtomicUpdateId, affectedIds, deletedAtomicUpdates };
  });

  if (!outcome.ok) {
    return outcome;
  }

  try {
    await refresh(database, tenantId, outcome.affectedIds);
  } catch (error) {
    console.error("[create-from-events] best-effort summary regen failed:", error);
  }

  return {
    ok: true,
    atomicUpdateId: outcome.atomicUpdateId,
    deletedAtomicUpdates: outcome.deletedAtomicUpdates,
  };
}
