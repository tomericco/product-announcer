import { and, asc, eq, inArray, isNull } from "drizzle-orm";
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
    .where(
      and(
        eq(atomicUpdates.tenantId, tenantId),
        eq(atomicUpdates.status, "open"),
        // Compose candidate set: an atomic update already linked to a draft
        // release is spoken for — it must not be offered again for a second
        // release until that draft is rejected/deleted (revertReleaseAtomicUpdates)
        // and its releaseId cleared.
        isNull(atomicUpdates.releaseId)
      )
    )
    // Same-webhook-batch atomic updates can share createdAt; tie-break on id
    // for deterministic ordering.
    .orderBy(asc(atomicUpdates.createdAt), asc(atomicUpdates.id));
}

/**
 * Claims the given OPEN, unlinked atomic updates into a new draft release:
 * inserts the release and sets `releaseId` on the atomic updates, all in one
 * transaction. Atomic updates stay `status = 'open'` — they only become
 * `released` when the release is published (see `markReleaseAtomicUpdatesReleased`).
 * Only tenant-owned, still-open, not-yet-linked (`releaseId IS NULL`) atomic
 * updates are claimable, so a re-submit or concurrent claim cannot double-claim
 * one into two releases. Returns null if nothing was claimable (the release
 * insert is rolled back).
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
          // Has a DB default (now()), but set explicitly so the claim-time
          // semantics are clear and testable — this is the baseline catch-up
          // deltas measure against.
          composedAt: new Date(),
          ...(input.review
            ? { reviewStatus: input.review.status, reviewIssues: input.review.issues, reviewedAt: new Date() }
            : {}),
        })
        .returning();

      const claimed = await tx
        .update(atomicUpdates)
        .set({ releaseId: release.id, updatedAt: new Date() })
        .where(
          and(
            inArray(atomicUpdates.id, input.atomicUpdateIds),
            eq(atomicUpdates.tenantId, input.tenantId),
            eq(atomicUpdates.status, "open"),
            isNull(atomicUpdates.releaseId)
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
 * On publish: closes a release's atomic updates. The inverse of leaving them
 * open while the release is a draft — this is the only place `status`
 * transitions to `released`.
 */
export async function markReleaseAtomicUpdatesReleased(
  releaseId: string,
  database: Executor = defaultDb
): Promise<number> {
  const released = await database
    .update(atomicUpdates)
    .set({ status: "released", updatedAt: new Date() })
    .where(eq(atomicUpdates.releaseId, releaseId))
    .returning({ id: atomicUpdates.id });
  return released.length;
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
