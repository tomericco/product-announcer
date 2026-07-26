import { NextResponse } from "next/server";
import { requireSession } from "@/lib/workspace/session";
import { buildAuthorizeUrl } from "@/lib/integrations/notion/oauth";
import { newStateNonce, buildOAuthState, OAUTH_STATE_COOKIE_OPTS } from "@/lib/integrations/oauth-state";

export async function GET() {
  const session = await requireSession();
  // state carries the tenant id (verified in the callback against the session),
  // where to return the user, and a random CSRF nonce that is also stored in an
  // httpOnly cookie so the callback can prove the redirect belongs to this browser.
  const nonce = newStateNonce();
  const state = buildOAuthState(session.user.tenantId, "integrations", nonce);
  const response = NextResponse.redirect(buildAuthorizeUrl(state));
  response.cookies.set("notion_oauth_state", nonce, OAUTH_STATE_COOKIE_OPTS);
  return response;
}
