// Maps a stored review_status to a short badge label, or null when no badge
// should show (compliant, un-reviewed, or an unrecognized value).
export function reviewStatusLabel(status: string | null): string | null {
  switch (status) {
    case "failed":
      return "Failed review";
    case "revised":
      return "Auto-revised";
    case "error":
      return "Review unavailable";
    default:
      return null;
  }
}
