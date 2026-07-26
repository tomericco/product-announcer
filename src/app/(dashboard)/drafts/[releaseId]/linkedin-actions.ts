"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { releases, linkedinConnections } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { generateLinkedinCopy } from "@/lib/ai/linkedin-copy";

async function loadTenantRelease(releaseId: string, tenantId: string) {
  const [release] = await db
    .select()
    .from(releases)
    .where(and(eq(releases.id, releaseId), eq(releases.tenantId, tenantId)))
    .limit(1);
  return release ?? null;
}

// The tenant's optional company-specific LinkedIn guidelines, used to extend
// the generation prompt. Null when no connection or no guidelines set.
async function loadTenantGuidelines(tenantId: string): Promise<string | null> {
  const [connection] = await db
    .select({ postGuidelines: linkedinConnections.postGuidelines })
    .from(linkedinConnections)
    .where(eq(linkedinConnections.tenantId, tenantId))
    .limit(1);
  return connection?.postGuidelines ?? null;
}

export async function generateLinkedinCopyAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const releaseId = String(formData.get("releaseId") ?? "");
  const release = await loadTenantRelease(releaseId, session.user.tenantId);
  if (!release) return;

  const guidelines = await loadTenantGuidelines(session.user.tenantId);
  const post = await generateLinkedinCopy({
    tenantId: session.user.tenantId,
    title: release.title,
    body: release.body,
    guidelines,
  });

  await db
    .update(releases)
    .set({ linkedinBody: post, linkedinBodyEditedAt: null })
    .where(and(eq(releases.id, releaseId), eq(releases.tenantId, session.user.tenantId)));
  revalidatePath(`/drafts/${releaseId}`);
}

export async function saveLinkedinCopyAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const releaseId = String(formData.get("releaseId") ?? "");
  const linkedinBody = String(formData.get("linkedinBody") ?? "");

  await db
    .update(releases)
    .set({ linkedinBody, linkedinBodyEditedAt: new Date() })
    .where(and(eq(releases.id, releaseId), eq(releases.tenantId, session.user.tenantId)));
  revalidatePath(`/drafts/${releaseId}`);
}
