// The vocabulary of the two workspace calendar settings — week start and
// holiday countries — and nothing else.
//
// Deliberately dependency-free, and deliberately NOT in
// `@/lib/content/holidays`: that module imports `date-holidays`, which carries
// a large rule/data payload and must never reach the browser bundle. The
// settings UI is a Client Component and needs the country list to render its
// checkboxes, so the list lives here where a `"use client"` file can import it
// without dragging the holiday engine along. Same split, same reason, as
// `calendar-view.ts` vs `calendar.ts` — see that file's header.

/** 0 = Sunday, 1 = Monday. Matches `Date#getDay()`'s numbering. */
export type WeekStartsOn = 0 | 1;

export const WEEK_START_OPTIONS: readonly { value: WeekStartsOn; label: string }[] = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
];

/**
 * The countries the workspace may switch on, in the order the UI offers them.
 * This array is the allow-list: `parseHolidayCountries` filters submissions
 * against it, and `readMonthHolidays` filters again on the way out, so a row
 * that somehow holds a code this list doesn't (a hand-edited database, an
 * older deploy) widens nothing.
 */
export const HOLIDAY_COUNTRIES: readonly { code: string; label: string }[] = [
  { code: "IL", label: "Israel" },
  { code: "US", label: "United States" },
  { code: "DE", label: "Germany" },
  { code: "GB", label: "United Kingdom" },
];

export const HOLIDAY_COUNTRY_CODES: readonly string[] = HOLIDAY_COUNTRIES.map((c) => c.code);

/** One holiday, already reduced to the local day the grid places it on. */
export type CalendarHoliday = {
  /** `YYYY-MM-DD`, the holiday's day in its own country. Never an instant. */
  date: string;
  name: string;
};

/**
 * Coerces anything (a `FormData` value, a database column read back, a query
 * string) to a real week start. Falls back to Sunday — the column default, and
 * the behaviour the grid had before the setting existed — rather than throwing:
 * a bad value here is a stale form or a hand-edited row, not an error worth
 * failing a page render over.
 */
export function normalizeWeekStart(raw: unknown): WeekStartsOn {
  const value = typeof raw === "number" ? raw : Number(raw);
  return value === 1 ? 1 : 0;
}

/**
 * Filters submitted country codes down to the offered ones, deduplicated and
 * re-ordered to match `HOLIDAY_COUNTRIES`. Ordering by the allow-list (rather
 * than by arrival) means the stored array is stable no matter which order the
 * checkboxes were ticked in, so two identical selections compare equal.
 */
export function parseHolidayCountries(raw: readonly unknown[]): string[] {
  const submitted = new Set(raw.map((value) => String(value)));
  return HOLIDAY_COUNTRY_CODES.filter((code) => submitted.has(code));
}
