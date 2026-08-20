import { and, eq, lt } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { deliveryAttempts, contentPieces } from "@/db/schema";
import { webhookDestination } from "./destinations/webhook";
import { webflowDestination } from "./destinations/webflow";
import { linkedinDestination } from "./destinations/linkedin";
import type { Destination, DeliveryResult, ContentPiece, DestinationId, PublishTarget } from "./destinations/types";

const MAX_ATTEMPTS = 3;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DESTINATIONS: Destination<any>[] = [webhookDestination, webflowDestination, linkedinDestination];

function statusFor(result: DeliveryResult) {
  if (result.status === "ok") return "success" as const;
  // A permanent failure is recorded as failed with attempts maxed out, so the
  // retry sweep skips it without needing a fourth status value.
  return "failed" as const;
}

// A unique-violation on delivery_attempts_content_piece_destination_unique
// (Postgres code 23505). Only possible on the insert branch below, when two
// claimants race to create the row for the same content piece+destination for
// the very first time — the row-lock further down only protects an EXISTING row.
//
// Drizzle wraps the driver error in a DrizzleQueryError and puts the
// original pg error on `.cause` (verified against real Postgres: the code
// lives on `error.cause.code`, not `error.code`). Walk the cause chain
// rather than assuming exactly one level of wrapping, or narrowing to
// DrizzleQueryError by class name — a future Drizzle version could nest
// differently, and this just needs to find a Postgres error code wherever
// it is.
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  while (current !== null && typeof current === "object") {
    const code = (current as { code?: unknown }).code;
    if (code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// Decides the `attempts` value to persist after a delivery result.
// `undefined` means "leave the column as-is" — used for a `configFault`
// permanent failure (bad credentials, an incomplete connection) so the row
// doesn't get pinned past MAX_ATTEMPTS: the user can fix the cause, and the
// row must stay selectable by retryFailedDeliveries once they do. A genuine
// permanent failure (no configFault — e.g. a 400 validation error) still
// pins to MAX_ATTEMPTS so the sweep stops retrying content it can't fix.
// `onOtherwise` supplies the value for "ok" and "retryable": a fresh publish
// resets to 1, a sweep retry increments the existing count.
function nextAttempts(result: DeliveryResult, onOtherwise: number): number | undefined {
  if (result.status === "permanent") {
    return result.configFault ? undefined : MAX_ATTEMPTS;
  }
  return onOtherwise;
}

// Claims the delivery_attempts row for this update+destination, delivers,
// and writes the result — all under a single row lock so a concurrent
// claimant (the cron sweep firing mid-re-publish, or two overlapping sweeps)
// can never read the same externalId before either has written, which is
// what let both create their own Webflow CMS item and orphan one of them.
//
// The lock is a real `SELECT ... FOR UPDATE` inside a transaction, held for
// the duration of the network call to the destination — the call is exactly
// what must not run twice concurrently for the same row, so the lock has to
// span it, not just the surrounding reads/writes.
//
// Never throws: `dispatchAllDestinations` and `retryFailedDeliveries` both
// call this from inside a per-destination/per-attempt try/catch, but a
// transaction failure here (e.g. a dropped connection) must not abort the
// destinations loop it's called from, so callers should treat this the same
// as any other awaited step in that try block.
async function claimAndDeliver(
  database: typeof defaultDb,
  destination: Destination<unknown>,
  piece: ContentPiece,
  config: unknown,
  attemptsFor: (result: DeliveryResult, currentAttempts: number) => number | undefined,
  // "publish": dispatchAllDestinations — a fresh publish, which deliberately
  // re-delivers even a row that previously succeeded (that's how an edited
  // announcement updates the existing CMS item) and resets attempts itself.
  // "retry": retryFailedDeliveries — a sweep over rows an earlier, now-stale
  // read decided were still eligible; gates the already-done re-check below.
  mode: "publish" | "retry"
): Promise<void> {
  await database.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(deliveryAttempts)
      .where(and(eq(deliveryAttempts.contentPieceId, piece.id), eq(deliveryAttempts.destination, destination.id)))
      .for("update")
      .limit(1);

    let attempt = existing;
    if (!attempt) {
      try {
        // Wrap the insert in a nested transaction so Drizzle emits a real
        // SAVEPOINT/ROLLBACK TO SAVEPOINT (verified against the node-postgres
        // driver used here) around just this statement. A bare insert inside
        // the outer transaction would, on a unique-violation, leave Postgres
        // in "current transaction is aborted" (25P02) for every later query
        // in this tx — including the recovery SELECT right below — because
        // Postgres aborts the whole transaction on an unhandled statement
        // error, not just the failing statement. The savepoint confines the
        // rollback to the insert alone.
        [attempt] = await tx.transaction(async (tx2) =>
          tx2.insert(deliveryAttempts).values({ contentPieceId: piece.id, destination: destination.id }).returning()
        );
      } catch (error) {
        // Another claimant inserted the row first (unique-index race on a
        // first-ever publish). Re-read it under lock rather than duplicating
        // delivery — it's either mid-flight or already recorded.
        if (!isUniqueViolation(error)) throw error;
        [attempt] = await tx
          .select()
          .from(deliveryAttempts)
          .where(and(eq(deliveryAttempts.contentPieceId, piece.id), eq(deliveryAttempts.destination, destination.id)))
          .for("update")
          .limit(1);
      }
    }
    if (!attempt) return;

    // A sweep retry re-reads the row it's about to act on now that the lock
    // is actually held: retryFailedDeliveries's outer SELECT (which decided
    // this row was still eligible) ran BEFORE the lock, so a concurrent
    // claimant may have already finished it — delivered successfully, or
    // burned the last retry — in the gap between that read and this one.
    // Bail out rather than re-deliver or spend another attempt on work
    // that's already done. Restricted to "retry": a fresh publish must not
    // get this treatment, since for it "status already success" describes
    // the PRIOR publish this call is deliberately re-delivering, not a
    // concurrent duplicate of itself.
    if (mode === "retry" && (attempt.status === "success" || attempt.attempts >= MAX_ATTEMPTS)) {
      return;
    }

    const result = await destination.deliver(piece, config, attempt.externalId, tx, attempt.metadata);
    const attempts = attemptsFor(result, attempt.attempts);
    // Carry metadata forward unless this result replaced it. A permanent
    // failure never returns any (the row is done), so it keeps whatever the
    // last non-permanent attempt left — harmless, and useful in the UI.
    const metadata = result.status !== "permanent" && result.metadata ? result.metadata : attempt.metadata;

    await tx
      .update(deliveryAttempts)
      .set({
        status: statusFor(result),
        ...(attempts !== undefined ? { attempts } : {}),
        lastError: result.status === "ok" ? null : result.error,
        externalId: result.status === "ok" ? (result.externalId ?? attempt.externalId) : attempt.externalId,
        metadata,
        lastAttemptAt: new Date(),
      })
      .where(eq(deliveryAttempts.id, attempt.id));
  });
}

// Readiness of every registered destination for this tenant, for the publish
// modal. `configured` mirrors exactly what dispatch would act on: loadConfig
// returning non-null (webhook active; Webflow with a picked collection). A
// destination dispatch would skip shows here as unconfigured, so the modal
// never offers a target that can't receive anything.
export async function listPublishTargets(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<PublishTarget[]> {
  const targets: PublishTarget[] = [];
  for (const destination of DESTINATIONS) {
    const config = await destination.loadConfig(tenantId, database);
    targets.push({ id: destination.id, label: destination.label, configured: config != null });
  }
  return targets;
}

// Human-readable label for a destination id, sourced from the registry so it
// can't drift from the labels shown in the publish modal. Falls back to the
// raw id for an unknown value (e.g. a row from a since-removed destination).
export function destinationLabel(id: DestinationId): string {
  return DESTINATIONS.find((d) => d.id === id)?.label ?? id;
}

export async function dispatchAllDestinations(
  contentPieceId: string,
  database: typeof defaultDb = defaultDb,
  // When provided, restricts delivery to these destinations — the publish
  // modal's chosen subset, which is what the only surviving caller
  // (`approveDraft`) always passes. Omitted keeps delivering to every
  // configured destination, kept for a caller that publishes without a modal
  // to choose in. A selected-but-now-unconfigured id is still safe: the
  // loadConfig null-skip below drops it.
  only?: DestinationId[]
): Promise<void> {
  // Runs AFTER the update is already published. Nothing here may throw — not the
  // network call, not the DB writes — or it 500s an action that already succeeded.
  try {
    const [piece] = await database.select().from(contentPieces).where(eq(contentPieces.id, contentPieceId)).limit(1);
    if (!piece) return;

    const targets = only ? DESTINATIONS.filter((d) => only.includes(d.id)) : DESTINATIONS;
    for (const destination of targets) {
      try {
        const config = await destination.loadConfig(piece.tenantId, database);
        if (!config) continue;

        // A fresh publish always gets a full retry budget, regardless of how
        // many attempts a prior publish burned through — otherwise a single
        // transient failure on a re-publish pushes the row past MAX_ATTEMPTS
        // and the sweep (`retryFailedDeliveries`) stops retrying it forever.
        await claimAndDeliver(database, destination, piece, config, (result) => nextAttempts(result, 1), "publish");
      } catch (error) {
        console.error(`Dispatch to ${destination.id} failed for update ${contentPieceId}:`, error);
      }
    }
  } catch (error) {
    console.error(`Dispatch failed for update ${contentPieceId}:`, error);
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

      const [piece] = await database.select().from(contentPieces).where(eq(contentPieces.id, attempt.contentPieceId)).limit(1);
      if (!piece) continue;

      const config = await destination.loadConfig(piece.tenantId, database);
      // Skip if the config was deactivated or removed since the original attempt.
      if (!config) continue;

      await claimAndDeliver(
        database,
        destination,
        piece,
        config,
        (result, currentAttempts) => nextAttempts(result, currentAttempts + 1),
        "retry"
      );
    } catch (error) {
      console.error(`Retry failed for delivery attempt ${attempt.id}:`, error);
    }
  }
}
