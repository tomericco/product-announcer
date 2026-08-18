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

// "draft", "review", and "scheduled" are all planning states a human owns —
// the board can move a piece freely among them, and none of them is a
// checkpoint that freezes editing. Only "brief" (an ungenerated scaffold),
// "published" (already delivered), and "archived" (rejected, atomic updates
// handed back) are not.
const EDITABLE_STATUSES: readonly ContentPieceStatus[] = ["draft", "review", "scheduled"];

/**
 * Refuses a body-mutating action on a content piece that is not in one of the
 * editable planning states ("draft", "review", "scheduled").
 *
 * Publishing already delivered the stored body to users, and archiving handed
 * the piece's atomic updates back to the pool — so rewriting either
 * afterwards silently changes what shipped, or edits a write-up whose
 * underlying changes have since been reassigned elsewhere. "brief" was never
 * editable in the first place — its body is still the accept-time scaffold.
 *
 * Deliberately NOT folded into `loadOwnedDraft`: `approveDraft` shares that
 * loader and supports an intentional re-publish, which this guard would
 * break. It stays gated by its own `publishedAt` check instead (and its own
 * allowlist, which independently also admits "review"/"scheduled" — see the
 * comment there).
 */
export function assertDraftEditable(piece: { status: ContentPieceStatus }): void {
  if (!EDITABLE_STATUSES.includes(piece.status)) {
    throw new Error(notEditableMessage(piece.status));
  }
}

/**
 * Refuses `deleteDraft` on a content piece that must not be removed:
 * "published" is the record of what actually shipped, and there is no
 * delete path for "archived" either.
 *
 * Deliberately its OWN check, not a reuse of `assertDraftEditable` — this one
 * additionally admits "brief", which `assertDraftEditable`'s other callers
 * depend on staying refused: a "brief" piece whose generation can never
 * succeed (no linked brief, or a persistent model failure) has no other exit.
 * Without this, `assertDraftEditable`'s refusal makes it permanently
 * undeletable and it inflates the sidebar's Board count forever.
 */
export function assertDraftDeletable(piece: { status: ContentPieceStatus }): void {
  if (piece.status !== "brief" && !EDITABLE_STATUSES.includes(piece.status)) {
    throw new Error(notEditableMessage(piece.status));
  }
}
