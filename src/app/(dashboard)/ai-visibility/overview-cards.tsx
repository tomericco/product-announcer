"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { EngineId, EngineMetrics } from "@/lib/ai-visibility/types";
import { engineGridClass } from "./engine-grid";
import { RateSparkline } from "./rate-sparkline";
import type { RatePoint } from "./sparkline-points";

export type TileReading = {
  /**
   * Which of the two readings this is. The headline text alone cannot carry
   * it: "Collecting baseline" is a sentence where a rate would be, and styling
   * off `band === null` would render it in the same weight as a measured
   * number.
   */
  kind: "rate" | "baseline";
  headline: string;
  band: string | null;
};

export type ShareReading = {
  /**
   * `none-named` is a FINDING, not an absence, and the tile renders it at full
   * contrast for that reason: the window is fat enough to report and no tracked
   * brand — ours or a competitor's — was named in any answer. On a discovery
   * prompt set that is usually the most actionable line on the page.
   */
  kind: "share" | "baseline" | "none-named";
  text: string;
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
 * What the big number on a tile says: MENTION RATE, "how often were we named".
 *
 * That is job 1 in the design's "Primary user & jobs" — "know if we are being
 * named" — and share of voice, which used to headline here, does not answer it.
 * Share is a ratio between brands, so it moves when a competitor is added to
 * the profile (the benchmark card below already has to say so), and it is
 * loudest exactly where it is thinnest: a tenant named in 1 of 84 answers with
 * no competitor named alongside scores 100% share. Mention rate has one
 * denominator, the answers we collected, and a marketer can explain it.
 *
 * Two readings:
 *
 * - `mentionRate === null` — the window is below n >= 30. NOTHING is known,
 *   and the tile says so in words. Rendering it as "0%" is the single worst
 *   thing this surface could do: indistinguishable from a real, terrible
 *   score.
 * - otherwise — the rate, with its band.
 *
 * The band is `mentionWilsonPp`, which describes THIS number: successes and
 * trials both counted in answers. The SOV band (`sovWilsonPp`) is still
 * computed and is deliberately not printed here — a band derived from one
 * metric set beside another is worse than no band at all.
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
 * The band and `n` stay. They are the trust cues, not decoration: a rate
 * without either is a number nobody can check.
 */
export function tileReading(metrics: EngineMetrics): TileReading {
  if (metrics.mentionRate === null) {
    return { kind: "baseline", headline: "Collecting baseline", band: null };
  }
  return {
    kind: "rate",
    headline: `${Math.round(metrics.mentionRate)}%`,
    band: metrics.mentionWilsonPp === null ? null : `±${Math.round(metrics.mentionWilsonPp)} pp`,
  };
}

/**
 * Share of voice, demoted to the small line but not dropped.
 *
 * It keeps the three readings it always had, because the null still means two
 * different things and they are still not the same fact:
 *
 * - `mentionRate === null` — below the threshold; nothing is known, so this
 *   prints an em dash rather than a claim.
 * - `shareOfVoice === null` with a known `mentionRate` — the window IS fat
 *   enough, and no tracked brand was named in any answer. Not "0%": a zero
 *   share implies a denominator, and here nobody won the mentions. It also
 *   says strictly more than the 0% headline above it, which reports only that
 *   WE were not named.
 * - otherwise — a real share.
 */
export function shareReading(metrics: EngineMetrics): ShareReading {
  if (metrics.mentionRate === null) return { kind: "baseline", text: "Share of voice —" };
  if (metrics.shareOfVoice === null) return { kind: "none-named", text: "No brands named" };
  return { kind: "share", text: `Share of voice ${Math.round(metrics.shareOfVoice)}%` };
}

/** The remaining two metrics, after the headline took mention rate and the share line took SOV. */
export function metricsLine(metrics: EngineMetrics): string {
  return [`Cited ${percent(metrics.citationRate)}`, `Recommended ${percent(metrics.recommendationRate)}`].join(
    " · "
  );
}

export type EngineTile = {
  engine: EngineId | "all";
  label: string;
  metrics: EngineMetrics;
  points: RatePoint[];
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
        const share = shareReading(tile.metrics);
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
                    reading.kind === "rate"
                      ? "text-2xl leading-none font-medium tabular-nums"
                      : "text-sm text-muted-foreground"
                  }
                >
                  {reading.headline}
                </span>
                {/* The word, every time. "31%" alone is the number a reader
                    mistakes for share of voice — which is precisely what this
                    tile used to print here. */}
                {reading.kind === "rate" && <span className="text-xs text-muted-foreground">named</span>}
                {reading.band && <span className="text-xs text-muted-foreground tabular-nums">{reading.band}</span>}
              </div>

              {/* Same metric as the headline above it. */}
              <RateSparkline
                points={tile.points}
                ariaLabel={`Mention rate over the last 12 weeks, ${tile.label}`}
              />

              <p className="text-xs text-muted-foreground tabular-nums">n = {tile.metrics.n} answers</p>
              <p className="text-xs text-muted-foreground">
                <span
                  className={
                    // A finding, not an absence: full-contrast text, so it does
                    // not read as "still collecting".
                    share.kind === "none-named" ? "font-medium text-foreground" : undefined
                  }
                >
                  {share.text}
                </span>
                {" · "}
                {metricsLine(tile.metrics)}
              </p>

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
