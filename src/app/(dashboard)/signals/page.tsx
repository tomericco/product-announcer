import { Radar } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  EmptyState,
  EmptyStateIcon,
  EmptyStateTitle,
  EmptyStateDescription,
} from "@/components/ui/empty-state";
import { requireSession } from "@/lib/workspace/session";
import { listCompetitors } from "@/lib/workspace/competitors";
import { listSignals, type SignalFilters } from "@/lib/signals/query";
import { single, parseKind, parseCompetitorId, parseMinScore, parseDateFrom, parseDateTo } from "@/lib/signals/params";
import { MAX_PROPOSAL_SIGNALS } from "@/lib/briefs/propose";
import { SignalsFilters } from "./signals-filters";
import { SignalsList } from "./signals-list";
import { AddSignalDialog } from "./add-signal-dialog";

/**
 * The signals browser: a debugging surface first, a feature second (see the
 * spec's framing). It ships before any external ingestion agent exists, so
 * that agent's first run lands on a page that already works instead of being
 * debugged blind.
 *
 * This page is a Server Component, so importing `MAX_PROPOSAL_SIGNALS` from
 * `@/lib/briefs/propose` here is safe — that module (and the AI SDK it pulls
 * in) stays on the server. `SignalsList` is a client component and gets only
 * the resolved number as a prop, never the import itself; see the comment on
 * `SignalsList` for why that boundary matters.
 *
 * Filters come from `searchParams` — a Next.js 16 async Server Component
 * page, per `node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md`
 * ("Rendering with search params": the `searchParams` prop is a `Promise`,
 * must be awaited, and reading it opts the page into dynamic rendering, which
 * is exactly what's wanted here — the list must reflect the latest filter on
 * every request), mirroring the Company page's pipeline sections.
 *
 * The 60-day window is deliberately NOT one of these filters: `listSignals`
 * applies `signalWindowCondition()` unconditionally, before any filter below,
 * so nothing this page reads from the URL can widen it.
 */
export default async function SignalsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;

  const minScoreRaw = single(params.minScore) ?? "";
  const fromRaw = single(params.from) ?? "";
  const toRaw = single(params.to) ?? "";
  const competitorIdRaw = single(params.competitorId) ?? "";

  const filters: SignalFilters = {
    kind: parseKind(single(params.kind)),
    competitorId: parseCompetitorId(competitorIdRaw),
    minScore: parseMinScore(minScoreRaw),
    from: parseDateFrom(fromRaw),
    to: parseDateTo(toRaw),
    includeStale: single(params.includeStale) === "1",
  };

  const session = await requireSession();
  const [rows, competitors] = await Promise.all([
    listSignals(session.user.tenantId, filters),
    listCompetitors(session.user.tenantId),
  ]);

  const competitorsById = new Map(competitors.map((competitor) => [competitor.id, competitor.name]));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-heading text-3xl leading-[1.15] tracking-[0.015em]">Signals</h1>
            <Badge variant="secondary">{rows.length}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Everything ingested in the last 60 days — shipped work, competitor moves, and market news — ahead of
            scoring, clustering, or turning into a brief. A row with no score means scoring failed, not that it
            scored zero.
          </p>
        </div>
        <AddSignalDialog />
      </div>

      <SignalsFilters
        kind={filters.kind ?? "all"}
        competitorId={competitorIdRaw || "all"}
        minScore={minScoreRaw}
        from={fromRaw}
        to={toRaw}
        includeStale={filters.includeStale ?? false}
        competitors={competitors.map((competitor) => ({ id: competitor.id, name: competitor.name }))}
      />

      {rows.length === 0 ? (
        <EmptyState>
          <EmptyStateIcon>
            <Radar />
          </EmptyStateIcon>
          <EmptyStateTitle>No signals</EmptyStateTitle>
          <EmptyStateDescription>
            Nothing matches these filters, or nothing has been ingested in the last 60 days yet.
          </EmptyStateDescription>
        </EmptyState>
      ) : (
        <SignalsList rows={rows} competitorsById={competitorsById} maxSelectable={MAX_PROPOSAL_SIGNALS} />
      )}
    </div>
  );
}
