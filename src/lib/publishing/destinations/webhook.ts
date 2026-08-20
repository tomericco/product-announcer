import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { webhookConfigs } from "@/db/schema";
import { decryptSecret } from "@/lib/credentials/encryption";
import { loadCoverImagePayload, type CoverImagePayload } from "@/lib/publishing/cover-image";
import type { Destination, DeliveryResult, DbClient, ContentPiece } from "./types";

const DELIVERY_TIMEOUT_MS = 5000;

type WebhookConfig = typeof webhookConfigs.$inferSelect;

function signPayload(secret: string, payload: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

function buildPayload(piece: ContentPiece, coverImage: CoverImagePayload | null) {
  return {
    id: piece.id,
    tenantId: piece.tenantId,
    title: piece.title,
    // Markdown. Body images are `![alt](https://…)` with absolute, stable,
    // hotlinkable Blob URLs — receivers may embed them directly.
    body: piece.body,
    status: piece.status,
    createdAt: piece.createdAt,
    publishedAt: piece.publishedAt,
    // The cover as a structured field (JSON Feed 1.1's `image` shape, spec
    // §8): null when the piece has no ready cover. Additive — every earlier
    // key keeps its meaning.
    coverImage,
  };
}

export const webhookDestination: Destination<WebhookConfig> = {
  id: "webhook",
  label: "Webhook",

  async loadConfig(tenantId, database: DbClient) {
    const [config] = await database
      .select()
      .from(webhookConfigs)
      .where(and(eq(webhookConfigs.tenantId, tenantId), eq(webhookConfigs.active, true)))
      .limit(1);
    return config ?? null;
  },

  // `externalId` is part of the `Destination` interface (webflow updates an
  // existing CMS item by it), but webhook delivery has no notion of an
  // external id. `database` is used only to read the cover row.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async deliver(piece, config, _externalId, database): Promise<DeliveryResult> {
    const coverImage = await loadCoverImagePayload(piece.tenantId, piece.id, database);
    // A secret is optional. With one, sign the body (HMAC) and, on a decrypt
    // failure (rotated/misconfigured CREDENTIALS_ENCRYPTION_KEY), fail
    // permanently as a config fault — retrying can't help, and it must not be
    // logged identically to a network timeout. Decrypt outside and before the
    // fetch's try block so a decrypt failure is never caught there and
    // misclassified as retryable. Without a secret, deliver unsigned: no
    // signature header at all.
    const body = JSON.stringify(buildPayload(piece, coverImage));
    let signature: string | null = null;
    if (config.secretCiphertext && config.secretIv && config.secretAuthTag) {
      let secret: string;
      try {
        secret = decryptSecret({
          ciphertext: config.secretCiphertext,
          iv: config.secretIv,
          authTag: config.secretAuthTag,
        });
      } catch {
        return {
          status: "permanent",
          error: "Could not decrypt the webhook secret. Check CREDENTIALS_ENCRYPTION_KEY.",
          configFault: true,
        };
      }
      signature = signPayload(secret, body);
    }

    try {
      // Bound the request: delivery runs synchronously inside the publish action
      // (and sequentially inside the cron sweep), so a slow/hanging tenant
      // endpoint must not block either.
      const response = await fetch(config.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(signature ? { "x-product-announcer-signature": signature } : {}),
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
