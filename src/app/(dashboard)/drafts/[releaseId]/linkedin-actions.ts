"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { contentPieces, linkedinConnections } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { generateLinkedinCopy } from "@/lib/ai/linkedin-copy";
import { writeVariant } from "@/lib/publishing/channel-variants";

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

  // Generation path: never marks the write as a hand-edit, so a later
  // regeneration knows this copy was never hand-touched.
  await writeVariant(db, contentPieceId, "linkedin", post);
  revalidatePath(`/drafts/${contentPieceId}`);
}

export async function saveLinkedinCopyAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const contentPieceId = String(formData.get("contentPieceId") ?? "");
  const linkedinBody = String(formData.get("linkedinBody") ?? "");

  // Tenant-scoped existence check first: writeVariant itself has no tenant
  // column to filter on, so ownership must be confirmed before writing.
  const piece = await loadTenantContentPiece(contentPieceId, session.user.tenantId);
  if (!piece) return;

  // Hand-edit save path: stamps editedAt so regeneration can warn before
  // overwriting a human's words.
  await writeVariant(db, contentPieceId, "linkedin", linkedinBody, { edited: true });
  revalidatePath(`/drafts/${contentPieceId}`);
}
