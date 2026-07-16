import { describe, it, expect } from "vitest";
import {
  shouldTriggerRun,
  advanceNextScheduledAt,
  computeNextScheduledAt,
} from "../../src/lib/scheduler-decision";

describe("shouldTriggerRun", () => {
  const now = new Date("2026-07-13T12:00:00Z");

  it("returns null when there is nothing pending, even if the cadence deadline passed", () => {
    const result = shouldTriggerRun(
      { cadence: "weekly", nextScheduledAt: new Date("2026-07-01T00:00:00Z"), threshold: 5, pendingCount: 0 },
      now
    );
    expect(result).toBeNull();
  });

  it("returns 'cadence' when the deadline has passed and something is pending", () => {
    const result = shouldTriggerRun(
      { cadence: "weekly", nextScheduledAt: new Date("2026-07-01T00:00:00Z"), threshold: 5, pendingCount: 1 },
      now
    );
    expect(result).toBe("cadence");
  });

  it("returns null when the cadence deadline has not passed and the threshold isn't met", () => {
    const result = shouldTriggerRun(
      { cadence: "weekly", nextScheduledAt: new Date("2026-07-20T00:00:00Z"), threshold: 5, pendingCount: 2 },
      now
    );
    expect(result).toBeNull();
  });

  it("returns 'threshold' when the pending count meets it, even if the cadence deadline hasn't passed", () => {
    const result = shouldTriggerRun(
      { cadence: "weekly", nextScheduledAt: new Date("2026-07-20T00:00:00Z"), threshold: 5, pendingCount: 5 },
      now
    );
    expect(result).toBe("threshold");
  });

  it("ignores nextScheduledAt entirely when cadence is 'none'", () => {
    const result = shouldTriggerRun(
      { cadence: "none", nextScheduledAt: new Date("2026-01-01T00:00:00Z"), threshold: 5, pendingCount: 3 },
      now
    );
    expect(result).toBeNull();
  });

  it("treats a null/zero threshold as 'threshold trigger disabled'", () => {
    const result = shouldTriggerRun(
      { cadence: "weekly", nextScheduledAt: new Date("2026-07-20T00:00:00Z"), threshold: null, pendingCount: 999 },
      now
    );
    expect(result).toBeNull();
  });
});

describe("advanceNextScheduledAt", () => {
  it("adds 1 day for daily", () => {
    expect(advanceNextScheduledAt(new Date("2026-07-13T00:00:00Z"), "daily")).toEqual(
      new Date("2026-07-14T00:00:00Z")
    );
  });

  it("adds 7 days for weekly", () => {
    expect(advanceNextScheduledAt(new Date("2026-07-13T00:00:00Z"), "weekly")).toEqual(
      new Date("2026-07-20T00:00:00Z")
    );
  });

  it("adds 14 days for biweekly", () => {
    expect(advanceNextScheduledAt(new Date("2026-07-13T00:00:00Z"), "biweekly")).toEqual(
      new Date("2026-07-27T00:00:00Z")
    );
  });

  it("adds 1 calendar month for monthly", () => {
    expect(advanceNextScheduledAt(new Date("2026-07-13T00:00:00Z"), "monthly")).toEqual(
      new Date("2026-08-13T00:00:00Z")
    );
  });

  it("skipping a run due tomorrow lands 8 days out on a weekly cadence, not 7 from today", () => {
    const dueTomorrow = new Date("2026-07-14T00:00:00Z"); // "now" is 2026-07-13
    expect(advanceNextScheduledAt(dueTomorrow, "weekly")).toEqual(new Date("2026-07-21T00:00:00Z"));
  });
});

describe("computeNextScheduledAt", () => {
  // Wed 2026-07-15 12:00 UTC (getUTCDay() === 3)
  const now = new Date("2026-07-15T12:00:00Z");

  it("daily: today at the hour if still ahead, else tomorrow", () => {
    expect(computeNextScheduledAt(now, "daily", { hour: 18 })).toEqual(
      new Date("2026-07-15T18:00:00Z")
    );
    expect(computeNextScheduledAt(now, "daily", { hour: 9 })).toEqual(
      new Date("2026-07-16T09:00:00Z")
    );
  });

  it("weekly: lands on the next occurrence of the target weekday at the hour", () => {
    // target Monday (1) — next Monday after Wed is 2026-07-20
    expect(computeNextScheduledAt(now, "weekly", { hour: 9, dayOfWeek: 1 })).toEqual(
      new Date("2026-07-20T09:00:00Z")
    );
    // target same weekday (Wed) but earlier hour → next Wednesday, not today
    expect(computeNextScheduledAt(now, "weekly", { hour: 9, dayOfWeek: 3 })).toEqual(
      new Date("2026-07-22T09:00:00Z")
    );
    // target same weekday, later hour → later today
    expect(computeNextScheduledAt(now, "weekly", { hour: 20, dayOfWeek: 3 })).toEqual(
      new Date("2026-07-15T20:00:00Z")
    );
  });

  it("monthly: uses the calendar day and rolls to next month when it has passed", () => {
    // day 20 this month is still ahead
    expect(computeNextScheduledAt(now, "monthly", { hour: 9, dayOfMonth: 20 })).toEqual(
      new Date("2026-07-20T09:00:00Z")
    );
    // day 10 already passed → next month
    expect(computeNextScheduledAt(now, "monthly", { hour: 9, dayOfMonth: 10 })).toEqual(
      new Date("2026-08-10T09:00:00Z")
    );
  });

  it("monthly: clamps a day-of-month beyond the month length", () => {
    // From Feb 2027, asking for day 31 → clamped to Feb 28
    const feb = new Date("2027-02-01T00:00:00Z");
    expect(computeNextScheduledAt(feb, "monthly", { hour: 9, dayOfMonth: 31 })).toEqual(
      new Date("2027-02-28T09:00:00Z")
    );
  });
});
