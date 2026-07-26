import { and, eq, isNotNull } from "drizzle-orm";
import { linkedinConnections } from "@/db/schema";
import { getValidAccessToken } from "@/lib/integrations/linkedin/token";
import { createPost, LinkedinApiError } from "@/lib/integrations/linkedin/client";
import { slugify } from "@/lib/publishing/slug";
import type { Destination, DeliveryResult, DbClient, Release } from "./types";

type LinkedinConnection = typeof linkedinConnections.$inferSelect;

function isAuthFailure(error: unknown): boolean {
  return error instanceof LinkedinApiError && (error.status === 401 || error.status === 403);
}

function classify(error: unknown): DeliveryResult {
  if (error instanceof LinkedinApiError) {
    if (error.status === 401 || error.status === 403) {
      return { status: "permanent", error: "LinkedIn rejected the token. Reconnect the integration.", configFault: true };
    }
    if (error.status === 429 || error.status === 408 || error.status >= 500) {
      return { status: "retryable", error: error.message };
    }
    return { status: "permanent", error: `LinkedIn rejected the post: ${error.message}` };
  }
  return { status: "retryable", error: error instanceof Error ? error.message : "request failed" };
}

// Best-effort: flip the connection to needs_reauth so the integrations banner
// prompts a reconnect. Never let this turn a clean classification into a throw.
async function recordNeedsReauth(database: DbClient, connectionId: string): Promise<void> {
  try {
    await database.update(linkedinConnections).set({ status: "needs_reauth" }).where(eq(linkedinConnections.id, connectionId));
  } catch (error) {
    console.error(`Failed to mark LinkedIn connection ${connectionId} as needs_reauth:`, error);
  }
}

async function classifyAndRecord(error: unknown, database: DbClient, connectionId: string): Promise<DeliveryResult> {
  if (isAuthFailure(error)) await recordNeedsReauth(database, connectionId);
  return classify(error);
}

export const linkedinDestination: Destination<LinkedinConnection> = {
  id: "linkedin",
  label: "LinkedIn",

  async loadConfig(tenantId, database: DbClient) {
    const [connection] = await database
      .select()
      .from(linkedinConnections)
      .where(
        and(
          eq(linkedinConnections.tenantId, tenantId),
          eq(linkedinConnections.status, "active"),
          isNotNull(linkedinConnections.organizationUrn),
          isNotNull(linkedinConnections.baseUrl)
        )
      )
      .limit(1);
    return connection ?? null;
  },

  async deliver(release: Release, connection, externalId, database): Promise<DeliveryResult> {
    // Post-once: a release already posted to LinkedIn must never be re-posted
    // (that would duplicate/spam), unlike Webflow which updates in place.
    if (externalId) return { status: "ok", externalId };

    if (!connection.organizationUrn || !connection.baseUrl) {
      return { status: "permanent", error: "LinkedIn connection is missing an organization or base URL.", configFault: true };
    }
    // Company-only guarantee 2: never post as a personal member. The author
    // must be an organization URN; anything else is a config fault, not a post.
    if (!connection.organizationUrn.startsWith("urn:li:organization:")) {
      return { status: "permanent", error: "LinkedIn author must be an organization page.", configFault: true };
    }
    if (!release.linkedinBody || !release.linkedinBody.trim()) {
      return { status: "permanent", error: "Generate a LinkedIn post before publishing." };
    }

    const link = new URL(slugify(release.title), connection.baseUrl).toString();
    const commentary = `${release.linkedinBody.trim()}\n\n${link}`;

    try {
      const accessToken = await getValidAccessToken(connection, database);
      const { postUrn } = await createPost({ accessToken, authorUrn: connection.organizationUrn, commentary });
      return { status: "ok", externalId: postUrn };
    } catch (error) {
      return classifyAndRecord(error, database, connection.id);
    }
  },
};
