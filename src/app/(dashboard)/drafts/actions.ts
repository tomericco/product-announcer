"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { contentPieces } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { assertDraftEditable, assertDraftDeletable, notEditableMessage } from "@/lib/draft-editable";
import { dispatchAllDestinations } from "@/lib/publishing/dispatch";
import { revertReleaseAtomicUpdates, markReleaseAtomicUpdatesReleased } from "@/lib/change-events/release-claim";
import type { DestinationId } from "@/lib/publishing/destinations/types";
import { findInvalidLinks, type LinkProblem } from "@/lib/ai/validate-links";

async function loadOwnedDraft(tenantId: string, contentPieceId: string) {
  const [update] = await db
    .select()
    .from(contentPieces)
    .where(and(eq(contentPieces.id, contentPieceId), eq(contentPieces.tenantId, tenantId)));
  if (!update) throw new Error("Update not found for this tenant");
  return update;
}

// If the WYSIWYG editor fails to parse the stored Markdown (e.g. a fenced
// code block, table, or image it doesn't recognize), it can render blank and
// submit an empty/whitespace-only body on the next keystroke. Guard against
// clobbering a real body with that empty state: only accept a submitted body
// that is blank when the draft didn't already have real content.
function resolveBody(submittedBody: string, existingBody: string) {
  if (submittedBody.trim().length === 0 && existingBody.trim().length > 0) {
    return existingBody;
  }
  return submittedBody;
}

// The hidden "publishedAt" field carries whatever `published_at` was rendered
// into the form (an ISO string, or "" when the update had never been
// published). Empty string means null, not the epoch.
function parseExpectedPublishedAt(raw: FormDataEntryValue | null): Date | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  return new Date(raw);
}

const KNOWN_DESTINATIONS: readonly DestinationId[] = ["webhook", "webflow"];

// The publish modal submits one `destinations` entry per chosen target. Never
// trust the wire: keep only real destination ids, and require at least one —
// publishing marks the content piece published/frozen and closes out its
// atomic updates, and the product rule is that a publish must name a delivery
// target.
// The modal disables Publish until one is picked; this is the server-side
// guard for a crafted request that bypasses the UI.
function parseSelectedDestinations(formData: FormData): DestinationId[] {
  const raw = formData.getAll("destinations");
  const selected = KNOWN_DESTINATIONS.filter((id) => raw.includes(id));
  if (selected.length === 0) {
    throw new Error("Select at least one destination to publish to.");
  }
  return selected;
}


export async function saveDraft(formData: FormData) {
  const session = await requireSession();
  const contentPieceId = formData.get("contentPieceId") as string;
  const existing = await loadOwnedDraft(session.user.tenantId, contentPieceId);
  assertDraftEditable(existing);

  const body = resolveBody(formData.get("body") as string, existing.body);
  // Only a body that actually differs from what's stored counts as a hand
  // edit — this must not fire when the blank-guard above fell back to the
  // existing body, or when the user simply re-saved the same content.
  const bodyChanged = body !== existing.body;

  await db
    .update(contentPieces)
    .set({
      title: formData.get("title") as string,
      body,
      editedBy: session.user.id,
      // A body-changing save is exactly when a human might have removed the
      // name the competitor scan flagged — without clearing generationError
      // here, the amber warning banner is permanent even after the edit that
      // fixed it. Only cleared on a real body change, not every re-save,
      // matching bodyEditedAt's own condition just above.
      ...(bodyChanged ? { bodyEditedAt: new Date(), generationError: null } : {}),
    })
    .where(eq(contentPieces.id, contentPieceId));

  revalidatePath(`/drafts/${contentPieceId}`);
}

/**
 * Runs the invalid-link check for a draft WITHOUT publishing, so the publish UI
 * can surface problems before the user even chooses destinations. Respects
 * unsaved editor edits via the submitted body, exactly like `approveDraft`.
 */
export async function checkDraftLinks(formData: FormData): Promise<{ problems: LinkProblem[] }> {
  const session = await requireSession();
  const contentPieceId = formData.get("contentPieceId") as string;
  const existing = await loadOwnedDraft(session.user.tenantId, contentPieceId);
  const body = resolveBody(formData.get("body") as string, existing.body);
  return { problems: await findInvalidLinks(body) };
}

export async function approveDraft(formData: FormData): Promise<{ problems: LinkProblem[] } | void> {
  const session = await requireSession();
  const contentPieceId = formData.get("contentPieceId") as string;
  const existing = await loadOwnedDraft(session.user.tenantId, contentPieceId);
  // NOT `assertDraftEditable` — this action deliberately also serves an
  // intentional re-publish of an already-`published` piece (see the docstring
  // on `assertDraftEditable`), which that gate would refuse. So this is an
  // allowlist, not a single-status blocklist: "draft", "review", "scheduled"
  // and "published" may proceed — "review" and "scheduled" are planning
  // states a human owns, not checkpoints, and the board can move a card
  // straight into either without it ever passing back through "draft". Only
  // "brief" is refused: it is an ungenerated scaffold and never a legitimate
  // publish target.
  if (
    existing.status !== "draft" &&
    existing.status !== "review" &&
    existing.status !== "scheduled" &&
    existing.status !== "published"
  ) {
    throw new Error(notEditableMessage(existing.status));
  }

  // Authoritative backstop: the detail UI already checks links before opening
  // the destination modal, but re-check here so a crafted request (or a body
  // changed after that check) can never publish invalid links.
  const bodyToPublish = resolveBody(formData.get("body") as string, existing.body);
  const problems = await findInvalidLinks(bodyToPublish);
  if (problems.length > 0) return { problems };

  // Validate the chosen destinations before publishing, so an empty/invalid
  // set aborts without marking the content piece published or closing its atomic updates.
  const destinations = parseSelectedDestinations(formData);
  // The value `published_at` had when this form was rendered — a hidden
  // field, not user-editable. Guards against a double-submit of the same
  // rendered form re-triggering delivery: gate the write on it still
  // matching, and only dispatch when it actually did.
  const expectedPublishedAt = parseExpectedPublishedAt(formData.get("publishedAt"));

  // Persist whatever title/body the user currently sees before publishing,
  // so approving doesn't silently discard unsaved edits in favor of the
  // last-saved DB copy.
  //
  // The publish UPDATE and closing out this content piece's atomic updates run in
  // one transaction: a crash between the two must not leave a published
  // content piece with atomic updates still sitting `open` (visible in the compose
  // list as if unclaimed).
  const [changed] = await db.transaction(async (tx) => {
    const rows = await tx
      .update(contentPieces)
      .set({
        title: formData.get("title") as string,
        body: bodyToPublish,
        editedBy: session.user.id,
        publishedBy: session.user.id,
        status: "published",
        publishedAt: new Date(),
        // A "scheduled" piece publishing is leaving "scheduled" the same as a
        // board drag out of it — moveContentPiece already clears scheduledFor
        // on every other way out, so publish must match or the calendar (spec
        // 8) would keep drawing a piece that has already shipped as if it
        // were still upcoming. Unconditional: a piece that was never
        // scheduled just has this stay null.
        scheduledFor: null,
      })
      .where(
        and(
          eq(contentPieces.id, contentPieceId),
          eq(contentPieces.tenantId, session.user.tenantId),
          // `= NULL` is never true in SQL, so a plain `eq` would break the very
          // first publish (published_at starts out null). IS NOT DISTINCT FROM
          // treats null-equals-null as a match.
          sql`${contentPieces.publishedAt} IS NOT DISTINCT FROM ${expectedPublishedAt}`
        )
      )
      .returning({ id: contentPieces.id });

    // A double submit's second call finds published_at already moved past what
    // it expected, matches zero rows — skip closing out the atomic updates too,
    // so it doesn't redundantly re-run against a content piece already fully published.
    if (rows.length > 0) {
      await markReleaseAtomicUpdatesReleased(contentPieceId, tx);
    }

    return rows;
  });

  // Dispatch stays outside the transaction: publishing already committed by
  // this point, so a delivery failure here shouldn't roll back the publish.
  if (changed) {
    await dispatchAllDestinations(contentPieceId, undefined, destinations);
  }

  revalidatePath("/board");
  redirect("/board");
}

export async function rejectDraft(formData: FormData) {
  const session = await requireSession();
  const contentPieceId = formData.get("contentPieceId") as string;
  // Reverting a published content piece's atomic updates would flip work that
  // already shipped back to `open`, so the compose list would offer it up for
  // a new draft. Unpublishing is not a supported operation — refuse instead.
  assertDraftEditable(await loadOwnedDraft(session.user.tenantId, contentPieceId));

  await db.transaction(async (tx) => {
    await tx.update(contentPieces).set({ status: "archived" }).where(eq(contentPieces.id, contentPieceId));
    // Rejecting the write-up isn't rejecting the underlying changes — hand the
    // atomic updates back so they can go into a later content piece instead of
    // vanishing.
    await revertReleaseAtomicUpdates(contentPieceId, tx);
  });

  revalidatePath("/board");
  redirect("/board");
}

export async function deleteDraft(formData: FormData) {
  const session = await requireSession();
  const contentPieceId = formData.get("contentPieceId") as string;
  // NOT `assertDraftEditable` — that gate refuses "brief", but a "brief"
  // piece whose generation can never succeed needs a way out or it sits
  // forever inflating the sidebar's Board count. A published content piece is still
  // refused: deleting it would erase that history and, via the revert below,
  // reopen its shipped atomic updates.
  assertDraftDeletable(await loadOwnedDraft(session.user.tenantId, contentPieceId));

  await db.transaction(async (tx) => {
    // Must precede the delete: contentPieceId is ON DELETE SET NULL, so
    // deleting first would null the FK before this can find the atomic
    // updates to revert, stranding them as status='released' with no content
    // piece — invisible to every open-only query.
    await revertReleaseAtomicUpdates(contentPieceId, tx);
    await tx.delete(contentPieces).where(eq(contentPieces.id, contentPieceId));
  });

  revalidatePath("/board");
}
