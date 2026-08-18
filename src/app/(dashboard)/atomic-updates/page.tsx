import { redirect } from "next/navigation";

// Both tabs retired in favour of /signals (evidence) and /company (curation).
// A redirect rather than a 404: these were in the nav for the life of the
// project and will be bookmarked.
export default function Page() {
  redirect("/company");
}
