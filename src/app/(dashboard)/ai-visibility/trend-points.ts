/**
 * The overview trend chart's data shapes and the pure derivations over them.
 *
 * Deliberately NOT in `visibility-trend.tsx`, and this file deliberately has no
 * `"use client"` directive — the same rule `sparkline-points.ts` documents at
 * length. A function exported from a client module is a client *reference*, not
 * a function: the server can render it as a component or pass it as a prop, but
 * calling it throws, and jsdom cannot catch that because `"use client"` is inert
 * under vitest. `tests/app/client-module-boundary.test.ts` enforces it.
 *
 * The overview page is a Server Component and it composes the series here, so
 * everything below has to be callable from the server even where only the chart
 * happens to call it today.
 */

import type { EngineId } from "@/lib/ai-visibility/types";

/** Every key the chart can draw: one per enabled engine, plus the pooled one. */
export type TrendKey = EngineId | "all";

/**
 * One line on the chart, as the page hands it over.
 *
 * `rate` is a MENTION rate, 0..100 — how often the engine named us — and not
 * share of voice. A share is a ratio between brands, so adding a competitor in
 * week 6 draws a step down on every line at once; over a twelve-run trend that
 * step is a settings change wearing the costume of a visibility change. Mention
 * rate has one denominator, the answers we collected.
 *
 * Nullable on purpose: a run whose cut fell below the display floor has no
 * publishable number, and the chart renders a null as a GAP (`connectNulls`
 * off) rather than as a zero. Zero and "not enough answers to say" are the two
 * readings this whole feature exists to keep apart.
 *
 * The floor is `MIN_N_HISTORY` (15), applied per run by `engineHistory` — NOT
 * the `MIN_N_AGGREGATE` (30) the tiles headline under, and NOT copied into
 * this file. Every line here is held to the same one, the pooled "All engines"
 * included. Consequence to expect when reading a rendered chart: at n=15 a
 * per-engine point carries roughly +/-25pp of Wilson noise, so single-run
 * wiggles on the backdrop lines are noise, and only the hero has enough
 * samples behind it to be read run-to-run.
 */
export type TrendSeries = {
  key: TrendKey;
  /** Drawn at the end of the line and used as the data table's column header. */
  name: string;
  points: readonly { runId: string; label: string; rate: number | null }[];
};

/**
 * One run's row, flattened for Recharts: `runId` and `label` plus one entry per
 * series key. Flat because `dataKey` addresses a top-level field — a nested
 * shape would need path strings, which is a silent-failure mode this file's
 * whole job is to avoid.
 */
export type TrendRow = { runId: string; label: string } & Partial<Record<TrendKey, number | null>>;

/**
 * The chart's rows: one per run, oldest first, every series aligned to it.
 *
 * Every series comes from the same `historyRuns` list, so the runs and their
 * order are shared; the spine is taken from the first series that has any, and
 * a series missing a run yields `null` — a gap for that line alone — rather
 * than dropping the run for everyone.
 */
export function trendRows(series: readonly TrendSeries[]): TrendRow[] {
  const spine = series.find((line) => line.points.length > 0)?.points ?? [];
  const byKey = new Map(
    series.map((line) => [line.key, new Map(line.points.map((point) => [point.runId, point.rate]))])
  );

  return spine.map((point) => {
    const row: TrendRow = { runId: point.runId, label: point.label };
    for (const line of series) {
      // `??`, not `||`: a measured 0% is a reading and must survive.
      row[line.key] = byKey.get(line.key)?.get(point.runId) ?? null;
    }
    return row;
  });
}

/** Whether ANY series has a plottable value — the "draw a chart at all" test. */
export function hasPlottablePoint(series: readonly TrendSeries[]): boolean {
  return series.some((line) => line.points.some((point) => point.rate !== null));
}

/**
 * Which run dates get an x-axis tick.
 *
 * Twelve dates in the width of a card overlap into a grey smear, so the axis is
 * thinned to about four, evenly spaced, always including the first and the last
 * — the two a reader needs to know what span they are looking at. Duplicates
 * (two runs on one date) collapse, so this can return fewer than `max`.
 */
export function trendTicks(rows: readonly TrendRow[], max = 4): string[] {
  if (max < 2 || rows.length <= max) return [...new Set(rows.map((row) => row.label))];

  const step = (rows.length - 1) / (max - 1);
  const picked: string[] = [];
  for (let i = 0; i < max; i++) {
    const label = rows[Math.round(i * step)].label;
    if (!picked.includes(label)) picked.push(label);
  }
  return picked;
}

/** Where a line's name is drawn: at its last plottable point. */
export type TrendEndLabel = {
  key: TrendKey;
  name: string;
  label: string;
  rate: number;
  /** Pixels to shift the NAME by, so two converging lines do not share a label position. */
  dy: number;
};

/**
 * The end-of-line labels, one per series that has anything to label.
 *
 * The LAST PLOTTABLE point, not the last row: a series whose newest runs fell
 * below the floor ends mid-chart, and a label pinned to a null would have no y
 * to sit at — the same reason `sparklineMarkers` drops a marker with no rate.
 * Labelling in place is what lets the three backdrop engines be told apart by
 * dash pattern alone, with no legend swatches to map back to lines.
 */
/**
 * Vertical breathing room between two end-of-line labels, in pixels.
 *
 * 11px text needs about this much before two names read as one smear.
 */
export const MIN_LABEL_GAP_PX = 13;

/**
 * Where the labels actually sit, after pushing apart the ones that would overlap.
 *
 * Placing each name at its own line's last value is correct until two lines
 * converge — and converging is the NORMAL late-window case, not an edge one:
 * three engines answering the same prompt set tend toward each other. Measured
 * in the DOM at 60% and 62%, two labels landed 3.2px apart, which at 11px text
 * is one unreadable smear where the reader most needs to tell the lines apart.
 *
 * So this walks them top-down and pushes any label that is too close to its
 * neighbour further down, returning a `dy` in pixels for the renderer to apply.
 * The line still ends where its data ends; only the NAME moves, which is the
 * honest trade — a label a few pixels off its line is readable and unambiguous,
 * two labels on top of each other are neither.
 *
 * `plotHeightPx` is the drawing area, not the chart box; the caller subtracts
 * its own margins. Rates are 0..100 with 0 at the bottom, so a higher rate is
 * a SMALLER y.
 */
export function trendEndLabels(
  rows: readonly TrendRow[],
  series: readonly TrendSeries[],
  plotHeightPx = 150
): TrendEndLabel[] {
  const found = series.flatMap((line) => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const rate = rows[i][line.key];
      if (typeof rate === "number") {
        return [{ key: line.key, name: line.name, label: rows[i].label, rate, dy: 0 }];
      }
    }
    return [];
  });

  // Top-down, so the highest line keeps its true position and the ones below
  // give way. The alternative — nudging both halves of a pair — moves labels
  // that had no collision.
  const byHeight = [...found].sort((a, b) => b.rate - a.rate);
  const toY = (rate: number) => ((100 - rate) / 100) * plotHeightPx;

  let lastY = Number.NEGATIVE_INFINITY;
  for (const label of byHeight) {
    const naturalY = toY(label.rate);
    const placedY = Math.max(naturalY, lastY + MIN_LABEL_GAP_PX);
    label.dy = Math.round(placedY - naturalY);
    lastY = placedY;
  }

  // Back to series order, so the render order does not depend on the data.
  return found;
}
