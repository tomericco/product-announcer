"use client";

import { Line, LineChart, ReferenceDot, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
// The pure derivations live in a non-client module, because a Server Component
// has to call them and anything re-exported THROUGH this file would still be a
// client reference. Import them from "./sparkline-points" directly.
import { sparklineMarkers, type SovPoint } from "./sparkline-points";

// Themed through ChartConfig against existing tokens rather than a literal
// colour, so the line follows the warm palette in both modes.
//
// --brand-ink, NOT --chart-1. Those two are not interchangeable and --chart-1
// is byte-identical to --brand (globals.css): a 1.5px stroke of it sits at
// ~1.4:1 against the card and the whole trend line disappears. The brand guide
// is explicit — any accent-coloured glyph, label or border uses --brand-ink.
// The markers stay on --chart-4 so they read as annotation, not as a second
// series.
const CHART_CONFIG = {
  sov: { label: "Share of voice", color: "var(--brand-ink)" },
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
