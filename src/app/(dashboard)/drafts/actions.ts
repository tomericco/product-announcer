"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { updates } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { dispatchWebhookForUpdate } from "@/lib/publishing/webhook-delivery";

async function loadOwnedDraft(tenantId: string, updateId: string) {
  const [update] = await db
    .select()
    .from(updates)
    .where(and(eq(updates.id, updateId), eq(updates.tenantId, tenantId)));
  if (!update) throw new Error("Update not found for this tenant");
  return update;
}

export async function saveDraft(formData: FormData) {
  const session = await requireSession();
  const updateId = formData.get("updateId") as string;
  await loadOwnedDraft(session.user.tenantId, updateId);

  await db
    .update(updates)
    .set({
      title: formData.get("title") as string,
      body: formData.get("body") as string,
      category: formData.get("category") as "new" | "improved" | "fixed",
      editedBy: session.user.id,
    })
    .where(eq(updates.id, updateId));

  revalidatePath(`/drafts/${updateId}`);
}

export async function approveDraft(formData: FormData) {
  const session = await requireSession();
  const updateId = formData.get("updateId") as string;
  await loadOwnedDraft(session.user.tenantId, updateId);

  await db.update(updates).set({ status: "published", publishedAt: new Date() }).where(eq(updates.id, updateId));

  await dispatchWebhookForUpdate(updateId);

  revalidatePath("/drafts");
  redirect("/drafts");
}

export async function rejectDraft(formData: FormData) {
  const session = await requireSession();
  const updateId = formData.get("updateId") as string;
  await loadOwnedDraft(session.user.tenantId, updateId);

  await db.update(updates).set({ status: "rejected" }).where(eq(updates.id, updateId));

  revalidatePath("/drafts");
  redirect("/drafts");
}
