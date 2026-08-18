import { describe, it, expect } from "vitest";
import { localDayOf, readMonthHolidays } from "../../../src/lib/content/holidays";

/**
 * `date-holidays` is a RULE source, not a date list: it stores each calendar's
 * own expressions (`"15 Nisan"`, `"easter -2"`) and resolves them per year at
 * runtime. Nothing here is cached in our database — the point of a rule source
 * is that it keeps being right in 2040, and persisting its output would
 * reinvent the stale-list problem it exists to avoid.
 *
 * Two things this file pins that nothing else can:
 *
 * 1. The date extraction, under the suite's `TZ=Asia/Jerusalem` pin (see
 *    vitest.setup.ts). `getHolidays()` hands back `date` strings like
 *    `"2027-03-26 00:00:00"` (GB) and `"2026-04-02 00:00:00 -0600"` (IL) —
 *    the leading `YYYY-MM-DD` is the holiday's day IN ITS OWN COUNTRY, and
 *    the trailing offset (when present at all) is not the viewer's. Feeding
 *    the whole string to `new Date()` and reading components back off it
 *    lands a holiday a day early: the GB assertions below are the ones that
 *    catch it, because an offset-less string is parsed as LOCAL midnight and
 *    so falls on the previous UTC day in any zone east of Greenwich.
 *
 * 2. Canaries on three known-correct dates, so a bad dependency bump fails
 *    loudly here instead of silently sliding a holiday by a day on the
 *    calendar, where nobody would notice for a year.
 */

const MONTHS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));

function forYear(countries: string[], year: number) {
  return MONTHS.flatMap((mm) => readMonthHolidays(countries, `${year}-${mm}`));
}

describe("localDayOf", () => {
  it("takes the leading YYYY-MM-DD and ignores the trailing offset", () => {
    expect(localDayOf("2026-04-02 00:00:00 -0600")).toBe("2026-04-02");
  });

  it("handles a date string that carries no offset at all", () => {
    expect(localDayOf("2027-03-26 00:00:00")).toBe("2027-03-26");
  });

  it("does not round-trip through Date — the tests run pinned off UTC", () => {
    // Documents the trap rather than trusting it stays theoretical: this is
    // what the naive implementation would produce for the same input under
    // this suite's TZ pin, and it is a day early.
    expect(process.env.TZ).toBe("Asia/Jerusalem");
    expect(new Date("2027-03-26 00:00:00").toISOString().slice(0, 10)).toBe("2027-03-25");
    expect(localDayOf("2027-03-26 00:00:00")).toBe("2027-03-26");
  });
});

describe("readMonthHolidays canaries", () => {
  it("puts Passover 2026 on 2 April", () => {
    const days = readMonthHolidays(["IL"], "2026-04");
    expect(days.find((h) => h.name.includes("Pesach"))?.date).toBe("2026-04-02");
  });

  it("puts Yom HaAtzmaut 2027 on 12 May", () => {
    const days = readMonthHolidays(["IL"], "2027-05");
    expect(days.find((h) => h.name.includes("Yom HaAtzmaut"))?.date).toBe("2027-05-12");
  });

  it("puts Good Friday 2027 (GB) on 26 March", () => {
    const days = readMonthHolidays(["GB"], "2027-03");
    expect(days.find((h) => h.name === "Good Friday")?.date).toBe("2027-03-26");
  });
});

describe("readMonthHolidays", () => {
  it("returns nothing when no country is enabled", () => {
    expect(readMonthHolidays([], "2026-04")).toEqual([]);
  });

  it("merges two enabled countries into one list", () => {
    const il = readMonthHolidays(["IL"], "2026-04");
    const gb = readMonthHolidays(["GB"], "2026-04");
    const both = readMonthHolidays(["IL", "GB"], "2026-04");

    expect(il.length).toBeGreaterThan(0);
    expect(gb.length).toBeGreaterThan(0);
    for (const holiday of [...il, ...gb]) {
      expect(both).toContainEqual(holiday);
    }
  });

  it("keeps only the requested month", () => {
    for (const holiday of readMonthHolidays(["US", "DE"], "2026-12")) {
      expect(holiday.date.startsWith("2026-12")).toBe(true);
    }
  });

  it("ignores a country code the workspace is not allowed to pick", () => {
    // Guards the DB round-trip: a stale or hand-edited `holiday_countries`
    // row must not silently widen the calendar to a country the UI never
    // offered, and must never throw on an unknown code either.
    expect(readMonthHolidays(["ZZ"], "2026-04")).toEqual([]);
    expect(readMonthHolidays(["FR"], "2026-04")).toEqual([]);
  });

  it("counts only public holidays, at the verified 2026 totals", () => {
    // `date-holidays` also carries bank/optional/school/observance entries;
    // these totals are the `public` ones only, so widening the filter fails.
    expect(forYear(["IL"], 2026)).toHaveLength(9);
    expect(forYear(["US"], 2026)).toHaveLength(12);
    expect(forYear(["DE"], 2026)).toHaveLength(9);
    expect(forYear(["GB"], 2026)).toHaveLength(8);
  });

  it("names Israeli holidays in English, not Hebrew", () => {
    // Israel's calendar defaults to Hebrew names; the lookup has to call
    // setLanguages("en") for anything readable to reach the grid.
    const names = forYear(["IL"], 2026).map((h) => h.name);
    expect(names).toContain("Passover (Pesach)");
  });

  it("sorts by day so the grid can consume it in order", () => {
    const dates = forYear(["IL", "US", "DE", "GB"], 2026).map((h) => h.date);
    expect([...dates].sort()).toEqual(dates);
  });
});
