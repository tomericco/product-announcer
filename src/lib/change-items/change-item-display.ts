export type FacingState = "facing" | "non-facing" | "low-confidence";

// Facing items whose classifier confidence is below this get a soft "low
// confidence" hint in the UI — informational only, never filtered.
export const LOW_CONFIDENCE_THRESHOLD = 0.5;

export function changeItemFacingState(item: {
  userFacing: boolean | null;
  enrichmentConfidence: number | null;
}): FacingState {
  if (item.userFacing === false) return "non-facing";
  if (
    item.userFacing === true &&
    item.enrichmentConfidence !== null &&
    item.enrichmentConfidence < LOW_CONFIDENCE_THRESHOLD
  ) {
    return "low-confidence";
  }
  return "facing";
}

export function ignoredReasonLabel(reason: "merge_commit" | "empty_diff" | null): string | null {
  switch (reason) {
    case "merge_commit":
      return "merge commit";
    case "empty_diff":
      return "empty diff";
    default:
      return null;
  }
}
