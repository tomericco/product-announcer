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

/**
 * The holiday label is a Badge, not hand-rolled markup — `data-slot="badge"`
 * is what the component itself stamps on every instance, so asserting on it
 * fails the moment someone swaps the pill back for a bare `<span>` with
 * badge-ish classes.
 */
describe("MonthGrid holiday tags", () => {
  function badgesIn(container: HTMLElement): HTMLElement[] {
    const days = container.querySelectorAll(".grid-cols-7")[1];
    return [...days.querySelectorAll('[data-slot="badge"]')] as HTMLElement[];
  }

  it("renders the holiday as a badge rather than a bare label", () => {
    const badges = badgesIn(grid(SUNDAY_MONTH, 0, [{ date: "2026-02-16", name: "Presidents' Day" }]));

    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toBe("Presidents' Day");
    expect(badges[0].dataset.variant).toBe("secondary");
  });

  it("renders one badge per holiday when two countries share a day", () => {
    const badges = badgesIn(
      grid(SUNDAY_MONTH, 0, [
        { date: "2026-02-16", name: "Presidents' Day" },
        { date: "2026-02-16", name: "Family Day" },
      ])
    );

    expect(badges.map((badge) => badge.textContent)).toEqual(["Presidents' Day", "Family Day"]);
  });

  it("renders no badge at all when there are no holidays", () => {
    // The day cells hold no other badge (piece cards do, but `pieces` is empty
    // in every case here), so this pins the tag to the holiday and nothing else.
    expect(badgesIn(grid(SUNDAY_MONTH, 0))).toHaveLength(0);
  });

  it("caps a long holiday name at the cell width and keeps the full text reachable", () => {
    // jsdom has no layout, so the guard is asserted structurally: the badge is
    // bounded by its cell (`max-w-full`) and ellipsised rather than allowed to
    // set the column's width, and the untruncated name stays in `title`.
    const name = "Independence Day (Yom HaAtzmaut)";
    const [badge] = badgesIn(grid(SUNDAY_MONTH, 0, [{ date: "2026-02-16", name }]));

    expect(badge.classList.contains("max-w-full")).toBe(true);
    expect(badge.querySelector(".truncate")).not.toBeNull();
    expect(badge.getAttribute("title")).toBe(name);
  });
});

/** The class the resting shade is carried by. Asserted directly because jsdom
 * renders no CSS: the class list IS the only evidence available here. */
const RESTING_SHADE = "bg-muted/40";

/**
 * The resting days, at their delivery point.
 *
 * `restingWeekdaysFor`/`isRestingDay` are pinned as pure functions in
 * tests/lib/content/calendar.test.ts. What those cannot see is that the grid
 * calls them with the workspace's own `weekStartsOn` — a grid that shaded the
 * right NUMBER of days in the wrong two columns keeps every unit test green.
 * Hence: assert per weekday column, never by counting.
 */
describe("MonthGrid resting days", () => {
  /**
   * Each in-month day cell's shaded-or-not, grouped under the weekday header
   * it actually sits below. Positional, from the rendered DOM: the days grid
   * is seven-wide, so index modulo 7 is the column, and `headerLabels` names
   * it. Leading blanks render no text and are skipped — they are not days.
   */
  function shadingByWeekday(container: HTMLElement): Record<string, boolean[]> {
    const labels = headerLabels(container);
    const days = container.querySelectorAll(".grid-cols-7")[1];
    const byWeekday: Record<string, boolean[]> = {};

    [...days.children].forEach((child, index) => {
      if (!(child.textContent ?? "").trim()) return;
      const label = labels[index % 7];
      (byWeekday[label] ??= []).push(child.classList.contains(RESTING_SHADE));
    });

    return byWeekday;
  }

  /** Which weekday columns are shaded, in header order — every cell in a
   * column must agree, or the column is reported neither way. */
  function restingColumns(container: HTMLElement): string[] {
    const byWeekday = shadingByWeekday(container);
    return headerLabels(container).filter((label) => {
      const cells = byWeekday[label];
      expect(cells?.length, `no day cells under ${label}`).toBeGreaterThan(0);
      expect(new Set(cells).size, `${label} is shaded inconsistently across the month`).toBe(1);
      return cells[0];
    });
  }

  it("Sunday start: shades Friday and Saturday", () => {
    expect(restingColumns(grid(SUNDAY_MONTH, 0))).toEqual(["Fri", "Sat"]);
  });

  it("Sunday start: does not shade Sunday", () => {
    expect(restingColumns(grid(SUNDAY_MONTH, 0))).not.toContain("Sun");
  });

  it("Monday start: shades Saturday and Sunday", () => {
    expect(restingColumns(grid(MONDAY_MONTH, 1))).toEqual(["Sat", "Sun"]);
  });

  it("Monday start: does not shade Friday", () => {
    expect(restingColumns(grid(MONDAY_MONTH, 1))).not.toContain("Fri");
  });

  it("follows the setting, not the month: the same month shades differently at each start", () => {
    // Both starts on ONE month, so nothing here can pass by accident of which
    // weekday the month happens to open on.
    expect(restingColumns(grid(SUNDAY_MONTH, 0))).toEqual(["Fri", "Sat"]);
    expect(restingColumns(grid(SUNDAY_MONTH, 1))).toEqual(["Sat", "Sun"]);
  });

  /**
   * The collision guard.
   *
   * This cell carries no other state today — there is no today, selected,
   * drag-target or outside-the-month treatment anywhere in the calendar (the
   * leading blanks are bare, borderless `<div>`s, and every real day renders
   * the identical `border border-border`). So the requested "a resting day
   * that is also today still reads as today" cannot be asserted: there is no
   * today to read.
   *
   * What CAN be pinned is the property that keeps it true when such a state
   * arrives: the shade adds a background and changes nothing else, leaving the
   * border, the ring and the type free for whatever claims them next. A shade
   * that swapped the border, or dropped a class, fails here.
   */
  it("adds a background and nothing else, leaving every other channel free", () => {
    const days = grid(SUNDAY_MONTH, 0).querySelectorAll(".grid-cols-7")[1];
    const cells = [...days.children] as HTMLElement[];
    // 2026-02 opens on a Sunday with no leading blanks, so index 5 is Friday
    // the 6th (resting) and index 1 is Monday the 2nd (not).
    const [working, resting] = [cells[1], cells[5]];
    const without = (cell: HTMLElement) => [...cell.classList].filter((c) => c !== RESTING_SHADE).sort();

    expect(resting.classList.contains(RESTING_SHADE)).toBe(true);
    expect(working.classList.contains(RESTING_SHADE)).toBe(false);
    expect(without(resting)).toEqual(without(working));
  });
});

describe("MonthGrid type scale", () => {
  it("keeps the month heading above the weekday header row", () => {
    const container = grid(SUNDAY_MONTH, 0);

    expect(container.querySelector("h2")?.className).toContain("text-lg");
    expect(container.querySelectorAll(".grid-cols-7")[0].className).toContain("text-sm");
  });

  it("sets the date numbers one step above the piece type labels", () => {
    const days = grid(SUNDAY_MONTH, 0).querySelectorAll(".grid-cols-7")[1];
    const dayNumber = [...days.children].find((child) => (child.textContent ?? "").trim() === "1");

    expect(dayNumber?.firstElementChild?.className).toContain("text-sm");
  });
});
