import type { contentPieces } from "@/db/schema";

type ContentPieceStatus = (typeof contentPieces.$inferSelect)["status"];

/**
 * Refusal wording for a mutation aimed at a content piece that has left the
 * draft state. Exported so the NDJSON routes can stream the same sentence the
 * server actions throw, rather than inventing their own phrasing per call
 * site.
 */
export function notEditableMessage(status: ContentPieceStatus): string {
  if (status === "published") {
    return "This update has already been published and can no longer be edited.";
  }
  // A "brief"-status piece is an ungenerated scaffold — it was never editable
  // in the first place, so "can no longer be edited" (which implies it once
  // was) would read oddly here.
  if (status === "brief") {
    return "This draft hasn't been generated yet and can't be edited until it is.";
  }
  return `This update is ${status} and can no longer be edited.`;
}

/**
 * Refuses a body-mutating action on a content piece that is no longer a draft.
 *
 * Publishing already delivered the stored body to users, and archiving handed
 * the piece's atomic updates back to the pool — so rewriting either
 * afterwards silently changes what shipped, or edits a write-up whose
 * underlying changes have since been reassigned elsewhere.
 *
 * Deliberately NOT folded into either `loadOwnedDraft`: `approveDraft` and
 * `publishDraft` share those loaders and support an intentional re-publish,
 * which this guard would break. They stay gated by their own `publishedAt`
 * check instead.
 */
export function assertDraftEditable(piece: { status: ContentPieceStatus }): void {
  if (piece.status !== "draft") {
    throw new Error(notEditableMessage(piece.status));
  }
}
