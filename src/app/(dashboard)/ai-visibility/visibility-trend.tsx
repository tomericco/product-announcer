"use client";

import { Line, LineChart, ReferenceDot, XAxis, YAxis } from "recharts";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import type { EngineId } from "@/lib/ai-visibility/types";
import { ratePct } from "./format";
// The pure derivations live in a non-client module, because a Server Component
// has to be able to call them and anything re-exported THROUGH this file would
// still be a client reference. Import them from "./trend-points" directly.
import {
  hasPlottablePoint,
  trendEndLabels,
  trendRows,
  trendTicks,
  type TrendSeries,
} from "./trend-points";

/**
 * How the three engines are told apart: DASH PATTERN, never colour.
 *
 * Measured against `--card`, only `--chart-3`, `--chart-4` and `--brand-ink`
 * clear 3:1 in both themes — and `--brand-ink` vs `--chart-4` is 1.03:1 in
 * light, because they are the same colour. `--chart-1` is byte-identical to
 * `--brand` at 1.37:1 and vanishes at any stroke width. The ramp is SEQUENTIAL,
 * not categorical: it was built to order a single quantity, and there are not
 * three distinguishable steps in it to spend on three engines. So every
 * backdrop line is `--muted-foreground` and the pattern carries the identity,
 * with the engine's name drawn at the end of its own line.
 */
const BACKDROP_DASH: Record<EngineId, string | undefined> = {
  openai: undefined, // ChatGPT — solid
  gemini: "5 3", // dashed
  anthropic: "1 3", // dotted
};

const HERO_COLOR = "var(--brand-ink)";
const BACKDROP_COLOR = "var(--muted-foreground)";

/**
 * The overview's one chart: mention rate per engine over the last runs, with
 * the pooled "All engines" as the hero line.
 *
 * It replaces four sparklines that drew the same metric over the same window
 * four times — one per engine tile plus one on the pooled tile — each pinned to
 * the same 0..100 domain and each 64px tall with both axes hidden. Four objects
 * saying one thing, none of them readable enough to answer "which way is this
 * going" for the tenant as a whole. One chart, with axes, does.
 *
 * The hero is POOLED samples (2px, `--brand-ink`); the three engines are a 1px
 * `--muted-foreground` backdrop. That hierarchy is the design: the question the
 * row above asks is "are we being named", and the per-engine split is context
 * for the answer rather than three competing answers.
 */
export function VisibilityTrend({ series }: { series: TrendSeries[] }) {
  const rows = trendRows(series);

  // Two different sentences, and the difference matters. "No runs yet" over
  // twelve runs that were all too thin to publish would be false, and this
  // feature's whole discipline is that "nothing happened" and "not enough
  // evidence" are separate readings. "Not enough answers yet" is reserved for
  // EVERY series being entirely null — one engine with a single plottable run
  // still gets a chart, with the rest drawn as gaps.
  if (rows.length === 0 || !hasPlottablePoint(series)) {
    return (
      <p className="text-sm text-muted-foreground">
        {rows.length === 0 ? "No runs yet" : "Not enough answers yet"}
      </p>
    );
  }

  // Built from the series the page actually handed over, so a tenant running
  // one engine gets one entry and no dead `--color-*` variables.
  const config: ChartConfig = Object.fromEntries(
    series.map((line) => [
      line.key,
      { label: line.name, color: line.key === "all" ? HERO_COLOR : BACKDROP_COLOR },
    ])
  );

  const ticks = trendTicks(rows);
  const endLabels = trendEndLabels(rows, series);
  const runWord = rows.length === 1 ? "run" : "runs";
  // "runs", not "weeks": cadence is a tenant setting and can be fortnightly, so
  // twelve of these is six months for some tenants. The sparkline this replaces
  // said "the last 12 weeks" in its accessible name and was wrong for them.
  const caption = `Mention rate — how often you were named — over the last ${rows.length} ${runWord}.`;

  return (
    <figure className="space-y-1">
      <ChartContainer config={config} className="h-48 w-full">
        <LineChart data={rows} margin={{ top: 8, right: 76, bottom: 0, left: 0 }}>
          {/* Both axes VISIBLE. Hiding them is right at 64px inside a tile,
              where the number is printed directly above the line, and wrong
              for the page's one real chart: without a y-axis the reader cannot
              tell 8% from 80%, and without run dates cannot tell what span
              they are looking at. */}
          <XAxis
            dataKey="label"
            ticks={ticks}
            interval={0}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
          />
          <YAxis
            domain={[0, 100]}
            ticks={[0, 50, 100]}
            tickFormatter={(value: number) => `${value}%`}
            tickLine={false}
            axisLine={false}
            tickMargin={4}
            width={38}
          />
          {series.map((line) => {
            const hero = line.key === "all";
            return (
              <Line
                key={line.key}
                dataKey={line.key}
                type="monotone"
                stroke={`var(--color-${line.key})`}
                strokeWidth={hero ? 2 : 1}
                strokeDasharray={hero ? undefined : BACKDROP_DASH[line.key as EngineId]}
                // A break, never a bridge. `engineHistory` nulls any run below
                // the display floor, and joining across one draws a straight
                // line through a week nobody measured.
                connectNulls={false}
                dot={false}
                isAnimationActive={false}
              />
            );
          })}
          {/* Labelled in place rather than in a legend: with the engines
              distinguished only by dash pattern, a swatch legend asks the
              reader to match "1 3" against a 12px stub and carry it back to
              the line. The name sits at the end of its own line instead.

              A ReferenceDot with r=0 is the positioning primitive — the same
              category-axis trick the sparkline's markers use, where `x` must
              be the category VALUE and never a numeric index. */}
          {endLabels.map((end) => (
            <ReferenceDot
              key={`${end.key}-name`}
              x={end.label}
              y={end.rate}
              r={0}
              fill="none"
              stroke="none"
              label={{
                value: end.name,
                position: "right",
                fontSize: 11,
                fill: end.key === "all" ? HERO_COLOR : BACKDROP_COLOR,
              }}
            />
          ))}
        </LineChart>
      </ChartContainer>

      {/* The data, for anyone not looking at it.
          `role="img"` plus a name — what the sparklines did — is thin at one
          series and dishonest at four: it announces that a chart exists and
          tells you nothing it shows. Every value is already in `series`, so
          this is a `.map`, not a second query. `ratePct` formats it, which is
          what makes an unpublishable run render "—" and never "0%". */}
      <table className="sr-only">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Run</th>
            {series.map((line) => (
              <th key={line.key} scope="col">
                {line.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.runId}>
              <th scope="row">{row.label}</th>
              {series.map((line) => (
                <td key={line.key}>{ratePct(row[line.key] ?? null)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {/* The pooling caveat only where there is something pooled: a one-engine
          tenant has no "All engines" series, and explaining one it cannot see
          is noise. */}
      <figcaption className="text-xs text-muted-foreground">
        {caption}
        {series.some((line) => line.key === "all")
          ? " All engines pools every sample rather than averaging the three rates."
          : ""}
      </figcaption>
    </figure>
  );
}
