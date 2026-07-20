import { and, eq, lt } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { deliveryAttempts, updates } from "@/db/schema";
import { webhookDestination } from "./destinations/webhook";
import type { Destination, DeliveryResult } from "./destinations/types";

const MAX_ATTEMPTS = 3;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DESTINATIONS: Destination<any>[] = [webhookDestination];

function statusFor(result: DeliveryResult) {
  if (result.status === "ok") return "success" as const;
  // A permanent failure is recorded as failed with attempts maxed out, so the
  // retry sweep skips it without needing a fourth status value.
  return "failed" as const;
}

export async function dispatchAllDestinations(
  updateId: string,
  database: typeof defaultDb = defaultDb
): Promise<void> {
  // Runs AFTER the update is already published. Nothing here may throw — not the
  // network call, not the DB writes — or it 500s an action that already succeeded.
  try {
    const [update] = await database.select().from(updates).where(eq(updates.id, updateId)).limit(1);
    if (!update) return;

    for (const destination of DESTINATIONS) {
      try {
        const config = await destination.loadConfig(update.tenantId, database);
        if (!config) continue;

        // Reuse the prior attempt row for this update+destination so a
        // re-publish updates the existing external item rather than duplicating.
        const [existing] = await database
          .select()
          .from(deliveryAttempts)
          .where(
            and(eq(deliveryAttempts.updateId, update.id), eq(deliveryAttempts.destination, destination.id))
          )
          .limit(1);

        const attempt =
          existing ??
          (
            await database
              .insert(deliveryAttempts)
              .values({ updateId: update.id, destination: destination.id })
              .returning()
          )[0];

        const result = await destination.deliver(update, config, attempt.externalId);

        // A fresh publish always gets a full retry budget, regardless of how
        // many attempts a prior publish burned through — otherwise a single
        // transient failure on a re-publish pushes the row past MAX_ATTEMPTS
        // and the sweep (`retryFailedDeliveries`) stops retrying it forever.
        await database
          .update(deliveryAttempts)
          .set({
            status: statusFor(result),
            attempts: result.status === "permanent" ? MAX_ATTEMPTS : 1,
            lastError: result.status === "ok" ? null : result.error,
            externalId: result.status === "ok" ? (result.externalId ?? attempt.externalId) : attempt.externalId,
            lastAttemptAt: new Date(),
          })
          .where(eq(deliveryAttempts.id, attempt.id));
      } catch (error) {
        console.error(`Dispatch to ${destination.id} failed for update ${updateId}:`, error);
      }
    }
  } catch (error) {
    console.error(`Dispatch failed for update ${updateId}:`, error);
  }
}

export async function retryFailedDeliveries(database: typeof defaultDb = defaultDb): Promise<void> {
  const failed = await database
    .select()
    .from(deliveryAttempts)
    .where(and(eq(deliveryAttempts.status, "failed"), lt(deliveryAttempts.attempts, MAX_ATTEMPTS)));

  for (const attempt of failed) {
    // Isolate each attempt: one bad row must not abort the sweep and starve the
    // rest for a full hour until the next tick.
    try {
      const destination = DESTINATIONS.find((d) => d.id === attempt.destination);
      if (!destination) continue;

      const [update] = await database.select().from(updates).where(eq(updates.id, attempt.updateId)).limit(1);
      if (!update) continue;

      const config = await destination.loadConfig(update.tenantId, database);
      // Skip if the config was deactivated or removed since the original attempt.
      if (!config) continue;

      const result = await destination.deliver(update, config, attempt.externalId);

      await database
        .update(deliveryAttempts)
        .set({
          status: statusFor(result),
          attempts: result.status === "permanent" ? MAX_ATTEMPTS : attempt.attempts + 1,
          lastError: result.status === "ok" ? null : result.error,
          externalId: result.status === "ok" ? (result.externalId ?? attempt.externalId) : attempt.externalId,
          lastAttemptAt: new Date(),
        })
        .where(eq(deliveryAttempts.id, attempt.id));
    } catch (error) {
      console.error(`Retry failed for delivery attempt ${attempt.id}:`, error);
    }
  }
}
