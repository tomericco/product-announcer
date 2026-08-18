import Holidays from "date-holidays";
import { HOLIDAY_COUNTRY_CODES, type CalendarHoliday } from "@/lib/workspace/calendar-settings";

/**
 * SERVER ONLY. `date-holidays` bundles the rule and translation data for every
 * country on earth; importing this module from a `"use client"` file would ship
 * all of it to the browser. The calendar's Server Component calls
 * `readMonthHolidays` and passes the plain `{ date, name }[]` result down as
 * props — the grid never imports this file. The country list and the
 * `CalendarHoliday` type live in `@/lib/workspace/calendar-settings`, which is
 * dependency-free, precisely so the settings UI can render its checkboxes
 * without reaching this module.
 *
 * Nothing here is persisted. `date-holidays` stores RULES in each calendar's
 * own terms — Israel's are Hebrew-calendar expressions like `"15 Nisan"` and
 * `"3 Tishrei if Saturday then next Sunday"` — and resolves them per year at
 * call time, which is why it still answers for 2040. Caching the resolved
 * output in our own table would trade that away for the stale-list problem the
 * rule source exists to avoid, so this recomputes per request.
 */

/**
 * The holiday's own local day, as `YYYY-MM-DD`.
 *
 * `getHolidays()` returns `date` as `"YYYY-MM-DD hh:mm:ss"` with an OPTIONAL
 * trailing offset — `"2027-03-26 00:00:00"` for GB, `"2026-04-02 00:00:00
 * -0600"` for IL. That offset is the library's, not the viewer's and not this
 * server's, and the leading date is already the day the holiday falls on in
 * its own country. So this takes the substring and stops.
 *
 * Do NOT route this through `new Date()`. An offset-less string is parsed as
 * LOCAL midnight, so reading UTC components back off it returns the previous
 * day anywhere east of Greenwich; a string that DOES carry an offset lands
 * wrong in the other direction far enough west. Both bugs are invisible on a
 * UTC machine, which is why the suite pins `TZ=Asia/Jerusalem` (see
 * vitest.setup.ts) and why tests/lib/content/holidays.test.ts asserts the GB
 * case specifically.
 */
export function localDayOf(raw: string): string {
  return raw.slice(0, 10);
}

/**
 * Every PUBLIC holiday landing in `month` (`"YYYY-MM"`) across the workspace's
 * enabled countries, merged and sorted by day.
 *
 * `countries` is filtered against the offered allow-list, so a stale or
 * hand-edited `holiday_countries` row can neither widen the calendar to a
 * country the UI never offered nor throw on a code `date-holidays` doesn't
 * know. Identical `date` + `name` pairs from two countries collapse to one —
 * Christmas Day should not be printed twice in a cell because both DE and GB
 * are ticked.
 */
export function readMonthHolidays(countries: readonly string[], month: string): CalendarHoliday[] {
  const enabled = HOLIDAY_COUNTRY_CODES.filter((code) => countries.includes(code));
  if (enabled.length === 0) return [];

  const year = Number(month.slice(0, 4));
  const seen = new Map<string, CalendarHoliday>();

  for (const code of enabled) {
    const calendar = new Holidays(code);
    // Israel's calendar answers in Hebrew by default; without this the grid
    // would label 2 April "פסח" instead of "Passover (Pesach)".
    calendar.setLanguages("en");

    for (const holiday of calendar.getHolidays(year)) {
      // `date-holidays` also carries bank, optional, school and observance
      // entries. Only actual public holidays belong on a publishing calendar.
      if (holiday.type !== "public") continue;

      const date = localDayOf(holiday.date);
      if (!date.startsWith(month)) continue;

      const name = String(holiday.name);
      seen.set(`${date}|${name}`, { date, name });
    }
  }

  return [...seen.values()].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}
