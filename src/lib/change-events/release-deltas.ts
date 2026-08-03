import { and, eq, gt, isNull } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { atomicUpdates, contentPieces } from "@/db/schema";

type Database = typeof defaultDb;
type AtomicUpdateRow = typeof atomicUpdates.$inferSelect;

export type ReleaseDelta = {
  newAtomicUpdates: AtomicUpdateRow[];
  changedAtomicUpdates: AtomicUpdateRow[];
  count: number;
};

const EMPTY_DELTA: ReleaseDelta = { newAtomicUpdates: [], changedAtomicUpdates: [], count: 0 };

/**
 * Computes how stale a draft release is against its `composedAt` baseline.
 * Pure read — mutates nothing. Two independent deltas:
 *
 * - `newAtomicUpdates` (membership delta): open, unclaimed atomic updates for
 *   this tenant that appeared AFTER compose. An open, unlinked atomic update
 *   created BEFORE composedAt was available at compose time and deliberately
 *   left out of the draft — it is not "new", so it's excluded here too.
 * - `changedAtomicUpdates` (evidence delta): atomic updates already linked to
 *   this release whose evidence (summary, attached commit) changed after
 *   compose, i.e. `updatedAt > composedAt`.
 *
 * A nonexistent contentPieceId returns the empty delta rather than throwing —
 * a missing content piece trivially has no deltas.
 */
export async function computeReleaseDelta(
  contentPieceId: string,
  database: Database = defaultDb
): Promise<ReleaseDelta> {
  const [piece] = await database.select().from(contentPieces).where(eq(contentPieces.id, contentPieceId));
  if (!piece) return EMPTY_DELTA;

  const [newAtomicUpdates, changedAtomicUpdates] = await Promise.all([
    database
      .select()
      .from(atomicUpdates)
      .where(
        and(
          eq(atomicUpdates.tenantId, piece.tenantId),
          eq(atomicUpdates.status, "open"),
          isNull(atomicUpdates.contentPieceId),
          gt(atomicUpdates.createdAt, piece.composedAt)
        )
      ),
    database
      .select()
      .from(atomicUpdates)
      .where(
        and(
          eq(atomicUpdates.tenantId, piece.tenantId),
          eq(atomicUpdates.contentPieceId, piece.id),
          gt(atomicUpdates.updatedAt, piece.composedAt)
        )
      ),
  ]);

  return {
    newAtomicUpdates,
    changedAtomicUpdates,
    count: newAtomicUpdates.length + changedAtomicUpdates.length,
  };
}
