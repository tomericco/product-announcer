import { redirect } from "next/navigation";

// The /drafts list is retired — the board's Draft column shows the same
// pieces, and the sidebar count moved to the Board nav item. A redirect
// rather than a 404: this route was in the nav for the life of the project,
// so it is bookmarked, sitting in browser history, and — because
// `safeCallbackUrl` treats it as an ordinary in-app path — can still be
// carried by a stale NextAuth `callbackUrl` cookie into a fresh sign-in.
//
// `redirect` throws, so nothing below it runs; this is the same shape
// /change-events and /atomic-updates use. It does NOT shadow
// /drafts/[releaseId], which is still a live route — the draft editor is the
// only surviving piece of this section.
export default function Page() {
  redirect("/board");
}
