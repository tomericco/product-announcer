import { and, asc, eq, inArray } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { atomicUpdates, releases } from "@/db/schema";
import type { ReviewStatus } from "@/lib/ai/review-draft";

type Database = typeof defaultDb;
type Executor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];
type Release = typeof releases.$inferSelect;
type AtomicUpdateRow = typeof atomicUpdates.$inferSelect;

export type DraftInput = { title: string; body: string };

class EmptyClaimError extends Error {}

export async function getOpenAtomicUpdates(
  tenantId: string,
  database: Database = defaultDb
): Promise<AtomicUpdateRow[]> {
  return database
    .select()
    .from(atomicUpdates)
    .where(and(eq(atomicUpdates.tenantId, tenantId), eq(atomicUpdates.status, "open")))
    .orderBy(asc(atomicUpdates.createdAt));
}

/**
 * Claims the given OPEN atomic updates into a new draft release: inserts the
 * release, flips the atomic updates to `released` + sets `releaseId`, all in one
 * transaction. Only tenant-owned, still-open atomic updates are claimable, so a
 * re-submit or concurrent claim cannot double-claim. Returns null if nothing was
 * claimable (the release insert is rolled back).
 *
 * `sourceItems` is a legacy NOT NULL column from the change-event-batch composition
 * path (removed in Task 7); releases composed from atomic updates have no
 * meaningful value for it, so it's set to `[]` rather than claiming it tracks
 * anything here — the real composition link is `atomicUpdates.releaseId`.
 */
export async function claimReleaseFromAtomicUpdates(
  input: {
    tenantId: string;
    atomicUpdateIds: string[];
    draft: DraftInput;
    review?: { status: ReviewStatus; issues: string[] };
  },
  database: Database = defaultDb
): Promise<Release | null> {
  if (input.atomicUpdateIds.length === 0) return null;

  return database
    .transaction(async (tx) => {
      const [release] = await tx
        .insert(releases)
        .values({
          tenantId: input.tenantId,
          title: input.draft.title,
          body: input.draft.body,
          sourceItems: [],
          ...(input.review
            ? { reviewStatus: input.review.status, reviewIssues: input.review.issues, reviewedAt: new Date() }
            : {}),
        })
        .returning();

      const claimed = await tx
        .update(atomicUpdates)
        .set({ status: "released", releaseId: release.id, updatedAt: new Date() })
        .where(
          and(
            inArray(atomicUpdates.id, input.atomicUpdateIds),
            eq(atomicUpdates.tenantId, input.tenantId),
            eq(atomicUpdates.status, "open")
          )
        )
        .returning({ id: atomicUpdates.id });

      if (claimed.length === 0) throw new EmptyClaimError(); // rolls back the release insert
      return release;
    })
    .catch((err) => {
      if (err instanceof EmptyClaimError) return null;
      throw err;
    });
}

/**
 * Inverse of the claim: reopens a release's atomic updates (status → open,
 * releaseId → null). Load-bearing on reject and delete — `releaseId` is
 * ON DELETE SET NULL, so a delete nulls the FK but leaves `status = 'released'`,
 * which would strand the atomic update, invisible to every open-only query.
 * Run it BEFORE deleting the release, or the FK is already null and this matches
 * zero rows.
 */
export async function revertReleaseAtomicUpdates(
  releaseId: string,
  database: Executor = defaultDb
): Promise<number> {
  const reverted = await database
    .update(atomicUpdates)
    .set({ status: "open", releaseId: null, updatedAt: new Date() })
    .where(eq(atomicUpdates.releaseId, releaseId))
    .returning({ id: atomicUpdates.id });
  return reverted.length;
}
