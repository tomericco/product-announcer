import { and, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { contentPieces } from "@/db/schema";
import { monthRangeUtc, type CalendarMonth, type CalendarPiece } from "./calendar-view";

type Database = typeof defaultDb;

// `CALENDAR_TYPES`, the `Calendar*` types, `monthRangeUtc`, `bucketByLocalDay`,
// `resolveMonth`, `isValidMonthParam`, and `shiftMonth` all live in
// `./calendar-view`, which has no `@/db` import — see that file's header
// comment for why the split exists (a client component must be able to
// import the pure pieces without pulling `pg`/`net`/`tls` into the browser
// bundle). Deliberately NOT re-exported here — import them from
// `./calendar-view` directly. A re-export used to sit here so the test file
// could pull everything from one path, but that made this module (the
// safe-looking `@/lib/content/calendar` path) the one that reintroduces the
// leak the split exists to prevent.
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
