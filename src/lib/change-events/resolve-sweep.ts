import { and, isNull, or, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { changeEvents } from "@/db/schema";
import { resolvePendingEvents } from "./pipeline";

export type ResolveSweepDeps = {
  database?: typeof defaultDb;
  resolvePending?: typeof resolvePendingEvents;
};

/**
 * Hourly cron sweep. Re-resolves change events that were ingested and
 * survived the tier-1 filter, but never made it into an atomic update because
 * the resolver's LLM call errored and it returned `[]`, leaving the event
 * `status='pending'` with no `atomicUpdateId`. Before `/pending` was removed,
 * that page was the only surface where such an event was recoverable; this
 * sweep is its replacement.
 *
 * Candidates:
 *  - status = 'pending'
 *  - atomicUpdateId IS NULL        (not already resolved)
 *  - filterReason IS NULL          (survived tier 1 — a deterministically
 *                                    dropped event, e.g. a merge commit or
 *                                    chore, is not an ingestion miss)
 *  - userFacing IS NULL OR true    (a confirmed userFacing=false event is
 *                                    correctly excluded, not orphaned)
 *
 * Grouped by tenant so `resolvePendingEvents` (which batches internally) is
 * called once per tenant. Each tenant's call is wrapped in its own try/catch,
 * mirroring `runSchedulerTick`'s per-tenant isolation, so one tenant's
 * resolver failure doesn't prevent the sweep from covering the rest.
 */
export async function sweepUnresolvedEvents(deps: ResolveSweepDeps = {}): Promise<void> {
  const database = deps.database ?? defaultDb;
  const resolvePending = deps.resolvePending ?? resolvePendingEvents;

  const rows = await database
    .select({ id: changeEvents.id, tenantId: changeEvents.tenantId })
    .from(changeEvents)
    .where(
      and(
        eq(changeEvents.status, "pending"),
        isNull(changeEvents.atomicUpdateId),
        isNull(changeEvents.filterReason),
        or(isNull(changeEvents.userFacing), eq(changeEvents.userFacing, true))
      )
    );

  if (rows.length === 0) return;

  const idsByTenant = new Map<string, string[]>();
  for (const row of rows) {
    const ids = idsByTenant.get(row.tenantId);
    if (ids) {
      ids.push(row.id);
    } else {
      idsByTenant.set(row.tenantId, [row.id]);
    }
  }

  for (const [tenantId, ids] of idsByTenant) {
    try {
      await resolvePending(tenantId, ids, { database });
    } catch (error) {
      // One tenant's failure must not starve the others in this sweep.
      console.error(`[resolve-sweep] sweep failed for tenant ${tenantId}:`, error);
    }
  }
}
