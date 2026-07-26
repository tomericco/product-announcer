import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { linkedinConnections } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { encryptSecret } from "@/lib/credentials/encryption";
import { exchangeCode } from "@/lib/integrations/linkedin/client";
import { parseOAuthState, OAUTH_STATE_COOKIE_OPTS } from "@/lib/integrations/oauth-state";

export async function GET(request: NextRequest) {
  const session = await requireSession();

  const code = request.nextUrl.searchParams.get("code");
  const parsed = parseOAuthState(request.nextUrl.searchParams.get("state"));
  // Wrap in NextRequest so `.cookies` works for both a real NextRequest and the
  // plain `Request` the test suite passes.
  const cookieNonce = new NextRequest(request).cookies.get("linkedin_oauth_state")?.value;

  // Always clear the state cookie on the way out — it is single-use.
  const clearStateCookie = (response: NextResponse) => {
    response.cookies.set("linkedin_oauth_state", "", { ...OAUTH_STATE_COOKIE_OPTS, maxAge: 0 });
    return response;
  };

  const errorUrl = new URL("/integrations?linkedin_connect=error", request.url);
  if (
    !code ||
    parsed.tenantId !== session.user.tenantId ||
    !parsed.nonce ||
    parsed.nonce !== cookieNonce
  ) {
    return clearStateCookie(NextResponse.redirect(errorUrl));
  }

  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  const redirectUri = process.env.LINKEDIN_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    return clearStateCookie(NextResponse.redirect(errorUrl));
  }

  let tokens;
  try {
    tokens = await exchangeCode({ code, clientId, clientSecret, redirectUri });
  } catch (error) {
    console.error("LinkedIn code exchange failed:", error);
    return clearStateCookie(NextResponse.redirect(errorUrl));
  }

  const access = encryptSecret(tokens.accessToken);
  const refresh = tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null;
  const expiresAt = new Date(Date.now() + tokens.expiresInSeconds * 1000);

  // Upsert on the unique tenantId: reconnecting replaces the stored tokens and
  // resets status to active without disturbing a previously-selected org/baseUrl.
  await db
    .insert(linkedinConnections)
    .values({
      tenantId: session.user.tenantId,
      accessTokenCiphertext: access.ciphertext,
      accessTokenIv: access.iv,
      accessTokenAuthTag: access.authTag,
      refreshTokenCiphertext: refresh?.ciphertext ?? null,
      refreshTokenIv: refresh?.iv ?? null,
      refreshTokenAuthTag: refresh?.authTag ?? null,
      expiresAt,
      status: "active",
      lastValidatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: linkedinConnections.tenantId,
      set: {
        accessTokenCiphertext: access.ciphertext,
        accessTokenIv: access.iv,
        accessTokenAuthTag: access.authTag,
        refreshTokenCiphertext: refresh?.ciphertext ?? null,
        refreshTokenIv: refresh?.iv ?? null,
        refreshTokenAuthTag: refresh?.authTag ?? null,
        expiresAt,
        status: "active",
        lastValidatedAt: new Date(),
      },
    });

  return clearStateCookie(NextResponse.redirect(new URL("/integrations?linkedin_connect=success", request.url)));
}
