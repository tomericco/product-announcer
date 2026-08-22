import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SovSparkline } from "../../../src/app/(dashboard)/ai-visibility/sov-sparkline";
// The pure derivations live outside the "use client" module so a Server
// Component can call them — importing them from here mirrors that.
import {
  publishMarkerRunIds,
  sparklineMarkers,
  type SovPoint,
} from "../../../src/app/(dashboard)/ai-visibility/sparkline-points";
import {
  CompetitorBars,
  orderedShares,
  type BrandShare,
} from "../../../src/app/(dashboard)/ai-visibility/competitor-bars";

function point(overrides: Partial<SovPoint> = {}): SovPoint {
  return { runId: "r1", label: "Jun 3", sov: 40, modelChange: null, publishedLabel: null, ...overrides };
}

function share(overrides: Partial<BrandShare> = {}): BrandShare {
  return {
    brandId: "b1",
    name: "Acme",
    isTenant: false,
    mentions: 10,
    sharePct: 25,
    perEngine: [],
    ...overrides,
  };
}

describe("sparklineMarkers", () => {
  it("marks the run where the model id changed, with the model's name", () => {
    const markers = sparklineMarkers([
      point({ runId: "r1" }),
      point({ runId: "r2", modelChange: "gpt-5.2-2026-07-01" }),
    ]);

    expect(markers).toEqual([{ runId: "r2", sov: 40, kind: "model", label: "gpt-5.2-2026-07-01" }]);
  });

  it("marks a publish on the same run as a model change without dropping either", () => {
    const markers = sparklineMarkers([
      point({ runId: "r1", modelChange: "gemini-3.1", publishedLabel: "published" }),
    ]);

    expect(markers.map((m) => m.kind)).toEqual(["model", "publish"]);
  });

  it("drops a marker whose run has no plottable value — there is no y to pin it to", () => {
    // A week below the n>=30 threshold reads "Collecting baseline" and has
    // no SOV. A ReferenceDot with y=null renders at zero, which would read
    // as "SOV collapsed to nothing that week".
    expect(sparklineMarkers([point({ sov: null, modelChange: "claude-4.7" })])).toEqual([]);
  });
});

describe("publishMarkerRunIds", () => {
  const RUNS = [
    { runId: "r1", runDate: "2026-06-01T09:00:00.000Z" },
    { runId: "r2", runDate: "2026-06-08T09:00:00.000Z" },
    { runId: "r3", runDate: "2026-06-15T09:00:00.000Z" },
  ];

  it("attaches a publish to the first run at or after it — runs are weekly, publishes are any weekday", () => {
    // Published on the Wednesday between two Monday runs: the SECOND run is
    // the first that could have observed the change. Keying by same
    // calendar day (the naive approach) would mark nothing at all here.
    expect(publishMarkerRunIds(RUNS, [new Date("2026-06-03T12:00:00.000Z")])).toEqual(new Set(["r2"]));
  });

  it("marks the same-instant run, not the one after", () => {
    expect(publishMarkerRunIds(RUNS, [new Date("2026-06-08T09:00:00.000Z")])).toEqual(new Set(["r2"]));
  });

  it("falls back to the newest run for a piece published after the last run in the window", () => {
    expect(publishMarkerRunIds(RUNS, [new Date("2026-06-20T00:00:00.000Z")])).toEqual(new Set(["r3"]));
  });

  it("collects one runId per publish, deduplicated", () => {
    expect(
      publishMarkerRunIds(RUNS, [
        new Date("2026-05-20T00:00:00.000Z"), // before every run → first run
        new Date("2026-06-03T00:00:00.000Z"),
        new Date("2026-06-04T00:00:00.000Z"), // same target run as above
      ])
    ).toEqual(new Set(["r1", "r2"]));
  });

  it("marks nothing when there are no runs to pin a marker to", () => {
    expect(publishMarkerRunIds([], [new Date("2026-06-03T00:00:00.000Z")])).toEqual(new Set());
  });
});

describe("SovSparkline", () => {
  it("carries its meaning in an accessible name, since the drawing is decorative to a screen reader", () => {
    render(<SovSparkline points={[point()]} ariaLabel="Share of voice, last 12 weeks, GPT" />);

    expect(screen.getByRole("img", { name: "Share of voice, last 12 weeks, GPT" })).toBeInTheDocument();
  });

  it("renders the empty shape rather than a chart when there is nothing to plot", () => {
    render(<SovSparkline points={[]} ariaLabel="Share of voice, last 12 weeks, GPT" />);

    expect(screen.getByText("No runs yet")).toBeInTheDocument();
  });
});

describe("orderedShares", () => {
  it("puts us first, then the rest by share descending", () => {
    const ordered = orderedShares([
      share({ brandId: "c1", name: "Competitor A", sharePct: 40 }),
      share({ brandId: "us", name: "Versional", isTenant: true, sharePct: 12 }),
      share({ brandId: "c2", name: "Competitor B", sharePct: 55 }),
    ]);

    expect(ordered.map((row) => row.name)).toEqual(["Versional", "Competitor B", "Competitor A"]);
  });

  it("breaks a tie by name so the order does not shuffle between runs", () => {
    const ordered = orderedShares([
      share({ brandId: "c2", name: "Bravo", sharePct: 30 }),
      share({ brandId: "c1", name: "Alpha", sharePct: 30 }),
    ]);

    expect(ordered.map((row) => row.name)).toEqual(["Alpha", "Bravo"]);
  });
});

describe("CompetitorBars", () => {
  it("states n and the share footnote, because a share without both is unreadable", () => {
    render(<CompetitorBars rows={[share({ isTenant: true, name: "Versional" })]} n={84} />);

    expect(screen.getByText("n = 84 answers")).toBeInTheDocument();
    expect(screen.getByText("Adding a competitor lowers every share.")).toBeInTheDocument();
  });

  it("outlines our own bar in --brand-ink so the one bar the card is about is not the faintest thing in it", () => {
    // --brand is a FILL token: at L 0.885 it sits at ~1.2:1 against the card.
    // Filled and left unoutlined, our bar disappears next to every competitor's
    // much darker --chart-3. The guide's rule is that any accent-coloured
    // border is --brand-ink, and this is the border.
    const { container } = render(
      <CompetitorBars
        n={84}
        rows={[
          share({ brandId: "us", name: "Versional", isTenant: true, sharePct: 40 }),
          share({ brandId: "c1", name: "Acme", sharePct: 25 }),
        ]}
      />
    );

    const bars = [...container.querySelectorAll("path.recharts-rectangle")];
    expect(bars.map((bar) => bar.getAttribute("fill"))).toEqual(["var(--brand)", "var(--chart-3)"]);
    expect(bars[0].getAttribute("stroke")).toBe("var(--brand-ink)");
    // One accent per region: a competitor bar is a neutral chart tone with no
    // outline at all.
    expect(bars[1].getAttribute("stroke")).toBe("none");
  });

  it("labels every row with its share, us first, in the same order as the bars", () => {
    render(
      <CompetitorBars
        n={84}
        rows={[
          share({ brandId: "c1", name: "Acme", sharePct: 25.4 }),
          share({ brandId: "us", name: "Versional", isTenant: true, sharePct: 40 }),
          share({ brandId: "other", name: "Other tracked brands", sharePct: 12 }),
        ]}
      />
    );

    const labels = screen.getAllByRole("button").map((button) => button.textContent);
    expect(labels).toEqual(["Versional · 40%", "Acme · 25%", "Other tracked brands · 12%"]);
  });
});

describe("chart theming", () => {
  it("draws the sparkline in --brand-ink, never in --chart-1", () => {
    // --chart-1 is byte-identical to --brand in globals.css. A 1.5px stroke of
    // it sits at ~1.4:1 against the card and the whole trend line vanishes.
    const { container } = render(<SovSparkline points={[point()]} ariaLabel="Share of voice" />);

    const theme = container.querySelector("style")!.textContent!;
    expect(theme).toContain("--color-sov: var(--brand-ink);");
    expect(theme).not.toContain("var(--chart-1)");
    expect(theme).not.toContain("--color-sov: var(--brand);");
  });

  it("keeps the benchmark's series token off the raw accent too", () => {
    const { container } = render(<CompetitorBars rows={[share()]} n={84} />);

    const theme = container.querySelector("style")!.textContent!;
    expect(theme).toContain("--color-sharePct: var(--chart-2);");
    expect(theme).not.toContain("var(--chart-1)");
  });
});
