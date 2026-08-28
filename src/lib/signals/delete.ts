import { and, eq, inArray } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { signals } from "@/db/schema";

export type DeleteSignalsResult = { ok: true; deletedCount: number } | { ok: false; error: string };

/**
 * Bulk-deletes signals by id, scoped to `tenantId` — mirrors `deleteBrief`'s
 * shape (the DELETE re-states the tenant itself rather than trusting a prior
 * read, since `ids` arrives from the browser and is untrusted).
 *
 * No status or kind restriction: unlike `SignalsList`'s selection checkboxes
 * (which disable `stale` rows and cap the set at `MAX_PROPOSAL_SIGNALS` for
 * brief creation), a delete has no such constraint to honor server-side —
 * those are UI rules for turning a selection into a brief, not data-integrity
 * rules about what may be removed.
 *
 * `signals.id` is the referenced side of `brief_signals.signalId`'s
 * `ON DELETE CASCADE` (see schema.ts), so deleting a signal that fed a past
 * brief only drops that evidence link — the brief itself is untouched.
 *
 * An id belonging to another tenant, or one that no longer exists, is simply
 * not deleted — `deletedCount` can be smaller than `ids.length` without that
 * being an error.
 */
export async function deleteSignals(
  tenantId: string,
  ids: string[],
  database: typeof defaultDb = defaultDb
): Promise<DeleteSignalsResult> {
  if (ids.length === 0) return { ok: false, error: "No signals selected." };

  const deleted = await database
    .delete(signals)
    .where(and(inArray(signals.id, ids), eq(signals.tenantId, tenantId)))
    .returning({ id: signals.id });

  return { ok: true, deletedCount: deleted.length };
}
