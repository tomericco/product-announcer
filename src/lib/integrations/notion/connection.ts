import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@/db/schema";
import { notionConnections, type NotionConnection } from "@/db/schema";
import { encryptSecret, decryptSecret } from "@/lib/credentials/encryption";
import { refreshAccessToken } from "./oauth";
import { NotionApiError } from "./client";

export type DbClient = NodePgDatabase<typeof schema>;

function isAuthFailure(error: unknown): boolean {
  return error instanceof NotionApiError && (error.status === 401 || error.status === 403);
}

async function markNeedsReauth(database: DbClient, connectionId: string): Promise<void> {
  try {
    await database.update(notionConnections).set({ status: "needs_reauth" }).where(eq(notionConnections.id, connectionId));
  } catch (updateError) {
    console.error(`Failed to mark Notion connection ${connectionId} as needs_reauth:`, updateError);
  }
}

export async function withFreshToken<T>(
  database: DbClient,
  connection: NotionConnection,
  fn: (token: string) => Promise<T>
): Promise<T> {
  const accessToken = decryptSecret({
    ciphertext: connection.accessTokenCiphertext,
    iv: connection.accessTokenIv,
    authTag: connection.accessTokenAuthTag,
  });

  try {
    return await fn(accessToken);
  } catch (error) {
    if (!isAuthFailure(error)) throw error;

    if (!connection.refreshTokenCiphertext || !connection.refreshTokenIv || !connection.refreshTokenAuthTag) {
      await markNeedsReauth(database, connection.id);
      throw error;
    }

    const refreshToken = decryptSecret({
      ciphertext: connection.refreshTokenCiphertext,
      iv: connection.refreshTokenIv,
      authTag: connection.refreshTokenAuthTag,
    });

    let refreshed;
    try {
      refreshed = await refreshAccessToken(refreshToken);
    } catch (refreshError) {
      await markNeedsReauth(database, connection.id);
      throw refreshError;
    }

    const newAccess = encryptSecret(refreshed.accessToken);
    const newRefresh = refreshed.refreshToken ? encryptSecret(refreshed.refreshToken) : null;
    await database
      .update(notionConnections)
      .set({
        accessTokenCiphertext: newAccess.ciphertext,
        accessTokenIv: newAccess.iv,
        accessTokenAuthTag: newAccess.authTag,
        ...(newRefresh
          ? {
              refreshTokenCiphertext: newRefresh.ciphertext,
              refreshTokenIv: newRefresh.iv,
              refreshTokenAuthTag: newRefresh.authTag,
            }
          : {}),
      })
      .where(eq(notionConnections.id, connection.id));

    try {
      return await fn(refreshed.accessToken);
    } catch (retryError) {
      if (isAuthFailure(retryError)) await markNeedsReauth(database, connection.id);
      throw retryError;
    }
  }
}
