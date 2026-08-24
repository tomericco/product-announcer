import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { EngineId } from "../../../src/lib/ai-visibility/types";
import type { SampleView } from "../../../src/app/(dashboard)/ai-visibility/prompts/[promptId]/engine-tabs";
import type { AnswerAlias } from "../../../src/app/(dashboard)/ai-visibility/prompts/[promptId]/highlighted-answer";
import type { RatePoint } from "../../../src/app/(dashboard)/ai-visibility/sparkline-points";
import type { CitedDomainRow } from "../../../src/app/(dashboard)/ai-visibility/cited-domains-table";

/**
 * `/ai-visibility/prompts/[promptId]` — the detail Server Component.
 *
 * Awaited and rendered. The alias table (built from the tenant's NAME, never
 * its category), the `?engine=` tab choice, the per-engine "named in x of y"
 * counting, the sub-threshold null in the sparkline and the deliberate null
 * `signalId` on this page's domain table are all page-body derivations.
 */

const captured = {
  tabs: null as { engines: EngineId[]; samples: SampleView[]; aliases: AnswerAlias[]; initialEngine: EngineId } | null,
  sparklines: [] as { points: RatePoint[]; ariaLabel: string }[],
  domains: null as CitedDomainRow[] | null,
};

vi.mock("@/app/(dashboard)/ai-visibility/prompts/[promptId]/engine-tabs", () => ({
  EngineTabs: (props: NonNullable<typeof captured.tabs>) => {
    captured.tabs = props;
    return <div data-testid="engine-tabs" />;
  },
}));
vi.mock("@/app/(dashboard)/ai-visibility/rate-sparkline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/(dashboard)/ai-visibility/rate-sparkline")>();
  return {
    ...actual,
    RateSparkline: (props: { points: RatePoint[]; ariaLabel: string }) => {
      captured.sparklines.push(props);
      return <div data-testid="sparkline" />;
    },
  };
});
vi.mock("@/app/(dashboard)/ai-visibility/cited-domains-table", () => ({
  CitedDomainsTable: (props: { rows: CitedDomainRow[] }) => {
    captured.domains = props.rows;
    return <div data-testid="cited-domains" />;
  },
}));

const {
  requireSession,
  getAiVisibilitySettings,
  effectiveEngines,
  listCompetitors,
  getPrompt,
  promptSamples,
  promptHistory,
  citedDomains,
  relatedPieces,
  notFound,
  tenantRows,
} = vi.hoisted(() => ({
  requireSession: vi.fn(),
  getAiVisibilitySettings: vi.fn(),
  // BYOK: both pages read the EFFECTIVE engine list, not `settings.engines`.
  effectiveEngines: vi.fn(async () => ["openai", "gemini", "anthropic"]),
  listCompetitors: vi.fn(),
  getPrompt: vi.fn(),
  promptSamples: vi.fn(),
  promptHistory: vi.fn(),
  citedDomains: vi.fn(),
  relatedPieces: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  tenantRows: { value: [{ name: "Versional" }] as { name: string }[] },
}));

vi.mock("next/navigation", () => ({ notFound }));
vi.mock("@/db", () => ({
  db: { select: () => ({ from: () => ({ where: () => Promise.resolve(tenantRows.value) }) }) },
}));
vi.mock("@/lib/workspace/session", () => ({ requireSession }));
vi.mock("@/lib/workspace/competitors", () => ({ listCompetitors }));
vi.mock("@/lib/ai-visibility/settings", () => ({ getAiVisibilitySettings }));
vi.mock("@/lib/ai-visibility/engine-keys", () => ({ effectiveEngines }));
vi.mock("@/lib/ai-visibility/prompts", () => ({ getPrompt, MAX_ACTIVE_PROMPTS: 30 }));
vi.mock("@/lib/ai-visibility/cited-domains", () => ({ citedDomains }));
vi.mock("@/lib/briefs/query", () => ({ relatedPieces }));
vi.mock("@/lib/ai-visibility/metrics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-visibility/metrics")>();
  return { ...actual, promptSamples, promptHistory };
});

const PromptDetailPage = (await import("@/app/(dashboard)/ai-visibility/prompts/[promptId]/page")).default;

function sample(overrides: Record<string, unknown> = {}) {
  return {
    id: "s1",
    runId: "r1",
    engine: "openai" as EngineId,
    sampleIndex: 0,
    status: "ok",
    askedAt: new Date("2026-08-17T09:00:00Z"),
    modelId: "gpt-5.2",
    answerText: "Versional and Acme are both good.",
    error: null,
    flagged: false,
    framing: null,
    quote: null,
    level: "mentioned" as const,
    citations: [],
    ...overrides,
  };
}

function setup(overrides: Record<string, unknown> = {}) {
  const o = overrides as Record<string, never>;
  requireSession.mockResolvedValue({ user: { tenantId: "t1", id: "u1" } });
  getAiVisibilitySettings.mockResolvedValue({
    enabled: true,
    cadence: "weekly",
    dayOfWeek: 1,
    engines: ["openai", "gemini", "anthropic"],
    samplesPerPrompt: 3,
    monthlyCapUsd: 20,
    ...((o.settings as object) ?? {}),
  });
  // The tabs are drawn from the EFFECTIVE engine list — the ones with a key —
  // so an engine nobody is paying for gets no permanently empty panel.
  effectiveEngines.mockResolvedValue(
    (o.effectiveEngines as string[]) ?? ["openai", "gemini", "anthropic"]
  );
  getPrompt.mockResolvedValue(
    "prompt" in overrides
      ? o.prompt
      : {
          id: "p1",
          text: "best localization tools",
          intent: "discovery",
          persona: null,
          branded: false,
          status: "active",
          flagReason: null,
          supersedesId: null,
          supersededById: null,
        }
  );
  listCompetitors.mockResolvedValue((o.competitors as unknown[]) ?? []);
  promptSamples.mockResolvedValue((o.samples as unknown[]) ?? [sample()]);
  promptHistory.mockImplementation(async () => (o.history as unknown[]) ?? []);
  citedDomains.mockResolvedValue((o.domains as unknown[]) ?? []);
  relatedPieces.mockResolvedValue((o.pieces as unknown[]) ?? []);
  tenantRows.value = (o.tenant as { name: string }[]) ?? [{ name: "Versional" }];
}

async function renderPage(query: Record<string, string | string[]> = {}) {
  render(
    await PromptDetailPage({ params: Promise.resolve({ promptId: "p1" }), searchParams: Promise.resolve(query) })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  captured.tabs = null;
  captured.sparklines = [];
  captured.domains = null;
});

describe("prompt detail — ownership and identity", () => {
  it("404s a prompt that does not exist, and another tenant's, without distinguishing them", async () => {
    setup({ prompt: null });

    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });

  it("makes the question itself the page title", async () => {
    setup();
    await renderPage();

    expect(screen.getByRole("heading", { level: 1, name: "best localization tools" })).toBeInTheDocument();
  });

  it("links both directions of the supersede chain", async () => {
    setup({
      prompt: {
        id: "p1",
        text: "best localization tools",
        intent: "discovery",
        persona: null,
        branded: false,
        status: "paused",
        flagReason: null,
        supersedesId: "p0",
        supersededById: "p2",
      },
    });
    await renderPage();

    expect(screen.getByRole("link", { name: "an earlier wording" })).toHaveAttribute(
      "href",
      "/ai-visibility/prompts/p0"
    );
    expect(screen.getByRole("link", { name: "a newer wording" })).toHaveAttribute(
      "href",
      "/ai-visibility/prompts/p2"
    );
    expect(screen.getByText("Paused")).toBeInTheDocument();
  });
});

describe("prompt detail — the alias table", () => {
  it("builds the tenant's aliases from its NAME, never from the company category", async () => {
    setup({ tenant: [{ name: "Versional" }], competitors: [{ id: "c1", name: "Acme Localization" }] });
    await renderPage();

    const aliases = captured.tabs!.aliases;
    const tenantNames = aliases.filter((alias) => alias.kind === "tenant").map((alias) => alias.name);
    expect(tenantNames).toContain("Versional");
    // "Localization" is the market, not the brand. Highlighting a category
    // word as "you" was the exact bug this page must not have.
    expect(tenantNames).not.toContain("Localization");
    expect(aliases.every((alias) => alias.kind !== "tenant" || alias.label === "Versional")).toBe(true);
  });

  it("labels every competitor spelling with the brand it belongs to", async () => {
    setup({ competitors: [{ id: "c1", name: "Acme Inc." }] });
    await renderPage();

    const competitorAliases = captured.tabs!.aliases.filter((alias) => alias.kind === "competitor");
    expect(competitorAliases.length).toBeGreaterThan(0);
    expect(competitorAliases.every((alias) => alias.label === "Acme Inc.")).toBe(true);
  });

  it("survives a tenant row that is somehow missing rather than throwing", async () => {
    setup({ tenant: [] });
    await renderPage();

    expect(captured.tabs!.aliases.filter((alias) => alias.kind === "tenant")).toHaveLength(0);
  });
});

describe("prompt detail — when nothing is keyed", () => {
  it("shows the answers already collected rather than an empty page", async () => {
    // THE REGRESSION. The tabs and the sparkline cards are drawn from the
    // EFFECTIVE engine list, which is empty for a tenant with no usable key —
    // so `engineGridClass(0)` drew nothing and `EngineTabs` opened with no
    // tabs, over answers that were sitting right there in `promptSamples`.
    //
    // With no run possible, the engines shown are the ones that ANSWERED this
    // prompt. No extra query: the answers are already loaded.
    setup({
      effectiveEngines: [],
      samples: [sample(), sample({ id: "s2", engine: "gemini" })],
    });
    await renderPage();

    expect(captured.tabs?.engines).toEqual(["openai", "gemini"]);
    expect(captured.tabs?.initialEngine).toBe("openai");
    expect(captured.tabs?.samples).toHaveLength(2);
    // One card per engine that answered, so the history is still readable.
    expect(captured.sparklines).toHaveLength(2);
  });

  it("says why nothing new is arriving, and routes to the keys", async () => {
    setup({ effectiveEngines: [], samples: [sample()] });
    await renderPage();

    expect(screen.getByText(/Measuring is paused/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect an engine" })).toHaveAttribute(
      "href",
      "/settings#ai-engines"
    );
  });

  it("says nothing about a pause while the engines are keyed", async () => {
    setup();
    await renderPage();

    expect(screen.queryByText(/Measuring is paused/)).not.toBeInTheDocument();
  });
});

describe("prompt detail — which engine tab opens", () => {
  it("opens the engine a matrix cell was about", async () => {
    setup();
    await renderPage({ engine: "gemini" });

    expect(captured.tabs!.initialEngine).toBe("gemini");
  });

  it("ignores an engine the tenant does not run rather than opening a tab that is not there", async () => {
    setup({ effectiveEngines: ["openai", "anthropic"] });
    await renderPage({ engine: "gemini" });

    expect(captured.tabs!.engines).toEqual(["openai", "anthropic"]);
    expect(captured.tabs!.initialEngine).toBe("openai");
  });

  it("ignores a garbage engine param", async () => {
    setup();
    await renderPage({ engine: "'; drop table" });

    expect(captured.tabs!.initialEngine).toBe("openai");
  });

  it("takes the first value of a repeated engine param", async () => {
    setup();
    await renderPage({ engine: ["anthropic", "gemini"] });

    expect(captured.tabs!.initialEngine).toBe("anthropic");
  });
});

describe("prompt detail — the per-engine cards", () => {
  it("counts only runs at or above the three-sample floor, and breaks the line below it", async () => {
    setup({
      effectiveEngines: ["openai"],
      history: [
        { runId: "r1", runDate: "2026-08-03T09:00:00Z", hits: 0, n: 2, modelId: "gpt-5.1" },
        { runId: "r2", runDate: "2026-08-10T09:00:00Z", hits: 2, n: 3, modelId: "gpt-5.1" },
        { runId: "r3", runDate: "2026-08-17T09:00:00Z", hits: 0, n: 3, modelId: "gpt-5.2" },
      ],
    });
    await renderPage();

    // r1 is neither a hit nor a usable run — it is not evidence of anything.
    expect(screen.getByText("Named in 1 of last 2 runs")).toBeInTheDocument();
    const points = captured.sparklines[0].points;
    expect(points.map((point) => point.rate)).toEqual([null, (2 / 3) * 100, 0]);
    // A model change is a tick, computed against the previous point only.
    expect(points.map((point) => point.modelChange)).toEqual([null, null, "gpt-5.2"]);
  });

  it("says so rather than claiming zero when no run has cleared the floor", async () => {
    setup({
      effectiveEngines: ["openai"],
      history: [{ runId: "r1", runDate: "2026-08-03T09:00:00Z", hits: 0, n: 1, modelId: null }],
    });
    await renderPage();

    expect(screen.getByText("No usable runs yet")).toBeInTheDocument();
  });

  it("marks the run that could first have observed a publish, per engine", async () => {
    setup({
      effectiveEngines: ["openai"],
      history: [
        { runId: "r1", runDate: "2026-08-03T09:00:00Z", hits: 1, n: 3, modelId: null },
        { runId: "r2", runDate: "2026-08-10T09:00:00Z", hits: 2, n: 3, modelId: null },
      ],
      pieces: [{ pieceId: "pc1", title: "A piece", status: "published", publishedAt: new Date("2026-08-05T00:00:00Z") }],
    });
    await renderPage();

    expect(captured.sparklines[0].points.map((point) => point.publishedLabel)).toEqual([null, "published"]);
  });

  it("marks nothing from an unpublished piece", async () => {
    setup({
      effectiveEngines: ["openai"],
      history: [{ runId: "r1", runDate: "2026-08-03T09:00:00Z", hits: 1, n: 3, modelId: null }],
      pieces: [{ pieceId: "pc1", title: "A draft", status: "drafting", publishedAt: null }],
    });
    await renderPage();

    expect(captured.sparklines[0].points[0].publishedLabel).toBeNull();
  });
});

describe("prompt detail — samples, sources and related pieces", () => {
  it("dates a sample in UTC and calls an unasked one what it is", async () => {
    setup({ samples: [sample(), sample({ id: "s2", askedAt: null, status: "pending", answerText: null })] });
    await renderPage();

    expect(captured.tabs!.samples[0].askedAtLabel).toBe("Aug 17, 2026");
    expect(captured.tabs!.samples[1].askedAtLabel).toBe("Not asked yet");
    // A null answer becomes an empty string, never the literal "null".
    expect(captured.tabs!.samples[1].answerText).toBe("");
  });

  it("offers no Propose brief here — a per-prompt row has no per-domain signal to resolve", async () => {
    setup({
      domains: [{ domain: "g2.com", citations: 4, answerShare: 33, engines: ["openai"], domainClass: "third_party" }],
    });
    await renderPage();

    expect(captured.domains![0].signalId).toBeNull();
    // And no note explaining the absence: this table never asked the signals
    // table anything, so "aged out" and "no signal yet" are both claims it
    // cannot make.
    expect(captured.domains![0].everSignalled).toBeNull();
  });

  it("says so rather than rendering an empty table when this prompt has no citations", async () => {
    setup();
    await renderPage();

    expect(screen.getByText("No citations recorded for this prompt yet.")).toBeInTheDocument();
  });

  it("hides the related-pieces section entirely when nothing cited this prompt", async () => {
    setup();
    await renderPage();

    expect(screen.queryByText("Related pieces")).not.toBeInTheDocument();
  });

  it("lists a related piece with its published date, and an unpublished one with its status", async () => {
    setup({
      pieces: [
        { pieceId: "pc1", title: "Shipped piece", status: "published", publishedAt: new Date("2026-08-05T00:00:00Z") },
        { pieceId: "pc2", title: "Still drafting", status: "drafting", publishedAt: null },
      ],
    });
    await renderPage();

    expect(screen.getByRole("link", { name: "Shipped piece" })).toHaveAttribute("href", "/drafts/pc1");
    expect(screen.getByText("Aug 5, 2026")).toBeInTheDocument();
    expect(screen.getByText("drafting")).toBeInTheDocument();
  });
});
