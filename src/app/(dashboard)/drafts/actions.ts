"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { releases } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { assertDraftEditable } from "@/lib/draft-editable";
import { dispatchAllDestinations } from "@/lib/publishing/dispatch";
import { revertReleaseAtomicUpdates, markReleaseAtomicUpdatesReleased } from "@/lib/change-events/release-claim";
import type { DestinationId } from "@/lib/publishing/destinations/types";
import { findInvalidLinks, type LinkProblem } from "@/lib/ai/validate-links";

async function loadOwnedDraft(tenantId: string, releaseId: string) {
  const [update] = await db
    .select()
    .from(releases)
    .where(and(eq(releases.id, releaseId), eq(releases.tenantId, tenantId)));
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
// publishing marks the release published/frozen and closes out its atomic
// updates, and the product rule is that a publish must name a delivery target.
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
  const releaseId = formData.get("releaseId") as string;
  const existing = await loadOwnedDraft(session.user.tenantId, releaseId);
  assertDraftEditable(existing);

  const body = resolveBody(formData.get("body") as string, existing.body);
  // Only a body that actually differs from what's stored counts as a hand
  // edit — this must not fire when the blank-guard above fell back to the
  // existing body, or when the user simply re-saved the same content.
  const bodyChanged = body !== existing.body;

  await db
    .update(releases)
    .set({
      title: formData.get("title") as string,
      body,
      editedBy: session.user.id,
      ...(bodyChanged ? { bodyEditedAt: new Date() } : {}),
    })
    .where(eq(releases.id, releaseId));

  revalidatePath(`/drafts/${releaseId}`);
}

/**
 * Runs the invalid-link check for a draft WITHOUT publishing, so the publish UI
 * can surface problems before the user even chooses destinations. Respects
 * unsaved editor edits via the submitted body, exactly like `approveDraft`.
 */
export async function checkDraftLinks(formData: FormData): Promise<{ problems: LinkProblem[] }> {
  const session = await requireSession();
  const releaseId = formData.get("releaseId") as string;
  const existing = await loadOwnedDraft(session.user.tenantId, releaseId);
  const body = resolveBody(formData.get("body") as string, existing.body);
  return { problems: await findInvalidLinks(body) };
}

export async function approveDraft(formData: FormData): Promise<{ problems: LinkProblem[] } | void> {
  const session = await requireSession();
  const releaseId = formData.get("releaseId") as string;
  const existing = await loadOwnedDraft(session.user.tenantId, releaseId);

  // Authoritative backstop: the detail UI already checks links before opening
  // the destination modal, but re-check here so a crafted request (or a body
  // changed after that check) can never publish invalid links.
  const bodyToPublish = resolveBody(formData.get("body") as string, existing.body);
  const problems = await findInvalidLinks(bodyToPublish);
  if (problems.length > 0) return { problems };

  // Validate the chosen destinations before publishing, so an empty/invalid
  // set aborts without marking the release published or closing its atomic updates.
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
  // The publish UPDATE and closing out this release's atomic updates run in
  // one transaction: a crash between the two must not leave a published
  // release with atomic updates still sitting `open` (visible in the compose
  // list as if unclaimed).
  const [changed] = await db.transaction(async (tx) => {
    const rows = await tx
      .update(releases)
      .set({
        title: formData.get("title") as string,
        body: bodyToPublish,
        editedBy: session.user.id,
        publishedBy: session.user.id,
        status: "published",
        publishedAt: new Date(),
      })
      .where(
        and(
          eq(releases.id, releaseId),
          eq(releases.tenantId, session.user.tenantId),
          // `= NULL` is never true in SQL, so a plain `eq` would break the very
          // first publish (published_at starts out null). IS NOT DISTINCT FROM
          // treats null-equals-null as a match.
          sql`${releases.publishedAt} IS NOT DISTINCT FROM ${expectedPublishedAt}`
        )
      )
      .returning({ id: releases.id });

    // A double submit's second call finds published_at already moved past what
    // it expected, matches zero rows — skip closing out the atomic updates too,
    // so it doesn't redundantly re-run against a release already fully published.
    if (rows.length > 0) {
      await markReleaseAtomicUpdatesReleased(releaseId, tx);
    }

    return rows;
  });

  // Dispatch stays outside the transaction: publishing already committed by
  // this point, so a delivery failure here shouldn't roll back the publish.
  if (changed) {
    await dispatchAllDestinations(releaseId, undefined, destinations);
  }

  revalidatePath("/drafts");
  redirect("/drafts");
}

export async function rejectDraft(formData: FormData) {
  const session = await requireSession();
  const releaseId = formData.get("releaseId") as string;
  // Reverting a published release's atomic updates would flip work that already
  // shipped back to `open`, so the compose list would offer it up for a new
  // draft. Unpublishing is not a supported operation — refuse instead.
  assertDraftEditable(await loadOwnedDraft(session.user.tenantId, releaseId));

  await db.transaction(async (tx) => {
    await tx.update(releases).set({ status: "rejected" }).where(eq(releases.id, releaseId));
    // Rejecting the write-up isn't rejecting the underlying changes — hand the
    // atomic updates back so they can go into a later release instead of
    // vanishing.
    await revertReleaseAtomicUpdates(releaseId, tx);
  });

  revalidatePath("/drafts");
  redirect("/drafts");
}

/**
 * Publishes a draft as-stored, for the drafts list — where there is no editor
 * and so nothing unsaved to preserve. `approveDraft` is the detail-page
 * equivalent and additionally persists the submitted title/body first.
 */
export async function publishDraft(
  formData: FormData
): Promise<{ problems: LinkProblem[]; body: string } | void> {
  const session = await requireSession();
  const releaseId = formData.get("releaseId") as string;
  const existing = await loadOwnedDraft(session.user.tenantId, releaseId);
  // Publishes as-stored (no editor here), so gate the stored body: an invalid
  // link returns the offenders — plus the body — so the list modal can fix them.
  const problems = await findInvalidLinks(existing.body);
  if (problems.length > 0) return { problems, body: existing.body };
  // Same guard as approveDraft: the drafts list only ever renders drafts, so
  // in practice this is always null, but the mechanism stays identical rather
  // than special-casing the list's caller.
  const expectedPublishedAt = parseExpectedPublishedAt(formData.get("publishedAt"));

  // See approveDraft: publish UPDATE + closing out the release's atomic
  // updates run in one transaction, so a crash between them can't leave a
  // published release with atomic updates still `open`.
  const [changed] = await db.transaction(async (tx) => {
    const rows = await tx
      .update(releases)
      .set({ status: "published", publishedAt: new Date(), publishedBy: session.user.id })
      .where(
        and(
          eq(releases.id, releaseId),
          eq(releases.tenantId, session.user.tenantId),
          sql`${releases.publishedAt} IS NOT DISTINCT FROM ${expectedPublishedAt}`
        )
      )
      .returning({ id: releases.id });

    if (rows.length > 0) {
      await markReleaseAtomicUpdatesReleased(releaseId, tx);
    }

    return rows;
  });

  if (changed) {
    await dispatchAllDestinations(releaseId);
  }

  revalidatePath("/drafts");
}

export async function deleteDraft(formData: FormData) {
  const session = await requireSession();
  const releaseId = formData.get("releaseId") as string;
  // A published release is the record of what was sent; deleting it would erase
  // that history and, via the revert below, reopen its shipped atomic updates.
  assertDraftEditable(await loadOwnedDraft(session.user.tenantId, releaseId));

  await db.transaction(async (tx) => {
    // Must precede the delete: releaseId is ON DELETE SET NULL, so deleting
    // first would null the FK before this can find the atomic updates to
    // revert, stranding them as status='released' with no release — invisible
    // to every open-only query.
    await revertReleaseAtomicUpdates(releaseId, tx);
    await tx.delete(releases).where(eq(releases.id, releaseId));
  });

  revalidatePath("/drafts");
}
