"use client";

import { Bar, BarChart, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import type { ByokPoint } from "@/lib/usage/queries";

const formatter = new Intl.NumberFormat("en-US");
const ENGINE_ORDER = ["GPT", "Gemini", "Claude"] as const;

/**
 * The BYOK channel's card body: tokens the AI-visibility sweeps spent on the
 * TENANT'S OWN keys, monthly over the last 12 months, stacked by engine.
 *
 * TOKENS, never "credits" — these calls bill the tenant's provider account
 * directly and are excluded from every credit number on this page. That
 * sentence is rendered, not just documented, because the distinction is the
 * whole reason this card is separate.
 */
export function ByokUsageChart({
  monthToDate,
  points,
  buckets,
}: {
  monthToDate: number;
  points: ByokPoint[];
  /** Monthly bucket skeleton (key + display label), zero-filled so sparse months don't collapse into adjacent bars. */
  buckets: { key: string; label: string }[];
}) {
  // Order-preserving dedupe: known engines first (in ENGINE_ORDER), then unknowns
  const engineSet = new Set(points.map((p) => p.engine));
  const engines: string[] = [
    ...ENGINE_ORDER.filter((e) => engineSet.has(e)),
    ...Array.from(engineSet).filter((e) => !ENGINE_ORDER.includes(e as (typeof ENGINE_ORDER)[number])),
  ];

  const rows = buckets.map(({ key, label }) => {
    const row: Record<string, number | string> = { bucket: key, label };
    for (const point of points.filter((p) => p.bucket === key)) {
      row[point.engine] = ((row[point.engine] as number) ?? 0) + point.tokens;
    }
    return row;
  });

  const config: ChartConfig = Object.fromEntries(
    engines.map((engine, i) => [engine, { label: engine, color: `var(--chart-${(i % 5) + 1})` }])
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Tracked for your cost visibility — these calls run on your own API keys and are
        not counted toward credits.
      </p>
      <p className="text-2xl font-semibold">
        {formatter.format(monthToDate)} <span className="text-sm font-normal text-muted-foreground">tokens this month</span>
      </p>
      {points.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No sweep usage tracked yet. Token tracking for AI-visibility sweeps starts with
          runs from this release onward.
        </p>
      ) : (
        <ChartContainer config={config} className="h-40 w-full">
          <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
            <YAxis tickFormatter={(v: number) => formatter.format(v)} tickLine={false} axisLine={false} width={64} />
            <ChartTooltip content={<ChartTooltipContent />} />
            {engines.map((engine) => (
              <Bar key={engine} dataKey={engine} stackId="tokens" fill={`var(--color-${engine})`} isAnimationActive={false} />
            ))}
          </BarChart>
        </ChartContainer>
      )}
    </div>
  );
}
