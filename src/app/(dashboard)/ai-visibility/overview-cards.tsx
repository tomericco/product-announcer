"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { EngineId, EngineMetrics } from "@/lib/ai-visibility/types";
import { engineGridClass } from "./engine-grid";
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
 * `metrics.deltaPp` is deliberately NOT read here, though the tile printed it
 * until now. It is damped by construction — `deltaPp` in `metrics.ts` documents
 * that both of its windows are "the last four complete runs as of their own cut
 * date", so they overlap, and below eight lifetime runs they share almost every
 * run — and it stays null until roughly eight runs have accumulated, which is
 * two months of a weekly cadence. What it was there to answer, "which way is
 * this going", the 12-week sparkline directly beneath answers with the whole
 * shape instead of one damped number. The field stays on `EngineMetrics`: a
 * later surface that can draw it in context (a hover on the sparkline, a
 * period-over-period view) should not have to recompute it.
 *
 * The band and `n` stay. They are the trust cues, not decoration: a share
 * without either is a number nobody can check.
 */
export function tileReading(metrics: EngineMetrics): TileReading {
  if (metrics.mentionRate === null) {
    return { kind: "baseline", headline: "Collecting baseline", band: null };
  }
  if (metrics.shareOfVoice === null) {
    return { kind: "measured-zero", headline: "No brands named", band: null };
  }
  return {
    kind: "share",
    headline: `${Math.round(metrics.shareOfVoice)}%`,
    band: metrics.wilsonPp === null ? null : `±${Math.round(metrics.wilsonPp)} pp`,
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
 * "All engines" is POOLED samples, not an average of the three rates — the
 * page hands it down already computed that way; this component only renders
 * what it is given. Averaging three rates would weight a 12-sample engine
 * equally with an 84-sample one.
 */
export function OverviewCards({ tiles }: { tiles: EngineTile[] }) {
  return (
    // One tile per ENABLED engine plus the pooled one, so this row is 2, 3 or
    // 4 cards long depending on the tenant's settings — never the five columns
    // it used to reserve.
    <div className={engineGridClass(tiles.length)}>
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
