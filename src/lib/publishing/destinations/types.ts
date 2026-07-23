import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { releases } from "@/db/schema";
import type * as schema from "@/db/schema";

export type DestinationId = "webhook" | "webflow";

// The shape every destination needs from a DB handle: enough for
// select/insert/update/delete. Deliberately NOT `typeof db` (which also
// carries `$client: Pool`) — dispatch.ts's row-locking fix passes a
// transaction handle (`tx`) here too, and a `PgTransaction` has no `$client`.
export type DbClient = NodePgDatabase<typeof schema>;

export type Release = typeof releases.$inferSelect;

export type DeliveryResult =
  // `externalId` is stored so a later re-publish can update rather than duplicate.
  | { status: "ok"; externalId?: string }
  // Worth another attempt in the cron sweep: network, 429, 5xx.
  | { status: "retryable"; error: string }
  // Retrying cannot help: bad credentials, validation failure, empty body.
  // `configFault` marks the subset caused by connection/credential SETUP
  // (a revoked token, an undecryptable secret, an incomplete wizard) rather
  // than by the content being published. dispatch.ts uses it to decide
  // whether to pin `attempts` to the retry cap: a genuine content/validation
  // failure should stop the sweep from retrying forever, but a config fault
  // is fixable by the user, so the row must stay sweepable once they fix it.
  | { status: "permanent"; error: string; configFault?: true };

export interface Destination<TConfig> {
  id: DestinationId;
  /** Human-readable name shown in the publish-destinations modal. */
  label: string;
  loadConfig(tenantId: string, database: DbClient): Promise<TConfig | null>;
  deliver(release: Release, config: TConfig, externalId: string | null, database: DbClient): Promise<DeliveryResult>;
}

// One row in the publish modal: a destination and whether it is ready to
// receive a publish (its loadConfig returns non-null — webhook active,
// Webflow has a picked collection). Unconfigured targets still appear, with
// a "Set up" link instead of a checkbox.
export type PublishTarget = { id: DestinationId; label: string; configured: boolean };
