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
export type TrendEndLabel = { key: TrendKey; name: string; label: string; rate: number };

/**
 * The end-of-line labels, one per series that has anything to label.
 *
 * The LAST PLOTTABLE point, not the last row: a series whose newest runs fell
 * below the floor ends mid-chart, and a label pinned to a null would have no y
 * to sit at — the same reason `sparklineMarkers` drops a marker with no rate.
 * Labelling in place is what lets the three backdrop engines be told apart by
 * dash pattern alone, with no legend swatches to map back to lines.
 */
export function trendEndLabels(
  rows: readonly TrendRow[],
  series: readonly TrendSeries[]
): TrendEndLabel[] {
  return series.flatMap((line) => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const rate = rows[i][line.key];
      if (typeof rate === "number") {
        return [{ key: line.key, name: line.name, label: rows[i].label, rate }];
      }
    }
    return [];
  });
}
