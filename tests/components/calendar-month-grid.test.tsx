import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

/**
 * The week start and the holiday labels, at their delivery point.
 *
 * `leadingBlanksFor` and `rotateWeekdayLabels` are pinned as pure functions in
 * tests/lib/content/calendar.test.ts, and `readMonthHolidays` in
 * tests/lib/content/holidays.test.ts — but "the grid actually calls them, with
 * the workspace's setting, and the header row and the blanks agree with each
 * other" is a wiring property none of those can see. A grid that rotated its
 * header but not its blanks (or vice versa) would keep every one of those
 * green while rendering every date under the wrong weekday.
 *
 * `useRouter` is mocked because `MonthGrid` reads it for the defaulted-month
 * correction; `isDefaulted` is false in every case here, so the effect returns
 * before touching it.
 */
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/calendar",
}));

import { MonthGrid } from "../../src/app/(dashboard)/calendar/month-grid";

// 2026-02 begins on a Sunday, 2026-06 on a Monday — the two month boundaries
// where a wrong rotation is off by six columns rather than by one.
const SUNDAY_MONTH = "2026-02";
const MONDAY_MONTH = "2026-06";

function grid(month: string, weekStartsOn: 0 | 1, holidays: { date: string; name: string }[] = []) {
  const { container } = render(
    <MonthGrid
      month={month}
      isDefaulted={false}
      pieces={[]}
      undatedPublished={0}
      weekStartsOn={weekStartsOn}
      holidays={holidays}
    />
  );
  return container;
}

/** The weekday header row, in render order. */
function headerLabels(container: HTMLElement): string[] {
  const row = container.querySelectorAll(".grid-cols-7")[0];
  return [...row.children].map((child) => child.textContent?.trim() ?? "");
}

/**
 * How many empty cells precede day 1. Counted from the DOM rather than from a
 * test-only attribute: a leading blank renders no text, a day cell always
 * renders its number, so the index of the "1" cell IS the blank count.
 */
function leadingBlanks(container: HTMLElement): number {
  const days = container.querySelectorAll(".grid-cols-7")[1];
  return [...days.children].findIndex((child) => (child.textContent ?? "").trim().startsWith("1"));
}

describe("MonthGrid week start", () => {
  it("renders a Sunday-first header row for a Sunday start", () => {
    expect(headerLabels(grid(SUNDAY_MONTH, 0))).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
  });

  it("renders a Monday-first header row for a Monday start", () => {
    expect(headerLabels(grid(MONDAY_MONTH, 1))).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  });

  it("Sunday start: a month beginning on a Sunday opens in the first column", () => {
    expect(leadingBlanks(grid(SUNDAY_MONTH, 0))).toBe(0);
  });

  it("Sunday start: a month beginning on a Monday opens in the second column", () => {
    expect(leadingBlanks(grid(MONDAY_MONTH, 0))).toBe(1);
  });

  it("Monday start: a month beginning on a Monday opens in the first column", () => {
    expect(leadingBlanks(grid(MONDAY_MONTH, 1))).toBe(0);
  });

  it("Monday start: a month beginning on a Sunday opens in the LAST column", () => {
    // The case the old hardcoded `getDay()` gets wrong, and the one a naive
    // `getDay() - weekStartsOn` gets wrong in the opposite direction.
    expect(leadingBlanks(grid(SUNDAY_MONTH, 1))).toBe(6);
  });

  it("keeps the 1st under the header cell its weekday actually names, at both starts", () => {
    for (const [month, weekStartsOn, weekday] of [
      [SUNDAY_MONTH, 0, "Sun"],
      [SUNDAY_MONTH, 1, "Sun"],
      [MONDAY_MONTH, 0, "Mon"],
      [MONDAY_MONTH, 1, "Mon"],
    ] as const) {
      const container = grid(month, weekStartsOn);
      expect(headerLabels(container)[leadingBlanks(container)]).toBe(weekday);
    }
  });
});

describe("MonthGrid holiday labels", () => {
  it("labels the day the holiday falls on", () => {
    const container = grid(SUNDAY_MONTH, 0, [{ date: "2026-02-16", name: "Presidents' Day" }]);
    const days = container.querySelectorAll(".grid-cols-7")[1];
    const cell = [...days.children].find((child) => (child.textContent ?? "").includes("Presidents' Day"));

    expect(cell).toBeDefined();
    expect(cell?.textContent?.trim().startsWith("16")).toBe(true);
  });

  it("labels nothing when the workspace has no holiday countries", () => {
    expect(grid(SUNDAY_MONTH, 0).textContent).not.toContain("Presidents' Day");
  });

  it("shows both names when two countries land a holiday on the same day", () => {
    const container = grid(SUNDAY_MONTH, 0, [
      { date: "2026-02-16", name: "Presidents' Day" },
      { date: "2026-02-16", name: "Family Day" },
    ]);

    expect(container.textContent).toContain("Presidents' Day");
    expect(container.textContent).toContain("Family Day");
  });

  it("ignores a holiday that belongs to another month", () => {
    expect(grid(SUNDAY_MONTH, 0, [{ date: "2026-03-16", name: "Nowhere Day" }]).textContent).not.toContain(
      "Nowhere Day"
    );
  });
});
