export type Cadence = "daily" | "weekly" | "biweekly" | "monthly" | "none";

export type ScheduleState = {
  cadence: Cadence;
  nextScheduledAt: Date | null;
  threshold: number | null;
  pendingCount: number;
};

export type TriggerReason = "cadence" | "threshold";

export function shouldTriggerRun(state: ScheduleState, now: Date): TriggerReason | null {
  if (state.pendingCount === 0) return null;

  const cadenceDue =
    state.cadence !== "none" && state.nextScheduledAt !== null && now.getTime() >= state.nextScheduledAt.getTime();
  if (cadenceDue) return "cadence";

  const thresholdMet =
    state.threshold !== null && state.threshold > 0 && state.pendingCount >= state.threshold;
  if (thresholdMet) return "threshold";

  return null;
}

export type ScheduleAnchor = {
  hour: number;
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
};

function clampInt(value: number, min: number, max: number, fallback: number): number {
  const n = Math.trunc(value);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function daysInUTCMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * The first scheduled run at/after `from` that matches the configured time-of-day
 * and (for weekly/monthly) day. All arithmetic is UTC. Subsequent runs advance
 * from this anchor via `advanceNextScheduledAt`, which preserves the hour and
 * weekday/day-of-month by adding whole days/months.
 */
export function computeNextScheduledAt(
  from: Date,
  cadence: Exclude<Cadence, "none">,
  anchor: ScheduleAnchor
): Date {
  const hour = clampInt(anchor.hour, 0, 23, 9);
  const next = new Date(from);
  next.setUTCHours(hour, 0, 0, 0);

  switch (cadence) {
    case "daily": {
      if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 1);
      return next;
    }
    case "weekly":
    case "biweekly": {
      const targetDow = clampInt(anchor.dayOfWeek ?? from.getUTCDay(), 0, 6, from.getUTCDay());
      // Step forward a day at a time (≤7 steps) until we land on the target
      // weekday strictly after `from`.
      let guard = 0;
      while ((next.getUTCDay() !== targetDow || next.getTime() <= from.getTime()) && guard < 8) {
        next.setUTCDate(next.getUTCDate() + 1);
        next.setUTCHours(hour, 0, 0, 0);
        guard++;
      }
      return next;
    }
    case "monthly": {
      const targetDom = clampInt(anchor.dayOfMonth ?? from.getUTCDate(), 1, 31, from.getUTCDate());
      const dim = daysInUTCMonth(next.getUTCFullYear(), next.getUTCMonth());
      next.setUTCDate(Math.min(targetDom, dim));
      next.setUTCHours(hour, 0, 0, 0);
      if (next.getTime() <= from.getTime()) {
        next.setUTCDate(1);
        next.setUTCMonth(next.getUTCMonth() + 1);
        const nextDim = daysInUTCMonth(next.getUTCFullYear(), next.getUTCMonth());
        next.setUTCDate(Math.min(targetDom, nextDim));
        next.setUTCHours(hour, 0, 0, 0);
      }
      return next;
    }
  }
}

export function advanceNextScheduledAt(current: Date, cadence: Exclude<Cadence, "none">): Date {
  const next = new Date(current);
  switch (cadence) {
    case "daily":
      next.setUTCDate(next.getUTCDate() + 1);
      break;
    case "weekly":
      next.setUTCDate(next.getUTCDate() + 7);
      break;
    case "biweekly":
      next.setUTCDate(next.getUTCDate() + 14);
      break;
    case "monthly":
      next.setUTCMonth(next.getUTCMonth() + 1);
      break;
  }
  return next;
}
