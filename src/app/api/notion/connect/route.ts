import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/workspace/session";
import { buildAuthorizeUrl } from "@/lib/integrations/notion/oauth";
import { newStateNonce, buildOAuthState, OAUTH_STATE_COOKIE_OPTS } from "@/lib/integrations/oauth-state";

// Mirrors /api/github/connect. Defaults to integrations so existing callers,
// which pass nothing, are unaffected.
const ALLOWED_RETURN_TO = new Set(["integrations", "onboarding"]);

export async function GET(request: NextRequest) {
  const session = await requireSession();
  const requested = new URL(request.url).searchParams.get("returnTo") ?? "integrations";
  const returnTo = ALLOWED_RETURN_TO.has(requested) ? requested : "integrations";
  // state carries the tenant id (verified in the callback against the session),
  // where to return the user, and a random CSRF nonce that is also stored in an
  // httpOnly cookie so the callback can prove the redirect belongs to this browser.
  const nonce = newStateNonce();
  const state = buildOAuthState(session.user.tenantId, returnTo, nonce);
  const response = NextResponse.redirect(buildAuthorizeUrl(state));
  response.cookies.set("notion_oauth_state", nonce, OAUTH_STATE_COOKIE_OPTS);
  return response;
}
