import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { tenants } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { parseOAuthState, OAUTH_STATE_COOKIE_OPTS } from "@/lib/integrations/oauth-state";

export async function GET(request: NextRequest) {
  const session = await requireSession();

  // Use `new URL(request.url)` rather than `request.nextUrl`: the test suite
  // exercises this handler with a plain `Request`, which lacks `nextUrl`.
  const searchParams = new URL(request.url).searchParams;
  const installationId = searchParams.get("installation_id");
  const parsed = parseOAuthState(searchParams.get("state"));
  // Wrap in NextRequest so `.cookies` works for both a real NextRequest and the
  // plain `Request` the test suite passes.
  const cookieNonce = new NextRequest(request).cookies.get("github_oauth_state")?.value;

  // Always clear the state cookie on the way out — it is single-use.
  const clearStateCookie = (response: NextResponse) => {
    response.cookies.set("github_oauth_state", "", { ...OAUTH_STATE_COOKIE_OPTS, maxAge: 0 });
    return response;
  };

  // Resolve where to send the user back to from the OAuth state's returnTo, so
  // a connect started on /integrations surfaces its result there (mirrors the
  // Notion/LinkedIn callbacks). Falls back to onboarding when returnTo is
  // absent — e.g. malformed state where we can't trust it.
  const destination =
    parsed.returnTo === "integrations" ? "/integrations" : parsed.returnTo === "settings" ? "/settings" : "/onboarding";

  if (
    !installationId ||
    parsed.tenantId !== session.user.tenantId ||
    !parsed.nonce ||
    parsed.nonce !== cookieNonce
  ) {
    return clearStateCookie(NextResponse.redirect(new URL(`${destination}?github_connect=error`, request.url)));
  }

  await db
    .update(tenants)
    .set({ githubInstallationId: installationId })
    .where(eq(tenants.id, session.user.tenantId));

  return clearStateCookie(NextResponse.redirect(new URL(`${destination}?github_connect=success`, request.url)));
}
