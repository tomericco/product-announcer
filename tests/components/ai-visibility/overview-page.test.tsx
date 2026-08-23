import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { EngineId, EngineMetrics, WindowCounts } from "../../../src/lib/ai-visibility/types";
import type { BrandShare } from "../../../src/app/(dashboard)/ai-visibility/competitor-bars";
import type { EngineTile } from "../../../src/app/(dashboard)/ai-visibility/overview-cards";
import type { MatrixRow } from "../../../src/app/(dashboard)/ai-visibility/prompt-matrix";
import type { CitedDomainRow } from "../../../src/app/(dashboard)/ai-visibility/cited-domains-table";
import type { RunEstimate } from "../../../src/app/(dashboard)/ai-visibility/run-now-button";

/**
 * `/ai-visibility` — the overview Server Component itself.
 *
 * An async Server Component is a function returning a Promise of an element
 * tree, so it can be awaited and handed straight to `render()`. That is the
 * ONLY way anything here gets exercised: the page's nine states, the cap
 * notices, the last-run line, the benchmark's three readings, the competitor
 * remainder row and the whole tile derivation live in the page BODY and are
 * not exported. Testing them by re-implementing the arithmetic in the test
 * would prove only that the copy compiles.
 *
 * The four charting children are stubbed to prop recorders. Their own
 * rendering is covered by their own tests; what is uncovered — and what this
 * file is for — is what the page COMPUTES and hands them.
 */

const captured = {
  tiles: null as EngineTile[] | null,
  bars: null as { rows: BrandShare[]; n: number } | null,
  matrix: null as MatrixRow[] | null,
  matrixEngines: null as readonly EngineId[] | null,
  domains: null as CitedDomainRow[] | null,
  runNow: null as {
    estimate: RunEstimate;
    disabledReason: string | null;
    disabledTone?: string;
    label?: string;
  } | null,
  generate: null as { disabledReason: string | null } | null,
};

vi.mock("@/app/(dashboard)/ai-visibility/overview-cards", () => ({
  OverviewCards: (props: { tiles: EngineTile[] }) => {
    captured.tiles = props.tiles;
    return <div data-testid="overview-cards" />;
  },
}));
vi.mock("@/app/(dashboard)/ai-visibility/competitor-bars", () => ({
  CompetitorBars: (props: { rows: BrandShare[]; n: number }) => {
    captured.bars = props;
    return <div data-testid="competitor-bars" />;
  },
}));
vi.mock("@/app/(dashboard)/ai-visibility/prompt-matrix", () => ({
  PromptMatrix: (props: { rows: MatrixRow[]; engines: readonly EngineId[] }) => {
    captured.matrix = props.rows;
    captured.matrixEngines = props.engines;
    return <div data-testid="prompt-matrix" />;
  },
}));
vi.mock("@/app/(dashboard)/ai-visibility/cited-domains-table", () => ({
  CitedDomainsTable: (props: { rows: CitedDomainRow[] }) => {
    captured.domains = props.rows;
    return <div data-testid="cited-domains" />;
  },
}));
vi.mock("@/app/(dashboard)/ai-visibility/run-now-button", () => ({
  RunNowButton: (props: {
    estimate: RunEstimate;
    disabledReason: string | null;
    disabledTone?: string;
    label?: string;
  }) => {
    captured.runNow = props;
    return <div data-testid="run-now" />;
  },
}));
vi.mock("@/app/(dashboard)/ai-visibility/generate-prompt-set-button", () => ({
  GeneratePromptSetButton: (props: { disabledReason: string | null }) => {
    captured.generate = props;
    return <div data-testid="generate-prompt-set">{props.disabledReason ?? "Generate prompt set"}</div>;
  },
}));

const {
  requireSession,
  getAiVisibilitySettings,
  getOrCreateCompanyProfile,
  listPrompts,
  listCompetitors,
  latestRun,
  capExceeded,
  engineMetrics,
  engineHistory,
  promptMatrix,
  runEngineHealth,
  windowCounts,
  citedDomains,
  everSignalledDomains,
  listSignals,
  tenantRows,
} = vi.hoisted(() => ({
  requireSession: vi.fn(),
  getAiVisibilitySettings: vi.fn(),
  getOrCreateCompanyProfile: vi.fn(),
  listPrompts: vi.fn(),
  listCompetitors: vi.fn(),
  latestRun: vi.fn(),
  capExceeded: vi.fn(),
  engineMetrics: vi.fn(),
  engineHistory: vi.fn(),
  promptMatrix: vi.fn(),
  runEngineHealth: vi.fn(),
  windowCounts: vi.fn(),
  citedDomains: vi.fn(),
  everSignalledDomains: vi.fn(),
  listSignals: vi.fn(),
  tenantRows: { value: [{ name: "Versional" }] as { name: string }[] },
}));

vi.mock("@/db", () => ({
  db: { select: () => ({ from: () => ({ where: () => Promise.resolve(tenantRows.value) }) }) },
}));
vi.mock("@/lib/workspace/session", () => ({ requireSession }));
vi.mock("@/lib/workspace/company-profile", () => ({ getOrCreateCompanyProfile }));
vi.mock("@/lib/workspace/competitors", () => ({ listCompetitors }));
vi.mock("@/lib/ai-visibility/settings", () => ({ getAiVisibilitySettings }));
vi.mock("@/lib/ai-visibility/prompts", () => ({ listPrompts, MAX_ACTIVE_PROMPTS: 30 }));
vi.mock("@/lib/ai-visibility/run", () => ({ latestRun }));
vi.mock("@/lib/ai-visibility/cited-domains", () => ({ citedDomains, everSignalledDomains }));
vi.mock("@/lib/signals/query", () => ({ listSignals }));
// `brandMentionTotal` stays REAL — it is the denominator the remainder row is
// derived against, and stubbing it would make the remainder assertions test
// the stub's arithmetic instead of the page's.
vi.mock("@/lib/ai-visibility/metrics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-visibility/metrics")>();
  return {
    ...actual,
    engineMetrics,
    engineHistory,
    promptMatrix,
    runEngineHealth,
    windowCounts,
  };
});
vi.mock("@/lib/ai-visibility/cost", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-visibility/cost")>();
  return { ...actual, capExceeded };
});

const AiVisibilityPage = (await import("@/app/(dashboard)/ai-visibility/page")).default;

const ALL_ENGINES: EngineId[] = ["openai", "gemini", "anthropic"];

function metrics(engine: EngineId | "all", overrides: Partial<EngineMetrics> = {}): EngineMetrics {
  return {
    engine,
    n: 84,
    mentionRate: 62,
    shareOfVoice: 31,
    citationRate: 18,
    recommendationRate: 24,
    mentionWilsonPp: 7,
    sovWilsonPp: 5,
    deltaPp: 3,
    ...overrides,
  };
}

function counts(overrides: Partial<WindowCounts> = {}): WindowCounts {
  return {
    n: 84,
    nGrounded: 84,
    tenantMentions: 20,
    competitorMentions: {},
    ownCitations: 4,
    recommendations: 6,
    ...overrides,
  };
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    status: "complete",
    startedAt: new Date("2026-08-17T09:00:00Z"),
    completedCalls: 252,
    plannedCalls: 252,
    costUsd: 3.12,
    error: null,
    ...overrides,
  };
}

function prompt(overrides: Record<string, unknown> = {}) {
  return { id: "p1", text: "best localization tools", status: "active", intent: "discovery", ...overrides };
}

/** The happy path every test starts from, then narrows. */
function setup(overrides: Record<string, unknown> = {}) {
  const o = overrides as Record<string, never>;
  requireSession.mockResolvedValue({ user: { tenantId: "t1", id: "u1" } });
  getAiVisibilitySettings.mockResolvedValue({
    enabled: true,
    cadence: "weekly",
    dayOfWeek: 1,
    engines: ALL_ENGINES,
    samplesPerPrompt: 3,
    monthlyCapUsd: 20,
    ...((o.settings as object) ?? {}),
  });
  getOrCreateCompanyProfile.mockResolvedValue({
    category: "Localization",
    positioning: "For design teams",
    userPersonas: [],
    updatedAt: new Date("2026-08-01T00:00:00Z"),
    ...((o.profile as object) ?? {}),
  });
  listPrompts.mockResolvedValue((o.prompts as unknown[]) ?? [prompt()]);
  listCompetitors.mockResolvedValue((o.competitors as unknown[]) ?? []);
  latestRun.mockResolvedValue("run" in overrides ? o.run : run());
  capExceeded.mockResolvedValue({
    spentUsd: 4.1,
    estimateUsd: 3.12,
    capUsd: 20,
    exceeded: false,
    reached: false,
    ...((o.cap as object) ?? {}),
  });
  engineMetrics.mockResolvedValue(
    (o.metrics as unknown[]) ?? [...ALL_ENGINES.map((e) => metrics(e)), metrics("all")]
  );
  engineHistory.mockImplementation(async () => (o.history as unknown[]) ?? []);
  promptMatrix.mockResolvedValue((o.matrix as unknown[]) ?? []);
  runEngineHealth.mockResolvedValue((o.health as unknown[]) ?? []);
  windowCounts.mockImplementation(async () => (o.counts as WindowCounts) ?? counts());
  citedDomains.mockResolvedValue((o.domains as unknown[]) ?? []);
  everSignalledDomains.mockResolvedValue(new Set((o.everSignalled as string[]) ?? []));
  listSignals.mockResolvedValue((o.signals as unknown[]) ?? []);
  tenantRows.value = (o.tenant as { name: string }[]) ?? [{ name: "Versional" }];
}

async function renderPage() {
  render(await AiVisibilityPage());
}

beforeEach(() => {
  vi.clearAllMocks();
  captured.tiles = null;
  captured.bars = null;
  captured.matrix = null;
  captured.matrixEngines = null;
  captured.domains = null;
  captured.runNow = null;
  captured.generate = null;
});

describe("overview — the nine states, and that they are mutually exclusive", () => {
  it("Off: says so, routes to Company, and loads no prompts at all", async () => {
    setup({ settings: { enabled: false } });
    await renderPage();

    expect(screen.getByText("AI visibility is off")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Company" })).toHaveAttribute(
      "href",
      "/company#ai-visibility"
    );
    // The whole point of the early return: an off tenant costs no queries.
    expect(listPrompts).not.toHaveBeenCalled();
    expect(screen.queryByTestId("overview-cards")).not.toBeInTheDocument();
    expect(screen.queryByTestId("run-now")).not.toBeInTheDocument();
  });

  it("No prompts: offers generation, disabled with the reason when the profile cannot support it", async () => {
    setup({ prompts: [], profile: { category: null, positioning: null, userPersonas: [] } });
    await renderPage();

    expect(screen.getByText("No prompts yet")).toBeInTheDocument();
    expect(captured.generate?.disabledReason).toBe("Add a category and positioning on Company first.");
  });

  it("No prompts with a configured profile: the control is live", async () => {
    setup({ prompts: [] });
    await renderPage();

    expect(captured.generate?.disabledReason).toBeNull();
  });

  it("No prompts but proposals waiting: sends the reviewer to them instead of drafting more", async () => {
    setup({ prompts: [prompt({ id: "s1", status: "proposed" }), prompt({ id: "s2", status: "proposed" })] });
    await renderPage();

    expect(screen.getByRole("link", { name: "Review 2 prompts" })).toHaveAttribute(
      "href",
      "/ai-visibility/prompts"
    );
    // Drafting a second batch on top of an unreviewed one costs a model call
    // for prompts nobody has looked at yet.
    expect(screen.queryByTestId("generate-prompt-set")).not.toBeInTheDocument();
  });

  it("No run yet: one empty state naming the next scheduled day, not three broken-looking tables", async () => {
    setup({ run: null });
    await renderPage();

    // Twice on purpose: the muted header line and the empty state's own title.
    expect(screen.getByRole("heading", { name: "No run yet" })).toBeInTheDocument();
    expect(screen.getAllByText("No run yet")).toHaveLength(2);
    expect(screen.getByText("First audit Monday — or run it now.")).toBeInTheDocument();
    expect(screen.queryByTestId("overview-cards")).not.toBeInTheDocument();
    expect(screen.queryByTestId("competitor-bars")).not.toBeInTheDocument();
    expect(screen.queryByTestId("prompt-matrix")).not.toBeInTheDocument();
    // Run now is still offered — it is the way out of this state.
    expect(captured.runNow?.disabledReason).toBeNull();
    // And it is offered NEXT TO the sentence that offers it, not only in the
    // opposite corner of the page.
    expect(screen.getAllByTestId("run-now")).toHaveLength(2);
    expect(captured.runNow?.label).toBe("Run first audit now");
  });

  it("No run yet with cadence off: says scheduling is off rather than naming a day that will never come", async () => {
    setup({ run: null, settings: { cadence: "off", dayOfWeek: 1 } });
    await renderPage();

    expect(screen.getByText("Scheduled runs are off. Run it now, or set a cadence in Settings.")).toBeInTheDocument();
  });

  it("Running: the header reports progress and never calls a half-finished run 'Last run'", async () => {
    setup({ run: run({ status: "running", completedCalls: 41, plannedCalls: 270, costUsd: 0.4 }) });
    await renderPage();

    expect(screen.getByText("Running… 41 / 270 calls")).toBeInTheDocument();
    expect(screen.queryByText(/Last run/)).not.toBeInTheDocument();
    // A partial tally must not be printed as a finished run's cost.
    expect(screen.queryByText(/\$0\.40/)).not.toBeInTheDocument();
    // Tiles keep their last values while a run is in flight.
    expect(screen.getByTestId("overview-cards")).toBeInTheDocument();
  });

  it("Running: the button's reason is muted — an in-flight run is not a failure", async () => {
    setup({ run: run({ status: "pending", completedCalls: 0, plannedCalls: 270 }) });
    await renderPage();

    expect(captured.runNow?.disabledReason).toBe("Running… 0 / 270 calls");
    expect(captured.runNow?.disabledTone).toBe("muted");
  });

  it("Paused by cap: quotes the run's own sentence, routes to Settings, and disables Run now destructively", async () => {
    setup({
      cap: { exceeded: true, reached: true, spentUsd: 20.4, capUsd: 20, estimateUsd: 3.12 },
      run: run({ status: "paused_by_cap", error: "Paused — monthly cap reached ($20.40 of $20.00)." }),
    });
    await renderPage();

    expect(screen.getByText(/Paused — monthly cap reached \(\$20\.40 of \$20\.00\)\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Raise it in Settings" })).toHaveAttribute(
      "href",
      "/settings#ai-visibility"
    );
    expect(captured.runNow?.disabledTone).toBe("destructive");
    expect(captured.runNow?.disabledReason).toContain("Paused — monthly cap reached");
  });

  it("Paused by cap with no sentence on the run: composes one rather than showing nothing", async () => {
    setup({
      cap: { exceeded: true, reached: true, spentUsd: 21, capUsd: 20, estimateUsd: 3.12 },
      run: run({ status: "complete", error: null }),
    });
    await renderPage();

    expect(screen.getByText(/Paused — monthly cap reached/)).toBeInTheDocument();
  });

  it("A cap pause the calendar resolved is dated and muted, never the error tone", async () => {
    setup({
      cap: { exceeded: false, reached: false, spentUsd: 1.2, capUsd: 20, estimateUsd: 3.12 },
      run: run({ status: "paused_by_cap", error: "Paused — monthly cap reached ($20.40 of $20.00)." }),
    });
    await renderPage();

    const note = screen.getByText("The Aug 17, 2026 run stopped at the $20.00 monthly cap. Runs have resumed.");
    expect(note.className).toContain("text-muted-foreground");
    expect(note.className).not.toContain("text-destructive");
    // Mutually exclusive with the live warning: last month's spend figure must
    // not be reprinted as a live problem.
    expect(screen.queryByRole("link", { name: "Raise it in Settings" })).not.toBeInTheDocument();
    expect(captured.runNow?.disabledReason).toBeNull();
  });

  it("Partial failure: the failing engine's tile carries the destructive note, the others do not", async () => {
    setup({
      health: [
        { engine: "gemini", erroredPrompts: 9, erroredPromptIds: ["p1"], lastError: "rate limited", totalSamples: 30, okSamples: 3, erroredSamples: 27, refusedSamples: 0 },
        { engine: "openai", erroredPrompts: 0, erroredPromptIds: [], lastError: null, totalSamples: 84, okSamples: 84, erroredSamples: 0, refusedSamples: 0 },
      ],
    });
    await renderPage();

    const byEngine = new Map(captured.tiles!.map((tile) => [tile.engine, tile]));
    expect(byEngine.get("gemini")!.failureNote).toBe(
      "Gemini API, grounded failed on 9 prompts — rate limited"
    );
    expect(byEngine.get("openai")!.failureNote).toBeNull();
    // The pooled tile is not an engine and has no health row of its own.
    expect(byEngine.get("all")!.failureNote).toBeNull();
  });

  it("Model changed: the note and the sparkline tick come from the same comparison", async () => {
    setup({
      history: [
        { runId: "r1", runDate: "2026-08-03T09:00:00Z", mentionPct: 55, sovPct: 30, modelId: "gpt-5.1" },
        { runId: "r2", runDate: "2026-08-10T09:00:00Z", mentionPct: 61, sovPct: 34, modelId: "gpt-5.2" },
      ],
    });
    await renderPage();

    const tile = captured.tiles![0];
    // The sparkline plots the metric the tile headlines — mention rate — and
    // not the share of voice returned beside it in the same history rows.
    expect(tile.points.map((point) => point.rate)).toEqual([55, 61]);
    expect(tile.modelChangeNote).toBe("Model changed to gpt-5.2 this run");
    expect(tile.points.map((point) => point.modelChange)).toEqual([null, "gpt-5.2"]);
    // The first point has nothing to compare against, so it is never a change.
    expect(tile.points[0].modelChange).toBeNull();
  });

  it("A failed run is reported as failed rather than as a run that answered nothing", async () => {
    setup({ run: run({ status: "failed", completedCalls: 0, costUsd: 0 }) });
    await renderPage();

    expect(screen.getByText("Last run Aug 17, 2026 — failed")).toBeInTheDocument();
  });

  it("A complete run prints the date, the answer count and the spend", async () => {
    setup();
    await renderPage();

    expect(screen.getByText("Last run Aug 17, 2026 · 252 answers · $3.12")).toBeInTheDocument();
  });
});

describe("overview — the benchmark's three readings", () => {
  it("Collecting baseline below n >= 30: no bars at all, so the card cannot contradict the tiles", async () => {
    setup({
      metrics: [
        ...ALL_ENGINES.map((e) => metrics(e)),
        metrics("all", {
          n: 12,
          mentionRate: null,
          shareOfVoice: null,
          mentionWilsonPp: null,
          sovWilsonPp: null,
          deltaPp: null,
        }),
      ],
      counts: counts({ n: 12, tenantMentions: 5 }),
    });
    await renderPage();

    expect(
      screen.getByText("Collecting baseline — n = 12 answers. Shares appear once there are enough.")
    ).toBeInTheDocument();
    expect(screen.queryByTestId("competitor-bars")).not.toBeInTheDocument();
  });

  it("A measured zero says nobody was named, rather than drawing every brand at 0%", async () => {
    // n >= 30 (mentionRate is a number) and no tracked brand named at all.
    // A share here would be computed against a denominator of zero.
    setup({
      metrics: [...ALL_ENGINES.map((e) => metrics(e)), metrics("all", { mentionRate: 0, shareOfVoice: null })],
      counts: counts({ tenantMentions: 0, competitorMentions: {} }),
    });
    await renderPage();

    expect(
      screen.getByText("No brands named in any answer — not ours, not a competitor's. n = 84 answers.")
    ).toBeInTheDocument();
    expect(screen.queryByTestId("competitor-bars")).not.toBeInTheDocument();
  });

  it("Ready: us first with a real share, and every configured competitor gets a row even at zero", async () => {
    setup({
      competitors: [
        { id: "c1", name: "Acme", createdAt: new Date("2026-01-01") },
        { id: "c2", name: "Nobody", createdAt: new Date("2026-01-01") },
      ],
      counts: counts({ tenantMentions: 20, competitorMentions: { c1: 30 } }),
    });
    await renderPage();

    const rows = captured.bars!.rows;
    expect(rows.map((row) => row.name)).toEqual(["Versional", "Acme", "Nobody"]);
    expect(rows[0].isTenant).toBe(true);
    expect(rows[0].sharePct).toBeCloseTo(40);
    // A missing bar reads as "not tracked"; a zero bar reads as "not named".
    expect(rows[2].mentions).toBe(0);
    expect(captured.bars!.n).toBe(84);
  });

  it("falls back to a neutral name when the tenant row is somehow missing", async () => {
    setup({ tenant: [] });
    await renderPage();

    expect(captured.bars!.rows[0].name).toBe("You");
  });
});

describe("overview — the deleted-competitor remainder", () => {
  it("names the unaccounted mentions rather than letting the bars disagree with the tile", async () => {
    // c2 was deleted from the profile; its mentions are deliberately kept in
    // the denominator, so the named rows sum to less than 100%.
    setup({
      competitors: [{ id: "c1", name: "Acme", createdAt: new Date("2026-01-01") }],
      counts: counts({ tenantMentions: 20, competitorMentions: { c1: 30, c2: 50 } }),
    });
    await renderPage();

    const rows = captured.bars!.rows;
    const other = rows.find((row) => row.brandId === "other")!;
    expect(other.name).toBe("Other tracked brands");
    expect(other.mentions).toBe(50);
    expect(other.isTenant).toBe(false);
    // Everything on the card now sums to the denominator.
    expect(rows.reduce((sum, row) => sum + row.sharePct, 0)).toBeCloseTo(100);
  });

  it("draws no remainder row when every mention belongs to a brand it can name", async () => {
    setup({
      competitors: [{ id: "c1", name: "Acme", createdAt: new Date("2026-01-01") }],
      counts: counts({ tenantMentions: 20, competitorMentions: { c1: 30 } }),
    });
    await renderPage();

    expect(captured.bars!.rows.some((row) => row.brandId === "other")).toBe(false);
  });

  it("leaves a per-engine cut of the remainder blank when that engine has none", async () => {
    let call = 0;
    setup({
      competitors: [{ id: "c1", name: "Acme", createdAt: new Date("2026-01-01") }],
    });
    // Pooled first, then one cut per engine: only the second engine carries
    // the deleted competitor's mentions.
    windowCounts.mockImplementation(async () => {
      call += 1;
      if (call === 1) return counts({ tenantMentions: 20, competitorMentions: { c1: 30, c2: 50 } });
      if (call === 3) return counts({ n: 21, tenantMentions: 5, competitorMentions: { c1: 5, c2: 50 } });
      return counts({ n: 21, tenantMentions: 5, competitorMentions: { c1: 5 } });
    });
    await renderPage();

    const other = captured.bars!.rows.find((row) => row.brandId === "other")!;
    // A zero remainder is "nothing unaccounted for", not "0% share".
    expect(other.perEngine[0].sharePct).toBeNull();
    expect(other.perEngine[1].sharePct).toBeGreaterThan(0);
  });

  it("blanks a per-engine share when that engine named nobody, instead of dividing by zero", async () => {
    let call = 0;
    setup({ competitors: [{ id: "c1", name: "Acme", createdAt: new Date("2026-01-01") }] });
    windowCounts.mockImplementation(async () => {
      call += 1;
      if (call === 1) return counts({ tenantMentions: 20, competitorMentions: { c1: 30 } });
      return counts({ n: 21, tenantMentions: 0, competitorMentions: {} });
    });
    await renderPage();

    for (const cut of captured.bars!.rows[0].perEngine) expect(cut.sharePct).toBeNull();
  });
});

describe("overview — what the tiles, the matrix and the domain table are handed", () => {
  it("gives a tile to each engine the tenant runs, plus the pooled one, in that order", async () => {
    setup({
      settings: { engines: ["gemini", "openai"] },
      metrics: [metrics("openai"), metrics("gemini"), metrics("all")],
    });
    await renderPage();

    // ENGINE_ORDER, filtered — not the settings array's own order.
    expect(captured.tiles!.map((tile) => tile.engine)).toEqual(["openai", "gemini", "all"]);
    expect(captured.tiles!.map((tile) => tile.label)).toEqual([
      "GPT-5.x API + web search",
      "Gemini API, grounded",
      "All engines",
    ]);
  });

  it("quotes the gate's own dollar estimate, not a second computation of it", async () => {
    setup({ cap: { estimateUsd: 2.75, spentUsd: 1, capUsd: 20, exceeded: false, reached: false } });
    await renderPage();

    expect(captured.runNow!.estimate.usd).toBe(2.75);
  });

  it("counts a brand-check prompt as one call per engine, matching how the cap gate counts it", async () => {
    setup({
      prompts: [
        prompt({ id: "p1", intent: "discovery" }),
        prompt({ id: "p2", intent: "discovery" }),
        prompt({ id: "p3", intent: "brand_check" }),
      ],
    });
    await renderPage();

    // 2 x 3 x 3 + 1 x 3 = 21. A flat prompts x engines x samples would say 27
    // and quote a number the enforcement disagrees with.
    expect(captured.runNow!.estimate.calls).toBe(21);
    expect(captured.runNow!.estimate.prompts).toBe(3);
  });

  it("marks a matrix cell as failed per PROMPT AND ENGINE, and a missing cut as no samples rather than zero", async () => {
    setup({
      health: [{ engine: "anthropic", erroredPrompts: 4, erroredPromptIds: ["p1"], lastError: "429", totalSamples: 12, okSamples: 0, erroredSamples: 12, refusedSamples: 0 }],
      matrix: [
        {
          promptId: "p1",
          text: "best localization tools",
          branded: false,
          cells: [{ engine: "openai", hits: 2, n: 3, competitorsNamed: 2 }],
        },
      ],
    });
    await renderPage();

    const cells = captured.matrix![0].cells;
    expect(cells.openai).toEqual({ named: 2, samples: 3, failed: false, competitors: 2 });
    // Never asked: null, not 0 — 0 would claim we asked and were not named.
    expect(cells.gemini).toEqual({ named: null, samples: 0, failed: false, competitors: 0 });
    expect(cells.anthropic!.failed).toBe(true);
  });

  it("one rate-limited prompt does not blank its engine's other cells", async () => {
    // The regression this whole per-cell carry exists for: `erroredPrompts > 0`
    // used to stamp `failed` onto every cell of the column, so one bad call out
    // of thirty erased twenty-nine readings that were fine.
    setup({
      health: [
        { engine: "gemini", erroredPrompts: 1, erroredPromptIds: ["p1"], lastError: "429", totalSamples: 6, okSamples: 3, erroredSamples: 3, refusedSamples: 0 },
      ],
      matrix: [
        { promptId: "p1", text: "one", branded: false, cells: [{ engine: "gemini", hits: 0, n: 0 }] },
        { promptId: "p2", text: "two", branded: false, cells: [{ engine: "gemini", hits: 3, n: 3 }] },
      ],
    });
    await renderPage();

    const [first, second] = captured.matrix!;
    expect(first.cells.gemini!.failed).toBe(true);
    expect(second.cells.gemini).toEqual({ named: 3, samples: 3, failed: false });
  });

  it("does not mark an engine failed for REFUSING — a refusal is an answer, not an outage", async () => {
    // A refusal is a coverage gap excluded from every rate; an error is a
    // broken engine worth reporting. Only the second one dashes the cells.
    setup({
      health: [
        { engine: "openai", erroredPrompts: 0, erroredPromptIds: [], lastError: null, totalSamples: 12, okSamples: 4, erroredSamples: 0, refusedSamples: 8 },
        { engine: "gemini", erroredPrompts: 2, erroredPromptIds: ["p1"], lastError: "500", totalSamples: 12, okSamples: 0, erroredSamples: 12, refusedSamples: 0 },
      ],
      matrix: [{ promptId: "p1", text: "q", branded: false, cells: [{ engine: "openai", hits: 1, n: 4 }] }],
    });
    await renderPage();

    expect(captured.matrix![0].cells.openai!.failed).toBe(false);
    expect(captured.matrix![0].cells.gemini!.failed).toBe(true);
    // And the tile agrees: no destructive note for an engine that only refused.
    const byEngine = new Map(captured.tiles!.map((tile) => [tile.engine, tile]));
    expect(byEngine.get("openai")!.failureNote).toBeNull();
  });

  it("gives the matrix and the benchmark only the engines the tenant runs", async () => {
    // The tiles already did this. The matrix walked every engine that exists,
    // so a switched-off engine left a permanent column of dashes that reads as
    // an outage rather than as something nobody is paying for.
    setup({
      settings: { engines: ["openai", "anthropic"] },
      matrix: [{ promptId: "p1", text: "q", branded: false, cells: [{ engine: "openai", hits: 2, n: 3 }] }],
      counts: counts({ tenantMentions: 20 }),
    });
    await renderPage();

    expect(captured.matrixEngines).toEqual(["openai", "anthropic"]);
    expect(Object.keys(captured.matrix![0].cells)).toEqual(["openai", "anthropic"]);
    expect(captured.bars!.rows[0].perEngine.map((cut) => cut.engine)).toEqual(["openai", "anthropic"]);
  });

  it("links a third-party domain to the signal that makes Propose brief resolvable, and nothing else", async () => {
    setup({
      domains: [
        { domain: "g2.com", citations: 9, answerShare: 17, engines: ["openai"], domainClass: "third_party" },
        { domain: "acme.com", citations: 3, answerShare: 5, engines: ["gemini"], domainClass: "competitor" },
      ],
      signals: [
        { id: "sig-1", payload: { signalType: "new_cited_domain", domain: "g2.com" } },
        // A different signal kind that happens to carry a domain. Linking a
        // brief to it would attach the wrong evidence to the row.
        { id: "sig-2", payload: { signalType: "competitor_gained", domain: "acme.com" } },
        { id: "sig-3", payload: { signalType: "new_cited_domain", domain: null } },
      ],
      everSignalled: ["g2.com"],
    });
    await renderPage();

    expect(captured.domains).toEqual([
      { domain: "g2.com", citations: 9, answerSharePct: 17, engines: ["openai"], domainClass: "third_party", signalId: "sig-1", everSignalled: true },
      { domain: "acme.com", citations: 3, answerSharePct: 5, engines: ["gemini"], domainClass: "competitor", signalId: null, everSignalled: false },
    ]);
  });

  it("separates a domain whose signal expired from one that never had a signal at all", async () => {
    // Both rows come back from `listSignals` with nothing, because the 60-day
    // window hides the difference. The unwindowed read is the only thing that
    // knows which of the two silences the row is in, and the table says
    // opposite sentences for them.
    setup({
      domains: [
        { domain: "expired.com", citations: 9, answerShare: 17, engines: ["openai"], domainClass: "third_party" },
        { domain: "steady.com", citations: 40, answerShare: 48, engines: ["openai"], domainClass: "third_party" },
      ],
      signals: [],
      everSignalled: ["expired.com"],
    });
    await renderPage();

    expect(captured.domains!.map((row) => [row.domain, row.signalId, row.everSignalled])).toEqual([
      ["expired.com", null, true],
      ["steady.com", null, false],
    ]);
  });

  it("says so in words rather than rendering an empty table when nothing has been cited or matched", async () => {
    setup();
    await renderPage();

    expect(screen.getByText("No citations recorded yet.")).toBeInTheDocument();
    expect(screen.getByText("No prompts have produced an answer yet.")).toBeInTheDocument();
    expect(screen.queryByTestId("cited-domains")).not.toBeInTheDocument();
    expect(screen.queryByTestId("prompt-matrix")).not.toBeInTheDocument();
  });

  it("routes to the prompt set and to the signals these runs produce", async () => {
    // Both links previously existed only inside early-return branches, so the
    // state anyone actually reads weekly was a dead end — including for the
    // gap → signal → brief path this feature exists to claim.
    setup({ prompts: [prompt(), prompt({ id: "p2" })] });
    await renderPage();

    expect(screen.getByRole("link", { name: "2 prompts" })).toHaveAttribute(
      "href",
      "/ai-visibility/prompts"
    );
    expect(screen.getByRole("link", { name: "Signals from these runs" })).toHaveAttribute(
      "href",
      "/signals?kind=ai_visibility"
    );
  });

  it("keeps the API-observed trust cue reachable from the keyboard", async () => {
    setup();
    await renderPage();

    const badge = screen.getByText("API-observed");
    expect(badge.closest("button")).not.toBeNull();
  });
});
