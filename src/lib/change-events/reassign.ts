import { and, eq, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { atomicUpdates, changeEvents } from "@/db/schema";
import { refreshAtomicUpdates } from "@/lib/ai/regenerate-atomic-summary";

type Database = typeof defaultDb;
type AtomicUpdateRow = typeof atomicUpdates.$inferSelect;

export type ReassignTarget =
  | { kind: "existing"; atomicUpdateId: string }
  | { kind: "detach" }
  | { kind: "new" };

export type ReassignInput = {
  tenantId: string;
  userId: string;
  eventId: string;
  target: ReassignTarget;
};

type ReassignDeps = {
  database?: Database;
  refresh?: (database: Database, tenantId: string, atomicUpdateIds: string[]) => Promise<void>;
};

export type ReassignResult = { ok: true } | { ok: false; reason: string };

/**
 * All `status='open'` atomic updates for the tenant, regardless of `releaseId`
 * — the valid reassign-target set. An atomic update sitting in an unpublished
 * draft release is still open (nothing has shipped yet), so it's a legitimate
 * destination for a manually reassigned event. Deliberately does NOT filter
 * `releaseId IS NULL` the way the compose-side candidate set does
 * (`getOpenAtomicUpdates` in release-claim.ts) — that filter exists to avoid
 * offering an already-claimed atomic update for a SECOND release, which is
 * irrelevant here.
 */
export async function openAtomicUpdatesForReassign(
  tenantId: string,
  database: Database = defaultDb
): Promise<AtomicUpdateRow[]> {
  return database
    .select()
    .from(atomicUpdates)
    .where(and(eq(atomicUpdates.tenantId, tenantId), eq(atomicUpdates.status, "open")));
}

function seedFromEvent(event: typeof changeEvents.$inferSelect): {
  title: string;
  summary: string;
  category: (typeof atomicUpdates.$inferInsert)["category"];
} {
  const firstLine = event.commitMessage?.split("\n")[0]?.trim();
  const title = event.prTitle ?? firstLine ?? "Untitled";
  const summary = event.impactSummary ?? title;
  return { title, summary, category: event.suggestedCategory ?? null };
}

/**
 * Moves a change event to a different atomic update, detaches it entirely, or
 * splits it into a brand-new atomic update. This is the correctness core for
 * manual reassignment (phase 3) — it operates only among OPEN atomic updates;
 * a `released` source or target freezes the move (published updates are not
 * editable). All mutation is one transaction, tenant-scoped throughout.
 *
 * Summary regeneration for the affected atomic update(s) runs best-effort
 * AFTER the transaction commits: a regen failure must never undo or fail an
 * already-committed reassignment, so it's caught and logged instead of thrown.
 */
export async function reassignChangeEvent(
  input: ReassignInput,
  deps: ReassignDeps = {}
): Promise<ReassignResult> {
  const database = deps.database ?? defaultDb;
  const refresh = deps.refresh ?? refreshAtomicUpdates;
  const { tenantId, userId, eventId, target } = input;

  type TxOutcome =
    | { ok: true; affectedIds: string[] }
    | { ok: false; reason: string };

  const outcome = await database.transaction(async (tx): Promise<TxOutcome> => {
    const [event] = await tx
      .select()
      .from(changeEvents)
      .where(and(eq(changeEvents.id, eventId), eq(changeEvents.tenantId, tenantId)))
      .limit(1);

    if (!event) {
      return { ok: false, reason: "Change event not found." };
    }

    const sourceAtomicUpdateId = event.atomicUpdateId;
    let sourceStatus: AtomicUpdateRow["status"] | null = null;

    if (sourceAtomicUpdateId) {
      const [source] = await tx
        .select({ status: atomicUpdates.status })
        .from(atomicUpdates)
        .where(and(eq(atomicUpdates.id, sourceAtomicUpdateId), eq(atomicUpdates.tenantId, tenantId)))
        .limit(1);
      sourceStatus = source?.status ?? null;

      if (sourceStatus === "released") {
        return { ok: false, reason: "Cannot move an event out of a published atomic update." };
      }
    }

    let targetAtomicUpdateId: string;

    if (target.kind === "existing") {
      const [targetAtomic] = await tx
        .select({ status: atomicUpdates.status })
        .from(atomicUpdates)
        .where(and(eq(atomicUpdates.id, target.atomicUpdateId), eq(atomicUpdates.tenantId, tenantId)))
        .limit(1);

      if (!targetAtomic) {
        return { ok: false, reason: "Target atomic update not found." };
      }
      if (targetAtomic.status !== "open") {
        return { ok: false, reason: "Target atomic update is not open." };
      }

      targetAtomicUpdateId = target.atomicUpdateId;

      await tx
        .update(changeEvents)
        .set({ atomicUpdateId: targetAtomicUpdateId, status: "pending", excludedAt: null, excludedBy: null })
        .where(and(eq(changeEvents.id, eventId), eq(changeEvents.tenantId, tenantId)));
    } else if (target.kind === "new") {
      const seed = seedFromEvent(event);
      const [created] = await tx
        .insert(atomicUpdates)
        .values({ tenantId, title: seed.title, summary: seed.summary, category: seed.category })
        .returning({ id: atomicUpdates.id });
      targetAtomicUpdateId = created.id;

      await tx
        .update(changeEvents)
        .set({ atomicUpdateId: targetAtomicUpdateId, status: "pending", excludedAt: null, excludedBy: null })
        .where(and(eq(changeEvents.id, eventId), eq(changeEvents.tenantId, tenantId)));
    } else {
      // detach
      await tx
        .update(changeEvents)
        .set({ atomicUpdateId: null, status: "excluded", excludedAt: new Date(), excludedBy: userId })
        .where(and(eq(changeEvents.id, eventId), eq(changeEvents.tenantId, tenantId)));

      const affectedIds: string[] = [];
      if (sourceAtomicUpdateId && sourceStatus === "open") {
        const survived = await cleanupIfEmpty(tx, tenantId, sourceAtomicUpdateId);
        if (survived) affectedIds.push(sourceAtomicUpdateId);
      }
      return { ok: true, affectedIds };
    }

    // existing/new: the target is always affected; the source is affected
    // only if it still exists (empty-source cleanup below may delete it).
    const affectedIds = [targetAtomicUpdateId];
    if (sourceAtomicUpdateId && sourceAtomicUpdateId !== targetAtomicUpdateId && sourceStatus === "open") {
      const survived = await cleanupIfEmpty(tx, tenantId, sourceAtomicUpdateId);
      if (survived) affectedIds.push(sourceAtomicUpdateId);
    }

    return { ok: true, affectedIds };
  });

  if (!outcome.ok) {
    return outcome;
  }

  try {
    if (outcome.affectedIds.length > 0) {
      await refresh(database, tenantId, outcome.affectedIds);
    }
  } catch (error) {
    console.error("[reassign] best-effort summary regen failed:", error);
  }

  return { ok: true };
}

/**
 * If the given (open) atomic update now has zero change events, deletes it.
 * Returns true if the atomic update still exists afterward (i.e. it was NOT
 * deleted), false if it was deleted. Only ever called for an `open` source —
 * a `released` source is rejected earlier and never reaches here.
 */
async function cleanupIfEmpty(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  tenantId: string,
  atomicUpdateId: string
): Promise<boolean> {
  const [{ count }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(changeEvents)
    .where(eq(changeEvents.atomicUpdateId, atomicUpdateId));

  if (count > 0) return true;

  await tx
    .delete(atomicUpdates)
    .where(and(eq(atomicUpdates.id, atomicUpdateId), eq(atomicUpdates.tenantId, tenantId), eq(atomicUpdates.status, "open")));

  return false;
}
