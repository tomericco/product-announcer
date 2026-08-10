"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/workspace/session";
import { moveContentPiece, assignContentPiece, type MoveResult, type BoardColumn } from "@/lib/content/board";

/**
 * The board's drag-end handler calls this. `id` and `to` arrive from client
 * state — a card the user is currently looking at and a column dnd-kit
 * resolved the drop over — so tenant scoping is not optional: it comes from
 * the caller's own session, not from anything the client supplied.
 *
 * `scheduledForIso` is an ISO instant string (already converted from the
 * `datetime-local` input's local wall-clock value on the client, per the
 * "date and time, not date alone" requirement). `moveContentPiece` itself
 * refuses a move into `scheduled` with no `scheduledFor`, and clears
 * `scheduledFor` on any move OUT of `scheduled` regardless of what is
 * passed here — both enforced server-side, not just by the UI only
 * offering the picker when entering that column.
 *
 * Only async exports belong in this file: it carries "use server", and a
 * synchronous export here breaks the production build while the test suite
 * stays green.
 */
export async function moveCard(id: string, to: BoardColumn, scheduledForIso?: string): Promise<MoveResult> {
  const session = await requireSession();
  const scheduledFor = scheduledForIso ? new Date(scheduledForIso) : undefined;
  const result = await moveContentPiece(id, session.user.tenantId, to, { scheduledFor });
  if (result.ok) revalidatePath("/board");
  return result;
}

export async function assignCard(id: string, userId: string | null): Promise<MoveResult> {
  const session = await requireSession();
  const result = await assignContentPiece(id, session.user.tenantId, userId);
  if (result.ok) revalidatePath("/board");
  return result;
}
