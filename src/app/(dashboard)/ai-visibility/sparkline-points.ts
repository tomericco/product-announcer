/**
 * The sparkline's data shapes and the two pure derivations over them.
 *
 * Deliberately NOT in `sov-sparkline.tsx`, and this file deliberately has no
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
 * One run's point on a 12-week share-of-voice sparkline.
 *
 * `sov` is nullable on purpose: a week whose cut fell below the n >= 30
 * display threshold has no publishable number, and Recharts renders a null
 * as a gap (`connectNulls` left off) rather than as a zero. Zero and
 * "not enough answers to say" are the two readings this whole feature
 * exists to keep apart.
 */
export type SovPoint = {
  runId: string;
  label: string;
  sov: number | null;
  modelChange: string | null;
  publishedLabel: string | null;
};

export type SparklineMarker = { runId: string; sov: number; kind: "model" | "publish"; label: string };

/**
 * The tick marks drawn on the line: a model-version change (the spec's
 * annotation, so a jump is not misread as a content win) and a publish date
 * (deliberately with no causal copy).
 *
 * A point with no plottable `sov` yields no marker — a `ReferenceDot` needs a
 * y, and pinning it at 0 would draw a collapse that did not happen. Both
 * marker kinds can land on the same run, so this returns a flat list rather
 * than at most one per point.
 */
export function sparklineMarkers(points: SovPoint[]): SparklineMarker[] {
  const markers: SparklineMarker[] = [];
  for (const point of points) {
    if (point.sov === null) continue;
    if (point.modelChange) {
      markers.push({ runId: point.runId, sov: point.sov, kind: "model", label: point.modelChange });
    }
    if (point.publishedLabel) {
      markers.push({ runId: point.runId, sov: point.sov, kind: "publish", label: point.publishedLabel });
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
