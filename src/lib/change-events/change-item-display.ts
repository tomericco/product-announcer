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

/**
 * When a change reached users: the PR's merge time, or for a commit the time it
 * landed on the watched branch.
 *
 * `releasedAt` is only known for commits that arrived via the push webhook —
 * GitHub's list-commits API carries no branch-landing time, so imported ones
 * fall back to the author date. That fallback is approximate by nature: a
 * commit can be authored days before it ships.
 */
export function changeItemReleasedAt(item: {
  type: "pull_request" | "commit" | "task";
  mergedAt: Date | null;
  releasedAt: Date | null;
  committedAt: Date | null;
}): Date | null {
  if (item.type === "pull_request") return item.mergedAt;
  return item.releasedAt ?? item.committedAt;
}

// Only merge_commit/empty_diff have labels today — the remaining filter
// reasons (lockfile_only, test_only, chore_prefix, empty_task) aren't produced
// by any ingestion path yet, so they fall through to null like an unset reason.
export function ignoredReasonLabel(
  reason:
    | "merge_commit"
    | "empty_diff"
    | "lockfile_only"
    | "test_only"
    | "chore_prefix"
    | "empty_task"
    | null
): string | null {
  switch (reason) {
    case "merge_commit":
      return "merge commit";
    case "empty_diff":
      return "empty diff";
    default:
      return null;
  }
}
