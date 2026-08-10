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
// `calendar.ts` re-exports every name below unchanged, so `readMonth` (and
// existing test imports from `@/lib/content/calendar`) see no difference —
// this is a file-organization change only, not an interface change.

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

  return days;
}
