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
import { SignalsFilters } from "./signals-filters";
import { SignalsList } from "./signals-list";

const KIND_VALUES = ["shipped_work", "competitor_move", "market_news", "manual"] as const;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseKind(value: string | undefined): SignalFilters["kind"] {
  return (KIND_VALUES as readonly string[]).includes(value ?? "")
    ? (value as SignalFilters["kind"])
    : undefined;
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseMinScore(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const score = Number(value);
  return Number.isFinite(score) ? score : undefined;
}

/**
 * The signals browser: a debugging surface first, a feature second (see the
 * spec's framing). It ships before any external ingestion agent exists, so
 * that agent's first run lands on a page that already works instead of being
 * debugged blind. Read-only in this task — selection and manual signal
 * creation are spec 6.
 *
 * Filters come from `searchParams` — a Next.js 16 async Server Component
 * page, per `node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md`
 * ("Rendering with search params": the `searchParams` prop is a `Promise`,
 * must be awaited, and reading it opts the page into dynamic rendering, which
 * is exactly what's wanted here — the list must reflect the latest filter on
 * every request), mirroring `/change-events`.
 *
 * The 60-day window is deliberately NOT one of these filters: `listSignals`
 * applies `signalWindowStart` unconditionally, before any filter below, so
 * nothing this page reads from the URL can widen it.
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
    competitorId: competitorIdRaw || undefined,
    minScore: parseMinScore(minScoreRaw),
    from: parseDate(fromRaw),
    to: parseDate(toRaw),
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
        <SignalsList rows={rows} competitorsById={competitorsById} />
      )}
    </div>
  );
}
