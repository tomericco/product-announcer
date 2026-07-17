import { intervalToDuration, formatDuration, type Duration } from "date-fns";

/**
 * A human "in 5 days and 1 hour"-style label for an upcoming time, using the two
 * largest non-zero units. Returns "now" if the target is already in the past and
 * "in less than a minute" when it's under a minute away.
 */
export function formatScheduleDistance(target: Date, now: Date = new Date()): string {
  if (target.getTime() <= now.getTime()) return "now";

  const duration = intervalToDuration({ start: now, end: target });
  const order: (keyof Duration)[] = ["years", "months", "days", "hours", "minutes"];
  const units = order.filter((u) => (duration[u] ?? 0) > 0).slice(0, 2);

  if (units.length === 0) return "in less than a minute";

  return `in ${formatDuration(duration, { format: units, delimiter: " and " })}`;
}
