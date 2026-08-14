import { and, desc, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { briefRuns, briefSignals, briefs, signals, type Brief, type BriefRun, type Signal } from "@/db/schema";

export type BriefFilters = { status?: Brief["status"] };

export type CitedSignal = { id: string; title: string; url: string | null; kind: Signal["kind"] };

/**
 * Tenant-scoped brief listing for the inbox.
 *
 * Ordered by score AND recency. The validation spike measured scores
 * clustering at 0.66-0.92 (see the comment on `briefs.score`), so score alone
 * cannot order a real backlog — recency breaks the ties it leaves.
 *
 * Defaults to `new`. Accepted, dismissed and expired briefs are decisions
 * already made and are reachable only by asking for them.
 *
 * No longer joins evidence: the list row doesn't show it (the editor at
 * `/briefs/[briefId]` does, via `listBriefSignals` below, scoped to the one
 * brief being opened rather than every row in the list).
 */
export async function listBriefs(
  tenantId: string,
  filters: BriefFilters,
  database: typeof defaultDb = defaultDb
): Promise<Brief[]> {
  return database
    .select()
    .from(briefs)
    .where(and(eq(briefs.tenantId, tenantId), eq(briefs.status, filters.status ?? "new")))
    .orderBy(desc(briefs.score), desc(briefs.createdAt));
}

/**
 * The evidence cited by one brief — the editor's read, not the list's.
 *
 * `briefId` arrives from the URL and is untrusted, so this is tenant-scoped in
 * its own right rather than trusting a prior tenant check on the brief itself:
 * the join filters on `signals.tenantId`, not `briefs.tenantId`, so a briefId
 * belonging to another tenant returns no rows even if the caller forgot (or
 * got wrong) the brief-level check. `brief_signals` carries no `tenantId` of
 * its own — `signals` is the tenant-scoped side of the join.
 */
export async function listBriefSignals(
  briefId: string,
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<CitedSignal[]> {
  return database
    .select({
      id: signals.id,
      title: signals.title,
      url: signals.url,
      kind: signals.kind,
    })
    .from(briefSignals)
    .innerJoin(signals, eq(signals.id, briefSignals.signalId))
    .where(and(eq(briefSignals.briefId, briefId), eq(signals.tenantId, tenantId)));
}

/**
 * This tenant's most recent ideation run, or null if the agent has never run.
 *
 * The inbox header reads this so an empty list can say WHICH empty it is: never
 * run, ran and judged the period quiet, or ran and failed. Without it those
 * three render identically — the failure `run.ts:246` already warns about.
 */
export async function latestBriefRun(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<BriefRun | null> {
  const [row] = await database
    .select()
    .from(briefRuns)
    .where(eq(briefRuns.tenantId, tenantId))
    .orderBy(desc(briefRuns.ranAt))
    .limit(1);
  return row ?? null;
}
