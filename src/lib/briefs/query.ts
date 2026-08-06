import { and, desc, eq, inArray } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { briefRuns, briefSignals, briefs, signals, type Brief, type BriefRun, type Signal } from "@/db/schema";

export type BriefFilters = { status?: Brief["status"] };

export type CitedSignal = { id: string; title: string; url: string | null; kind: Signal["kind"] };

export type BriefWithSignals = Brief & { signals: CitedSignal[] };

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
 * Evidence is fetched in a SECOND query rather than joined, so a brief cited by
 * five signals stays one row. It is also a LEFT relationship in effect: a brief
 * with no evidence still appears, with an empty array.
 */
export async function listBriefs(
  tenantId: string,
  filters: BriefFilters,
  database: typeof defaultDb = defaultDb
): Promise<BriefWithSignals[]> {
  const rows = await database
    .select()
    .from(briefs)
    .where(and(eq(briefs.tenantId, tenantId), eq(briefs.status, filters.status ?? "new")))
    .orderBy(desc(briefs.score), desc(briefs.createdAt));

  if (rows.length === 0) return [];

  const links = await database
    .select({
      briefId: briefSignals.briefId,
      id: signals.id,
      title: signals.title,
      url: signals.url,
      kind: signals.kind,
    })
    .from(briefSignals)
    .innerJoin(signals, eq(signals.id, briefSignals.signalId))
    .where(
      inArray(
        briefSignals.briefId,
        rows.map((r) => r.id)
      )
    );

  const byBrief = new Map<string, CitedSignal[]>();
  for (const link of links) {
    const list = byBrief.get(link.briefId) ?? [];
    list.push({ id: link.id, title: link.title, url: link.url, kind: link.kind });
    byBrief.set(link.briefId, list);
  }

  return rows.map((r) => ({ ...r, signals: byBrief.get(r.id) ?? [] }));
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
