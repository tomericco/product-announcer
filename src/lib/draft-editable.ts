import type { contentPieces } from "@/db/schema";

type ContentPieceStatus = (typeof contentPieces.$inferSelect)["status"];

/**
 * Refusal wording for a mutation aimed at a content piece that has left the
 * draft state. Exported so the NDJSON routes can stream the same sentence the
 * server actions throw, rather than inventing their own phrasing per call
 * site.
 */
export function notEditableMessage(status: ContentPieceStatus): string {
  return status === "published"
    ? "This update has already been published and can no longer be edited."
    : `This update is ${status} and can no longer be edited.`;
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
