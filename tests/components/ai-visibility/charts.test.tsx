import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RateSparkline } from "../../../src/app/(dashboard)/ai-visibility/rate-sparkline";
// The pure derivations live outside the "use client" module so a Server
// Component can call them — importing them from here mirrors that.
import {
  publishMarkerRunIds,
  sparklineMarkers,
  type RatePoint,
} from "../../../src/app/(dashboard)/ai-visibility/sparkline-points";
import {
  CompetitorBars,
  orderedShares,
  type BrandShare,
} from "../../../src/app/(dashboard)/ai-visibility/competitor-bars";
import { VisibilityTrend } from "../../../src/app/(dashboard)/ai-visibility/visibility-trend";
// Same rule as the sparkline's: the derivations sit outside the "use client"
// module so a Server Component can call them, and importing them from there
// mirrors that.
import {
  hasPlottablePoint,
  MIN_LABEL_GAP_PX,
  trendEndLabels,
  trendRows,
  trendTicks,
  type TrendSeries,
} from "../../../src/app/(dashboard)/ai-visibility/trend-points";

function point(overrides: Partial<RatePoint> = {}): RatePoint {
  return { runId: "r1", label: "Jun 3", rate: 40, modelChange: null, publishedLabel: null, ...overrides };
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

    expect(markers).toEqual([{ runId: "r2", rate: 40, kind: "model", label: "gpt-5.2-2026-07-01" }]);
  });

  it("marks a publish on the same run as a model change without dropping either", () => {
    const markers = sparklineMarkers([
      point({ runId: "r1", modelChange: "gemini-3.1", publishedLabel: "published" }),
    ]);

    expect(markers.map((m) => m.kind)).toEqual(["model", "publish"]);
  });

  it("drops a marker whose run has no plottable value — there is no y to pin it to", () => {
    // A week below the n>=30 threshold reads "Collecting baseline" and has
    // no rate. A ReferenceDot with y=null renders at zero, which would read
    // as "we lost every mention that week".
    expect(sparklineMarkers([point({ rate: null, modelChange: "claude-4.7" })])).toEqual([]);
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

describe("RateSparkline", () => {
  it("carries its meaning in an accessible name, since the drawing is decorative to a screen reader", () => {
    render(<RateSparkline points={[point()]} ariaLabel="Mention rate, last 12 weeks, GPT" />);

    expect(screen.getByRole("img", { name: "Mention rate, last 12 weeks, GPT" })).toBeInTheDocument();
  });

  it("renders the empty shape rather than a chart when there is nothing to plot", () => {
    render(<RateSparkline points={[]} ariaLabel="Mention rate, last 12 weeks, GPT" />);

    expect(screen.getByText("No runs yet")).toBeInTheDocument();
  });

  it("renders the empty shape when every run in the window was too thin to publish", () => {
    // `engineHistory` nulls any run below the aggregate floor, so a young or
    // thin window arrives as a full-length array with nothing plottable in it.
    // Testing only `length === 0` drew an empty 64px box with no line, which
    // reads as a broken chart.
    render(
      <RateSparkline
        points={[point({ runId: "r1", rate: null }), point({ runId: "r2", rate: null })]}
        ariaLabel="Mention rate, last 12 weeks, GPT"
      />
    );

    // And it says WHY. "No runs yet" over twelve runs that all fell below the
    // floor would be false: nothing-happened and not-enough-evidence are the
    // two readings this feature exists to keep apart.
    expect(screen.getByText("Not enough answers yet")).toBeInTheDocument();
    expect(screen.queryByText("No runs yet")).not.toBeInTheDocument();
  });

  it("still draws the chart when one run in the window has a number", () => {
    render(
      <RateSparkline
        points={[point({ runId: "r1", rate: null }), point({ runId: "r2", rate: 40 })]}
        ariaLabel="Mention rate, last 12 weeks, GPT"
      />
    );

    expect(screen.queryByText("Not enough answers yet")).not.toBeInTheDocument();
    expect(screen.queryByText("No runs yet")).not.toBeInTheDocument();
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

  it("breaks a share down over the engines it was handed, not every engine that exists", async () => {
    // A disabled engine has no tile and no matrix column; a permanent "—" row
    // here reads as a broken engine rather than one nobody is paying for.
    render(
      <CompetitorBars
        n={84}
        rows={[
          share({
            brandId: "us",
            name: "Versional",
            isTenant: true,
            perEngine: [
              { engine: "openai", sharePct: 40 },
              { engine: "anthropic", sharePct: null },
            ],
          }),
        ]}
      />
    );

    const trigger = screen.getByRole("button", { name: /Versional/ });
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    fireEvent.mouseEnter(trigger);
    await screen.findByText("ChatGPT API + web search", undefined, { timeout: 2000 });
    expect(screen.getByText("Claude API + web search")).toBeInTheDocument();
    expect(screen.queryByText("Gemini API, grounded")).not.toBeInTheDocument();
    // A brand with no mentions on an engine it DOES run still gets its row.
    expect(screen.getByText("—")).toBeInTheDocument();
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
    const { container } = render(<RateSparkline points={[point()]} ariaLabel="Mention rate" />);

    const theme = container.querySelector("style")!.textContent!;
    expect(theme).toContain("--color-rate: var(--brand-ink);");
    expect(theme).not.toContain("var(--chart-1)");
    expect(theme).not.toContain("--color-rate: var(--brand);");
  });

  it("keeps the benchmark's series token off the raw accent too", () => {
    const { container } = render(<CompetitorBars rows={[share()]} n={84} />);

    const theme = container.querySelector("style")!.textContent!;
    expect(theme).toContain("--color-sharePct: var(--chart-2);");
    expect(theme).not.toContain("var(--chart-1)");
  });
});


const RUN_LABELS = [
  "Jun 1", "Jun 8", "Jun 15", "Jun 22", "Jun 29", "Jul 6",
  "Jul 13", "Jul 20", "Jul 27", "Aug 3", "Aug 10", "Aug 17",
];

/** One trend line over the first `rates.length` runs of RUN_LABELS. */
function line(key: TrendSeries["key"], name: string, rates: (number | null)[]): TrendSeries {
  return {
    key,
    name,
    points: rates.map((rate, index) => ({ runId: `r${index}`, label: RUN_LABELS[index], rate })),
  };
}

/** Four lines: three backdrop engines plus the pooled hero. */
function fourLines(): TrendSeries[] {
  return [
    line("openai", "ChatGPT", [10, 20, 30, 40]),
    line("gemini", "Gemini", [null, 25, 35, 45]),
    line("anthropic", "Claude", [12, 22, 32, 42]),
    line("all", "All engines", [11, 21, 31, 41]),
  ];
}

describe("trendRows", () => {
  it("puts every series on one row per run, aligned by run id", () => {
    const rows = trendRows([line("openai", "ChatGPT", [10, 20]), line("all", "All engines", [11, 21])]);

    expect(rows).toEqual([
      { runId: "r0", label: "Jun 1", openai: 10, all: 11 },
      { runId: "r1", label: "Jun 8", openai: 20, all: 21 },
    ]);
  });

  it("keeps a measured zero, which is a reading and not a missing value", () => {
    // `??`, not `||`. A 0% run means the engines answered and named nobody;
    // dropping it to null would draw a gap where there is a real, bad number.
    expect(trendRows([line("openai", "ChatGPT", [0])])[0].openai).toBe(0);
  });

  it("gives a run one series is missing a null, rather than dropping the run for everyone", () => {
    const rows = trendRows([
      { key: "openai", name: "ChatGPT", points: [{ runId: "r0", label: "Jun 1", rate: 10 }] },
      { key: "all", name: "All engines", points: [] },
    ]);

    expect(rows).toEqual([{ runId: "r0", label: "Jun 1", openai: 10, all: null }]);
  });

  it("takes the run spine from the first series that has any", () => {
    const rows = trendRows([
      { key: "openai", name: "ChatGPT", points: [] },
      line("all", "All engines", [11, 21, 31]),
    ]);

    expect(rows.map((row) => row.label)).toEqual(["Jun 1", "Jun 8", "Jun 15"]);
  });

  it("draws nothing at all when no series has a run", () => {
    expect(trendRows([{ key: "openai", name: "ChatGPT", points: [] }])).toEqual([]);
  });
});

describe("hasPlottablePoint", () => {
  it("is false only when EVERY series is entirely null", () => {
    expect(hasPlottablePoint([line("openai", "ChatGPT", [null, null])])).toBe(false);
    // One number anywhere is enough — the rest are honest gaps, and the pooled
    // line clears the floor several runs before any single engine does.
    expect(
      hasPlottablePoint([line("openai", "ChatGPT", [null, null]), line("all", "All engines", [null, 41])])
    ).toBe(true);
  });
});

describe("trendTicks", () => {
  it("thins twelve run dates to about four, keeping the first and the last", () => {
    const rows = trendRows([line("all", "All engines", RUN_LABELS.map((_, i) => i * 5))]);
    const ticks = trendTicks(rows);

    expect(ticks).toHaveLength(4);
    expect(ticks[0]).toBe("Jun 1");
    expect(ticks.at(-1)).toBe("Aug 17");
    // Evenly spaced, so the axis reads as a scale rather than as four arbitrary
    // dates: twelve labels in the width of a card overlap into a grey smear.
    expect(ticks).toEqual(["Jun 1", "Jun 29", "Jul 20", "Aug 17"]);
  });

  it("labels every run when there are few enough to fit", () => {
    const rows = trendRows([line("all", "All engines", [11, 21, 31])]);
    expect(trendTicks(rows)).toEqual(["Jun 1", "Jun 8", "Jun 15"]);
  });

  it("collapses two runs that share a date rather than ticking it twice", () => {
    const rows = trendRows([
      {
        key: "all",
        name: "All engines",
        points: [
          { runId: "r0", label: "Jun 1", rate: 10 },
          { runId: "r1", label: "Jun 1", rate: 20 },
        ],
      },
    ]);

    expect(trendTicks(rows)).toEqual(["Jun 1"]);
  });
});

describe("trendEndLabels", () => {
  it("pushes converging names apart, because converging is the normal late case", () => {
    // Measured in the DOM before this existed: 60% and 62% put "ChatGPT" and
    // "Claude" 3.2px apart, which at 11px type is one smear exactly where the
    // reader most needs to tell the two lines apart. Three engines answering
    // one prompt set tend toward each other, so this is the common ending, not
    // an edge case.
    const series = [
      line("openai", "ChatGPT", [50, 60]),
      line("anthropic", "Claude", [50, 62]),
    ];
    const rows = trendRows(series);
    const labels = trendEndLabels(rows, series, 150);

    const chatgpt = labels.find((l) => l.key === "openai")!;
    const claude = labels.find((l) => l.key === "anthropic")!;

    // Claude is higher (62), so it keeps its true position and ChatGPT gives way.
    expect(claude.dy).toBe(0);
    expect(chatgpt.dy).toBeGreaterThan(0);

    // Whatever the offsets, the drawn names end up at least a readable gap apart.
    const drawnY = (rate: number, dy: number) => ((100 - rate) / 100) * 150 + dy;
    expect(drawnY(chatgpt.rate, chatgpt.dy) - drawnY(claude.rate, claude.dy)).toBeGreaterThanOrEqual(
      MIN_LABEL_GAP_PX
    );
    // The line itself is untouched — only the name moved.
    expect(chatgpt.rate).toBe(60);
  });

  it("leaves well-separated names exactly where their lines end", () => {
    const series = [line("openai", "ChatGPT", [10]), line("anthropic", "Claude", [90])];
    const rows = trendRows(series);

    for (const label of trendEndLabels(rows, series, 150)) expect(label.dy).toBe(0);
  });

  it("returns labels in series order, so render order does not follow the data", () => {
    // Placement walks top-down by value; the output must not, or the DOM order
    // of the names would change every time the numbers crossed.
    const series = [line("openai", "ChatGPT", [10]), line("all", "All engines", [90])];
    const rows = trendRows(series);

    expect(trendEndLabels(rows, series, 150).map((l) => l.key)).toEqual(["openai", "all"]);
  });

  it("pins each name to its line's LAST PLOTTABLE point, not to the last run", () => {
    // A series whose newest runs fell below the floor ends mid-chart. A label
    // at a null has no y to sit at — the same reason `sparklineMarkers` drops a
    // marker with no rate.
    const series = [line("openai", "ChatGPT", [10, 20, null, null]), line("all", "All engines", [11, 21, 31, 41])];
    const rows = trendRows(series);

    expect(trendEndLabels(rows, series)).toEqual([
      { key: "openai", name: "ChatGPT", label: "Jun 8", rate: 20, dy: 0 },
      { key: "all", name: "All engines", label: "Jun 22", rate: 41, dy: 0 },
    ]);
  });

  it("labels a series with nothing plottable not at all", () => {
    const series = [line("openai", "ChatGPT", [null, null]), line("all", "All engines", [11, 21])];
    expect(trendEndLabels(trendRows(series), series).map((end) => end.key)).toEqual(["all"]);
  });

  it("labels a line whose only reading is a measured zero", () => {
    const series = [line("all", "All engines", [0])];
    expect(trendEndLabels(trendRows(series), series)).toEqual([
      { key: "all", name: "All engines", label: "Jun 1", rate: 0, dy: 0 },
    ]);
  });
});

describe("VisibilityTrend", () => {
  it("says there are no runs yet rather than drawing an empty frame", () => {
    render(<VisibilityTrend series={[{ key: "all", name: "All engines", points: [] }]} />);

    expect(screen.getByText("No runs yet")).toBeInTheDocument();
  });

  it("says the answers are too thin when EVERY series is null, which is a different sentence", () => {
    // "No runs yet" over twelve runs that all fell below the floor would be
    // false. Nothing-happened and not-enough-evidence are the two readings this
    // feature exists to keep apart.
    render(
      <VisibilityTrend
        series={[line("openai", "ChatGPT", [null, null]), line("all", "All engines", [null, null])]}
      />
    );

    expect(screen.getByText("Not enough answers yet")).toBeInTheDocument();
    expect(screen.queryByText("No runs yet")).not.toBeInTheDocument();
  });

  it("draws the chart when one series has one number, leaving the rest as gaps", () => {
    render(
      <VisibilityTrend
        series={[line("openai", "ChatGPT", [null, null]), line("all", "All engines", [null, 41])]}
      />
    );

    expect(screen.queryByText("Not enough answers yet")).not.toBeInTheDocument();
    // The engine with nothing to plot draws an EMPTY path rather than a flat
    // zero — `connectNulls` off and no point to anchor, so there is no line.
    expect(document.querySelector('path[stroke="var(--color-openai)"]')!.getAttribute("d")).toBeFalsy();
    expect(document.querySelector('path[stroke="var(--color-all)"]')!.getAttribute("d")).toBeTruthy();
  });

  it("makes the pooled line the hero and the three engines a 1px backdrop", () => {
    const { container } = render(<VisibilityTrend series={fourLines()} />);

    const lines = [...container.querySelectorAll("path.recharts-line-curve")];
    expect(lines.map((path) => path.getAttribute("stroke"))).toEqual([
      "var(--color-openai)",
      "var(--color-gemini)",
      "var(--color-anthropic)",
      "var(--color-all)",
    ]);
    expect(lines.map((path) => path.getAttribute("stroke-width"))).toEqual(["1", "1", "1", "2"]);
    // The hero is LAST in document order. Recharts paints in child order, so a
    // backdrop drawn after it would cross over the 2px line.
    expect(lines.at(-1)!.getAttribute("stroke")).toBe("var(--color-all)");
  });

  it("tells the engines apart by DASH PATTERN, because the palette cannot do it", () => {
    // Measured against --card, only --chart-3, --chart-4 and --brand-ink clear
    // 3:1 in both themes — and --brand-ink vs --chart-4 is 1.03:1 in light,
    // because they are the same colour. The ramp is sequential, not
    // categorical: there are not three distinguishable steps to spend here.
    const { container } = render(<VisibilityTrend series={fourLines()} />);

    const dashes = [...container.querySelectorAll("path.recharts-line-curve")].map((path) =>
      path.getAttribute("stroke-dasharray")
    );
    expect(dashes).toEqual([null, "5 3", "1 3", null]);
  });

  it("colours the hero --brand-ink and every backdrop --muted-foreground, never --chart-1", () => {
    // --chart-1 is byte-identical to --brand in globals.css and sits at ~1.4:1
    // against the card: a 1px stroke of it is not there at all.
    const { container } = render(<VisibilityTrend series={fourLines()} />);

    const theme = container.querySelector("style")!.textContent!;
    expect(theme).toContain("--color-all: var(--brand-ink);");
    expect(theme).toContain("--color-openai: var(--muted-foreground);");
    expect(theme).toContain("--color-gemini: var(--muted-foreground);");
    expect(theme).toContain("--color-anthropic: var(--muted-foreground);");
    expect(theme).not.toContain("var(--chart-1)");
    expect(theme).not.toContain("var(--brand)");
  });

  it("names each line at its own end, with no legend to map a dash pattern back from", () => {
    const { container } = render(<VisibilityTrend series={fourLines()} />);

    const labels = [...container.querySelectorAll("text.recharts-label")].map((node) => node.textContent);
    expect(labels).toEqual(["ChatGPT", "Gemini", "Claude", "All engines"]);
    expect(container.querySelector(".recharts-legend-wrapper")).toBeNull();
  });

  it("shows both axes — this is the page's one real chart, not a 64px tile glyph", () => {
    // Without a y-axis a reader cannot tell 8% from 80%; without run dates they
    // cannot tell what span they are looking at. Hiding both is right inside a
    // tile, where the number is printed directly above the line, and wrong here.
    const { container } = render(<VisibilityTrend series={fourLines()} />);

    const yTicks = [...container.querySelectorAll(".recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value")];
    expect(yTicks.map((node) => node.textContent)).toEqual(["0%", "50%", "100%"]);

    const xTicks = [...container.querySelectorAll(".recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value")];
    expect(xTicks.map((node) => node.textContent)).toEqual(["Jun 1", "Jun 8", "Jun 15", "Jun 22"]);
  });

  it("puts the numbers in an sr-only table, since role=img with a name says nothing at 48 points", () => {
    render(<VisibilityTrend series={fourLines()} />);

    const table = screen.getByRole("table");
    expect(table.className).toContain("sr-only");
    const headers = [...table.querySelectorAll("thead th")].map((node) => node.textContent);
    expect(headers).toEqual(["Run", "ChatGPT", "Gemini", "Claude", "All engines"]);

    const firstRow = [...table.querySelectorAll("tbody tr")[0].children].map((node) => node.textContent);
    // Gemini's first run fell below the floor. `ratePct` renders it as one em
    // dash — the single substitution this whole feature is arranged against is
    // printing that as "0%".
    expect(firstRow).toEqual(["Jun 1", "10%", "—", "12%", "11%"]);
  });

  it("counts the span in RUNS, never in weeks — a fortnightly tenant reads twelve of these as six months", () => {
    const { container } = render(<VisibilityTrend series={fourLines()} />);

    // Both the visible caption and the data table's own, which are the same
    // sentence deliberately: one string, so they cannot disagree.
    expect(container.querySelector("figcaption")!.textContent).toContain(
      "Mention rate — how often you were named — over the last 4 runs."
    );
    expect(screen.getByRole("table").querySelector("caption")!.textContent).toContain("4 runs");
    expect(screen.queryByText(/weeks/)).not.toBeInTheDocument();
  });

  it("draws one line and skips the pooling caveat for a one-engine tenant", () => {
    // The page drops "all" when there is one engine, because the pooled cut IS
    // that engine's cut. Nothing here special-cases it: one series, no backdrop
    // to distinguish it from, and no sentence explaining a line that is absent.
    const { container } = render(<VisibilityTrend series={[line("anthropic", "Claude", [12, 22])]} />);

    expect(container.querySelectorAll("path.recharts-line-curve")).toHaveLength(1);
    expect(screen.queryByText(/All engines pools/)).not.toBeInTheDocument();
    expect([...container.querySelectorAll("text.recharts-label")].map((n) => n.textContent)).toEqual([
      "Claude",
    ]);
  });
});
