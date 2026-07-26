import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { linkedinConnections } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { encryptSecret } from "@/lib/credentials/encryption";
import { exchangeCode } from "@/lib/integrations/linkedin/client";

export async function GET(request: NextRequest) {
  const session = await requireSession();

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const [tenantIdFromState] = (state ?? "").split("|");

  const errorUrl = new URL("/integrations?linkedin_connect=error", request.url);
  if (!code || tenantIdFromState !== session.user.tenantId) {
    return NextResponse.redirect(errorUrl);
  }

  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  const redirectUri = process.env.LINKEDIN_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    return NextResponse.redirect(errorUrl);
  }

  let tokens;
  try {
    tokens = await exchangeCode({ code, clientId, clientSecret, redirectUri });
  } catch (error) {
    console.error("LinkedIn code exchange failed:", error);
    return NextResponse.redirect(errorUrl);
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

  return NextResponse.redirect(new URL("/integrations?linkedin_connect=success", request.url));
}
