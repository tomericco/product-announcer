import { Badge } from "@/components/ui/badge";
import type { Signal } from "@/db/schema";
import type { CitedSignal } from "@/lib/briefs/query";

const SIGNAL_KIND_LABEL: Record<Signal["kind"], string> = {
  shipped_work: "Shipped work",
  competitor_move: "Competitor move",
  market_news: "Market news",
  manual: "Manual",
};

/**
 * The brief's cited evidence. Recovered verbatim (down to the markup) from
 * the deleted inbox card — `git show d452e9e^:"src/app/(dashboard)/briefs/brief-card.tsx"`,
 * around lines 96-118 — the only place in the UI that showed what a brief was
 * grounded in before briefs became editor documents and `/briefs` became a
 * list of rows. `SIGNAL_KIND_LABEL` above is the same map, copied from that
 * file's line 21.
 *
 * A plain Server Component, not `"use client"`: nothing here is interactive,
 * it just renders the rows `listBriefSignals` (`src/lib/briefs/query.ts`)
 * already fetched tenant-scoped by the page.
 *
 * Rendered on BOTH the editable and read-only branches of
 * `BriefDetailPage` — a dismissed or accepted brief is exactly when you want
 * to see what it was based on, not only while it's still undecided.
 */
export function BriefEvidence({ signals }: { signals: CitedSignal[] }) {
  if (signals.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">Evidence:</span>
      {signals.map((signal) => (
        <Badge key={signal.id} variant="outline" className="max-w-64">
          {signal.url ? (
            <a
              href={signal.url}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate hover:underline"
              title={signal.title}
            >
              {signal.title}
            </a>
          ) : (
            <span className="truncate" title={signal.title}>
              {signal.title}
            </span>
          )}
          <span className="text-muted-foreground">· {SIGNAL_KIND_LABEL[signal.kind]}</span>
        </Badge>
      ))}
    </div>
  );
}
