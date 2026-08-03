import { and, desc, eq, gte, isNull, lte, ne, or } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { signals, type Signal } from "@/db/schema";
import { signalWindowStart } from "./window";

export type SignalFilters = {
  kind?: Signal["kind"];
  competitorId?: string;
  // Null relevanceScore means scoring failed, not "scored zero" — it must
  // survive this filter (see the OR/isNull below), never be silently
  // dropped by a `>= minScore` comparison.
  minScore?: number;
  // Narrows *within* the 60-day window on `occurredAt` — a different
  // question ("when did this happen") from how long the row is retained.
  from?: Date;
  to?: Date;
  includeStale?: boolean;
};

/**
 * Tenant-scoped signal listing for the debugging browser.
 *
 * The 60-day window is not one of `filters` and cannot be bypassed by a
 * caller: it is applied unconditionally, first in the condition list, as the
 * stand-in for the retention delete job that does not exist yet. When that
 * job is built it must gate on the same `signalWindowStart`/`createdAt` pair
 * used here, or a signal could be visible here after the job has already
 * discarded it (or retained forever with nothing able to show it).
 */
export async function listSignals(
  tenantId: string,
  filters: SignalFilters,
  database: typeof defaultDb = defaultDb
): Promise<Signal[]> {
  const conditions = [eq(signals.tenantId, tenantId), gte(signals.createdAt, signalWindowStart(new Date()))];

  if (!filters.includeStale) {
    conditions.push(ne(signals.status, "stale"));
  }
  if (filters.kind) {
    conditions.push(eq(signals.kind, filters.kind));
  }
  if (filters.competitorId) {
    conditions.push(eq(signals.competitorId, filters.competitorId));
  }
  if (filters.minScore !== undefined) {
    // `relevanceScore >= minScore` alone drops NULL rows silently in SQL
    // (three-valued logic), which would hide exactly the scoring failures
    // this browser exists to surface. `isNull` first makes null rows pass
    // regardless of the threshold.
    conditions.push(or(isNull(signals.relevanceScore), gte(signals.relevanceScore, filters.minScore))!);
  }
  if (filters.from) {
    conditions.push(gte(signals.occurredAt, filters.from));
  }
  if (filters.to) {
    conditions.push(lte(signals.occurredAt, filters.to));
  }

  return database
    .select()
    .from(signals)
    .where(and(...conditions))
    .orderBy(desc(signals.occurredAt), desc(signals.id));
}
