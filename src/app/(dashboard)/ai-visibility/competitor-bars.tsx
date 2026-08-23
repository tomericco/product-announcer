"use client";

import { Bar, BarChart, Cell, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { PreviewCard, PreviewCardContent, PreviewCardTrigger } from "@/components/ui/preview-card";
import type { EngineId } from "@/lib/ai-visibility/types";
import { ENGINE_LABEL } from "./engine-labels";

export type BrandShare = {
  brandId: string;
  name: string;
  isTenant: boolean;
  mentions: number;
  sharePct: number;
  perEngine: { engine: EngineId; sharePct: number | null }[];
};

/**
 * Us first, then everyone else by share descending, ties broken by name.
 *
 * Us-first is the design's call (the benchmark card exists to answer "where
 * are we against them", and hunting for our own row defeats it), and the
 * name tiebreak keeps two evenly-matched competitors from swapping places
 * between runs, which reads as movement that did not happen.
 */
export function orderedShares(rows: BrandShare[]): BrandShare[] {
  return [...rows].sort((a, b) => {
    if (a.isTenant !== b.isTenant) return a.isTenant ? -1 : 1;
    if (a.sharePct !== b.sharePct) return b.sharePct - a.sharePct;
    return a.name.localeCompare(b.name);
  });
}

const CHART_CONFIG = {
  sharePct: { label: "Share of voice", color: "var(--chart-2)" },
} satisfies ChartConfig;

/**
 * The competitor benchmark: a horizontal bar per tracked brand.
 *
 * Our own bar is the one accent fill on this row — state, in the brand
 * guide's sense — and every competitor is a neutral chart tone. Hovering a
 * name opens the per-engine breakdown in a `PreviewCard` rather than
 * overlaying four more series, which is the five-line spaghetti the design
 * decided against.
 */
export function CompetitorBars({ rows, n }: { rows: BrandShare[]; n: number }) {
  const ordered = orderedShares(rows);

  return (
    <div className="space-y-3">
      <ChartContainer config={CHART_CONFIG} className="h-56 w-full">
        <BarChart data={ordered} layout="vertical" margin={{ top: 4, right: 12, bottom: 4, left: 8 }}>
          <XAxis type="number" domain={[0, 100]} hide />
          <YAxis type="category" dataKey="name" width={120} tickLine={false} axisLine={false} fontSize={12} />
          <ChartTooltip content={<ChartTooltipContent labelKey="name" />} />
          <Bar dataKey="sharePct" radius={2} isAnimationActive={false}>
            {ordered.map((row) => (
              <Cell
                key={row.brandId}
                // Theme tokens directly — `--color-*` variables exist only
                // for ChartConfig series keys (here, `--color-sharePct`).
                //
                // Our bar is the accent FILL (principle 1: --brand is a fill,
                // ink on bright) with a --brand-ink outline. Without the
                // outline the one bar the card exists to point at is the
                // faintest thing in it: --brand sits at ~1.2:1 against the
                // card while every competitor is the much darker --chart-3.
                fill={row.isTenant ? "var(--brand)" : "var(--chart-3)"}
                stroke={row.isTenant ? "var(--brand-ink)" : "none"}
                strokeWidth={row.isTenant ? 1 : 0}
              />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>

      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {ordered.map((row) => (
          <li key={row.brandId}>
            <PreviewCard>
              <PreviewCardTrigger render={<button type="button" className="hover:text-foreground" />}>
                {row.name} · {row.sharePct.toFixed(0)}%
              </PreviewCardTrigger>
              <PreviewCardContent className="max-w-64">
                <p className="font-medium">{row.name}</p>
                {/* The rows the page HANDED us, not every engine that exists:
                    `perEngine` is already cut to the engines the tenant runs
                    (and in ENGINE_ORDER), so walking the full list instead
                    drew a permanent "—" for an engine nobody is paying for. */}
                <ul className="space-y-0.5">
                  {row.perEngine.map((cut) => (
                    <li key={cut.engine} className="flex justify-between gap-3">
                      <span className="text-muted-foreground">{ENGINE_LABEL[cut.engine]}</span>
                      <span>{cut.sharePct === null ? "—" : `${cut.sharePct.toFixed(0)}%`}</span>
                    </li>
                  ))}
                </ul>
              </PreviewCardContent>
            </PreviewCard>
          </li>
        ))}
      </ul>

      <p className="text-xs text-muted-foreground">n = {n} answers</p>
      <p className="text-xs text-muted-foreground">Adding a competitor lowers every share.</p>
    </div>
  );
}
