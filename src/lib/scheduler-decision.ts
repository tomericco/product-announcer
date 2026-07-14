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
