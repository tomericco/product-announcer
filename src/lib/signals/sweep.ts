import { and, eq, ne } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { sources, type Source } from "@/db/schema";
import { runCompetitorSource, type CompetitorAgentDeps } from "./competitor-agent";

export type SweepCompetitorSourcesDeps = {
  database?: typeof defaultDb;
  runSource?: (source: Source, deps?: CompetitorAgentDeps) => ReturnType<typeof runCompetitorSource>;
};

/**
 * Cron sweep for the per-source competitor agent (`runCompetitorSource`,
 * task 5). Runs every `competitor_web` source that isn't `disabled` --
 * `failing` sources are included on purpose, so a source that recovers (the
 * competitor's site comes back, a redesign settles) gets picked up again
 * instead of sitting red forever. Only a human setting `disabled` retires a
 * source for good.
 *
 * Structured like `resolve-sweep.ts`'s `sweepUnresolvedEvents`, which this
 * mirrors deliberately: the candidate select gets its own try/catch that
 * logs and returns, because a thrown error here would reject the whole cron
 * handler and undo the steps that ran before it. Candidates are then grouped
 * by tenant, and each tenant's sources run inside their own try/catch that
 * logs and continues -- one tenant's broken competitor site (or any other
 * unexpected failure) must not stop every other tenant's ingestion.
 *
 * `runCompetitorSource` itself doesn't throw for the failures it expects
 * (an unreachable page, a failed write) -- those are caught internally and
 * recorded on the source row. A throw reaching this sweep is the
 * exceptional case, not the common one.
 */
export async function sweepCompetitorSources(deps: SweepCompetitorSourcesDeps = {}): Promise<void> {
  const database = deps.database ?? defaultDb;
  const runSource = deps.runSource ?? runCompetitorSource;

  let candidates: Source[];
  try {
    candidates = await database
      .select()
      .from(sources)
      .where(and(eq(sources.type, "competitor_web"), ne(sources.status, "disabled")));
  } catch (error) {
    console.error("[sweep] failed to load candidate sources:", error);
    return;
  }

  if (candidates.length === 0) return;

  const byTenant = new Map<string, Source[]>();
  for (const source of candidates) {
    const list = byTenant.get(source.tenantId);
    if (list) {
      list.push(source);
    } else {
      byTenant.set(source.tenantId, [source]);
    }
  }

  for (const [tenantId, tenantSources] of byTenant) {
    try {
      for (const source of tenantSources) {
        await runSource(source, { database });
      }
    } catch (error) {
      // One tenant's failure must not starve the others in this sweep.
      console.error(`[sweep] sweep failed for tenant ${tenantId}:`, error);
    }
  }
}
