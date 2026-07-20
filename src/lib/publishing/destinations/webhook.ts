import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { db as defaultDb } from "@/db";
import { webhookConfigs } from "@/db/schema";
import { decryptSecret } from "@/lib/credentials/encryption";
import type { Destination, DeliveryResult, Update } from "./types";

const DELIVERY_TIMEOUT_MS = 5000;

type WebhookConfig = typeof webhookConfigs.$inferSelect;

function signPayload(secret: string, payload: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

function buildPayload(update: Update) {
  return {
    id: update.id,
    tenantId: update.tenantId,
    title: update.title,
    body: update.body,
    status: update.status,
    sourceItems: update.sourceItems,
    createdAt: update.createdAt,
    publishedAt: update.publishedAt,
  };
}

export const webhookDestination: Destination<WebhookConfig> = {
  id: "webhook",

  async loadConfig(tenantId, database: typeof defaultDb) {
    const [config] = await database
      .select()
      .from(webhookConfigs)
      .where(and(eq(webhookConfigs.tenantId, tenantId), eq(webhookConfigs.active, true)))
      .limit(1);
    return config ?? null;
  },

  // `externalId` and `database` are part of the `Destination` interface
  // (webflow needs `database` to record `needs_reauth`), but webhook
  // delivery has no notion of an external id and no DB write of its own.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async deliver(update, config, _externalId, _database): Promise<DeliveryResult> {
    // A decrypt failure (rotated/misconfigured CREDENTIALS_ENCRYPTION_KEY) can't be
    // fixed by retrying, and must not be logged identically to a network timeout.
    // Decrypt outside and before the fetch's try block so a decrypt failure is
    // never caught there and misclassified as retryable.
    let secret: string;
    try {
      secret = decryptSecret({
        ciphertext: config.secretCiphertext,
        iv: config.secretIv,
        authTag: config.secretAuthTag,
      });
    } catch {
      return { status: "permanent", error: "Could not decrypt the webhook secret. Check CREDENTIALS_ENCRYPTION_KEY." };
    }

    const body = JSON.stringify(buildPayload(update));
    try {
      // Bound the request: delivery runs synchronously inside the publish action
      // (and sequentially inside the cron sweep), so a slow/hanging tenant
      // endpoint must not block either.
      const response = await fetch(config.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-product-announcer-signature": signPayload(secret, body),
        },
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      // Preserves prior behavior: any non-2xx is simply "failed" and retried.
      return response.ok ? { status: "ok" } : { status: "retryable", error: `HTTP ${response.status}` };
    } catch (error) {
      return { status: "retryable", error: error instanceof Error ? error.message : "request failed" };
    }
  },
};
