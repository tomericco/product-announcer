"use client";

import Link from "next/link";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
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
import {
  bucketByLocalDay,
  leadingBlanksFor,
  resolveMonth,
  rotateWeekdayLabels,
  shiftMonth,
  type CalendarPiece,
} from "@/lib/content/calendar-view";
// Type-only from the settings module, and a plain data prop for the holidays
// themselves: `@/lib/content/holidays` (which imports `date-holidays`) is
// never reachable from this file's module graph. The lookup runs in page.tsx,
// on the server.
import type { CalendarHoliday, WeekStartsOn } from "@/lib/workspace/calendar-settings";
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
  isDefaulted,
  pieces,
  undatedPublished,
  weekStartsOn,
  holidays,
}: {
  month: string;
  /** True when the server had no explicit `?month=` to honour and guessed
   * from its own clock — see the effect below and page.tsx's comment. */
  isDefaulted: boolean;
  pieces: CalendarPiece[];
  undatedPublished: number;
  /** Workspace setting: 0 = Sunday, 1 = Monday. */
  weekStartsOn: WeekStartsOn;
  /** Already resolved server-side for this month; `[]` when the workspace has
   * no holiday countries enabled. */
  holidays: CalendarHoliday[];
}) {
  const hydrated = useHydrated();
  const router = useRouter();
  const [year, monthNum] = month.split("-").map(Number);

  // The server's fallback month (when `?month=` was absent/invalid) is a
  // guess made from ITS clock, not the viewer's — the one date decision in
  // this feature that isn't already pushed to the client (every other one
  // goes through `bucketByLocalDay`, which only runs here). Once mounted,
  // redo that same fallback against the browser's real clock; if it disagrees
  // with what the server guessed, replace the URL with the viewer's actual
  // current month so `readMonth` re-queries the right range. A no-op — no
  // extra navigation — whenever `?month=` was explicit or the two clocks
  // already agree, which is the overwhelming majority of loads.
  useEffect(() => {
    if (!isDefaulted) return;
    const viewerMonth = resolveMonth(undefined);
    if (viewerMonth !== month) {
      router.replace(`/calendar?month=${viewerMonth}`);
    }
  }, [isDefaulted, month, router]);

  const days = useMemo(
    () => bucketByLocalDay(hydrated ? pieces : [], month),
    [hydrated, pieces, month]
  );

  // Still gated on `hydrated`, for the same reason it always was: which
  // weekday the 1st falls on is read from a local `Date`, so the server pass
  // would answer in ITS zone and disagree with the client's first pass. The
  // week start itself is a server-provided prop and needs no gate — only the
  // `getDay()` inside does.
  const leadingBlanks = hydrated ? leadingBlanksFor(month, weekStartsOn) : 0;

  // Holidays arrive as plain `YYYY-MM-DD` strings computed on the server, so
  // no timezone question arises and no hydration gate is needed. Two enabled
  // countries can land on the same day, hence a list per day rather than one.
  const holidaysByDay = useMemo(() => {
    const byDay = new Map<string, string[]>();
    for (const holiday of holidays) {
      const names = byDay.get(holiday.date);
      if (names) names.push(holiday.name);
      else byDay.set(holiday.date, [holiday.name]);
    }
    return byDay;
  }, [holidays]);

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
        {rotateWeekdayLabels(weekStartsOn).map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1.5">
        {Array.from({ length: leadingBlanks }, (_, i) => (
          <div key={`blank-${i}`} />
        ))}
        {days.map((day) => (
          <DayCell
            key={day.key}
            dayNumber={Number(day.key.slice(-2))}
            pieces={day.pieces}
            holidays={holidaysByDay.get(day.key) ?? []}
          />
        ))}
      </div>
    </div>
  );
}
