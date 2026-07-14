import { createHmac } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { webhookConfigs, webhookDeliveries, updates } from "../db/schema";

const MAX_ATTEMPTS = 3;

function signPayload(secret: string, payload: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

function buildPayload(update: typeof updates.$inferSelect) {
  return {
    id: update.id,
    tenantId: update.tenantId,
    title: update.title,
    body: update.body,
    category: update.category,
    status: update.status,
    sourceItems: update.sourceItems,
    createdAt: update.createdAt,
    publishedAt: update.publishedAt,
  };
}

const DELIVERY_TIMEOUT_MS = 5000;

async function attemptDelivery(url: string, secret: string, payload: object): Promise<boolean> {
  const body = JSON.stringify(payload);
  try {
    // Bound the request: delivery runs synchronously inside the publish action
    // (and sequentially inside the cron sweep), so a slow/hanging tenant
    // endpoint must not block either. A timeout aborts into the catch below and
    // is recorded as a failed delivery.
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-product-announcer-signature": signPayload(secret, body),
      },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function dispatchWebhookForUpdate(
  updateId: string,
  database: typeof defaultDb = defaultDb
): Promise<void> {
  // This runs inside approveDraft AFTER the update is already published. Per the
  // plan's constraint, delivery must never fail the publish action — so nothing
  // in here may throw, not just the network call. A DB error (recording the
  // delivery row, etc.) is logged and swallowed rather than propagating out and
  // 500-ing an action that already succeeded.
  try {
    const [update] = await database.select().from(updates).where(eq(updates.id, updateId)).limit(1);
    if (!update) return;

    const [config] = await database
      .select()
      .from(webhookConfigs)
      .where(and(eq(webhookConfigs.tenantId, update.tenantId), eq(webhookConfigs.active, true)))
      .limit(1);
    if (!config) return;

    const [delivery] = await database
      .insert(webhookDeliveries)
      .values({ updateId: update.id, webhookConfigId: config.id })
      .returning();

    const succeeded = await attemptDelivery(config.url, config.secret, buildPayload(update));

    await database
      .update(webhookDeliveries)
      .set({ status: succeeded ? "success" : "failed", attempts: 1, lastAttemptAt: new Date() })
      .where(eq(webhookDeliveries.id, delivery.id));
  } catch (error) {
    console.error(`Webhook dispatch failed for update ${updateId}:`, error);
  }
}

export async function retryFailedWebhookDeliveries(database: typeof defaultDb = defaultDb): Promise<void> {
  const failedDeliveries = await database
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.status, "failed"), lt(webhookDeliveries.attempts, MAX_ATTEMPTS)));

  for (const delivery of failedDeliveries) {
    // Isolate each delivery: one bad row (DB error, etc.) must not abort the
    // rest of the sweep — and starve them for a full hour until the next tick.
    try {
      const [config] = await database
        .select()
        .from(webhookConfigs)
        .where(eq(webhookConfigs.id, delivery.webhookConfigId))
        .limit(1);
      const [update] = await database.select().from(updates).where(eq(updates.id, delivery.updateId)).limit(1);
      // Skip if the config was deactivated since the original attempt —
      // consistent with dispatchWebhookForUpdate, which only delivers to active
      // configs.
      if (!config || !config.active || !update) continue;

      const succeeded = await attemptDelivery(config.url, config.secret, buildPayload(update));

      await database
        .update(webhookDeliveries)
        .set({ status: succeeded ? "success" : "failed", attempts: delivery.attempts + 1, lastAttemptAt: new Date() })
        .where(eq(webhookDeliveries.id, delivery.id));
    } catch (error) {
      console.error(`Webhook retry failed for delivery ${delivery.id}:`, error);
    }
  }
}
