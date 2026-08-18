import { and, eq, ne, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { sources, type Source } from "@/db/schema";
import { runNewsSource, type NewsAgentDeps } from "./news-agent";

export type SweepNewsSourcesDeps = {
  database?: typeof defaultDb;
  runSource?: (source: Source, deps?: NewsAgentDeps) => ReturnType<typeof runNewsSource>;
};

/**
 * Cron sweep for the per-tenant news agent, deliberately the same shape as
 * `sweepCompetitorSources` in `sweep.ts`.
 *
 * `failing` sources are included on purpose: a source that recovers (the API
 * key is fixed, the rate limit clears) gets picked up again instead of sitting
 * red forever. Only a human setting `disabled` retires one.
 *
 * The candidate select gets its own try/catch that logs and returns — a throw
 * here would reject the whole cron handler and undo the steps that ran before
 * it, and there is nothing to sweep if the select itself failed.
 *
 * Past that, the try/catch is per *source*, not per tenant, so one tenant's
 * broken run cannot stop the rest of the sweep.
 */
export async function sweepNewsSources(deps: SweepNewsSourcesDeps = {}): Promise<void> {
  const database = deps.database ?? defaultDb;
  const runSource = deps.runSource ?? runNewsSource;

  let candidates: Source[];
  try {
    candidates = await database
      .select()
      .from(sources)
      .where(and(eq(sources.type, "news"), ne(sources.status, "disabled")))
      // Never-run first, then least-recently-run, so if this sweep is ever cut
      // short the starvation rotates fairly instead of always favouring the
      // same tenants.
      .orderBy(sql`${sources.lastRunAt} ASC NULLS FIRST`);
  } catch (error) {
    console.error("[news-sweep] failed to load candidate sources:", error);
    return;
  }

  for (const source of candidates) {
    try {
      await runSource(source, { database });
    } catch (error) {
      console.error(`[news-sweep] failed for source ${source.id} (tenant ${source.tenantId}):`, error);
    }
  }
}
