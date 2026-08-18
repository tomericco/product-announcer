import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
// The server pass, which `render()` can never show: @testing-library/react
// mounts with `createRoot`, so `useSyncExternalStore` reads `getSnapshot()`
// and the tree is already "hydrated" on its very first pass. react-dom/server
// is the only way to observe what the server actually emits — see the
// "MonthGrid today" describe at the foot of this file.
import { renderToStaticMarkup, renderToString } from "react-dom/server";

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

/**
 * Today's two treatments, as the classes that carry them. jsdom renders no
 * CSS, so — exactly as with `RESTING_SHADE` above — the class list IS the
 * only evidence available. Two constants, not one, because the brief asks
 * for two independent things: a highlight on the CELL and a marker on the
 * date NUMBER. A change that delivered only one of them must fail.
 */
const TODAY_CELL_HIGHLIGHT = ["ring-2", "ring-primary"];
const TODAY_NUMBER_MARKER = ["rounded-full", "bg-primary"];

/**
 * Today, at its delivery point.
 *
 * `todayDayNumberIn` is pinned as a pure function in
 * tests/lib/content/calendar.test.ts. What only this file can see is that the
 * grid calls it with the month ACTUALLY ON SCREEN, behind the same hydration
 * gate as the leading blanks, and that the two treatments compose with the
 * resting shade instead of replacing it.
 *
 * ## How "now" is controlled, and why it isn't timezone-luck
 *
 * `vi.useFakeTimers({ toFake: ["Date"] })` + `vi.setSystemTime(...)` — the
 * mechanism already used in tests/app/propose-actions.test.ts and every
 * poller test under tests/components.
 *
 * The instant is always built with `localNoon()`: local calendar components
 * in, local calendar components out. `new Date(2026, 1, 16, 12)` is noon on
 * 16 February in whatever zone the runtime happens to be in, and reading
 * `.getDate()` back off it returns 16 in that same zone — midday, so no
 * offset change (DST, a historical zone revision) can push it across a
 * midnight. Nothing here depends on the node project's `TZ=Asia/Jerusalem`
 * pin, which the jsdom project does not even apply: run this file under
 * `TZ=UTC` or `TZ=Pacific/Auckland` and it asserts the identical thing. A
 * literal like `new Date("2026-02-16T00:00:00Z")` would NOT have that
 * property — it is 16 February in Jerusalem and 15 February in Los Angeles,
 * which is precisely the trap that moved the US/DE/GB holidays a day in the
 * earlier work.
 */
describe("MonthGrid today", () => {
  /** Noon on a local calendar date — see the block comment above. */
  function localNoon(year: number, monthIndex: number, day: number): Date {
    return new Date(year, monthIndex, day, 12, 0, 0, 0);
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Every in-month day cell (the leading blanks render no text). */
  function dayCells(container: HTMLElement): HTMLElement[] {
    const days = container.querySelectorAll(".grid-cols-7")[1];
    return [...days.children].filter((child) => (child.textContent ?? "").trim()) as HTMLElement[];
  }

  /** The cell whose date number is exactly `day`. */
  function cellForDay(container: HTMLElement, day: number): HTMLElement {
    const cell = dayCells(container).find(
      (child) => child.firstElementChild?.textContent?.trim() === String(day)
    );
    expect(cell, `no cell rendering day ${day}`).toBeDefined();
    return cell as HTMLElement;
  }

  /** Treatment 1: the cell itself. */
  function cellIsHighlighted(cell: HTMLElement): boolean {
    return TODAY_CELL_HIGHLIGHT.every((cls) => cell.classList.contains(cls));
  }

  /** Treatment 2: the date number inside it. */
  function numberIsMarked(cell: HTMLElement): boolean {
    const number = cell.firstElementChild as HTMLElement;
    return TODAY_NUMBER_MARKER.every((cls) => number.classList.contains(cls));
  }

  it("highlights today's cell and marks its date number", () => {
    vi.setSystemTime(localNoon(2026, 1, 16));
    const cell = cellForDay(grid(SUNDAY_MONTH, 0), 16);

    // Asserted separately, not as one "the cell looks different" check: the
    // brief asked for both, so delivering either alone must fail here.
    expect(cellIsHighlighted(cell)).toBe(true);
    expect(numberIsMarked(cell)).toBe(true);
  });

  it("leaves every other day of the same month untouched", () => {
    vi.setSystemTime(localNoon(2026, 1, 16));
    const container = grid(SUNDAY_MONTH, 0);

    const others = dayCells(container).filter(
      (cell) => cell.firstElementChild?.textContent?.trim() !== "16"
    );
    expect(others.length).toBe(27); // 2026-02 has 28 days
    expect(others.some(cellIsHighlighted)).toBe(false);
    expect(others.some(numberIsMarked)).toBe(false);
  });

  it("marks nothing when the month on screen is not the current one", () => {
    // Today is 16 February; the grid is showing March, which has a 16th of
    // its own. A treatment keyed on the day number alone lights it up.
    vi.setSystemTime(localNoon(2026, 1, 16));
    const container = grid("2026-03", 0);

    expect(dayCells(container).some(cellIsHighlighted)).toBe(false);
    expect(dayCells(container).some(numberIsMarked)).toBe(false);
  });

  it("marks nothing in the same month of a different year", () => {
    // The check that compares month-of-year and forgets the year passes every
    // other case in this describe and fails this one.
    vi.setSystemTime(localNoon(2025, 1, 16));
    const container = grid(SUNDAY_MONTH, 0);

    expect(dayCells(container).some(cellIsHighlighted)).toBe(false);
    expect(dayCells(container).some(numberIsMarked)).toBe(false);
  });

  /**
   * The collision the resting-day test above could only describe in a comment,
   * because until now there was no today to collide with.
   *
   * 2026-02 opens on a Sunday, so at a Sunday start Friday the 6th is a
   * resting day. Each treatment is asserted on its own channel — background,
   * cell highlight, number marker — rather than by counting classes, so a
   * today treatment that overwrote the shade (or a shade that swallowed the
   * highlight) fails on the specific channel it clobbered.
   */
  it("reads as BOTH when today is also a resting day", () => {
    vi.setSystemTime(localNoon(2026, 1, 6));
    const cell = cellForDay(grid(SUNDAY_MONTH, 0), 6);

    expect(cell.classList.contains(RESTING_SHADE)).toBe(true);
    expect(cellIsHighlighted(cell)).toBe(true);
    expect(numberIsMarked(cell)).toBe(true);
  });

  it("still marks today on a working day, so the resting case proves composition", () => {
    // The control for the test above: without it, "both" could be passing
    // because the highlight is unconditional rather than because it composes.
    vi.setSystemTime(localNoon(2026, 1, 2)); // Monday the 2nd
    const cell = cellForDay(grid(SUNDAY_MONTH, 0), 2);

    expect(cell.classList.contains(RESTING_SHADE)).toBe(false);
    expect(cellIsHighlighted(cell)).toBe(true);
    expect(numberIsMarked(cell)).toBe(true);
  });

  /**
   * The hydration gate, from the only angle that can see it.
   *
   * `render()` from @testing-library/react mounts with `createRoot`, so
   * `useSyncExternalStore` reads `getSnapshot()` and `hydrated` is true on the
   * very first pass — every test above is a post-hydration view. The server
   * pass is reachable only through react-dom/server, which is what makes this
   * the one place the gate is observable at all.
   *
   * Today is viewer-local; the server does not know the viewer's date. If it
   * renders one anyway it is showing ITS today to everyone, and React's first
   * client pass disagrees. So: nothing marked server-side, exactly as
   * `leadingBlanks` is 0 server-side.
   */
  it("marks nothing in the server render, so the first client pass agrees", () => {
    vi.setSystemTime(localNoon(2026, 1, 16));
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <MonthGrid
        month={SUNDAY_MONTH}
        isDefaulted={false}
        pieces={[]}
        undatedPublished={0}
        weekStartsOn={0}
        holidays={[]}
      />
    );

    // The 16th is on screen — this is the same clock and the same month the
    // first test in this describe marks — and it is not marked.
    expect(dayCells(container)).toHaveLength(28);
    expect(dayCells(container).some(cellIsHighlighted)).toBe(false);
    expect(dayCells(container).some(numberIsMarked)).toBe(false);
  });

  it("hydrates that markup with no mismatch, then marks today", async () => {
    vi.setSystemTime(localNoon(2026, 1, 16));
    const element = (
      <MonthGrid
        month={SUNDAY_MONTH}
        isDefaulted={false}
        pieces={[]}
        undatedPublished={0}
        weekStartsOn={0}
        holidays={[]}
      />
    );

    const container = document.createElement("div");
    document.body.appendChild(container);
    container.innerHTML = renderToString(element);

    const recovered: unknown[] = [];
    const root = await act(async () =>
      hydrateRoot(container, element, { onRecoverableError: (error) => recovered.push(error) })
    );

    // A hydration mismatch is a recoverable error, not a throw — React repaints
    // from the nearest boundary and carries on. Asserting on the count is the
    // only way to notice.
    expect(recovered).toEqual([]);
    expect(cellIsHighlighted(cellForDay(container, 16))).toBe(true);
    expect(numberIsMarked(cellForDay(container, 16))).toBe(true);

    await act(async () => root.unmount());
    container.remove();
  });
});
