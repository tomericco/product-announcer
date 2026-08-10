"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
// Imported from `@/lib/content/calendar-view`, not `@/lib/content/calendar`
// — see the comment in `month-grid.tsx` for why: `calendar.ts` imports
// `@/db`, and any import from it into a "use client" file pulls the whole
// module graph (`pg`, `net`, `tls`) into the browser bundle.
import { CALENDAR_TYPES, type CalendarPiece, type CalendarType } from "@/lib/content/calendar-view";

// Mirrors board/card.tsx's useHydrated: a mount-gated useSyncExternalStore
// whose server snapshot returns false, so the server render and React's
// first client render (before hydration settles) agree on the same
// (unhydrated) output, and the real local time only appears once hydration
// has actually finished. See the fuller comment in board/card.tsx for why
// this beats useState+useEffect (an extra synchronous re-render on every
// mount, flagged by react-hooks/set-state-in-effect) and why
// suppressHydrationWarning is wrong here (it silences the warning but
// leaves the server's wrong-zone time on screen indefinitely instead of
// ever correcting).
function useHydrated(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );
}

const TYPE_LABEL: Record<CalendarType, string> = {
  product_update: "Product update",
  blog_post: "Blog post",
  social_post: "Social post",
};

/**
 * One day of the month grid. Renders a lane per `CalendarType` that has at
 * least one piece that day — an empty day renders no lanes, just the day
 * number — so pieces of different types never run together in the same
 * row. Every card links to `/drafts/[id]`; this view is read-only, so a
 * click is the only thing a piece here can do.
 */
export function DayCell({
  dayNumber,
  pieces,
}: {
  dayNumber: number;
  pieces: Record<CalendarType, CalendarPiece[]>;
}) {
  const hydrated = useHydrated();

  return (
    <div className="flex min-h-28 flex-col gap-1.5 rounded-lg border border-border p-1.5">
      <span className="text-xs font-medium text-muted-foreground">{dayNumber}</span>
      {/* No `overflow-hidden` here on purpose: this view's whole job is
          coverage, so a busy day must grow the cell (and its row) rather
          than silently clip pieces past the third or so with no "+N more"
          affordance to say anything was hidden. */}
      <div className="flex flex-col gap-1.5">
        {CALENDAR_TYPES.map((type) => {
          const typePieces = pieces[type];
          if (typePieces.length === 0) return null;
          return (
            <div key={type} className="flex flex-col gap-0.5">
              <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                {TYPE_LABEL[type]}
              </span>
              {typePieces.map((piece) => (
                <Link
                  key={piece.id}
                  href={`/drafts/${piece.id}`}
                  title={piece.title}
                  className="flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 text-xs hover:bg-muted"
                >
                  <Badge variant={piece.status === "published" ? "secondary" : "outline"} className="shrink-0">
                    {/* Formatting a Date renders the server's zone on the
                        server pass and the browser's after hydration — a
                        mismatch if shown unconditionally. "—" until
                        hydration settles, then the viewer's real local
                        time. */}
                    {hydrated ? format(piece.at, "HH:mm") : "—"}
                  </Badge>
                  <span className="truncate">{piece.title}</span>
                </Link>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
