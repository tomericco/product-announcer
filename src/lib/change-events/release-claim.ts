import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { atomicUpdates, contentPieces } from "@/db/schema";
import type { ReviewStatus } from "@/lib/ai/review-draft";

type Database = typeof defaultDb;
type Executor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];
type Release = typeof contentPieces.$inferSelect;
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
        // and its contentPieceId cleared.
        isNull(atomicUpdates.contentPieceId)
      )
    )
    // Same-webhook-batch atomic updates can share createdAt; tie-break on id
    // for deterministic ordering.
    .orderBy(asc(atomicUpdates.createdAt), asc(atomicUpdates.id));
}

/**
 * Claims the given OPEN, unlinked atomic updates into a new draft release:
 * inserts the release and sets `contentPieceId` on the atomic updates, all in
 * one transaction. Atomic updates stay `status = 'open'` — they only become
 * `released` when the release is published (see `markReleaseAtomicUpdatesReleased`).
 * Only tenant-owned, still-open, not-yet-linked (`contentPieceId IS NULL`)
 * atomic updates are claimable, so a re-submit or concurrent claim cannot
 * double-claim one into two releases. Returns null if nothing was claimable
 * (the release insert is rolled back).
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

  // Single timestamp shared by the release's composedAt AND the linked atomic
  // updates' updatedAt. These are two separate round-trips, so two independent
  // `new Date()` calls would leave the AUs' updatedAt a few ms AFTER
  // composedAt — computeReleaseDelta's strict `updatedAt > composedAt` would
  // then misread every just-linked AU as a post-compose "evidence" change.
  // Using the same Date value for both makes them equal, so the strict `>`
  // correctly excludes them.
  const now = new Date();

  return database
    .transaction(async (tx) => {
      const [release] = await tx
        .insert(contentPieces)
        .values({
          tenantId: input.tenantId,
          title: input.draft.title,
          body: input.draft.body,
          // Has a DB default (now()), but set explicitly so the claim-time
          // semantics are clear and testable — this is the baseline catch-up
          // deltas measure against.
          composedAt: now,
          ...(input.review
            ? { reviewStatus: input.review.status, reviewIssues: input.review.issues, reviewedAt: new Date() }
            : {}),
        })
        .returning();

      const claimed = await tx
        .update(atomicUpdates)
        .set({ contentPieceId: release.id, updatedAt: now })
        .where(
          and(
            inArray(atomicUpdates.id, input.atomicUpdateIds),
            eq(atomicUpdates.tenantId, input.tenantId),
            eq(atomicUpdates.status, "open"),
            isNull(atomicUpdates.contentPieceId)
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
 * Links already-derived atomic updates to an EXISTING content piece,
 * tenant-scoped. Sets `contentPieceId` and NOTHING else — `status` stays
 * `open` until the piece is actually published.
 *
 * The half of `claimReleaseFromAtomicUpdates` that survives the unified
 * drafting path. That function had to CREATE the piece because the
 * atomic-update flow had none until it made one; a brief-driven piece already
 * exists by the time drafting runs, so only the link remains. (The claim stays
 * in place until its last caller — `compose-draft.ts`, still wired to the live
 * API route — retires.)
 *
 * This deliberately does NOT flip `status` to `released`, though drafting is
 * the point at which the work is spoken for. Publish owns that transition
 * (`catch-up.ts:56`; `markReleaseAtomicUpdatesReleased` below, called from
 * `approveDraft`/`publishDraft`), and the flip bought nothing the link had not
 * already bought: every compose-candidate query requires BOTH `status = 'open'`
 * AND `contentPieceId IS NULL` (see `getOpenAtomicUpdates` and
 * `computeReleaseDelta`), so `contentPieceId` alone already prevents the
 * duplicate compose. What it cost was visible — an editor could no longer
 * regroup or delete change events behind a merely-DRAFTED piece, and
 * `reassign.ts`'s refusal called an unpublished draft "published".
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
 * phantom catch-up documented on `claimReleaseFromAtomicUpdates` above.
 *
 * Drops rather than steals: an atomic update that is no longer `open`, or that
 * something else linked to a piece in the meantime, is left alone and simply
 * not counted in the return value. The caller re-derives its set with the same
 * predicates (`generateDraftForPiece`), but that derivation and this write are
 * separated by a full generate + review round-trip — tens of seconds, during
 * which the still-live `/api/atomic-updates/draft` → `claimReleaseFromAtomicUpdates`
 * path can claim the same rows. Every other writer in this subsystem takes the
 * same stance (`claimReleaseFromAtomicUpdates` above, `linkNewAtomicUpdates` in
 * `catch-up.ts`); this one being the exception would make a lost race silently
 * rewrite somebody else's evidence.
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
 * transitions to `released`, for both the claim-based path and the unified
 * drafting path (`linkAtomicUpdatesToPiece` above links without closing).
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
