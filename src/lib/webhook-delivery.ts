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

async function attemptDelivery(url: string, secret: string, payload: object): Promise<boolean> {
  const body = JSON.stringify(payload);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-product-announcer-signature": signPayload(secret, body),
      },
      body,
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
}

export async function retryFailedWebhookDeliveries(database: typeof defaultDb = defaultDb): Promise<void> {
  const failedDeliveries = await database
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.status, "failed"), lt(webhookDeliveries.attempts, MAX_ATTEMPTS)));

  for (const delivery of failedDeliveries) {
    const [config] = await database
      .select()
      .from(webhookConfigs)
      .where(eq(webhookConfigs.id, delivery.webhookConfigId))
      .limit(1);
    const [update] = await database.select().from(updates).where(eq(updates.id, delivery.updateId)).limit(1);
    if (!config || !update) continue;

    const succeeded = await attemptDelivery(config.url, config.secret, buildPayload(update));

    await database
      .update(webhookDeliveries)
      .set({ status: succeeded ? "success" : "failed", attempts: delivery.attempts + 1, lastAttemptAt: new Date() })
      .where(eq(webhookDeliveries.id, delivery.id));
  }
}
