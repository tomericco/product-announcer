export type DraftStepKey = "collecting" | "preparing" | "generating" | "reviewing" | "saving";

export type DraftProgressEvent =
  | { type: "step"; key: DraftStepKey; status: "start" | "done" }
  | { type: "detail"; text: string }
  | { type: "done"; updateId: string }
  | { type: "error"; message: string };

export type OnDraftProgress = (event: DraftProgressEvent) => void;

export const DRAFT_STEPS: { key: DraftStepKey; label: string }[] = [
  { key: "collecting", label: "Collecting pending changes" },
  { key: "preparing", label: "Preparing brand profile & examples" },
  { key: "generating", label: "Generating the draft" },
  { key: "reviewing", label: "Reviewing against brand guidelines" },
  { key: "saving", label: "Saving the draft" },
];
