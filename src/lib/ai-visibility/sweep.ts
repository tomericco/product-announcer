import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { sources, aiVisibilityRuns, type Source } from "@/db/schema";
import { capPausedMessage } from "@/lib/ai-visibility/cost";
import { getAiVisibilitySettingsForTenants } from "@/lib/ai-visibility/settings";
import { planRun, runSlice, finalizeRun, type Clock, type PlanRunRefusal } from "@/lib/ai-visibility/run";

/**
 * A knob read from the environment, or its default.
 *
 * `Number(undefined)` is NaN and so is `Number("12s")`; an unset variable in a
 * `??` chain is the only case the plain form gets right. NaN here is not a
 * loud failure — `Math.max(5_000, NaN)` is NaN, and `elapsed >= NaN` is false
 * forever, so the budget silently ceases to exist and one slice runs a 360-call
 * work list inside a single invocation until the platform kills it. An empty
 * string is worse than useless in the other direction: `Number("")` is 0.
 */
function positiveNumberFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * How long the whole AI-visibility step of one cron tick may take.
 *
 * The scheduler runs several steps sequentially inside one serverless
 * invocation, and this is the only one that makes hundreds of outbound calls.
 * It must stay a fraction of the route's `maxDuration`, because two more steps
 * — brief expiry and the ideation sweep — run *after* this one and are the
 * things that actually get cut off if this overruns.
 */
export const SWEEP_BUDGET_MS = positiveNumberFromEnv(
  process.env.AI_VISIBILITY_SWEEP_BUDGET_MS,
  120_000
);

/**
 * Engine calls in flight at once, per source.
 *
 * Contract decision 3 targets 360 calls in one tick at concurrency 12–20. Held
 * at the low end of that: four different providers' rate limits are in play and
 * a 429 costs a sample outright, since there is no retry helper in this repo.
 */
export const SWEEP_CONCURRENCY = positiveNumberFromEnv(process.env.AI_VISIBILITY_CONCURRENCY, 12);

/** No source gets less than this, however many are waiting. */
export const MIN_SOURCE_BUDGET_MS = 5_000;

/** Milliseconds in a day, for the elapsed tests below. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Nominal period of each cadence, in days. */
const PERIOD_DAYS: Record<string, number> = { weekly: 7, fortnightly: 14 };

/**
 * Fortnightly tolerance on the scheduled weekday. Two matching weekdays are
 * exactly 14 days apart, so a tick that fires a few minutes earlier than the
 * last one would fail a strict `>= 14 days` test and silently skip a whole
 * fortnight. 13 days makes the weekday match the real gate and the elapsed test
 * a guard against firing on consecutive weeks.
 */
const FORTNIGHT_MIN_DAYS = 13;

/**
 * Whether a scheduled run is due for this tenant right now.
 *
 * UTC throughout — `dayOfWeek` is documented as UTC in the settings schema and
 * on the settings card, because a per-tenant timezone would make "last ran
 * Monday" mean different things on the card and in the database.
 *
 * Two ways to be due, and the second one is the important one:
 *
 *  1. It is the configured weekday (and, for fortnightly, a fortnight has gone
 *     by). This is the schedule.
 *  2. A whole period has elapsed since the last run, whatever today is. This is
 *     the catch-up, and without it the product promises "a run a week" while
 *     delivering "an attempt a week": one cron tick that dies, times out, or
 *     never fires costs the tenant a full week, and every default tenant shares
 *     `dayOfWeek = 1`, so a truncated Monday is exactly the tick most likely to
 *     be lost.
 *
 * The catch-up threshold is a FULL period, not period − 1. Six days after a
 * Monday run is Sunday, so a 6-day catch-up would fire a day early every week
 * and walk the schedule backwards through the calendar — the schedule has to be
 * the weekday, with the elapsed test only ever recovering a miss.
 *
 * A tenant that has never run waits for its weekday rather than starting on
 * whatever day the feature was switched on; "Run now" is the control for
 * starting immediately, and it does not go through here.
 */
export function cadenceDue(
  settings: { cadence: string; dayOfWeek: number },
  lastRunAt: Date | null,
  now: Date
): boolean {
  if (settings.cadence === "off") return false;

  // One run per UTC day, whichever arm below wants to fire. This is the guard
  // against a cron that ticks twice, and against the catch-up arm re-firing
  // beside a run that has already happened today.
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (lastRunAt && lastRunAt.getTime() >= startOfToday) return false;

  const elapsedMs = lastRunAt ? now.getTime() - lastRunAt.getTime() : Infinity;

  if (now.getUTCDay() === settings.dayOfWeek) {
    if (settings.cadence === "fortnightly") return elapsedMs >= FORTNIGHT_MIN_DAYS * DAY_MS;
    return true;
  }

  // Off-weekday: only a missed period gets a run, and a tenant with no run to
  // measure from has not missed anything yet.
  if (!lastRunAt) return false;
  const periodDays = PERIOD_DAYS[settings.cadence] ?? PERIOD_DAYS.weekly;
  return elapsedMs >= periodDays * DAY_MS;
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
      // Unreachable from the sweep — that refusal is resumed, not recorded (see
      // the call site). Kept so this switch stays exhaustive over the union.
      return "A run is already in flight.";
    case "cap_reached":
      return capPausedMessage(refusal.spentUsd, refusal.capUsd);
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
 * What differs from the news sweep is time. This agent's unit of work is
 * hundreds of outbound calls, not one page fetch, so the tick is bounded twice:
 *
 *  - the budget is divided up front, so the first tenant in the list cannot
 *    spend all of it and leave the rest permanently half-finished; and
 *  - a deadline is checked before every source, so the sweep stops on its own
 *    terms rather than being killed by the platform mid-slice — the steps that
 *    run AFTER it in the cron route (brief expiry, ideation) are what a killed
 *    invocation actually costs.
 *
 * The divisor counts the sources that will do work — due, or holding an
 * in-flight run — not every row. Every tenant defaults to `dayOfWeek = 1`, so
 * the ordinary Monday has all of them due at once and the ordinary Tuesday has
 * none; dividing by the row count would hand each Monday tenant a share sized
 * for a week where nobody runs.
 */
export async function sweepAiVisibility(deps: SweepAiVisibilityDeps = {}): Promise<void> {
  const database = deps.database ?? defaultDb;
  const now = deps.now ?? (() => new Date());
  const plan = deps.plan ?? planRun;
  const slice = deps.slice ?? runSlice;
  const finalize = deps.finalize ?? finalizeRun;
  const totalBudgetMs = deps.budgetMs ?? SWEEP_BUDGET_MS;
  const concurrency = deps.concurrency ?? SWEEP_CONCURRENCY;
  const deadline = now().getTime() + totalBudgetMs;

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

  // Two queries, not two per source: the budget cannot be divided until every
  // candidate has been classified, and classifying them one round trip at a
  // time spends the budget before any work starts.
  let workers: { source: Source; runId: string | null }[];
  try {
    const tenantIds = candidates.map((source) => source.tenantId);
    const inFlightRows = await database
      .select({ tenantId: aiVisibilityRuns.tenantId, id: aiVisibilityRuns.id })
      .from(aiVisibilityRuns)
      .where(
        and(
          inArray(aiVisibilityRuns.tenantId, tenantIds),
          inArray(aiVisibilityRuns.status, ["pending", "running"])
        )
      );
    // A partial unique index enforces one in-flight run per tenant, so first
    // wins is the only entry there can be.
    const inFlight = new Map(inFlightRows.map((row) => [row.tenantId, row.id]));
    const settings = await getAiVisibilitySettingsForTenants(tenantIds, database);

    workers = candidates
      .map((source) => {
        // An in-flight run is resumed on ANY day, cadence irrelevant: it was
        // already authorised and paid for, and leaving it half-finished until
        // next Monday would leave the dashboard showing a permanent "Running…".
        // The sweep is not the only resumer — a manual "Run now" (H3) also
        // drives an in-flight run forward — but the sweep is the guarantee: a
        // run left `running` completes by the next tick even if nobody clicks
        // anything.
        const runId = inFlight.get(source.tenantId) ?? null;
        if (runId) return { source, runId };

        const tenantSettings = settings.get(source.tenantId);
        if (!tenantSettings?.enabled) return null;
        if (!cadenceDue(tenantSettings, source.lastRunAt, now())) return null;
        return { source, runId: null };
      })
      .filter((worker): worker is { source: Source; runId: string | null } => worker !== null);
  } catch (error) {
    console.error("[ai-visibility-sweep] failed to classify candidate sources:", error);
    return;
  }
  if (workers.length === 0) return;

  const perSourceBudgetMs = Math.max(
    MIN_SOURCE_BUDGET_MS,
    Math.floor(totalBudgetMs / workers.length)
  );

  for (const [index, worker] of workers.entries()) {
    const { source } = worker;
    // The floor above can hand out more time in total than the tick has, once
    // enough tenants are due at once. Whoever is past the deadline stops, and
    // because the ordering is `lastRunAt ASC NULLS FIRST` the tenants that were
    // cut sort to the front of next tick's list rather than being skipped
    // again. Stopping here is also why `cadenceDue` has a catch-up arm: a
    // tenant cut on its scheduled Monday is due again on Tuesday.
    const remainingTickMs = deadline - now().getTime();
    if (remainingTickMs <= 0) {
      console.warn(
        `[ai-visibility-sweep] out of budget with ${workers.length - index} source(s) left`
      );
      break;
    }
    const budgetMs = Math.min(perSourceBudgetMs, remainingTickMs);

    try {
      let runId = worker.runId;

      if (!runId) {
        const planned = await plan(source.tenantId, { trigger: "scheduled", now }, { database });
        if (!planned.ok) {
          if (planned.reason === "run_in_flight") {
            // Not an error, and emphatically not one to paint the source red
            // with: the in-flight lookup above is not transactional with
            // `planRun`, so a manual "Run now" landing in between is an
            // ordinary race. The refusal carries the run, the slice lease makes
            // driving it safe, so drive it.
            runId = planned.runId;
          } else {
            const message = refusalMessage(planned);
            // Recorded, not swallowed. A tenant whose cap tripped or whose
            // prompt set is empty must be able to see why nothing happened —
            // otherwise the source sits green and silent, which is
            // indistinguishable from working.
            //
            // `lastRunAt` is deliberately NOT touched: it is the cadence anchor
            // (the catch-up and same-day tests both measure from it), and a
            // refusal is not a run. Stamping it here would make a cap-refused
            // fortnightly tenant re-wait a fortnight after the month resets
            // instead of running on the next matching weekday. Real runs move
            // it via `runSlice`'s cap pause and `finalizeRun`'s `finish()`.
            //
            // `status` is written only for the cap. Echoing the status read
            // before the loop would let a source a human disabled a moment ago
            // be resurrected to `active` by this write.
            await database
              .update(sources)
              .set({
                lastError: message,
                ...(planned.reason === "cap_reached" ? { status: "failing" as const } : {}),
              })
              .where(eq(sources.id, source.id));
            continue;
          }
        } else {
          runId = planned.runId;
        }
      }

      const sliceStartedAt = now().getTime();
      const outcome = await slice(runId, { budgetMs, concurrency, now }, { database });

      // Nothing left to ask, and the cap did not stop us: close the run out with
      // whatever this source's budget has left. `finalizeRun` is itself
      // resumable, so a short remainder is fine — it keeps the run `running`.
      //
      // `remaining: 0` also comes back when this driver LOST the slice lease to
      // a concurrent "Run now", in which case the run may still be full of
      // pending samples. That is safe rather than lucky: `finalizeRun` takes the
      // same lease (so it no-ops and reports `running`), and even holding it, it
      // re-counts pending samples before aggregating. Aggregates are never
      // written off a half-finished work list.
      if (outcome.remaining === 0 && !outcome.pausedByCap) {
        const spent = now().getTime() - sliceStartedAt;
        const left = Math.max(MIN_SOURCE_BUDGET_MS, budgetMs - spent);
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
