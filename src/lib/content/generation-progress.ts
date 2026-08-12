import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { contentPieces } from "@/db/schema";
import type { DraftStepKey } from "@/lib/drafting/draft-progress";

type Database = typeof defaultDb;

export type GenerationProgress = {
  generationStep: DraftStepKey | null;
  generatedAt: Date | null;
  generationError: string | null;
  status: (typeof contentPieces.$inferSelect)["status"];
};

/**
 * One piece's generation state, for the client's polling checklist.
 *
 * `generationStep` is free text in the database (see the schema comment) and is
 * asserted to `DraftStepKey` here. A value written by a future version of the
 * writer that this client does not know renders as an unrecognized step rather
 * than crashing the checklist — the caller must tolerate a key it cannot place.
 *
 * Returns null for a missing piece and for one belonging to another tenant,
 * deliberately without distinguishing them: the caller is a poll loop and has
 * nothing useful to do differently, and telling a stranger that an id exists is
 * information they should not have.
 */
export async function readGenerationProgress(
  tenantId: string,
  contentPieceId: string,
  database: Database = defaultDb
): Promise<GenerationProgress | null> {
  const [piece] = await database
    .select({
      generationStep: contentPieces.generationStep,
      generatedAt: contentPieces.generatedAt,
      generationError: contentPieces.generationError,
      status: contentPieces.status,
    })
    .from(contentPieces)
    .where(and(eq(contentPieces.id, contentPieceId), eq(contentPieces.tenantId, tenantId)))
    .limit(1);

  if (!piece) return null;

  return {
    generationStep: piece.generationStep as DraftStepKey | null,
    generatedAt: piece.generatedAt,
    generationError: piece.generationError,
    status: piece.status,
  };
}
