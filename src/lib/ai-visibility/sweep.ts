import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { sources, aiVisibilityRuns, type Source } from "@/db/schema";
import { getAiVisibilitySettings } from "@/lib/ai-visibility/settings";
import { planRun, runSlice, finalizeRun, type Clock, type PlanRunRefusal } from "@/lib/ai-visibility/run";

/**
 * How long the whole AI-visibility step of one cron tick may take.
 *
 * The scheduler runs seven steps sequentially inside one serverless invocation,
 * and this is the only one that makes hundreds of outbound calls. The default
 * assumes the sweep is not the only thing in the tick; raise it only together
 * with the platform's function timeout, never alone.
 */
export const SWEEP_BUDGET_MS = Number(process.env.AI_VISIBILITY_SWEEP_BUDGET_MS ?? 120_000);

/**
 * Engine calls in flight at once, per source.
 *
 * Contract decision 3 targets 360 calls in one tick at concurrency 12–20. Held
 * at the low end of that: four different providers' rate limits are in play and
 * a 429 costs a sample outright, since there is no retry helper in this repo.
 */
export const SWEEP_CONCURRENCY = Number(process.env.AI_VISIBILITY_CONCURRENCY ?? 12);

/** No source gets less than this, however many are waiting. */
export const MIN_SOURCE_BUDGET_MS = 5_000;

/** Milliseconds in a day, for the fortnight test. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Fortnightly tolerance. Two matching weekdays are exactly 14 days apart, so a
 * tick that fires a few minutes earlier than the last one would fail a strict
 * `>= 14 days` test and silently skip a whole fortnight. 13 days makes the
 * weekday match the real gate and the elapsed test a guard against firing on
 * consecutive weeks.
 */
const FORTNIGHT_MIN_DAYS = 13;

/**
 * Whether a scheduled run is due for this tenant right now.
 *
 * UTC throughout — `dayOfWeek` is documented as UTC in the settings schema and
 * on the settings card, because a per-tenant timezone would make "last ran
 * Monday" mean different things on the card and in the database.
 */
export function cadenceDue(
  settings: { cadence: string; dayOfWeek: number },
  lastRunAt: Date | null,
  now: Date
): boolean {
  if (settings.cadence === "off") return false;
  if (now.getUTCDay() !== settings.dayOfWeek) return false;

  if (settings.cadence === "fortnightly") {
    if (!lastRunAt) return true;
    return now.getTime() - lastRunAt.getTime() >= FORTNIGHT_MIN_DAYS * DAY_MS;
  }

  // Weekly: the weekday match is the schedule; this only stops a second run if
  // the cron somehow ticks twice in one day.
  if (!lastRunAt) return true;
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return lastRunAt.getTime() < startOfToday;
}

export type SweepAiVisibilityDeps = {
  database?: typeof defaultDb;
  now?: Clock;
  plan?: typeof planRun;
  slice?: typeof runSlice;
  finalize?: typeof finalizeRun;
  budgetMs?: number;
  concurrency?: number;
};

/** Human sentences for the refusals a scheduled run can hit. */
function refusalMessage(refusal: PlanRunRefusal): string {
  switch (refusal.reason) {
    case "disabled":
      return "AI visibility is turned off for this workspace.";
    case "no_prompts":
      return "No active prompts — approve a prompt set to start measuring.";
    case "run_in_flight":
      return "A run is already in flight.";
    case "cap_reached":
      return `Paused — monthly cap reached ($${refusal.spentUsd.toFixed(2)} of $${refusal.capUsd.toFixed(2)}).`;
  }
}

/**
 * Cron sweep for the per-tenant AI-visibility agent.
 *
 * Deliberately the same shape as `sweepNewsSources`: `failing` sources are
 * included so a tenant whose cap resets or whose engine key is fixed is picked
 * up again, only a human setting `disabled` retires one; the candidate select
 * has its own try/catch that logs and returns, because a throw here would
 * reject the whole cron handler and undo the steps that ran before it; and past
 * that the try/catch is per source, so one tenant's broken run cannot stop the
 * rest of the sweep.
 *
 * What differs from the news sweep is the budget. This agent's unit of work is
 * hundreds of outbound calls, not one page fetch, so the tick's time is divided
 * up front. Without that division the first tenant in the list would spend the
 * whole budget every week and the tenants behind it would never run at all —
 * and because the ordering is `lastRunAt ASC NULLS FIRST`, they would then sort
 * to the front next week, so the failure would look like everyone's runs being
 * permanently half-finished rather than like starvation.
 */
export async function sweepAiVisibility(deps: SweepAiVisibilityDeps = {}): Promise<void> {
  const database = deps.database ?? defaultDb;
  const now = deps.now ?? (() => new Date());
  const plan = deps.plan ?? planRun;
  const slice = deps.slice ?? runSlice;
  const finalize = deps.finalize ?? finalizeRun;
  const totalBudgetMs = deps.budgetMs ?? SWEEP_BUDGET_MS;
  const concurrency = deps.concurrency ?? SWEEP_CONCURRENCY;

  let candidates: Source[];
  try {
    candidates = await database
      .select()
      .from(sources)
      .where(and(eq(sources.type, "ai_visibility"), ne(sources.status, "disabled")))
      // Never-run first, then least-recently-run, so if this sweep is ever cut
      // short the starvation rotates fairly instead of always favouring the
      // same tenants.
      .orderBy(sql`${sources.lastRunAt} ASC NULLS FIRST`);
  } catch (error) {
    console.error("[ai-visibility-sweep] failed to load candidate sources:", error);
    return;
  }
  if (candidates.length === 0) return;

  const perSourceBudgetMs = Math.max(
    MIN_SOURCE_BUDGET_MS,
    Math.floor(totalBudgetMs / candidates.length)
  );

  for (const source of candidates) {
    try {
      // A run already in flight is resumed on ANY day, cadence irrelevant: it
      // was already authorised and paid for, and leaving it half-finished until
      // next Monday would leave the dashboard showing a permanent "Running…".
      // The sweep is not the only resumer — a manual "Run now" (H3) also
      // drives an in-flight run forward when planRun refuses run_in_flight —
      // but the sweep is the guarantee: a run left `running` completes by the
      // next tick even if nobody clicks anything.
      const [inFlight] = await database
        .select({ id: aiVisibilityRuns.id })
        .from(aiVisibilityRuns)
        .where(
          and(
            eq(aiVisibilityRuns.tenantId, source.tenantId),
            inArray(aiVisibilityRuns.status, ["pending", "running"])
          )
        )
        .limit(1);

      let runId = inFlight?.id ?? null;

      if (!runId) {
        const settings = await getAiVisibilitySettings(source.tenantId, database);
        if (!settings.enabled) continue;
        if (!cadenceDue(settings, source.lastRunAt, now())) continue;

        const planned = await plan(source.tenantId, { trigger: "scheduled", now }, { database });
        if (!planned.ok) {
          const message = refusalMessage(planned);
          // Recorded, not swallowed. A tenant whose cap tripped or whose prompt
          // set is empty must be able to see why nothing happened — otherwise
          // the source sits green and silent, which is indistinguishable from
          // working. `lastRunAt` is deliberately NOT touched: it is the cadence
          // anchor (the fortnight-elapsed test and the weekly same-day guard),
          // and a refusal is not a run. Stamping it here would make a
          // cap-refused fortnightly tenant re-wait 13 days after the month
          // resets instead of running on the next matching weekday. Real runs
          // move it via `runSlice`'s cap pause and `finalizeRun`'s `finish()`.
          await database
            .update(sources)
            .set({
              lastError: message,
              status: planned.reason === "cap_reached" ? "failing" : source.status,
            })
            .where(eq(sources.id, source.id));
          continue;
        }
        runId = planned.runId;
      }

      const sliceStartedAt = now().getTime();
      const outcome = await slice(runId, { budgetMs: perSourceBudgetMs, concurrency, now }, { database });

      // Nothing left to ask, and the cap did not stop us: close the run out with
      // whatever this source's budget has left. `finalizeRun` is itself
      // resumable, so a short remainder is fine — it keeps the run `running`.
      if (outcome.remaining === 0 && !outcome.pausedByCap) {
        const spent = now().getTime() - sliceStartedAt;
        const left = Math.max(MIN_SOURCE_BUDGET_MS, perSourceBudgetMs - spent);
        await finalize(runId, { budgetMs: left, now }, { database });
      }
    } catch (error) {
      // Per source, not per tenant: one broken run must not stop the rest of the
      // sweep. `planRun`, `runSlice` and `finalizeRun` all record their own
      // expected failures, so a throw reaching here is the exceptional case.
      console.error(
        `[ai-visibility-sweep] failed for source ${source.id} (tenant ${source.tenantId}):`,
        error
      );
    }
  }
}
