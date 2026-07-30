import { and, eq, inArray, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { atomicUpdates, changeEvents } from "@/db/schema";
import { refreshAtomicUpdates } from "@/lib/ai/regenerate-atomic-summary";

type Database = typeof defaultDb;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
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
  /**
   * Must be `true` to proceed with a move that would leave the source atomic
   * update with zero change events. Without it, a would-empty move performs
   * NO mutation and comes back as `needsConfirmation` so the UI can warn the
   * user before the atomic update is silently dissolved (Finding 2).
   */
  confirmEmptyDeletion?: boolean;
  /**
   * When `true`, every still-open atomic update affected by this move (the
   * target for `existing`/`new`, and the surviving source) has its
   * `summaryEditedAt` freeze CLEARED after the transaction commits and before
   * the best-effort `refresh` runs — so a hand-edited title/summary is
   * overwritten by the new evidence instead of being skipped by
   * `refreshAtomicUpdates`'s freeze check. Default (absent/false) preserves
   * today's behavior: a hand-edited update never regenerates automatically.
   * `refreshAtomicUpdates` itself is untouched; clearing the flag here is
   * what unfreezes it.
   */
  forceRegenerate?: boolean;
};

type ReassignDeps = {
  database?: Database;
  refresh?: (database: Database, tenantId: string, atomicUpdateIds: string[]) => Promise<void>;
};

export type ReassignSuccess = {
  ok: true;
  /** Present only when the move emptied the source atomic update and it was deleted. */
  deletedAtomicUpdate?: { id: string; title: string };
};

export type ReassignRejection = { ok: false; reason: string };

export type ReassignNeedsConfirmation = {
  ok: false;
  reason: "needs_confirmation";
  needsConfirmation: true;
  emptiedAtomicUpdate: { id: string; title: string; inDraft: boolean };
};

export type ReassignResult = ReassignSuccess | ReassignRejection | ReassignNeedsConfirmation;

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

export function seedFromEvent(event: typeof changeEvents.$inferSelect): {
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
 * A single `now` timestamp is captured for the whole transaction and used to
 * deterministically bump `updatedAt` on every affected still-open atomic
 * update (the target for `existing`/`new`, and the source if it survives).
 * This is what fires a draft release's catch-up "evidence delta"
 * (`atomicUpdates.updatedAt > release.composedAt`) reliably — it must not
 * depend on the best-effort, freeze-skippable summary regen below.
 *
 * Summary regeneration for the affected atomic update(s) runs best-effort
 * AFTER the transaction commits: a regen failure must never undo or fail an
 * already-committed reassignment, so it's caught and logged instead of
 * thrown. It's fine that it skips atomic updates with a hand-edited summary
 * (`summaryEditedAt` set) — only the summary TEXT is frozen by that; the
 * `updatedAt` staleness signal is bumped deterministically above regardless.
 *
 * If the move would leave the source atomic update with zero change events,
 * it is NOT silently deleted: unless `confirmEmptyDeletion` is `true`, the
 * transaction performs no mutation and returns `needsConfirmation` with
 * enough info (`emptiedAtomicUpdate`) for the UI to warn the user first —
 * especially since an atomic update in a draft release still has its
 * evidence described in the draft's body.
 */
export async function reassignChangeEvent(
  input: ReassignInput,
  deps: ReassignDeps = {}
): Promise<ReassignResult> {
  const database = deps.database ?? defaultDb;
  const refresh = deps.refresh ?? refreshAtomicUpdates;
  const { tenantId, userId, eventId, target, confirmEmptyDeletion, forceRegenerate } = input;

  type TxOutcome =
    | { ok: true; affectedIds: string[]; deletedAtomicUpdate?: { id: string; title: string } }
    | ReassignRejection
    | ReassignNeedsConfirmation;

  const outcome = await database.transaction(async (tx): Promise<TxOutcome> => {
    const now = new Date();

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
    let sourceTitle: string | null = null;
    let sourceReleaseId: string | null = null;

    if (sourceAtomicUpdateId) {
      const [source] = await tx
        .select({
          status: atomicUpdates.status,
          title: atomicUpdates.title,
          releaseId: atomicUpdates.releaseId,
        })
        .from(atomicUpdates)
        .where(and(eq(atomicUpdates.id, sourceAtomicUpdateId), eq(atomicUpdates.tenantId, tenantId)))
        .limit(1);
      sourceStatus = source?.status ?? null;
      sourceTitle = source?.title ?? null;
      sourceReleaseId = source?.releaseId ?? null;

      if (sourceStatus === "released") {
        return { ok: false, reason: "Cannot move an event out of a published atomic update." };
      }
    }

    let targetAtomicUpdateId: string | null = null;

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
    }

    // Every branch (detach, new, existing-onto-a-different-AU) leaves the
    // source; "existing" onto the source's own id is the sole no-op case
    // that never vacates it. Checked BEFORE any mutation so an unconfirmed
    // would-empty move can bail out with zero side effects.
    //
    // The `sourceStatus === "open"` clause deliberately skips empty-source
    // cleanup and the updatedAt bump when the source is `hidden` (a `released`
    // source is already rejected above). Editing a hidden update's evidence is
    // unreachable through the UI (the add-picker excludes hidden-AU events and
    // hidden cards offer only Unhide), so this only matters to a stale client
    // hitting the exported action directly: the worst case is an empty hidden
    // atomic update left behind — out of the pipeline and harmless, not a leak.
    const leavesSource =
      sourceAtomicUpdateId !== null &&
      sourceStatus === "open" &&
      (target.kind === "detach" || target.kind === "new" || targetAtomicUpdateId !== sourceAtomicUpdateId);

    if (leavesSource) {
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(changeEvents)
        .where(eq(changeEvents.atomicUpdateId, sourceAtomicUpdateId!));

      if (count === 1 && !confirmEmptyDeletion) {
        return {
          ok: false,
          reason: "needs_confirmation",
          needsConfirmation: true,
          emptiedAtomicUpdate: {
            id: sourceAtomicUpdateId!,
            title: sourceTitle ?? "",
            inDraft: sourceReleaseId !== null,
          },
        };
      }
    }

    if (target.kind === "existing") {
      await tx
        .update(changeEvents)
        .set({ atomicUpdateId: targetAtomicUpdateId, status: "pending", excludedAt: null, excludedBy: null })
        .where(and(eq(changeEvents.id, eventId), eq(changeEvents.tenantId, tenantId)));

      await tx
        .update(atomicUpdates)
        .set({ updatedAt: now })
        .where(and(eq(atomicUpdates.id, targetAtomicUpdateId!), eq(atomicUpdates.tenantId, tenantId)));
    } else if (target.kind === "new") {
      const seed = seedFromEvent(event);
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
      targetAtomicUpdateId = created.id;

      await tx
        .update(changeEvents)
        .set({ atomicUpdateId: targetAtomicUpdateId, status: "pending", excludedAt: null, excludedBy: null })
        .where(and(eq(changeEvents.id, eventId), eq(changeEvents.tenantId, tenantId)));
    } else {
      // detach
      await tx
        .update(changeEvents)
        .set({ atomicUpdateId: null, status: "excluded", excludedAt: now, excludedBy: userId })
        .where(and(eq(changeEvents.id, eventId), eq(changeEvents.tenantId, tenantId)));
    }

    const affectedIds: string[] = [];
    let deletedAtomicUpdate: { id: string; title: string } | undefined;

    if (targetAtomicUpdateId) {
      affectedIds.push(targetAtomicUpdateId);
    }

    if (sourceAtomicUpdateId && sourceStatus === "open" && sourceAtomicUpdateId !== targetAtomicUpdateId) {
      const { survived } = await cleanupOrTouch(tx, tenantId, sourceAtomicUpdateId, now);
      if (survived) {
        affectedIds.push(sourceAtomicUpdateId);
      } else {
        deletedAtomicUpdate = { id: sourceAtomicUpdateId, title: sourceTitle ?? "" };
      }
    }

    return { ok: true, affectedIds, deletedAtomicUpdate };
  });

  if (!outcome.ok) {
    return outcome;
  }

  try {
    if (outcome.affectedIds.length > 0) {
      // Clear the hand-edit freeze on exactly the affected atomic updates
      // BEFORE calling refresh, so refreshAtomicUpdates's own
      // `summaryEditedAt IS NULL` check now passes and it regenerates from
      // the new evidence instead of skipping. refreshAtomicUpdates itself is
      // unchanged — this clear is what unfreezes it. Scoped to
      // `status='open'` to match refresh's own precondition (a released
      // update is never in affectedIds anyway, but this stays defensive).
      if (forceRegenerate) {
        await database
          .update(atomicUpdates)
          .set({ summaryEditedAt: null })
          .where(
            and(
              inArray(atomicUpdates.id, outcome.affectedIds),
              eq(atomicUpdates.tenantId, tenantId),
              eq(atomicUpdates.status, "open")
            )
          );
      }
      await refresh(database, tenantId, outcome.affectedIds);
    }
  } catch (error) {
    console.error("[reassign] best-effort summary regen failed:", error);
  }

  return outcome.deletedAtomicUpdate ? { ok: true, deletedAtomicUpdate: outcome.deletedAtomicUpdate } : { ok: true };
}

/**
 * If the given (open) atomic update now has zero change events, deletes it
 * and reports it did not survive. Otherwise bumps `updatedAt` to `now` — the
 * deterministic catch-up staleness signal for a draft release's evidence
 * delta (Finding 1) — and reports it survived. Only ever called for an
 * `open` source — a `released` source is rejected earlier and never reaches
 * here.
 */
export async function cleanupOrTouch(
  tx: Tx,
  tenantId: string,
  atomicUpdateId: string,
  now: Date
): Promise<{ survived: boolean }> {
  const [{ count }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(changeEvents)
    .where(eq(changeEvents.atomicUpdateId, atomicUpdateId));

  if (count > 0) {
    await tx
      .update(atomicUpdates)
      .set({ updatedAt: now })
      .where(and(eq(atomicUpdates.id, atomicUpdateId), eq(atomicUpdates.tenantId, tenantId)));
    return { survived: true };
  }

  await tx
    .delete(atomicUpdates)
    .where(
      and(eq(atomicUpdates.id, atomicUpdateId), eq(atomicUpdates.tenantId, tenantId), eq(atomicUpdates.status, "open"))
    );

  return { survived: false };
}
