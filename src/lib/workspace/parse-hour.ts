/**
 * Parses a schedule hour (0-23) out of a form submission. Missing, empty,
 * non-numeric, and out-of-range input all fall back to a sane value rather
 * than failing the save: null/"" default to 9 (`scheduleConfigs.hour`'s own
 * default), and an out-of-range number clamps to the nearest bound.
 *
 * Shared by the settings and onboarding schedule-save actions so the two
 * call sites can't quietly disagree on how an empty `hour` field resolves.
 */
export function parseHour(raw: FormDataEntryValue | null): number {
  if (raw === null || raw === "") return 9;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 9;
  return Math.min(23, Math.max(0, Math.trunc(n)));
}
