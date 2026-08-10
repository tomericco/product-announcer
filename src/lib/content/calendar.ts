import { and, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { contentPieces } from "@/db/schema";

type Database = typeof defaultDb;

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

export async function readMonth(
  tenantId: string,
  month: string,
  database: Database = defaultDb
): Promise<CalendarMonth> {
  const { from, to } = monthRangeUtc(month);

  // A scheduled piece is placed by scheduledFor and a published one by
  // publishedAt — never the other's. A piece that was scheduled and later
  // published carries both columns, so the status branch (not a coalesce)
  // decides which column is authoritative for that row.
  const rows = await database
    .select({
      id: contentPieces.id,
      title: contentPieces.title,
      type: contentPieces.type,
      status: contentPieces.status,
      scheduledFor: contentPieces.scheduledFor,
      publishedAt: contentPieces.publishedAt,
    })
    .from(contentPieces)
    .where(
      and(
        eq(contentPieces.tenantId, tenantId),
        or(
          and(
            eq(contentPieces.status, "scheduled"),
            gte(contentPieces.scheduledFor, from),
            lt(contentPieces.scheduledFor, to)
          ),
          and(
            eq(contentPieces.status, "published"),
            gte(contentPieces.publishedAt, from),
            lt(contentPieces.publishedAt, to)
          )
        )
      )
    );

  const pieces: CalendarPiece[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    type: row.type,
    status: row.status as "scheduled" | "published",
    at: (row.status === "scheduled" ? row.scheduledFor : row.publishedAt) as Date,
  }));

  // Published pieces with no publishedAt have no date the calendar can place
  // them on. Dropping them silently would understate coverage, which is the
  // one thing this view measures, so they're counted instead — across the
  // whole tenant, not scoped to this month, since they have no month to
  // belong to.
  const [{ count: undatedPublished }] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(contentPieces)
    .where(
      and(eq(contentPieces.tenantId, tenantId), eq(contentPieces.status, "published"), isNull(contentPieces.publishedAt))
    );

  return { pieces, undatedPublished };
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
