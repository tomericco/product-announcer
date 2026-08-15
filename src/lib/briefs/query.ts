import { and, desc, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { briefRuns, briefSignals, signals, type BriefRun, type Signal } from "@/db/schema";

export type CitedSignal = { id: string; title: string; url: string | null; kind: Signal["kind"] };

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
