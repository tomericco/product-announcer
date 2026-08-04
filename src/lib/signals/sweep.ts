import { and, eq, ne, sql } from "drizzle-orm";
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
 * The candidate select gets its own try/catch that logs and returns,
 * matching `resolve-sweep.ts`'s `sweepUnresolvedEvents` -- a thrown error
 * here would reject the whole cron handler and undo the steps that ran
 * before it, and there's nothing to sweep if the select itself fails.
 *
 * Past that, this sweep's shape differs from `resolve-sweep.ts` on purpose:
 * that sweep makes exactly one (internally-batched) call per tenant, so a
 * single per-tenant try/catch is the finest granularity available. Here,
 * a tenant can have several sources -- one competitor's changelog and
 * another's blog -- and each gets its own `runSource` call. Wrapping a whole
 * tenant's sources in one try/catch would let one broken competitor site
 * stop every other competitor that same tenant is watching for the rest of
 * the sweep. So the try/catch is per *source*: one call's failure is logged
 * and the loop moves on, both within a tenant and across tenants. This is
 * the same isolation argument the shipped-work reconciler's per-row rewrite
 * made earlier in this series. No per-tenant grouping is needed to get a
 * tenant-labeled log line -- every `Source` already carries its own
 * `tenantId` -- so this is a single flat loop over the candidates.
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
      .where(and(eq(sources.type, "competitor_web"), ne(sources.status, "disabled")))
      // Never-run sources first, then least-recently-run -- an unordered
      // select makes the candidate order (and therefore which rows a
      // starved tail never reaches) an accident of Postgres's plan rather
      // than a deliberate policy. With this order, starvation (if the sweep
      // is ever cut short, or a future producer shares this same cron run)
      // rotates fairly across sources instead of always favoring the same
      // ones.
      .orderBy(sql`${sources.lastRunAt} ASC NULLS FIRST`);
  } catch (error) {
    console.error("[sweep] failed to load candidate sources:", error);
    return;
  }

  for (const source of candidates) {
    try {
      await runSource(source, { database });
    } catch (error) {
      // One source's failure must not stop this tenant's other sources, or
      // any other tenant's -- see the function doc for why this is
      // per-source rather than per-tenant.
      console.error(`[sweep] failed for source ${source.id} (tenant ${source.tenantId}):`, error);
    }
  }
}
