/**
 * The AI-visibility SCHEDULE, as pure functions of settings, the last run and
 * the clock.
 *
 * Its own module, and deliberately a leaf: nothing here touches the database,
 * the engines or the run driver. `sweep.ts` — which does all three — imports
 * from here and re-exports `cadenceDue` for its existing callers, and the
 * /ai-visibility page imports `nextScheduledRun` for the line under "Run now".
 * That line is the reason for the split: importing it from `sweep.ts` dragged
 * the whole sweep — db handle, settings reader, `planRun`, `runSlice`,
 * `finalizeRun` — into a React Server Component's module graph to compute a
 * date.
 */

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

/**
 * The UTC hour the scheduler's cron fires, mirrored from `vercel.ts`
 * (`"0 9 * * *"`).
 *
 * Only `nextScheduledRun` reads it, and only to decide whether TODAY's tick is
 * still ahead of the reader. Nothing schedules off this constant — the cron
 * expression is the schedule — so a drift between the two costs a
 * "Next scan tomorrow" that should have said "later today", not a missed run.
 */
export const SWEEP_HOUR_UTC = 9;

/** How far ahead `nextScheduledRun` will look before giving up. */
const NEXT_RUN_HORIZON_DAYS = 30;

/**
 * When the next SCHEDULED run would fire — the sentence under "Run now".
 *
 * Deliberately not a second reading of the cadence rules: it walks forward one
 * UTC day at a time and asks `cadenceDue` itself, at the hour the cron fires,
 * until one says yes. Fortnightly's 13-day tolerance, the catch-up arm and the
 * once-per-day guard are therefore all honoured for free, and a change to any
 * of them moves this line with it. A hand-rolled `(dayOfWeek - today + 7) % 7`
 * would have agreed with `cadenceDue` on the weekly case and quietly lied
 * about every other one.
 *
 * `null` for `cadence: "off"` — there is no next scan — and also if nothing
 * comes due inside the horizon, which no live cadence does; that arm exists so
 * a future cadence with a longer period returns "unknown" rather than looping.
 *
 * The result is the cron TICK, not a promise: a tick that is over budget defers
 * the tenant to the next one, which is what the catch-up arm then recovers.
 */
export function nextScheduledRun(
  settings: { cadence: string; dayOfWeek: number },
  lastRunAt: Date | null,
  now: Date
): Date | null {
  if (settings.cadence === "off") return null;

  for (let offset = 0; offset <= NEXT_RUN_HORIZON_DAYS; offset += 1) {
    const tick = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset, SWEEP_HOUR_UTC)
    );
    // Today's tick, already fired: it is not the NEXT one whether or not it was
    // due. Anything it would have started is `lastRunAt` by now, which the
    // once-per-day guard inside `cadenceDue` reads on the following days.
    if (tick.getTime() < now.getTime()) continue;
    if (cadenceDue(settings, lastRunAt, tick)) return tick;
  }
  return null;
}
