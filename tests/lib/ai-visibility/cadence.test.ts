import { describe, it, expect } from "vitest";
import { nextScheduledRun, SWEEP_HOUR_UTC } from "../../../src/lib/ai-visibility/cadence";

/**
 * `nextScheduledRun` — the date behind "Next scan in 3 days".
 *
 * `cadenceDue` has its own tests in `sweep.test.ts`; these are about the walk
 * forward, and specifically about the cases a hand-rolled
 * `(dayOfWeek - today + 7) % 7` would have got wrong. That arithmetic agrees
 * with the schedule on the plain weekly case and quietly disagrees with it on
 * fortnightly, on catch-ups and on the day a run already happened — which is
 * exactly why this function asks `cadenceDue` rather than restating it.
 */

const WEEKLY = { cadence: "weekly", dayOfWeek: 1 } as const;
const FORTNIGHTLY = { cadence: "fortnightly", dayOfWeek: 1 } as const;

// All Mondays are dayOfWeek 1; Aug 17 and Aug 24 2026 are consecutive Mondays.
const MON_17 = new Date("2026-08-17T09:00:00Z");
const MON_24 = new Date("2026-08-24T09:00:00Z");

describe("nextScheduledRun", () => {
  it("has no answer for a cadence that is off — there is no next scan", () => {
    expect(nextScheduledRun({ cadence: "off", dayOfWeek: 1 }, MON_17, new Date("2026-08-19T12:00:00Z"))).toBeNull();
  });

  it("lands on the configured weekday, at the hour the cron fires", () => {
    const next = nextScheduledRun(WEEKLY, MON_17, new Date("2026-08-19T12:00:00Z"));

    expect(next?.toISOString()).toBe(MON_24.toISOString());
    expect(next?.getUTCHours()).toBe(SWEEP_HOUR_UTC);
    expect(next?.getUTCDay()).toBe(WEEKLY.dayOfWeek);
  });

  it("skips today's tick once it has fired, rather than naming a time in the past", () => {
    // 10:00 on the scheduled Monday, an hour after the 09:00 sweep ran this
    // tenant — so `lastRunAt` is today's run, not last week's, and the next
    // scan is a week out.
    const next = nextScheduledRun(WEEKLY, MON_24, new Date("2026-08-24T10:00:00Z"));

    expect(next?.toISOString()).toBe("2026-08-31T09:00:00.000Z");
  });

  it("offers tomorrow when the scheduled tick came and went without running", () => {
    // The state the catch-up arm exists for: it is Monday evening, the 09:00
    // sweep was truncated or died, and `lastRunAt` is still a week old. The
    // schedule does not make this tenant wait another seven days — the very
    // next tick picks them up.
    const next = nextScheduledRun(WEEKLY, MON_17, new Date("2026-08-24T22:00:00Z"));

    expect(next?.toISOString()).toBe("2026-08-25T09:00:00.000Z");
  });

  it("names today when the day's tick is still ahead", () => {
    const next = nextScheduledRun(WEEKLY, MON_17, new Date("2026-08-24T08:00:00Z"));

    expect(next?.toISOString()).toBe(MON_24.toISOString());
  });

  it("does not name a Monday a fortnightly tenant is not due on", () => {
    // Ran Monday the 17th, so the 24th fails the 13-day test and the 31st is
    // the real next scan. The weekday alone would have said the 24th.
    const next = nextScheduledRun(FORTNIGHTLY, MON_17, new Date("2026-08-19T12:00:00Z"));

    expect(next?.toISOString()).toBe("2026-08-31T09:00:00.000Z");
  });

  it("names the catch-up tick, not the weekday, for a tenant that has already missed a period", () => {
    // Last run Monday the 3rd and today is Wednesday the 19th: a whole weekly
    // period has elapsed, so the sweep's catch-up arm fires at the very next
    // tick rather than waiting for Monday.
    const next = nextScheduledRun(WEEKLY, new Date("2026-08-03T09:00:00Z"), new Date("2026-08-19T08:00:00Z"));

    expect(next?.toISOString()).toBe("2026-08-19T09:00:00.000Z");
  });

  it("waits for the weekday when there is no run to measure from", () => {
    // A tenant that has never run does not start on whatever day the feature
    // was switched on — "Run now" is the control for that.
    const next = nextScheduledRun(WEEKLY, null, new Date("2026-08-19T12:00:00Z"));

    expect(next?.toISOString()).toBe(MON_24.toISOString());
  });

  it("does not offer a second scan on a day one has already run", () => {
    // Ran at 06:00 this morning, before the sweep hour. The once-per-day guard
    // means today's 09:00 tick is not a scan, so the next one is next week.
    const next = nextScheduledRun(WEEKLY, new Date("2026-08-24T06:00:00Z"), new Date("2026-08-24T07:00:00Z"));

    expect(next?.toISOString()).toBe("2026-08-31T09:00:00.000Z");
  });
});
