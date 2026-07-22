"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { releases } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { dispatchAllDestinations } from "@/lib/publishing/dispatch";
import { releaseBatchForUpdate } from "@/lib/change-events/change-item-batch";

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

export async function saveDraft(formData: FormData) {
  const session = await requireSession();
  const releaseId = formData.get("releaseId") as string;
  const existing = await loadOwnedDraft(session.user.tenantId, releaseId);

  await db
    .update(releases)
    .set({
      title: formData.get("title") as string,
      body: resolveBody(formData.get("body") as string, existing.body),
      editedBy: session.user.id,
    })
    .where(eq(releases.id, releaseId));

  revalidatePath(`/drafts/${releaseId}`);
}

export async function approveDraft(formData: FormData) {
  const session = await requireSession();
  const releaseId = formData.get("releaseId") as string;
  const existing = await loadOwnedDraft(session.user.tenantId, releaseId);
  // The value `published_at` had when this form was rendered — a hidden
  // field, not user-editable. Guards against a double-submit of the same
  // rendered form re-triggering delivery: gate the write on it still
  // matching, and only dispatch when it actually did.
  const expectedPublishedAt = parseExpectedPublishedAt(formData.get("publishedAt"));

  // Persist whatever title/body the user currently sees before publishing,
  // so approving doesn't silently discard unsaved edits in favor of the
  // last-saved DB copy.
  const [changed] = await db
    .update(releases)
    .set({
      title: formData.get("title") as string,
      body: resolveBody(formData.get("body") as string, existing.body),
      editedBy: session.user.id,
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
  // it expected, matches zero rows, and skips dispatch — the update is
  // already published, which is what the user wanted, so this isn't an error.
  if (changed) {
    await dispatchAllDestinations(releaseId);
  }

  revalidatePath("/drafts");
  redirect("/drafts");
}

export async function rejectDraft(formData: FormData) {
  const session = await requireSession();
  const releaseId = formData.get("releaseId") as string;
  await loadOwnedDraft(session.user.tenantId, releaseId);

  await db.transaction(async (tx) => {
    await tx.update(releases).set({ status: "rejected" }).where(eq(releases.id, releaseId));
    // Rejecting the write-up isn't rejecting the commits — hand them back so
    // they can go into a later update instead of vanishing from Pending.
    await releaseBatchForUpdate(releaseId, tx);
  });

  revalidatePath("/drafts");
  redirect("/drafts");
}

/**
 * Publishes a draft as-stored, for the drafts list — where there is no editor
 * and so nothing unsaved to preserve. `approveDraft` is the detail-page
 * equivalent and additionally persists the submitted title/body first.
 */
export async function publishDraft(formData: FormData) {
  const session = await requireSession();
  const releaseId = formData.get("releaseId") as string;
  await loadOwnedDraft(session.user.tenantId, releaseId);
  // Same guard as approveDraft: the drafts list only ever renders drafts, so
  // in practice this is always null, but the mechanism stays identical rather
  // than special-casing the list's caller.
  const expectedPublishedAt = parseExpectedPublishedAt(formData.get("publishedAt"));

  const [changed] = await db
    .update(releases)
    .set({ status: "published", publishedAt: new Date() })
    .where(
      and(
        eq(releases.id, releaseId),
        eq(releases.tenantId, session.user.tenantId),
        sql`${releases.publishedAt} IS NOT DISTINCT FROM ${expectedPublishedAt}`
      )
    )
    .returning({ id: releases.id });

  if (changed) {
    await dispatchAllDestinations(releaseId);
  }

  revalidatePath("/drafts");
}

export async function deleteDraft(formData: FormData) {
  const session = await requireSession();
  const releaseId = formData.get("releaseId") as string;
  await loadOwnedDraft(session.user.tenantId, releaseId);

  await db.transaction(async (tx) => {
    // Must precede the delete: change_events.update_id has no ON DELETE clause,
    // so the FK rejects removing an update that still owns items.
    await releaseBatchForUpdate(releaseId, tx);
    await tx.delete(releases).where(eq(releases.id, releaseId));
  });

  revalidatePath("/drafts");
}
