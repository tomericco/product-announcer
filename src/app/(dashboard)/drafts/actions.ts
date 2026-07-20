"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { updates } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { dispatchAllDestinations } from "@/lib/publishing/dispatch";
import { releaseBatchForUpdate } from "@/lib/change-items/change-item-batch";

async function loadOwnedDraft(tenantId: string, updateId: string) {
  const [update] = await db
    .select()
    .from(updates)
    .where(and(eq(updates.id, updateId), eq(updates.tenantId, tenantId)));
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

export async function saveDraft(formData: FormData) {
  const session = await requireSession();
  const updateId = formData.get("updateId") as string;
  const existing = await loadOwnedDraft(session.user.tenantId, updateId);

  await db
    .update(updates)
    .set({
      title: formData.get("title") as string,
      body: resolveBody(formData.get("body") as string, existing.body),
      editedBy: session.user.id,
    })
    .where(eq(updates.id, updateId));

  revalidatePath(`/drafts/${updateId}`);
}

export async function approveDraft(formData: FormData) {
  const session = await requireSession();
  const updateId = formData.get("updateId") as string;
  const existing = await loadOwnedDraft(session.user.tenantId, updateId);

  // Persist whatever title/body the user currently sees before publishing,
  // so approving doesn't silently discard unsaved edits in favor of the
  // last-saved DB copy.
  await db
    .update(updates)
    .set({
      title: formData.get("title") as string,
      body: resolveBody(formData.get("body") as string, existing.body),
      editedBy: session.user.id,
      status: "published",
      publishedAt: new Date(),
    })
    .where(eq(updates.id, updateId));

  await dispatchAllDestinations(updateId);

  revalidatePath("/drafts");
  redirect("/drafts");
}

export async function rejectDraft(formData: FormData) {
  const session = await requireSession();
  const updateId = formData.get("updateId") as string;
  await loadOwnedDraft(session.user.tenantId, updateId);

  await db.transaction(async (tx) => {
    await tx.update(updates).set({ status: "rejected" }).where(eq(updates.id, updateId));
    // Rejecting the write-up isn't rejecting the commits — hand them back so
    // they can go into a later update instead of vanishing from Pending.
    await releaseBatchForUpdate(updateId, tx);
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
  const updateId = formData.get("updateId") as string;
  await loadOwnedDraft(session.user.tenantId, updateId);

  await db
    .update(updates)
    .set({ status: "published", publishedAt: new Date() })
    .where(eq(updates.id, updateId));

  await dispatchAllDestinations(updateId);

  revalidatePath("/drafts");
}

export async function deleteDraft(formData: FormData) {
  const session = await requireSession();
  const updateId = formData.get("updateId") as string;
  await loadOwnedDraft(session.user.tenantId, updateId);

  await db.transaction(async (tx) => {
    // Must precede the delete: change_items.update_id has no ON DELETE clause,
    // so the FK rejects removing an update that still owns items.
    await releaseBatchForUpdate(updateId, tx);
    await tx.delete(updates).where(eq(updates.id, updateId));
  });

  revalidatePath("/drafts");
}
