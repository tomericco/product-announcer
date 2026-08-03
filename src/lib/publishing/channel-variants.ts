import { and, eq } from "drizzle-orm";
import { channelVariants } from "@/db/schema";
import type { DbClient } from "./destinations/types";

export type ChannelVariant = { body: string; editedAt: Date | null };

/** The stored body for one channel, or null when nothing has been generated yet. */
export async function readVariant(
  database: DbClient,
  contentPieceId: string,
  channel: string
): Promise<ChannelVariant | null> {
  const [row] = await database
    .select({ body: channelVariants.body, editedAt: channelVariants.editedAt })
    .from(channelVariants)
    .where(and(eq(channelVariants.contentPieceId, contentPieceId), eq(channelVariants.channel, channel)))
    .limit(1);
  return row ?? null;
}

/**
 * Upserts the body for one channel. `edited` stamps `editedAt`, which marks the
 * body as hand-written so regeneration can warn before overwriting it — the
 * per-channel analogue of `contentPieces.bodyEditedAt`.
 *
 * Takes no tenant parameter, so it cannot verify that `contentPieceId` belongs
 * to the caller's tenant — callers MUST confirm that ownership themselves
 * before calling this.
 */
export async function writeVariant(
  database: DbClient,
  contentPieceId: string,
  channel: string,
  body: string,
  opts: { edited?: boolean } = {}
): Promise<void> {
  const editedAt = opts.edited ? new Date() : null;
  await database
    .insert(channelVariants)
    .values({ contentPieceId, channel, body, editedAt })
    .onConflictDoUpdate({
      target: [channelVariants.contentPieceId, channelVariants.channel],
      set: { body, editedAt },
    });
}
