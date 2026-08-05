import { and, eq, lte } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { briefs, companyProfiles } from "@/db/schema";
import { runIdeation, type IdeationRunResult } from "./run";

export type ExpireDeps = { database?: typeof defaultDb };

/**
 * Expires briefs nobody decided on, so the inbox never accumulates debt.
 *
 * Only `new` briefs are touched. An accepted or dismissed brief is a decision
 * someone made; re-expiring it would rewrite history, and an already-expired
 * one has nothing to change.
 */
export async function expireStaleBriefs(deps: ExpireDeps = {}): Promise<number> {
  const database = deps.database ?? defaultDb;
  const rows = await database
    .update(briefs)
    .set({ status: "expired", updatedAt: new Date() })
    .where(and(eq(briefs.status, "new"), lte(briefs.expiresAt, new Date())))
    .returning({ id: briefs.id });
  return rows.length;
}

export type SweepIdeationDeps = {
  database?: typeof defaultDb;
  runFn?: (tenantId: string) => Promise<IdeationRunResult>;
};

/**
 * Cron fan-out for the ideation run, deliberately the same shape as
 * `src/lib/signals/news-sweep.ts`.
 *
 * The candidate select gets its own try/catch that logs and returns — a throw
 * here would reject the whole cron handler and undo the steps that ran before
 * it, and there is nothing to sweep if the select itself failed.
 *
 * Past that the try/catch is per *tenant*, so one tenant's failure cannot stop
 * the rest of the sweep.
 *
 * Candidates are tenants with a company profile: without one there is no
 * positioning and no topics, so ideation has nothing to reason from.
 */
export async function sweepIdeation(deps: SweepIdeationDeps = {}): Promise<void> {
  const database = deps.database ?? defaultDb;
  const runFn = deps.runFn ?? runIdeation;

  let candidates: { tenantId: string }[];
  try {
    candidates = await database
      .select({ tenantId: companyProfiles.tenantId })
      .from(companyProfiles)
      // Ordered only so the sweep is deterministic rather than dependent on
      // Postgres's plan. This is NOT fair rotation: `companyProfiles` carries
      // no last-run timestamp, so a sweep cut short would starve the same
      // tenants every time. `scheduleConfigs.lastRunAt` is the column that
      // would fix it, and nothing writes it yet — see the accepted gaps.
      .orderBy(companyProfiles.tenantId);
  } catch (error) {
    console.error("[ideation-sweep] failed to load candidate tenants:", error);
    return;
  }

  for (const { tenantId } of candidates) {
    try {
      await runFn(tenantId);
    } catch (error) {
      console.error(`[ideation-sweep] failed for tenant ${tenantId}:`, error);
    }
  }
}
