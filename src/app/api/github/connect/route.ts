import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/workspace/session";
import { getGithubApp } from "@/lib/integrations/github/github";
import { newStateNonce, buildOAuthState, OAUTH_STATE_COOKIE_OPTS } from "@/lib/integrations/oauth-state";

const ALLOWED_RETURN_TO = new Set(["integrations", "onboarding", "settings"]);

export async function GET(request: NextRequest) {
  const session = await requireSession();
  const requested = new URL(request.url).searchParams.get("returnTo") ?? "onboarding";
  const returnTo = ALLOWED_RETURN_TO.has(requested) ? requested : "onboarding";

  const nonce = newStateNonce();
  const state = buildOAuthState(session.user.tenantId, returnTo, nonce);
  try {
    const installUrl = await getGithubApp().getInstallationUrl({ state });
    const response = NextResponse.redirect(installUrl);
    response.cookies.set("github_oauth_state", nonce, OAUTH_STATE_COOKIE_OPTS);
    return response;
  } catch {
    // GitHub App not configured (missing env) — send back with an error flag.
    return NextResponse.redirect(new URL(`/${returnTo}?github_connect=error`, request.url));
  }
}
