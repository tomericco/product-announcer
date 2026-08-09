"use client";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Signal } from "@/db/schema";

const KIND_LABEL: Record<Signal["kind"], string> = {
  shipped_work: "Shipped work",
  competitor_move: "Competitor move",
  market_news: "Market news",
  manual: "Manual",
};

const STATUS_LABEL: Record<Signal["status"], string> = {
  new: "New",
  used: "Used",
  stale: "Stale",
};

// Pinned locale + UTC, like `groupByMonth`'s formatter: an unpinned
// toLocaleString() renders differently on the server and the client and
// breaks hydration.
const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * A null `relevanceScore` means scoring FAILED, not "scored zero" — this is
 * the load-bearing distinction the whole browser exists to surface, so it
 * gets its own labeled badge ("Not scored") rather than a blank cell that
 * would silently read as "scored zero" at a glance. The rationale, when
 * present, explains why (a classifier error, a missed field) via hover
 * instead of crowding the row with a paragraph of text.
 */
function ScoreBadge({ score, rationale }: { score: number | null; rationale: string | null }) {
  const badge =
    score === null ? (
      <Badge variant="outline" className="text-muted-foreground">
        Not scored
      </Badge>
    ) : (
      <Badge variant="secondary">{score.toFixed(2)}</Badge>
    );

  if (!rationale) return badge;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>{badge}</TooltipTrigger>
        <TooltipContent>{rationale}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * One row in the /signals list. Everything here arrives as props from the
 * server-rendered page — the competitor name is resolved there (`listSignals`
 * returns the raw `signals` row, with only `competitorId`, not a join) and
 * passed down, so this component never imports `db`/pg.
 *
 * `stale` gets the same dashed, low-opacity treatment `ChangeEventRow` uses
 * for the resolver's rejects: visually set apart from live evidence without
 * hiding it, matching this being a debugging surface. `stale` is currently
 * unreachable in practice (nothing marks a signal stale yet — the retention
 * job that would is deferred), but the row still renders correctly for the
 * one seeded directly in tests, and for whenever that job lands.
 *
 * Selection lives in `SignalsList` (a `Set<string>` of ids), not here — this
 * row only renders the checkbox and reports toggles up. `selectionDisabled`,
 * when set, is a human-readable reason (a stale signal, or the selection cap)
 * rendered as a tooltip rather than a silently inert control, per the same
 * "visible reason" rule `DisabledHint` follows elsewhere in the dashboard.
 */
export function SignalRow({
  row,
  competitorName,
  selected,
  onToggleSelected,
  selectionDisabled,
}: {
  row: Signal;
  competitorName?: string;
  selected: boolean;
  onToggleSelected: () => void;
  selectionDisabled?: string | null;
}) {
  const checkbox = (
    <input
      type="checkbox"
      className="size-4 shrink-0 rounded border-input disabled:cursor-not-allowed disabled:opacity-40"
      checked={selected}
      disabled={!!selectionDisabled}
      onChange={onToggleSelected}
      aria-label={selectionDisabled ? `${row.title} — ${selectionDisabled}` : `Select ${row.title}`}
    />
  );

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3",
        row.status === "stale" && "dashed-outline border-transparent opacity-85"
      )}
    >
      <div className="flex shrink-0 items-center self-start pt-0.5">
        {selectionDisabled ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>{checkbox}</TooltipTrigger>
              <TooltipContent>{selectionDisabled}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          checkbox
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="shrink-0">
            {KIND_LABEL[row.kind]}
          </Badge>
          {competitorName && (
            <Badge variant="outline" className="shrink-0">
              {competitorName}
            </Badge>
          )}
          {row.url ? (
            <a
              href={row.url}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate font-medium hover:underline"
            >
              {row.title}
            </a>
          ) : (
            <span className="truncate font-medium">{row.title}</span>
          )}
        </div>
        {row.excerpt && <p className="truncate text-xs text-muted-foreground">{row.excerpt}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-xs text-muted-foreground">{DATE_FORMAT.format(row.occurredAt)}</span>
        <ScoreBadge score={row.relevanceScore} rationale={row.relevanceRationale} />
        {row.status !== "new" && <Badge variant="outline">{STATUS_LABEL[row.status]}</Badge>}
      </div>
    </div>
  );
}
