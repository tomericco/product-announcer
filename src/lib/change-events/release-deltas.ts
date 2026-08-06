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
 *
 * Scoped to `type === "product_update"` pieces only. `newAtomicUpdates` is
 * TENANT-WIDE — every open, unclaimed atomic update the tenant has, not just
 * ones related to this piece — because that is exactly what catch-up is for:
 * offering shipped work nobody has claimed yet. A `blog_post` or
 * `social_post` draft has no business claiming that pool: without this gate,
 * the first unclaimed atomic update after a brief is accepted into one of
 * those drafts would light the CatchUpBanner and, if actioned, get linked via
 * `linkNewAtomicUpdates` and silently disappear from the pool a real product
 * update needed. Gating here (rather than only in the banner) protects every
 * caller — the banner, `catchUpRelease`, and `startOverRelease` all resolve
 * to `count === 0` / the empty delta for a non-product-update piece, so
 * there is no still-callable path that can link atomic updates into one.
 */
export async function computeReleaseDelta(
  contentPieceId: string,
  database: Database = defaultDb
): Promise<ReleaseDelta> {
  const [piece] = await database.select().from(contentPieces).where(eq(contentPieces.id, contentPieceId));
  if (!piece) return EMPTY_DELTA;
  if (piece.type !== "product_update") return EMPTY_DELTA;

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
