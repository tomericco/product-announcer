export type DraftStepKey = "collecting" | "preparing" | "generating" | "reviewing" | "illustrating" | "saving";

export type DraftProgressEvent =
  | { type: "step"; key: DraftStepKey; status: "start" | "done" }
  | { type: "detail"; text: string }
  // `body` is carried by the whole-update edit stream so the client can drop
  // the reviewed result straight into the editor (the compose flow omits it and
  // navigates to the draft instead).
  | { type: "done"; updateId: string; body?: string }
  | { type: "error"; message: string };

export type OnDraftProgress = (event: DraftProgressEvent) => void;

/**
 * One row of a stepped loader.
 *
 * `slow` marks a step whose duration is a real model call rather than server
 * bookkeeping — the steps a user is genuinely waiting on. It exists for
 * `usePacedStatuses` (src/components/draft-progress-checklist.tsx), which
 * gives every OTHER step a minimum visible duration so it can be read instead
 * of flashing past. Never paced means never *padded*: the flag is what keeps a
 * fast failure out of a model call from being held behind an artificial floor.
 *
 * It lives on the step definition rather than in a key list inside the pacing
 * hook for three reasons. The flows deliberately do not share a key type
 * (see `ProposalStepKey` below), so a key list would have to be a union or a
 * per-flow map — exactly the coupling that comment argues against. `"saving"`
 * is a key in both DRAFT_STEPS and PROPOSAL_STEPS, so a key list is ambiguous
 * by construction. And a fourth flow declares its own slow step where it
 * declares its steps, instead of having to find and edit a list somewhere else.
 */
export type ProgressStep<K extends string> = {
  key: K;
  label: string;
  slow?: boolean;
};

export const DRAFT_STEPS: ProgressStep<DraftStepKey>[] = [
  { key: "collecting", label: "Collecting pending changes" },
  { key: "preparing", label: "Preparing brand profile" },
  // The model call the whole checklist is really waiting on.
  { key: "generating", label: "Generating the draft", slow: true },
  // Also a real model call, not bookkeeping: `generateDraftForPiece` runs
  // `review(draft, brandProfile)` under this step (src/lib/briefs/draft.ts).
  // Without the flag, `reviewing -> saving` was charged an 800ms floor on top
  // of a wait that was already as long as it was going to be — and a failure
  // out of the review would have been held behind that floor.
  { key: "reviewing", label: "Reviewing against brand guidelines", slow: true },
  // The illustration agent (spec 2026-08-18 §4): one text-model plan call,
  // then a cover render and the body renders in parallel — two image
  // round trips, ~30-60 s. Blocks draft readiness by design (the body is one
  // text column with hand-edit-freeze semantics; splicing images in after
  // save would race the human's first edit). `slow` for the same reason as
  // the two above: nothing here is bookkeeping.
  { key: "illustrating", label: "Creating images", slow: true },
  { key: "saving", label: "Saving the draft" },
];

// The whole-update agent edit runs the same generate → review → save pipeline
// as the compose flow, minus the atomic-update "collecting" pass (it edits an
// existing body rather than assembling one). Same step keys, so the compose
// dialog's checklist loader renders it unchanged.
export const EDIT_STEPS: ProgressStep<DraftStepKey>[] = [
  { key: "preparing", label: "Preparing brand profile" },
  { key: "generating", label: "Regenerating the update", slow: true },
  { key: "reviewing", label: "Reviewing against brand guidelines" },
  { key: "saving", label: "Saving the update" },
];

// Deliberately its own type rather than added to DraftStepKey. DraftStepKey
// isn't just a checklist label key — it's persisted: `generationStep` (the DB
// column read by generation-progress.ts, board.ts, and briefs/draft.ts) is
// typed `DraftStepKey | null` and asserted straight from that column's raw
// value. "resolving" and "proposing" belong to the brief-proposal flow, which
// never writes that column — widening DraftStepKey to include them would let
// values that can never actually appear in `generationStep` type-check as if
// they could. `ProgressChecklist` and `initialStepStatuses` take the step key
// as a generic parameter for exactly this reason: a fourth flow gets its own
// key type too, instead of every future flow's steps accreting onto one union
// that a persisted DB column also happens to use.
export type ProposalStepKey = "resolving" | "proposing" | "saving";

export const PROPOSAL_STEPS: ProgressStep<ProposalStepKey>[] = [
  { key: "resolving", label: "Resolving your signals" },
  // `proposeBriefForSelection`'s single `generateObject` call is nearly the
  // whole wait — see the pacing note in create-brief-modal.tsx.
  { key: "proposing", label: "Proposing an angle", slow: true },
  { key: "saving", label: "Creating the brief" },
];
