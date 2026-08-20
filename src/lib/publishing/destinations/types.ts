import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { contentPieces } from "@/db/schema";
import type * as schema from "@/db/schema";
import type { DeliveryMetadata } from "@/db/schema";
// Re-exported so destinations import everything delivery-shaped from here.
export type { DeliveryMetadata };

export type DestinationId = "webhook" | "webflow" | "linkedin";

// The shape every destination needs from a DB handle: enough for
// select/insert/update/delete. Deliberately NOT `typeof db` (which also
// carries `$client: Pool`) — dispatch.ts's row-locking fix passes a
// transaction handle (`tx`) here too, and a `PgTransaction` has no `$client`.
export type DbClient = NodePgDatabase<typeof schema>;

export type ContentPiece = typeof contentPieces.$inferSelect;

export type DeliveryResult =
  // `externalId` is stored so a later re-publish can update rather than duplicate.
  // `metadata` (optional) is destination-private state persisted on the
  // attempt row and handed back on the next `deliver` call — see
  // DeliveryMetadata in schema.ts. Omitting it leaves the stored value as-is.
  | { status: "ok"; externalId?: string; metadata?: DeliveryMetadata }
  // Worth another attempt in the cron sweep: network, 429, 5xx, or an upload
  // LinkedIn is still processing. `metadata` lets that retry pick up where
  // this attempt stopped instead of redoing its side effects.
  | { status: "retryable"; error: string; metadata?: DeliveryMetadata }
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
  // `metadata` is whatever the previous attempt for this piece+destination
  // returned (null on a first attempt). Optional so destinations that keep no
  // cross-attempt state (webhook, webflow) neither declare nor receive it, and
  // their existing call sites keep compiling.
  deliver(
    piece: ContentPiece,
    config: TConfig,
    externalId: string | null,
    database: DbClient,
    metadata?: DeliveryMetadata | null
  ): Promise<DeliveryResult>;
}

// One row in the publish modal: a destination and whether it is ready to
// receive a publish (its loadConfig returns non-null — webhook active,
// Webflow has a picked collection). Unconfigured targets still appear, with
// a "Set up" link instead of a checkbox.
export type PublishTarget = { id: DestinationId; label: string; configured: boolean };
