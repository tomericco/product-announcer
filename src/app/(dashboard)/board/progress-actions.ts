"use server";

import { requireSession } from "@/lib/workspace/session";
import { readGenerationProgress, type GenerationProgress } from "@/lib/content/generation-progress";

// No revalidatePath: this is a read on a hot 3-second poll loop, and
// revalidating the whole page on every tick would refetch far more than the
// one column this checklist needs.
export async function pollGenerationProgress(contentPieceId: string): Promise<GenerationProgress | null> {
  const session = await requireSession();
  return readGenerationProgress(session.user.tenantId, contentPieceId);
}
