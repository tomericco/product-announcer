import { and, eq, inArray } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { atomicUpdates, changeEvents } from "@/db/schema";
import { refreshAtomicUpdates } from "@/lib/ai/regenerate-atomic-summary";
import { cleanupOrTouch } from "./reassign";

type Database = typeof defaultDb;

export type AddEventsInput = {
  tenantId: string;
  userId: string;
  atomicUpdateId: string;
  eventIds: string[];
  confirmEmptyDeletion?: boolean;
};

type AddEventsDeps = {
  database?: Database;
  refresh?: (database: Database, tenantId: string, atomicUpdateIds: string[]) => Promise<void>;
};

export type AddEventsSuccess = { ok: true; deletedAtomicUpdates?: { id: string; title: string }[] };
export type AddEventsRejection = { ok: false; reason: string };
export type AddEventsNeedsConfirmation = {
  ok: false;
  reason: "needs_confirmation";
  needsConfirmation: true;
  emptiedAtomicUpdates: { id: string; title: string; inDraft: boolean }[];
};
export type AddEventsResult = AddEventsSuccess | AddEventsRejection | AddEventsNeedsConfirmation;

/**
 * Batched "add these events to THIS existing open atomic update", the
 * multi-select sibling of `createAtomicUpdateFromEvents` (which creates a new
 * update). Reuses `cleanupOrTouch` from `reassign.ts`. All moves happen in one
 * transaction; a single `now` deterministically bumps `updatedAt` on the
 * target and every surviving source (this is what fires a draft's catch-up
 * delta reliably). Summary regeneration runs best-effort AFTER commit and is
 * FORCED — the target's (and surviving sources') `summaryEditedAt` freeze is
 * cleared first, so adding evidence overrides a prior hand-edit.
 *
 * If moving events out of their open source update(s) would empty any, they
 * are not silently deleted: unless `confirmEmptyDeletion`, no mutation happens
 * and `needsConfirmation` lists every source that would be emptied. Any
 * selected event currently in a `released` update freezes the whole batch. The
 * target must exist, be owned by the tenant, and be `open`.
 */
export async function addEventsToExistingAtomicUpdate(
  input: AddEventsInput,
  deps: AddEventsDeps = {}
): Promise<AddEventsResult> {
  const database = deps.database ?? defaultDb;
  const refresh = deps.refresh ?? refreshAtomicUpdates;
  const { tenantId, atomicUpdateId, eventIds, confirmEmptyDeletion } = input;

  type TxOutcome =
    | { ok: true; affectedIds: string[]; deletedAtomicUpdates: { id: string; title: string }[] }
    | AddEventsRejection
    | AddEventsNeedsConfirmation;

  const outcome = await database.transaction(async (tx): Promise<TxOutcome> => {
    const now = new Date();

    const requestedIds = Array.from(new Set(eventIds));
    if (requestedIds.length === 0) return { ok: false, reason: "No change events selected." };

    // Target must exist, be owned, and be open.
    const [target] = await tx
      .select({ id: atomicUpdates.id, status: atomicUpdates.status })
      .from(atomicUpdates)
      .where(and(eq(atomicUpdates.id, atomicUpdateId), eq(atomicUpdates.tenantId, tenantId)))
      .limit(1);
    if (!target) return { ok: false, reason: "Atomic update not found." };
    if (target.status !== "open") return { ok: false, reason: "Can only add events to an open atomic update." };

    const events = await tx
      .select()
      .from(changeEvents)
      .where(and(inArray(changeEvents.id, requestedIds), eq(changeEvents.tenantId, tenantId)));
    if (events.length < requestedIds.length) return { ok: false, reason: "One or more change events were not found." };

    // Source updates = the events' current updates, excluding the target itself.
    const sourceAtomicUpdateIds = Array.from(
      new Set(
        events
          .map((e) => e.atomicUpdateId)
          .filter((id): id is string => id !== null && id !== atomicUpdateId)
      )
    );
    const sourceAtomics =
      sourceAtomicUpdateIds.length > 0
        ? await tx
            .select({ id: atomicUpdates.id, status: atomicUpdates.status, title: atomicUpdates.title, contentPieceId: atomicUpdates.contentPieceId })
            .from(atomicUpdates)
            .where(and(inArray(atomicUpdates.id, sourceAtomicUpdateIds), eq(atomicUpdates.tenantId, tenantId)))
        : [];
    const sourceById = new Map(sourceAtomics.map((s) => [s.id, s]));

    const releasedSource = sourceAtomics.find((s) => s.status === "released");
    if (releasedSource) {
      return { ok: false, reason: `Cannot move an event out of the published atomic update "${releasedSource.title}".` };
    }

    const eventIdSet = new Set(events.map((e) => e.id));
    const openSourceIds = sourceAtomics.filter((s) => s.status === "open").map((s) => s.id);

    const emptiedAtomicUpdates: { id: string; title: string; inDraft: boolean }[] = [];
    for (const sourceId of openSourceIds) {
      const remaining = await tx.select({ id: changeEvents.id }).from(changeEvents).where(eq(changeEvents.atomicUpdateId, sourceId));
      const remainingOutsideBatch = remaining.filter((r) => !eventIdSet.has(r.id));
      if (remainingOutsideBatch.length === 0) {
        const source = sourceById.get(sourceId)!;
        emptiedAtomicUpdates.push({ id: source.id, title: source.title, inDraft: source.contentPieceId !== null });
      }
    }
    if (emptiedAtomicUpdates.length > 0 && confirmEmptyDeletion !== true) {
      return { ok: false, reason: "needs_confirmation", needsConfirmation: true, emptiedAtomicUpdates };
    }

    await tx
      .update(changeEvents)
      .set({ atomicUpdateId, status: "pending", excludedAt: null, excludedBy: null })
      .where(and(inArray(changeEvents.id, requestedIds), eq(changeEvents.tenantId, tenantId)));

    await tx.update(atomicUpdates).set({ updatedAt: now }).where(eq(atomicUpdates.id, atomicUpdateId));

    const affectedIds: string[] = [atomicUpdateId];
    const deletedAtomicUpdates: { id: string; title: string }[] = [];
    for (const sourceId of openSourceIds) {
      const { survived } = await cleanupOrTouch(tx, tenantId, sourceId, now);
      if (survived) affectedIds.push(sourceId);
      else deletedAtomicUpdates.push({ id: sourceById.get(sourceId)!.id, title: sourceById.get(sourceId)!.title });
    }

    return { ok: true, affectedIds, deletedAtomicUpdates };
  });

  if (!outcome.ok) return outcome;

  // Force regeneration: clear the hand-edit freeze on every affected open
  // update so the best-effort refresh below actually regenerates them
  // (refreshAtomicUpdates skips frozen ones). Evidence changes override a
  // prior manual edit.
  await database
    .update(atomicUpdates)
    .set({ summaryEditedAt: null })
    .where(and(inArray(atomicUpdates.id, outcome.affectedIds), eq(atomicUpdates.tenantId, tenantId), eq(atomicUpdates.status, "open")));

  try {
    await refresh(database, tenantId, outcome.affectedIds);
  } catch (error) {
    console.error("[add-events-to-atomic-update] best-effort summary regen failed:", error);
  }

  return { ok: true, deletedAtomicUpdates: outcome.deletedAtomicUpdates };
}
