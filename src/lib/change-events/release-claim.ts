import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { atomicUpdates } from "@/db/schema";

type Database = typeof defaultDb;
type Executor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];
type AtomicUpdateRow = typeof atomicUpdates.$inferSelect;

export async function getOpenAtomicUpdates(
  tenantId: string,
  database: Database = defaultDb
): Promise<AtomicUpdateRow[]> {
  return database
    .select()
    .from(atomicUpdates)
    .where(
      and(
        eq(atomicUpdates.tenantId, tenantId),
        eq(atomicUpdates.status, "open"),
        // Compose candidate set: an atomic update already linked to a draft
        // release is spoken for — it must not be offered again for a second
        // release until that draft is rejected/deleted (revertReleaseAtomicUpdates)
        // and its contentPieceId cleared.
        isNull(atomicUpdates.contentPieceId)
      )
    )
    // Same-webhook-batch atomic updates can share createdAt; tie-break on id
    // for deterministic ordering.
    .orderBy(asc(atomicUpdates.createdAt), asc(atomicUpdates.id));
}

/**
 * Links already-derived atomic updates to an EXISTING content piece,
 * tenant-scoped. Sets `contentPieceId` and NOTHING else — `status` stays
 * `open` until the piece is actually published.
 *
 * A brief-driven piece already exists by the time drafting runs (created at
 * accept time), so this only needs to link, not create.
 *
 * This deliberately does NOT flip `status` to `released`, though drafting is
 * the point at which the work is spoken for. Publish owns that transition
 * (`catch-up.ts:56`; `markReleaseAtomicUpdatesReleased` below), and the flip
 * would buy nothing the link doesn't already buy: every compose-candidate
 * query requires BOTH `status = 'open'` AND `contentPieceId IS NULL` (see
 * `getOpenAtomicUpdates` and `computeReleaseDelta`), so `contentPieceId`
 * alone already prevents the duplicate compose. What it would cost is
 * visible — an editor could no longer regroup or delete change events behind
 * a merely-DRAFTED piece, and `reassign.ts`'s refusal would call an
 * unpublished draft "published".
 *
 * Takes an `Executor` so the caller can pass a transaction and make the link
 * atomic with its own draft-body write: a piece saved with a body while its
 * atomic updates were still unlinked would offer the same shipped work to the
 * next compose run and ship it twice. Called with the default `database` it is
 * a single UPDATE, atomic on its own.
 *
 * `at` stamps `updatedAt`. Pass the same Date the caller writes to the piece's
 * `composedAt`, or `computeReleaseDelta`'s strict `updatedAt > composedAt`
 * reads every atomic update just linked here as a post-compose change — the
 * phantom catch-up this timestamp-sharing avoids.
 *
 * Drops rather than steals: an atomic update that is no longer `open`, or that
 * something else linked to a piece in the meantime, is left alone and simply
 * not counted in the return value. The caller re-derives its set with the same
 * predicates (`generateDraftForPiece`), but that derivation and this write are
 * separated by a full generate + review round-trip — tens of seconds, during
 * which another concurrent writer (e.g. `linkNewAtomicUpdates` in
 * `catch-up.ts`) can claim the same rows. Every writer in this subsystem takes
 * the same stance; this one being the exception would make a lost race
 * silently rewrite somebody else's evidence.
 */
export async function linkAtomicUpdatesToPiece(
  input: {
    tenantId: string;
    contentPieceId: string;
    atomicUpdateIds: string[];
    at?: Date;
  },
  database: Executor = defaultDb
): Promise<number> {
  // `inArray` with an empty list is a query that can only match nothing —
  // return before spending a round-trip on it.
  if (input.atomicUpdateIds.length === 0) return 0;

  const linked = await database
    .update(atomicUpdates)
    .set({
      contentPieceId: input.contentPieceId,
      updatedAt: input.at ?? new Date(),
    })
    .where(
      and(
        inArray(atomicUpdates.id, input.atomicUpdateIds),
        // The security boundary. Without it a signal citing another tenant's
        // atomic update would pull that row into this tenant's piece.
        eq(atomicUpdates.tenantId, input.tenantId),
        // Drop, don't steal — see the docstring. Only work that is still open
        // and unspoken-for can be linked here.
        eq(atomicUpdates.status, "open"),
        isNull(atomicUpdates.contentPieceId)
      )
    )
    .returning({ id: atomicUpdates.id });
  return linked.length;
}

/**
 * On publish: closes a release's atomic updates. The inverse of leaving them
 * open while the release is a draft — this is the only place `status`
 * transitions to `released` (`linkAtomicUpdatesToPiece` above links without
 * closing).
 */
export async function markReleaseAtomicUpdatesReleased(
  contentPieceId: string,
  database: Executor = defaultDb
): Promise<number> {
  const released = await database
    .update(atomicUpdates)
    .set({ status: "released", updatedAt: new Date() })
    .where(eq(atomicUpdates.contentPieceId, contentPieceId))
    .returning({ id: atomicUpdates.id });
  return released.length;
}

/**
 * Inverse of the claim: reopens a release's atomic updates (status → open,
 * contentPieceId → null). Load-bearing on reject and delete — `contentPieceId`
 * is ON DELETE SET NULL, so a delete nulls the FK but leaves `status = 'released'`,
 * which would strand the atomic update, invisible to every open-only query.
 * Run it BEFORE deleting the content piece, or the FK is already null and this
 * matches zero rows.
 */
export async function revertReleaseAtomicUpdates(
  contentPieceId: string,
  database: Executor = defaultDb
): Promise<number> {
  const reverted = await database
    .update(atomicUpdates)
    .set({ status: "open", contentPieceId: null, updatedAt: new Date() })
    .where(eq(atomicUpdates.contentPieceId, contentPieceId))
    .returning({ id: atomicUpdates.id });
  return reverted.length;
}
