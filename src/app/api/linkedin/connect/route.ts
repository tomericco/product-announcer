import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/workspace/session";
import { buildAuthorizeUrl } from "@/lib/integrations/linkedin/client";
import { newStateNonce, buildOAuthState, OAUTH_STATE_COOKIE_OPTS } from "@/lib/integrations/oauth-state";

export async function GET(request: NextRequest) {
  const session = await requireSession();

  const nonce = newStateNonce();
  const state = buildOAuthState(session.user.tenantId, "integrations", nonce);
  try {
    const clientId = process.env.LINKEDIN_CLIENT_ID;
    const redirectUri = process.env.LINKEDIN_REDIRECT_URI;
    if (!clientId || !redirectUri) {
      throw new Error("LinkedIn is not configured on the server.");
    }
    const authorizeUrl = buildAuthorizeUrl({ clientId, redirectUri, state });
    const response = NextResponse.redirect(authorizeUrl);
    response.cookies.set("linkedin_oauth_state", nonce, OAUTH_STATE_COOKIE_OPTS);
    return response;
  } catch {
    // LinkedIn app not configured (missing env) or URL build failed — send back with an error flag.
    return NextResponse.redirect(new URL("/integrations?linkedin_connect=error", request.url));
  }
}
