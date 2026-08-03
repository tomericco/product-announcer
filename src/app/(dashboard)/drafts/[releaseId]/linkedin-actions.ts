"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { contentPieces, linkedinConnections } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { generateLinkedinCopy } from "@/lib/ai/linkedin-copy";

async function loadTenantContentPiece(contentPieceId: string, tenantId: string) {
  const [piece] = await db
    .select()
    .from(contentPieces)
    .where(and(eq(contentPieces.id, contentPieceId), eq(contentPieces.tenantId, tenantId)))
    .limit(1);
  return piece ?? null;
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
  const contentPieceId = String(formData.get("contentPieceId") ?? "");
  const piece = await loadTenantContentPiece(contentPieceId, session.user.tenantId);
  if (!piece) return;

  const guidelines = await loadTenantGuidelines(session.user.tenantId);
  const post = await generateLinkedinCopy({
    tenantId: session.user.tenantId,
    title: piece.title,
    body: piece.body,
    guidelines,
  });

  await db
    .update(contentPieces)
    .set({ linkedinBody: post, linkedinBodyEditedAt: null })
    .where(and(eq(contentPieces.id, contentPieceId), eq(contentPieces.tenantId, session.user.tenantId)));
  revalidatePath(`/drafts/${contentPieceId}`);
}

export async function saveLinkedinCopyAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const contentPieceId = String(formData.get("contentPieceId") ?? "");
  const linkedinBody = String(formData.get("linkedinBody") ?? "");

  await db
    .update(contentPieces)
    .set({ linkedinBody, linkedinBodyEditedAt: new Date() })
    .where(and(eq(contentPieces.id, contentPieceId), eq(contentPieces.tenantId, session.user.tenantId)));
  revalidatePath(`/drafts/${contentPieceId}`);
}
