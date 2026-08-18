// The client-safe half of `@/lib/content/calendar`, split into its own file
// with NO import of `@/db` (or anything that pulls in `pg`/drizzle).
//
// `bucketByLocalDay` must run in the browser — that's the whole reason
// Task 1 split it out of `readMonth` in the first place: "local day" means
// local to the viewer, and only the browser knows that timezone. But
// `calendar.ts` also has `readMonth`, which imports `db` at module scope.
// Next's client bundler does not tree-shake unused named exports away from
// a shared local module — importing ANY name from `calendar.ts` into a
// "use client" file pulls the whole module graph (including `pg`, `net`,
// `tls`) into the browser bundle and fails `npm run build`. This file is
// the fix: it holds nothing but pure, dependency-free code, so a client
// component can import it without touching `db`.
//
// `calendar.ts` does NOT re-export these — that re-export used to exist
// purely so the test file could import everything from one path, but it made
// `@/lib/content/calendar` (the safe-looking path) the one that reintroduces
// the exact `pg`/`net`/`tls` leak this split exists to prevent. Import the
// pure members (this file) and `readMonth` (`calendar.ts`) from their own
// paths — the two-import cost is what keeps the leak from being one typo
// away.
//
// `resolveMonth`, `isValidMonthParam`, and `shiftMonth` live here too, not in
// the route files that used to hold them unexported: they're pure
// year/month arithmetic with no route dependency, so they belong beside
// `monthRangeUtc` — and being unexported was the reason they had no direct
// test coverage at all.

import type { WeekStartsOn } from "@/lib/workspace/calendar-settings";

export const CALENDAR_TYPES = ["product_update", "blog_post", "social_post"] as const;
export type CalendarType = (typeof CALENDAR_TYPES)[number];

export type CalendarPiece = {
  id: string;
  title: string;
  type: CalendarType;
  status: "scheduled" | "published";
  at: Date; // scheduledFor for scheduled, publishedAt for published
};

export type CalendarMonth = { pieces: CalendarPiece[]; undatedPublished: number };

export type CalendarDay = { key: string; pieces: Record<CalendarType, CalendarPiece[]> };

// Parses "YYYY-MM" and returns the UTC instant one day before the month's
// first and one day after its last. Built directly from Date.UTC (not
// date-fns' local-time helpers like startOfMonth/addDays) because this must
// return the same instants no matter what timezone the server process runs
// in — Date.UTC ignores the runtime's local zone, while date-fns' calendar
// helpers read and write through local getters/setters and would drift.
export function monthRangeUtc(month: string): { from: Date; to: Date } {
  const [year, monthNum] = month.split("-").map(Number);
  const monthIndex = monthNum - 1;

  // Date.UTC rolls month overflow into the year correctly (e.g. December + 1
  // becomes January of the next year), so no separate year-boundary handling
  // is needed here.
  const monthStart = Date.UTC(year, monthIndex, 1);
  const nextMonthStart = Date.UTC(year, monthIndex + 1, 1);

  const oneDayMs = 24 * 60 * 60 * 1000;
  return {
    from: new Date(monthStart - oneDayMs),
    to: new Date(nextMonthStart + oneDayMs),
  };
}

// Runs in the browser, where the local timezone is real. Builds every day of
// the month up front (with all three type lanes present and empty) and then
// places each piece on the LOCAL day its `Date` reports — never the UTC one
// — discarding anything that lands outside the month once bucketed locally.
export function bucketByLocalDay(pieces: CalendarPiece[], month: string): CalendarDay[] {
  const [year, monthNum] = month.split("-").map(Number);
  const monthIndex = monthNum - 1;

  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();

  const emptyLanes = (): Record<CalendarType, CalendarPiece[]> => ({
    product_update: [],
    blog_post: [],
    social_post: [],
  });

  const days: CalendarDay[] = [];
  const dayByKey = new Map<string, CalendarDay>();
  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${year}-${String(monthNum).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const calendarDay: CalendarDay = { key, pieces: emptyLanes() };
    days.push(calendarDay);
    dayByKey.set(key, calendarDay);
  }

  for (const piece of pieces) {
    const localKey = `${piece.at.getFullYear()}-${String(piece.at.getMonth() + 1).padStart(2, "0")}-${String(
      piece.at.getDate()
    ).padStart(2, "0")}`;
    const calendarDay = dayByKey.get(localKey);
    if (!calendarDay) continue; // outside the month once bucketed locally
    calendarDay.pieces[piece.type].push(piece);
  }

  // `readMonth`'s query has no ORDER BY (rows arrive in Postgres heap order,
  // which can change between identical reloads), and every card in a lane
  // shows its time — so an unsorted lane can render 21:00 above 09:00 with
  // nothing to explain why. This is the one place that can fix it once: every
  // piece for every day funnels through here regardless of source query.
  for (const day of days) {
    for (const type of CALENDAR_TYPES) {
      day.pieces[type].sort((a, b) => a.at.getTime() - b.at.getTime());
    }
  }

  return days;
}

const MONTH_PARAM_RE = /^\d{4}-\d{2}$/;

/**
 * True only for a `"YYYY-MM"` string that is both well-formed and names a
 * real calendar month (`01`-`12`). Shared by `resolveMonth` (what to fall
 * back to) and the route (whether a fallback happened at all, which is what
 * decides whether the viewer's own clock gets a say — see `resolveMonth`'s
 * comment).
 */
export function isValidMonthParam(raw: string | undefined): raw is string {
  if (!raw || !MONTH_PARAM_RE.test(raw)) return false;
  const monthNum = Number(raw.slice(5, 7));
  return monthNum >= 1 && monthNum <= 12;
}

/**
 * Falls back to `now`'s month for anything that isn't a clean `YYYY-MM` in
 * range — absent, malformed (`?month=nonsense`), out-of-range
 * (`?month=2026-13`), or repeated (`?month=a&month=b`, where `single()`
 * already collapses to the first value before this runs). A bad query string
 * is a navigation mistake, not an error condition, so this never throws.
 *
 * `now` defaults to the caller's clock. The route calls this once on the
 * server (server-local `now`, just to have *something* to query with on the
 * first paint) and the client corrects it afterwards if it guessed wrong —
 * see `month-grid.tsx`'s effect, which redoes this exact fallback against
 * the viewer's own clock and navigates to the right month when the two
 * disagree. "Local day" means local to the viewer everywhere else in this
 * feature; a defaulted month is no exception.
 */
export function resolveMonth(raw: string | undefined, now: Date = new Date()): string {
  if (isValidMonthParam(raw)) return raw;
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Shifts a `"YYYY-MM"` month by `delta` months, crossing year boundaries
 * (`2026-12` + 1 -> `2027-01`, `2026-01` - 1 -> `2025-12`). Built on
 * `Date.UTC`, the same trick `monthRangeUtc` uses: UTC month overflow rolls
 * into the year on its own, and UTC math never reads the runtime's local
 * zone, so this produces the same answer on the server pass and every
 * client — no hydration gate needed for prev/next links.
 */
export function shiftMonth(month: string, delta: number): string {
  const [year, monthNum] = month.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, monthNum - 1 + delta, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The weekday header row, rotated to open on the workspace's configured first
 * day. Pure and identical on server and client — it depends only on a prop, not
 * on a clock or a zone — so unlike the grid's contents it needs no hydration
 * gate.
 */
export function rotateWeekdayLabels(weekStartsOn: WeekStartsOn): string[] {
  return [...WEEKDAY_LABELS.slice(weekStartsOn), ...WEEKDAY_LABELS.slice(0, weekStartsOn)];
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * How many empty cells precede the 1st, so it lands under the header column its
 * weekday actually names.
 *
 * The `+ 7` before the modulo is the whole point: `getDay()` counts from Sunday,
 * so a Monday-start month that begins on a Sunday gives `0 - 1 = -1`, and
 * `Array.from({ length: -1 })` renders NO blanks rather than six — silently
 * shifting the entire month one column left with nothing on screen to explain
 * it. The modulo folds it back to 6.
 *
 * Reads local components on purpose: which weekday a date falls on is a local
 * question, and the grid's caller gates this behind hydration for exactly the
 * reason its `bucketByLocalDay` call is gated — see `month-grid.tsx`.
 */
export function leadingBlanksFor(month: string, weekStartsOn: WeekStartsOn): number {
  const [year, monthNum] = month.split("-").map(Number);
  return (new Date(year, monthNum - 1, 1).getDay() - weekStartsOn + 7) % 7;
}
