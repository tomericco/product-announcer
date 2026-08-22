"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { EngineId, EngineMetrics } from "@/lib/ai-visibility/types";
import { SovSparkline } from "./sov-sparkline";
import type { SovPoint } from "./sparkline-points";

export type TileReading = {
  /**
   * Which of the three readings this is. The headline text alone cannot carry
   * it: "Collecting baseline" and "No brands named" are both bandless, so
   * styling off `band === null` renders a measured finding in the same muted
   * "still waiting" tone as an absence of data — and the measured zero is
   * usually the most actionable thing on the page.
   */
  kind: "share" | "baseline" | "measured-zero";
  headline: string;
  band: string | null;
  delta: string | null;
};

/**
 * `engineMetrics` returns every rate already in percentage points (0..100),
 * so this rounds and appends a sign — it does NOT multiply. Multiplying
 * again would print "6200%" and, worse, would look plausible on the day
 * someone changes the scale back.
 */
function percent(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate)}%`;
}

/**
 * What the big number on a tile says.
 *
 * Three readings, and the whole design turns on keeping them apart:
 *
 * - `mentionRate === null` — the window is below n >= 30. NOTHING is known,
 *   and the tile says so in words. Rendering it as "0%" is the single worst
 *   thing this surface could do: indistinguishable from a real, terrible
 *   score.
 * - `shareOfVoice === null` with a known `mentionRate` — the window IS fat
 *   enough, and no tracked brand was named in any answer. That is a measured
 *   fact and usually the most actionable thing on the page. It is NOT
 *   "collecting baseline", which is why this branches on `mentionRate` and
 *   never on `shareOfVoice` alone. It is not "0%" either: a zero share implies
 *   a denominator, and here nobody won the mentions.
 * - otherwise — a real share, with its band.
 *
 * The delta is 30 days, muted, and never coloured — effects take 60–90 days,
 * so a green arrow on a week's movement would be a claim we cannot support.
 * The fall case uses U+2212 MINUS, not a hyphen, so "−2" lines up with "+3"
 * in a tabular column.
 */
export function tileReading(metrics: EngineMetrics): TileReading {
  if (metrics.mentionRate === null) {
    return { kind: "baseline", headline: "Collecting baseline", band: null, delta: null };
  }
  if (metrics.shareOfVoice === null) {
    return { kind: "measured-zero", headline: "No brands named", band: null, delta: null };
  }
  return {
    kind: "share",
    headline: `${Math.round(metrics.shareOfVoice)}%`,
    band: metrics.wilsonPp === null ? null : `±${Math.round(metrics.wilsonPp)} pp`,
    delta:
      metrics.deltaPp === null
        ? null
        : `${metrics.deltaPp < 0 ? "−" : "+"}${Math.abs(Math.round(metrics.deltaPp))} pp vs 30 days ago`,
  };
}

/** The other three metrics, one line under the headline. */
export function metricsLine(metrics: EngineMetrics): string {
  return [
    `Mentioned ${percent(metrics.mentionRate)}`,
    `Cited ${percent(metrics.citationRate)}`,
    `Recommended ${percent(metrics.recommendationRate)}`,
  ].join(" · ");
}

export type EngineTile = {
  engine: EngineId | "all";
  label: string;
  metrics: EngineMetrics;
  points: SovPoint[];
  failureNote: string | null;
  modelChangeNote: string | null;
};

/**
 * Row 1 of the overview: one card per engine plus "All engines".
 *
 * "All engines" is POOLED samples, not an average of the four rates — the
 * page hands it down already computed that way; this component only renders
 * what it is given. Averaging four rates would weight a 12-sample engine
 * equally with an 84-sample one.
 */
export function OverviewCards({ tiles }: { tiles: EngineTile[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {tiles.map((tile) => {
        const reading = tileReading(tile.metrics);
        return (
          <Card key={tile.engine} size="sm">
            <CardHeader>
              <CardTitle className="truncate" title={tile.label}>
                {tile.label}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex items-baseline gap-2">
                <span
                  className={
                    reading.kind === "share"
                      ? "text-2xl leading-none font-medium tabular-nums"
                      : reading.kind === "measured-zero"
                        ? // A finding, not an absence: full-contrast text, so it
                          // does not read as "still collecting".
                          "text-sm font-medium text-foreground"
                        : "text-sm text-muted-foreground"
                  }
                >
                  {reading.headline}
                </span>
                {reading.band && <span className="text-xs text-muted-foreground tabular-nums">{reading.band}</span>}
              </div>

              {reading.delta && <p className="text-xs text-muted-foreground">{reading.delta}</p>}

              <SovSparkline
                points={tile.points}
                ariaLabel={`Share of voice over the last 12 weeks, ${tile.label}`}
              />

              <p className="text-xs text-muted-foreground tabular-nums">n = {tile.metrics.n} answers</p>
              <p className="text-xs text-muted-foreground">{metricsLine(tile.metrics)}</p>

              {tile.modelChangeNote && <p className="text-xs text-muted-foreground">{tile.modelChangeNote}</p>}
              {/* --destructive owns every failure state in this system;
                  there is deliberately no amber "warning" tone. */}
              {tile.failureNote && <p className="text-xs text-destructive">{tile.failureNote}</p>}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
