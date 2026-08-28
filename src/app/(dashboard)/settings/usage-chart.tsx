"use client";

import { useState } from "react";
import { Bar, BarChart, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltipContent, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FEATURE_LABELS, type FeatureKey } from "@/lib/usage/features";
import type { Granularity } from "@/lib/usage/queries";

export type UsageChartRow = { bucket: string; label: string } & Partial<Record<FeatureKey, number>>;
export type UsageDataset = {
  rows: UsageChartRow[];
  totals: { feature: FeatureKey; credits: number }[];
};

const GRANULARITIES: { key: Granularity; label: string }[] = [
  { key: "daily", label: "Daily" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
];

const formatter = new Intl.NumberFormat("en-US");

/**
 * All three datasets arrive precomputed from the server (≤ 30 rows each), so
 * the toggle is pure client state — no fetch, no server round-trip.
 *
 * Bars are stacked by feature on the sequential --chart-* ramp. Unlike the
 * trend chart's 1px lines (see visibility-trend.tsx's contrast note), filled
 * bars carry enough area for the ramp to stay readable; identity is also in
 * the tooltip and the table below, never colour alone.
 */
export function UsageChart({
  datasets,
  features,
}: {
  datasets: Record<Granularity, UsageDataset>;
  features: FeatureKey[];
}) {
  const [granularity, setGranularity] = useState<Granularity>("daily");
  const { rows, totals } = datasets[granularity];
  const total = totals.reduce((sum, t) => sum + t.credits, 0);

  const config: ChartConfig = Object.fromEntries(
    features.map((feature, i) => [
      feature,
      { label: FEATURE_LABELS[feature], color: `var(--chart-${(i % 5) + 1})` },
    ])
  );

  return (
    <div className="space-y-6">
      <Tabs value={granularity} onValueChange={(value) => setGranularity(value as Granularity)}>
        <TabsList>
          {GRANULARITIES.map((g) => (
            <TabsTrigger key={g.key} value={g.key}>
              {g.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {total === 0 ? (
        <p className="text-sm text-muted-foreground">No AI usage in this period yet.</p>
      ) : (
        <ChartContainer config={config} className="h-56 w-full">
          <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
            <YAxis
              tickFormatter={(value: number) => formatter.format(value)}
              tickLine={false}
              axisLine={false}
              width={64}
            />
            <ChartTooltip content={<ChartTooltipContent />} />
            {features.map((feature) => (
              <Bar
                key={feature}
                dataKey={feature}
                stackId="credits"
                fill={`var(--color-${feature})`}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ChartContainer>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Feature</TableHead>
            <TableHead className="text-right">Credits</TableHead>
            <TableHead className="text-right">Share</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {totals.map((row) => (
            <TableRow key={row.feature}>
              <TableCell>{FEATURE_LABELS[row.feature]}</TableCell>
              <TableCell className="text-right">{formatter.format(row.credits)}</TableCell>
              <TableCell className="text-right">
                {total === 0 ? "—" : `${Math.round((row.credits / total) * 100)}%`}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
