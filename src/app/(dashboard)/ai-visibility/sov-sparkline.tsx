"use client";

import { Line, LineChart, ReferenceDot, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";

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
 *
 * A pure derivation, exported for the prompt detail page (Task H11) and
 * pinned by unit test — the same reason `sparklineMarkers` lives here.
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

// Themed through ChartConfig against the existing --chart-* tokens in
// globals.css rather than a literal colour, so the line follows the warm
// palette in both modes. --chart-1 is the accent itself; the markers sit on
// --chart-4 so they read as annotation, not as a second series.
const CHART_CONFIG = {
  sov: { label: "Share of voice", color: "var(--chart-1)" },
} satisfies ChartConfig;

/**
 * A LineChart with both axes hidden — the numbers live in the tile above it,
 * and axis furniture at this size is noise. The wrapper carries the
 * accessible name: the SVG itself is decorative to a screen reader (Recharts
 * emits no readable structure), so without this the trend is unavailable
 * to anyone not looking at it.
 */
export function SovSparkline({ points, ariaLabel }: { points: SovPoint[]; ariaLabel: string }) {
  if (points.length === 0) {
    return (
      <div role="img" aria-label={ariaLabel} className="flex h-16 items-center text-xs text-muted-foreground">
        No runs yet
      </div>
    );
  }

  const markers = sparklineMarkers(points);

  return (
    <div role="img" aria-label={ariaLabel}>
      <ChartContainer config={CHART_CONFIG} className="h-16 w-full">
        <LineChart data={points} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
          <XAxis dataKey="label" hide />
          <YAxis hide domain={[0, 100]} />
          <ChartTooltip content={<ChartTooltipContent labelKey="label" />} />
          <Line
            dataKey="sov"
            type="monotone"
            stroke="var(--color-sov)"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
          {markers.map((marker) => {
            // The XAxis is a CATEGORY axis on `label`, so ReferenceDot's `x`
            // must be the category VALUE (the point's label), never a
            // numeric index — an index silently fails to position the dot.
            const markerPoint = points.find((point) => point.runId === marker.runId);
            if (!markerPoint) return null;
            return (
              <ReferenceDot
                key={`${marker.runId}-${marker.kind}`}
                x={markerPoint.label}
                y={marker.sov}
                r={3}
                // Theme tokens directly: `--color-*` variables exist only for
                // ChartConfig series keys (here, `--color-sov`).
                fill="var(--chart-4)"
                stroke="var(--background)"
                strokeWidth={1}
                label={{ value: marker.label, position: "top", fontSize: 10, fill: "var(--muted-foreground)" }}
              />
            );
          })}
        </LineChart>
      </ChartContainer>
    </div>
  );
}
