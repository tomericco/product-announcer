"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { EngineId, EngineMetrics } from "@/lib/ai-visibility/types";
import { ENGINE_LABEL } from "./engine-labels";
import { engineGridClass } from "./engine-grid";
import { ratePct } from "./format";
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
    headline: ratePct(metrics.mentionRate),
    band: metrics.mentionWilsonPp === null ? null : `±${Math.round(metrics.mentionWilsonPp)} pp`,
  };
}

export type EngineTile = {
  engine: EngineId | "all";
  /**
   * The tile's title — the SHORT engine name ("GPT"), not the methodology one.
   *
   * `ENGINE_LABEL` ("GPT-5.x API + web search") is ~180px of card header wide
   * and was rendered truncated on every tile, so the only part a reader saw was
   * the part the abbreviation already says. The "API-observed" badge in the
   * page header carries the proxy caveat once, with the tooltip that explains
   * it; the full name is still what the tooltip, the failure note and this
   * card's `title` attribute use.
   */
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
        // The methodology name, for the places a full sentence fits: the
        // header's `title`, and the sparkline's accessible name, where "GPT"
        // alone would be the whole thing a screen reader is told.
        const fullName = tile.engine === "all" ? "All engines" : ENGINE_LABEL[tile.engine];
        return (
          <Card key={tile.engine} size="sm">
            <CardHeader>
              <CardTitle className="truncate" title={fullName}>
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
                ariaLabel={`Mention rate over the last 12 weeks, ${fullName}`}
              />

              {/* Plain words, not "n = 84 answers". `n` on this tile and
                  `completedCalls` in the header are different counts — this one
                  excludes errors, refusals and brand-check prompts — and the
                  algebraic prefix made the smaller of the two look like the
                  authoritative one.

                  The `Share of voice · Cited · Recommended` line that used to
                  sit here is gone: twelve numbers in the page's densest row,
                  three em dashes joined by interpuncts in the baseline state,
                  and a share of voice the benchmark card below already states
                  twice. The metrics are still computed; citation rate is now
                  stated once, on the Cited-sources card, beside the denominator
                  it is actually measured over. */}
              <p className="text-xs text-muted-foreground tabular-nums">{tile.metrics.n} answers read</p>

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
