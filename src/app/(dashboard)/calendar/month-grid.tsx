"use client";

import Link from "next/link";
import { useMemo, useSyncExternalStore } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
// Imported from `@/lib/content/calendar-view`, NOT `@/lib/content/calendar`.
// `calendar.ts` imports `@/db` at module scope (for `readMonth`); Next's
// client bundler does not tree-shake unused exports away from a shared
// local module, so importing anything — even just `bucketByLocalDay` and
// `CALENDAR_TYPES` — from `calendar.ts` into this "use client" file pulls
// the whole module graph (`pg`, `net`, `tls`) into the browser bundle and
// fails `npm run build`. `calendar-view.ts` is the db-free split of the
// same names (see its header comment); `readMonth` itself must never be
// imported here regardless of which file it's imported from.
import { bucketByLocalDay, type CalendarPiece } from "@/lib/content/calendar-view";
import { DayCell } from "./day-cell";

// Same pattern as day-cell.tsx and board/card.tsx: a mount-gated
// useSyncExternalStore whose server snapshot is always `false`, so the
// server render and React's first client render agree, and the real
// (viewer-local) value only takes effect once hydration has settled.
function useHydrated(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Shifts a `"YYYY-MM"` month by `delta` months, crossing year boundaries
 * (`2026-12` + 1 -> `2027-01`, `2026-01` - 1 -> `2025-12`). Built on
 * `Date.UTC`, the same trick `calendar.ts`'s `monthRangeUtc` uses: UTC
 * month overflow rolls into the year on its own, and UTC math never reads
 * the runtime's local zone, so this produces the same answer on the server
 * pass and every client — no hydration gate needed for prev/next links.
 */
function shiftMonth(month: string, delta: number): string {
  const [year, monthNum] = month.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, monthNum - 1 + delta, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The client half of `/calendar`. `bucketByLocalDay` runs here and only
 * here — it's the whole reason Task 1 split it out of `readMonth`: "local
 * day" means local to the viewer, and this is the one place that's known.
 *
 * Both the grid's contents and its weekday alignment (which day of week
 * the 1st falls on) depend on the viewer's real timezone, so both are
 * gated behind `hydrated` the same way `day-cell.tsx` gates its times:
 * an empty, correctly-shaped grid (0 pieces, 0 leading blanks) until
 * hydration settles, so the server pass and React's first client pass
 * agree — then the real bucketing and alignment appear once it's safe to
 * differ from that first pass. `month`/`pieces` never change without a
 * navigation (a full page load), so this never flickers after the initial
 * mount.
 */
export function MonthGrid({
  month,
  pieces,
  undatedPublished,
}: {
  month: string;
  pieces: CalendarPiece[];
  undatedPublished: number;
}) {
  const hydrated = useHydrated();
  const [year, monthNum] = month.split("-").map(Number);

  const days = useMemo(
    () => bucketByLocalDay(hydrated ? pieces : [], month),
    [hydrated, pieces, month]
  );

  const leadingBlanks = hydrated ? new Date(year, monthNum - 1, 1).getDay() : 0;

  const monthLabel = `${MONTH_NAMES[monthNum - 1]} ${year}`;
  const prevMonth = shiftMonth(month, -1);
  const nextMonth = shiftMonth(month, 1);

  return (
    <div className="flex flex-1 flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{monthLabel}</h2>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            aria-label="Previous month"
            render={<Link href={`/calendar?month=${prevMonth}`} />}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="Next month"
            render={<Link href={`/calendar?month=${nextMonth}`} />}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>

      {/* Tenant-wide, not month-scoped: an undated published piece belongs
          to no month, so this count is the same on every month view. */}
      {undatedPublished > 0 && (
        <div className="rounded-lg border border-dashed border-foreground/15 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          <Badge variant="secondary" className="mr-1.5">
            {undatedPublished}
          </Badge>
          {undatedPublished === 1 ? "published piece has" : "published pieces have"} no publication date and so
          cannot be placed on any month.
        </div>
      )}

      <div className="grid grid-cols-7 gap-1.5 text-center text-xs font-medium text-muted-foreground">
        {WEEKDAY_LABELS.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1.5">
        {Array.from({ length: leadingBlanks }, (_, i) => (
          <div key={`blank-${i}`} />
        ))}
        {days.map((day) => (
          <DayCell key={day.key} dayNumber={Number(day.key.slice(-2))} pieces={day.pieces} />
        ))}
      </div>
    </div>
  );
}
