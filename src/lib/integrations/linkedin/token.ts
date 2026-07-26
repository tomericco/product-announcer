import { eq } from "drizzle-orm";
import { linkedinConnections } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/credentials/encryption";
import type { DbClient } from "@/lib/publishing/destinations/types";
import { LinkedinApiError, refreshAccessToken } from "./client";

type LinkedinConnection = typeof linkedinConnections.$inferSelect;

const REFRESH_SKEW_MS = 60_000;

export async function getValidAccessToken(connection: LinkedinConnection, database: DbClient): Promise<string> {
  const near = connection.expiresAt.getTime() - Date.now() <= REFRESH_SKEW_MS;
  if (!near) {
    return decryptSecret({
      ciphertext: connection.accessTokenCiphertext,
      iv: connection.accessTokenIv,
      authTag: connection.accessTokenAuthTag,
    });
  }

  if (!connection.refreshTokenCiphertext || !connection.refreshTokenIv || !connection.refreshTokenAuthTag) {
    throw new LinkedinApiError(401, "LinkedIn access token expired and no refresh token is stored. Reconnect.");
  }

  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new LinkedinApiError(401, "LINKEDIN_CLIENT_ID/SECRET not configured.");
  }

  const refreshToken = decryptSecret({
    ciphertext: connection.refreshTokenCiphertext,
    iv: connection.refreshTokenIv,
    authTag: connection.refreshTokenAuthTag,
  });

  // Let a refresh failure surface as LinkedinApiError(401) so the destination
  // classifies it as a configFault and flips the connection to needs_reauth.
  const tokens = await refreshAccessToken({ refreshToken, clientId, clientSecret });

  const access = encryptSecret(tokens.accessToken);
  const nextRefresh = tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null;
  await database
    .update(linkedinConnections)
    .set({
      accessTokenCiphertext: access.ciphertext,
      accessTokenIv: access.iv,
      accessTokenAuthTag: access.authTag,
      ...(nextRefresh
        ? {
            refreshTokenCiphertext: nextRefresh.ciphertext,
            refreshTokenIv: nextRefresh.iv,
            refreshTokenAuthTag: nextRefresh.authTag,
          }
        : {}),
      expiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000),
      lastValidatedAt: new Date(),
    })
    .where(eq(linkedinConnections.id, connection.id));

  return tokens.accessToken;
}
