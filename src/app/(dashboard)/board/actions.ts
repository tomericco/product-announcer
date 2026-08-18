"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/workspace/session";
import { moveContentPiece, assignContentPiece, type MoveResult, type BoardColumn } from "@/lib/content/board";
import { acceptBrief, deleteBrief, type AcceptResult, type DeleteBriefResult } from "../briefs/actions";
import { deleteDraft } from "../drafts/actions";

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
  let scheduledFor: Date | undefined;
  if (scheduledForIso) {
    scheduledFor = new Date(scheduledForIso);
    // `new Date("garbage")` is an Invalid Date, not a thrown error — it is
    // still truthy and would otherwise sail past moveContentPiece's own
    // "scheduledFor is required" guard, only to blow up as a RangeError when
    // drizzle calls `.toISOString()` on it during the write. Catch it here,
    // as a normal refused move, so the client's optimistic patch reverts
    // instead of the card silently sitting in a column the DB never wrote.
    if (Number.isNaN(scheduledFor.getTime())) {
      return { ok: false, error: "That schedule time isn't valid." };
    }
  }
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

/**
 * A brief card dragged onto Draft calls this, once the drop's confirmation
 * dialog is accepted. `briefId` arrives from the browser and is untrusted,
 * exactly like `id` above — but the tenant check is not this function's to
 * make.
 * `acceptBrief` (src/app/(dashboard)/briefs/actions.ts) is already the
 * authority for accepting a brief: it re-reads the brief scoped to the
 * caller's own tenant, creates the content piece, seeds its body from the
 * brief's own document, links the two, and schedules generation in `after()`.
 * Reimplementing any of that here — even just the tenant check — would be
 * the second copy of acceptance the design doc says not to build, so this
 * stays a thin wrapper: delegate, revalidate the board (belt-and-suspenders —
 * acceptBrief already revalidates /board and /drafts), return exactly what
 * acceptBrief returned.
 *
 * Note there is deliberately no `requireSession()` here. This function had
 * one, whose result it discarded — which reads like a guard and is not one:
 * `acceptBrief` opens with its own `requireSession()` and scopes every read
 * and write to that session's tenant, so a second call could only ever
 * agree with it. Keeping it would suggest this wrapper shares the tenant
 * authority when it has none, exactly the second copy of acceptance the
 * design doc rules out.
 */
export async function acceptBriefCard(briefId: string): Promise<AcceptResult> {
  const result = await acceptBrief(briefId);
  if (result.ok) revalidatePath("/board");
  return result;
}

/**
 * Delete on a content-piece card. `contentPieceId` is untrusted, exactly
 * like `id` in `moveCard` — and, exactly like `acceptBriefCard` above, the
 * tenant check is not this function's to make.
 *
 * `deleteDraft` (src/app/(dashboard)/drafts/actions.ts) is already the
 * authority on deleting a piece and there is deliberately no second copy of
 * it here. It re-reads the piece under the caller's own tenant, refuses a
 * `published` one through `assertDraftDeletable` (which never consults
 * `reviewStatus`, so a piece is deletable at any review outcome, and which
 * deliberately ADMITS `brief` — a generation that can never succeed needs a
 * way out), and reverts the piece's atomic updates back to `open` inside a
 * transaction, in that order, because `contentPieceId` is ON DELETE SET NULL
 * and deleting first would strand them.
 *
 * Two things this wrapper does add:
 *
 *  - `revalidatePath("/board")`. `deleteDraft` revalidates `/drafts` only,
 *    and has no reason to know the board exists.
 *  - The throw-to-result conversion. `deleteDraft` throws (the /drafts row
 *    menu catches and toasts), while every board action returns a
 *    `{ ok }` result the board reports — so a refusal arrives here the same
 *    shape as a refused move, rather than as a rejected promise the caller
 *    has to remember to catch. The message is `assertDraftDeletable`'s own,
 *    passed through unchanged rather than restated.
 *
 * FormData because that is `deleteDraft`'s signature (it is wired to a form
 * on /drafts). Building one here is cheaper than widening a shared authority
 * to please a second caller.
 */
export async function deleteCard(contentPieceId: string): Promise<MoveResult> {
  const formData = new FormData();
  formData.set("contentPieceId", contentPieceId);
  try {
    await deleteDraft(formData);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Something went wrong. The card wasn't deleted.",
    };
  }
  revalidatePath("/board");
  return { ok: true };
}

/**
 * Delete on a brief card. A thin wrapper for the same reason
 * `acceptBriefCard` is one: `deleteBrief` (src/app/(dashboard)/briefs/
 * actions.ts) is the authority — it owns the tenant scope, the refusal of an
 * `accepted` brief, and the doc comment recording why deleting a brief is
 * NOT the same as dismissing one (a dismissed brief still feeds ideation's
 * dedupe; a deleted one cannot, so the agent may re-propose it). Read that
 * comment before changing anything here.
 *
 * `requireSession()` is deliberately absent, as in `acceptBriefCard`:
 * `deleteBrief` opens with its own and scopes the delete to that session's
 * tenant, so a second call could only ever agree with it while suggesting
 * this wrapper shares an authority it does not have.
 */
export async function deleteBriefCard(briefId: string): Promise<DeleteBriefResult> {
  const result = await deleteBrief(briefId);
  if (result.ok) revalidatePath("/board");
  return result;
}
