"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
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
  holidays,
  resting,
  today,
}: {
  dayNumber: number;
  pieces: Record<CalendarType, CalendarPiece[]>;
  /** Public holiday names falling on this day, already resolved on the server
   * (see calendar/page.tsx). Plain strings, so nothing here is
   * timezone-dependent and no hydration gate applies — unlike the times
   * below. More than one when two enabled countries share a day. */
  holidays: string[];
  /** One of the workspace's two resting days — the last two columns of the
   * week as displayed, derived from `weekStartsOn` alone. Decided by the
   * caller so this component stays a pure renderer. */
  resting: boolean;
  /** The viewer's own today. Decided by the caller — and, crucially, gated
   * there behind hydration, because the server's clock is not the viewer's;
   * see `month-grid.tsx`. False on the server pass and on React's first
   * client pass, exactly like `resting`. */
  today: boolean;
}) {
  const hydrated = useHydrated();

  return (
    <div
      className={cn(
        "flex min-h-28 flex-col gap-1.5 rounded-lg border border-border p-1.5",
        // A background and NOTHING else, on purpose. This cell carries no
        // other state today — every day renders the same border, and the
        // leading blanks are bare borderless divs — but the moment one
        // arrives (today, selected, a drop target) it will want the border,
        // the ring or the type weight. Keeping the resting shade to the one
        // channel nothing else uses is what lets a "today" ring read straight
        // through it instead of fighting it. Do not promote this to a border
        // or a ring colour without moving whatever claims that channel first.
        //
        // /40 rather than a solid fill for the same reason: the piece links
        // inside hover to a full-strength `bg-muted`, so the hover still steps
        // up visibly on a resting day rather than matching its background.
        resting && "bg-muted/40",
        // Today, treatment 1 of 2: an INSET ring, taking the channel the
        // resting shade left free on purpose (see just above). Inset rather
        // than the default outset so it draws inside the cell's own box and
        // cannot overlap its neighbours across the 1.5 grid gap; `ring-*`
        // rather than `border-*` because the border is already spoken for by
        // every cell equally, and swapping its colour here would make today
        // read as "a differently-outlined cell" instead of an added mark.
        // Composes with the shade by construction: one paints `background`,
        // the other `box-shadow`, so a resting day that is also today shows
        // both at once — which is the case tests pin explicitly.
        today && "ring-2 ring-primary ring-inset"
      )}
      // The standard semantics for "this is the current date" in a grid of
      // dates, so the ring is not the only channel carrying it — a screen
      // reader announces today without seeing a single class.
      aria-current={today ? "date" : undefined}
    >
      <span
        className={cn(
          "text-sm font-medium",
          // Today, treatment 2 of 2: the date number itself in a filled
          // circle — the convention every calendar app has trained people to
          // read — rather than merely recoloured text, which is invisible
          // beside 27 other numbers. `size-6` fixes the circle's width so the
          // span does not stretch to the cell in this flex column, and
          // `inline-flex` + centring keeps the digits on its centre at both
          // one and two digits.
          today
            ? "inline-flex size-6 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground"
            : "text-muted-foreground"
        )}
      >
        {dayNumber}
      </span>
      {holidays.length > 0 && (
        // `flex-wrap` rather than a plain stack: two enabled countries can
        // land on one day, and in a column wide enough for both pills they
        // sit side by side, otherwise they wrap onto their own lines. Either
        // way the cell grows — matching the no-`overflow-hidden` decision
        // below — instead of the grid column widening to fit a long name.
        <div className="flex flex-wrap gap-1">
          {holidays.map((holiday) => (
            // `max-w-full` is the guard: Badge is `w-fit whitespace-nowrap`,
            // which is fit-content over unbreakable text — i.e. the pill's
            // full natural width, cell be damned. Capping it at the cell and
            // truncating the label inside keeps "Independence Day (Yom
            // HaAtzmaut)" inside its column; `title` keeps the whole name
            // reachable. The inner span (not the Badge itself) carries
            // `truncate` because `text-overflow` does not apply to the
            // anonymous flex item a bare text child of an `inline-flex`
            // Badge becomes.
            <Badge key={holiday} variant="secondary" title={holiday} className="max-w-full">
              <span className="min-w-0 truncate">{holiday}</span>
            </Badge>
          ))}
        </div>
      )}
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
