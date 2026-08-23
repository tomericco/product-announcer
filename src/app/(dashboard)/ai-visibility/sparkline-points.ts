/**
 * The sparkline's data shapes and the two pure derivations over them.
 *
 * Deliberately NOT in `rate-sparkline.tsx`, and this file deliberately has no
 * `"use client"` directive. A function exported from a client module is a
 * client *reference*, not a function: the server can render it as a component
 * or pass it as a prop, but calling it throws
 *
 *     Attempted to call publishMarkerRunIds() from the server but
 *     publishMarkerRunIds is on the client.
 *
 * which is exactly what the prompt detail page — a Server Component — did.
 * jsdom cannot catch that: `"use client"` is inert under vitest, so the unit
 * tests called these directly and passed. Only a real render finds it.
 *
 * Anything server-rendered code needs to compute belongs here; the chart
 * component beside it imports these too, so there is one definition.
 */

/**
 * One run's point on a 12-RUN sparkline. Runs, not weeks: cadence is a tenant
 * setting and can be fortnightly.
 *
 * `rate` is a percentage, 0..100 — on the one surface left that draws this,
 * `/ai-visibility/prompts/[promptId]`, how often that engine named us on that
 * one prompt. It was called `sov` back when the overview tile headlined share
 * of voice and the prompt card — which never plotted a share — borrowed the
 * name; a chart whose field name disagrees with what it draws is how a line
 * ends up labelled as the wrong metric.
 *
 * The overview no longer uses any of this: its four tile sparklines are one
 * `VisibilityTrend` chart, whose own shapes live in `trend-points.ts` for the
 * same server/client reason spelled out above.
 *
 * Nullable on purpose: a run whose cut fell below the display threshold has no
 * publishable number, and Recharts renders a null as a gap (`connectNulls` left
 * off) rather than as a zero. Zero and "not enough answers to say" are the two
 * readings this whole feature exists to keep apart.
 */
export type RatePoint = {
  runId: string;
  label: string;
  rate: number | null;
  modelChange: string | null;
  publishedLabel: string | null;
};

export type SparklineMarker = { runId: string; rate: number; kind: "model" | "publish"; label: string };

/**
 * The tick marks drawn on the line: a model-version change (the spec's
 * annotation, so a jump is not misread as a content win) and a publish date
 * (deliberately with no causal copy).
 *
 * A point with no plottable `rate` yields no marker — a `ReferenceDot` needs a
 * y, and pinning it at 0 would draw a collapse that did not happen. Both
 * marker kinds can land on the same run, so this returns a flat list rather
 * than at most one per point.
 */
export function sparklineMarkers(points: RatePoint[]): SparklineMarker[] {
  const markers: SparklineMarker[] = [];
  for (const point of points) {
    if (point.rate === null) continue;
    if (point.modelChange) {
      markers.push({ runId: point.runId, rate: point.rate, kind: "model", label: point.modelChange });
    }
    if (point.publishedLabel) {
      markers.push({ runId: point.runId, rate: point.rate, kind: "publish", label: point.publishedLabel });
    }
  }
  return markers;
}

/**
 * Which run should carry each "published" marker.
 *
 * Runs are weekly and publishes land on any weekday, so requiring the two to
 * share a calendar day would draw a marker almost never. Each publish is
 * attached to the FIRST run at-or-after it — the run that could first have
 * observed the change — falling back to the newest run for a piece published
 * after the last run in the window. `runs` must be oldest-first, which is
 * how every history query returns them.
 */
export function publishMarkerRunIds(
  runs: readonly { runId: string; runDate: string }[],
  publishedAts: readonly Date[]
): Set<string> {
  const marked = new Set<string>();
  if (runs.length === 0) return marked;
  for (const publishedAt of publishedAts) {
    const at = publishedAt.getTime();
    const firstAtOrAfter = runs.find((run) => new Date(run.runDate).getTime() >= at);
    marked.add((firstAtOrAfter ?? runs[runs.length - 1]).runId);
  }
  return marked;
}
