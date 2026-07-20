import type { db as defaultDb } from "@/db";
import type { updates } from "@/db/schema";

export type DestinationId = "webhook" | "webflow";

export type Update = typeof updates.$inferSelect;

export type DeliveryResult =
  // `externalId` is stored so a later re-publish can update rather than duplicate.
  | { status: "ok"; externalId?: string }
  // Worth another attempt in the cron sweep: network, 429, 5xx.
  | { status: "retryable"; error: string }
  // Retrying cannot help: bad credentials, validation failure, empty body.
  | { status: "permanent"; error: string };

export interface Destination<TConfig> {
  id: DestinationId;
  loadConfig(tenantId: string, database: typeof defaultDb): Promise<TConfig | null>;
  deliver(update: Update, config: TConfig, externalId: string | null): Promise<DeliveryResult>;
}
