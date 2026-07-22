import { and, eq, gt, isNull } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { atomicUpdates, releases } from "@/db/schema";

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
 * A nonexistent releaseId returns the empty delta rather than throwing — a
 * missing release trivially has no deltas.
 */
export async function computeReleaseDelta(releaseId: string, database: Database = defaultDb): Promise<ReleaseDelta> {
  const [release] = await database.select().from(releases).where(eq(releases.id, releaseId));
  if (!release) return EMPTY_DELTA;

  const [newAtomicUpdates, changedAtomicUpdates] = await Promise.all([
    database
      .select()
      .from(atomicUpdates)
      .where(
        and(
          eq(atomicUpdates.tenantId, release.tenantId),
          eq(atomicUpdates.status, "open"),
          isNull(atomicUpdates.releaseId),
          gt(atomicUpdates.createdAt, release.composedAt)
        )
      ),
    database
      .select()
      .from(atomicUpdates)
      .where(
        and(
          eq(atomicUpdates.tenantId, release.tenantId),
          eq(atomicUpdates.releaseId, release.id),
          gt(atomicUpdates.updatedAt, release.composedAt)
        )
      ),
  ]);

  return {
    newAtomicUpdates,
    changedAtomicUpdates,
    count: newAtomicUpdates.length + changedAtomicUpdates.length,
  };
}
