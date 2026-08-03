export type DraftStepKey = "collecting" | "preparing" | "generating" | "reviewing" | "saving";

export type DraftProgressEvent =
  | { type: "step"; key: DraftStepKey; status: "start" | "done" }
  | { type: "detail"; text: string }
  // `body` is carried by the whole-update edit stream so the client can drop
  // the reviewed result straight into the editor (the compose flow omits it and
  // navigates to the draft instead).
  | { type: "done"; updateId: string; body?: string }
  | { type: "error"; message: string };

export type OnDraftProgress = (event: DraftProgressEvent) => void;

export const DRAFT_STEPS: { key: DraftStepKey; label: string }[] = [
  { key: "collecting", label: "Collecting pending changes" },
  { key: "preparing", label: "Preparing brand profile & examples" },
  { key: "generating", label: "Generating the draft" },
  { key: "reviewing", label: "Reviewing against brand guidelines" },
  { key: "saving", label: "Saving the draft" },
];

// The whole-update agent edit runs the same generate → review → save pipeline
// as the compose flow, minus the atomic-update "collecting" pass (it edits an
// existing body rather than assembling one). Same step keys, so the compose
// dialog's checklist loader renders it unchanged.
export const EDIT_STEPS: { key: DraftStepKey; label: string }[] = [
  { key: "preparing", label: "Preparing brand profile" },
  { key: "generating", label: "Regenerating the update" },
  { key: "reviewing", label: "Reviewing against brand guidelines" },
  { key: "saving", label: "Saving the update" },
];
