import { and, eq } from "drizzle-orm";
import type { db as defaultDb } from "@/db";
import { webflowConnections } from "@/db/schema";
import { decryptSecret } from "@/lib/credentials/encryption";
import {
  WebflowApiError,
  createItem,
  getCollection,
  updateItem,
  type WebflowField,
  type WebflowItemBody,
} from "@/lib/integrations/webflow/client";
import { buildFieldData } from "@/lib/integrations/webflow/mapping";
import { slugify, withSuffix } from "@/lib/publishing/slug";
import type { Destination, DeliveryResult, Update } from "./types";

type WebflowConnection = typeof webflowConnections.$inferSelect;

const MAX_SLUG_ATTEMPTS = 5;

function isSlugCollision(error: WebflowApiError): boolean {
  return (
    error.status === 400 &&
    error.validationDetails.some((d) => d.toLowerCase().includes("unique value is already in database"))
  );
}

// `validateMapping` runs at config-save time against the schema alone, so it
// can never see the update's actual content. A required field mapped to,
// say, `title` passes that check every time, then silently writes "" here
// and Webflow 400s with no actionable detail. This is the only place that
// holds both the update AND the live collection schema, so it's the only
// place that can catch content-dependent emptiness before the network call.
function findEmptyRequiredField(
  fieldData: Record<string, unknown>,
  fields: WebflowField[]
): WebflowField | undefined {
  return fields.find((field) => {
    if (!field.isRequired) return false;
    const value = fieldData[field.slug];
    if (value === undefined || value === null) return true;
    return typeof value === "string" && value.trim() === "";
  });
}

function classify(error: unknown): DeliveryResult {
  if (error instanceof WebflowApiError) {
    // 401: the token was revoked or the app uninstalled. Webflow issues no
    // refresh token, so retrying can never succeed — the user must reconnect.
    if (error.status === 401 || error.status === 403) {
      return { status: "permanent", error: "Webflow rejected the token. Reconnect the integration." };
    }
    if (error.status === 400) {
      const detail = error.validationDetails.join("; ") || error.message;
      return { status: "permanent", error: `Webflow rejected the item: ${detail}` };
    }
    if (error.status === 429 || error.status === 408 || error.status >= 500) {
      return { status: "retryable", error: error.message };
    }
    return { status: "permanent", error: error.message };
  }
  // Network failure or timeout.
  return { status: "retryable", error: error instanceof Error ? error.message : "request failed" };
}

export const webflowDestination: Destination<WebflowConnection> = {
  id: "webflow",

  async loadConfig(tenantId, database: typeof defaultDb) {
    const [connection] = await database
      .select()
      .from(webflowConnections)
      .where(and(eq(webflowConnections.tenantId, tenantId), eq(webflowConnections.status, "active")))
      .limit(1);
    return connection ?? null;
  },

  async deliver(update: Update, connection, externalId): Promise<DeliveryResult> {
    if (!connection.collectionId) {
      return { status: "permanent", error: "Webflow connection is missing a collection." };
    }
    // MDXEditor can submit a blank body on a parse failure (see resolveBody in
    // drafts/actions.ts). Publishing an empty CMS item is worse than failing.
    if (!update.body.trim()) {
      return { status: "permanent", error: "Update body is empty; nothing to publish." };
    }

    const live = connection.publishMode === "live";

    try {
      const token = decryptSecret({
        ciphertext: connection.tokenCiphertext,
        iv: connection.tokenIv,
        authTag: connection.tokenAuthTag,
      });

      // Re-fetch the schema rather than trusting the stored mapping: a field
      // deleted in Webflow since setup would otherwise 400 with no explanation.
      const collection = await getCollection(token, connection.collectionId);

      const baseSlug = slugify(update.title);
      let lastError: DeliveryResult | null = null;
      // Tracks genuine slug-collision retries only. Kept separate from the
      // 404-fallback below so a deleted-item recovery never eats into this
      // budget or skips ahead to a suffixed slug it never needed.
      let slugAttempt = 0;

      while (slugAttempt < MAX_SLUG_ATTEMPTS) {
        const fieldData = buildFieldData(
          update,
          connection.fieldMapping,
          collection.fields,
          withSuffix(baseSlug, slugAttempt)
        );

        const emptyRequired = findEmptyRequiredField(fieldData, collection.fields);
        if (emptyRequired) {
          return {
            status: "permanent",
            error: `Webflow requires "${emptyRequired.displayName}", but the mapped value is empty.`,
          };
        }

        const body: WebflowItemBody = { isDraft: !live, fieldData };

        try {
          if (externalId) {
            const updated = await updateItem(token, connection.collectionId, externalId, body, live);
            return { status: "ok", externalId: updated.id };
          }
          const created = await createItem(token, connection.collectionId, body, live);
          return { status: "ok", externalId: created.id };
        } catch (error) {
          if (error instanceof WebflowApiError && error.status === 404 && externalId) {
            // The customer deleted our item in Webflow. Drop the stale id and
            // create a fresh one on the next pass, at the SAME slug attempt —
            // this isn't a slug collision, so it must not consume one.
            externalId = null;
            continue;
          }
          if (error instanceof WebflowApiError && isSlugCollision(error)) {
            // A deleted item's slug stays reserved until the site republishes,
            // so check-then-insert cannot prevent this — only retrying can.
            lastError = classify(error);
            slugAttempt++;
            continue;
          }
          return classify(error);
        }
      }

      return lastError ?? { status: "permanent", error: "Could not find an available slug in Webflow." };
    } catch (error) {
      return classify(error);
    }
  },
};
