import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { PromptRowData } from "../../../src/app/(dashboard)/ai-visibility/prompts/prompts-editor";
import type { ProposalRow } from "../../../src/app/(dashboard)/ai-visibility/prompts/suggestions-section";
import type { PromptsFilterState } from "../../../src/app/(dashboard)/ai-visibility/prompts/filter-params";

/**
 * `/ai-visibility/prompts` — the prompt-set Server Component.
 *
 * Awaited and rendered, for the same reason as the overview: the filtering,
 * the chip derivation, the `deletable` guess, the "Suggest more" gate, the
 * profile-changed strip and the empty-state gate are all page-body code that
 * no exported helper reaches.
 */

const captured = {
  editor: null as {
    rows: PromptRowData[];
    filters: PromptsFilterState;
    personas: string[];
    competitors: { id: string; name: string }[];
    activeCount: number;
    maxActive: number;
    baseQuery?: string;
  } | null,
  suggestions: null as {
    proposals: ProposalRow[];
    profileChangedNote: string | null;
    canSuggestMore: boolean;
    suggestMoreReason: string | null;
  } | null,
  generate: null as { disabledReason: string | null } | null,
};

vi.mock("@/app/(dashboard)/ai-visibility/prompts/prompts-editor", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/app/(dashboard)/ai-visibility/prompts/prompts-editor")
  >();
  return {
    ...actual,
    PromptsEditor: (props: NonNullable<typeof captured.editor>) => {
      captured.editor = props;
      return <div data-testid="prompts-editor" />;
    },
  };
});
vi.mock("@/app/(dashboard)/ai-visibility/prompts/suggestions-section", () => ({
  SuggestionsSection: (props: NonNullable<typeof captured.suggestions>) => {
    captured.suggestions = props;
    return <div data-testid="suggestions" />;
  },
}));
vi.mock("@/app/(dashboard)/ai-visibility/generate-prompt-set-button", () => ({
  GeneratePromptSetButton: (props: { disabledReason: string | null }) => {
    captured.generate = props;
    return <div data-testid="generate-prompt-set" />;
  },
}));

const {
  requireSession,
  getAiVisibilitySettings,
  getOrCreateCompanyProfile,
  listPrompts,
  listCompetitors,
  promptMatrix,
  personaRows,
} = vi.hoisted(() => ({
  requireSession: vi.fn(),
  getAiVisibilitySettings: vi.fn(),
  getOrCreateCompanyProfile: vi.fn(),
  listPrompts: vi.fn(),
  listCompetitors: vi.fn(),
  promptMatrix: vi.fn(),
  personaRows: { value: [] as { key: string; name: string; brief: string }[] },
}));

vi.mock("@/db", () => ({
  db: { select: () => ({ from: () => Promise.resolve(personaRows.value) }) },
}));
vi.mock("@/lib/workspace/session", () => ({ requireSession }));
vi.mock("@/lib/workspace/company-profile", () => ({ getOrCreateCompanyProfile }));
vi.mock("@/lib/workspace/competitors", () => ({ listCompetitors }));
vi.mock("@/lib/ai-visibility/settings", () => ({ getAiVisibilitySettings }));
vi.mock("@/lib/ai-visibility/prompts", () => ({ listPrompts, MAX_ACTIVE_PROMPTS: 30 }));
vi.mock("@/lib/ai-visibility/metrics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-visibility/metrics")>();
  return { ...actual, promptMatrix };
});

const PromptsPage = (await import("@/app/(dashboard)/ai-visibility/prompts/page")).default;

const APPROVED_AT = new Date("2026-08-01T00:00:00Z");

function prompt(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    text: "best localization tools",
    status: "active",
    intent: "discovery",
    persona: null,
    competitorId: null,
    origin: "generated",
    branded: false,
    flagReason: null,
    approvedAt: APPROVED_AT,
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
    engines: ["openai", "perplexity", "gemini", "anthropic"],
    samplesPerPrompt: 3,
    monthlyCapUsd: 20,
    ...((o.settings as object) ?? {}),
  });
  getOrCreateCompanyProfile.mockResolvedValue({
    category: "Localization",
    positioning: "For design teams",
    userPersonas: [],
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    ...((o.profile as object) ?? {}),
  });
  listPrompts.mockResolvedValue((o.prompts as unknown[]) ?? [prompt()]);
  listCompetitors.mockResolvedValue((o.competitors as unknown[]) ?? []);
  promptMatrix.mockResolvedValue((o.matrix as unknown[]) ?? []);
  personaRows.value = (o.personaCatalog as { key: string; name: string; brief: string }[]) ?? [];
}

async function renderPage(params: Record<string, string | string[]> = {}) {
  render(await PromptsPage({ searchParams: Promise.resolve(params) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  captured.editor = null;
  captured.suggestions = null;
  captured.generate = null;
});

describe("prompts page — states", () => {
  it("Off: the same empty state as the overview, with no live Switches to invite pointless edits", async () => {
    setup({ settings: { enabled: false } });
    await renderPage();

    expect(screen.getByText("AI visibility is off")).toBeInTheDocument();
    expect(screen.queryByTestId("prompts-editor")).not.toBeInTheDocument();
    expect(screen.queryByTestId("suggestions")).not.toBeInTheDocument();
  });

  it("No prompts at all: the Generate CTA, with the reason when the profile cannot support it", async () => {
    setup({ prompts: [], profile: { category: null, positioning: null, userPersonas: [], updatedAt: new Date() } });
    await renderPage();

    expect(screen.getByText("No prompts yet")).toBeInTheDocument();
    expect(captured.generate?.disabledReason).toBe("Add a category and positioning on Company first.");
    expect(captured.editor).toBeNull();
  });

  it("Proposals but no approved prompts: the editor still renders, so the batch has somewhere to land", async () => {
    setup({ prompts: [prompt({ status: "proposed" })] });
    await renderPage();

    expect(screen.queryByText("No prompts yet")).not.toBeInTheDocument();
    expect(captured.editor).not.toBeNull();
    expect(captured.suggestions!.proposals).toHaveLength(1);
  });

  it("keeps the editor — and its filter bar — when a filter matches nothing", async () => {
    // Gating the empty state on the FILTERED rows replaced the whole page the
    // moment a filter matched nothing, leaving no on-screen way back.
    setup({ prompts: [prompt({ status: "active", intent: "discovery" })] });
    await renderPage({ intent: "pricing" });

    expect(screen.queryByText("No prompts yet")).not.toBeInTheDocument();
    expect(captured.editor!.rows).toHaveLength(0);
    expect(captured.editor!.filters.intent).toBe("pricing");
  });
});

describe("prompts page — what the editor is handed", () => {
  it("filters by status, intent, persona and competitor together", async () => {
    setup({
      competitors: [{ id: "22222222-2222-4222-8222-222222222222", name: "Acme", createdAt: APPROVED_AT }],
      personaCatalog: [{ key: "design_manager", name: "Head of Design", brief: "b" }],
      profile: {
        category: "L",
        positioning: "P",
        userPersonas: [{ type: "system", key: "design_manager" }],
        updatedAt: new Date("2026-07-01T00:00:00Z"),
      },
      prompts: [
        prompt({ id: "a1111111-1111-4111-8111-111111111111", intent: "pricing", persona: "Head of Design", competitorId: "22222222-2222-4222-8222-222222222222" }),
        prompt({ id: "b1111111-1111-4111-8111-111111111111", intent: "discovery", persona: "Head of Design" }),
        prompt({ id: "c1111111-1111-4111-8111-111111111111", intent: "pricing", persona: null, status: "paused" }),
      ],
    });
    await renderPage({
      intent: "pricing",
      persona: "Head of Design",
      competitor: "22222222-2222-4222-8222-222222222222",
      status: "active",
    });

    expect(captured.editor!.rows.map((row) => row.id)).toEqual(["a1111111-1111-4111-8111-111111111111"]);
  });

  it("never lists a proposed or rejected prompt among the approved ones", async () => {
    setup({
      prompts: [
        prompt({ id: "a1111111-1111-4111-8111-111111111111", status: "active" }),
        prompt({ id: "b1111111-1111-4111-8111-111111111111", status: "proposed" }),
        prompt({ id: "c1111111-1111-4111-8111-111111111111", status: "rejected" }),
        prompt({ id: "d1111111-1111-4111-8111-111111111111", status: "paused" }),
      ],
    });
    await renderPage();

    expect(captured.editor!.rows.map((row) => row.status)).toEqual(["active", "paused"]);
    // The count badge counts ACTIVE prompts, not everything on screen.
    expect(captured.editor!.activeCount).toBe(1);
  });

  it("dashes a chip below the three-sample floor rather than reporting a thin count", async () => {
    setup({
      matrix: [
        {
          promptId: "11111111-1111-4111-8111-111111111111",
          text: "best localization tools",
          branded: false,
          cells: [
            { engine: "openai", hits: 2, n: 3 },
            { engine: "perplexity", hits: 1, n: 2 },
          ],
        },
      ],
    });
    await renderPage();

    expect(captured.editor!.rows[0].chips).toEqual([
      { engine: "openai", named: 2, samples: 3 },
      { engine: "perplexity", named: null, samples: 2 },
    ]);
  });

  it("offers Delete only on an active prompt with no samples anywhere", async () => {
    setup({
      prompts: [
        prompt({ id: "a1111111-1111-4111-8111-111111111111" }),
        prompt({ id: "b1111111-1111-4111-8111-111111111111" }),
        prompt({ id: "c1111111-1111-4111-8111-111111111111", status: "paused" }),
      ],
      matrix: [
        { promptId: "a1111111-1111-4111-8111-111111111111", text: "x", branded: false, cells: [{ engine: "openai", hits: 0, n: 0 }] },
        { promptId: "b1111111-1111-4111-8111-111111111111", text: "y", branded: false, cells: [{ engine: "openai", hits: 0, n: 3 }] },
      ],
    });
    await renderPage();

    const deletable = new Map(captured.editor!.rows.map((row) => [row.id, row.deletable]));
    expect(deletable.get("a1111111-1111-4111-8111-111111111111")).toBe(true);
    expect(deletable.get("b1111111-1111-4111-8111-111111111111")).toBe(false);
    // `promptMatrix` covers active prompts only, so a paused one has no row —
    // conservatively undeletable rather than offered a Delete the server refuses.
    expect(deletable.get("c1111111-1111-4111-8111-111111111111")).toBe(false);
  });

  it("passes the whole current query down, so a filter change merges rather than rebuilds", async () => {
    setup();
    await renderPage({ highlight: "p9", status: "paused" });

    const base = new URLSearchParams(captured.editor!.baseQuery);
    expect(base.get("highlight")).toBe("p9");
    expect(base.get("status")).toBe("paused");
  });

  it("resolves a competitor id to its name on the row", async () => {
    setup({
      competitors: [{ id: "22222222-2222-4222-8222-222222222222", name: "Acme", createdAt: APPROVED_AT }],
      prompts: [prompt({ competitorId: "22222222-2222-4222-8222-222222222222" })],
    });
    await renderPage();

    expect(captured.editor!.rows[0].competitorName).toBe("Acme");
  });
});

describe("prompts page — the suggestions section's gates", () => {
  it("blocks Suggest more at the active cap and states the count as the reason", async () => {
    setup({
      prompts: Array.from({ length: 30 }, (_, index) =>
        prompt({ id: `${index}`.padStart(8, "0") + "-1111-4111-8111-111111111111" })
      ),
    });
    await renderPage();

    expect(captured.suggestions!.canSuggestMore).toBe(false);
    expect(captured.suggestions!.suggestMoreReason).toBe("30 / 30 limit");
  });

  it("blocks it on an unconfigured profile with a different, actionable reason", async () => {
    setup({ profile: { category: null, positioning: "P", userPersonas: [], updatedAt: new Date() } });
    await renderPage();

    expect(captured.suggestions!.canSuggestMore).toBe(false);
    expect(captured.suggestions!.suggestMoreReason).toBe("Add a category and positioning on Company first.");
  });

  it("allows it below the cap on a configured profile", async () => {
    setup();
    await renderPage();

    expect(captured.suggestions!.canSuggestMore).toBe(true);
    expect(captured.suggestions!.suggestMoreReason).toBeNull();
  });

  it("reports a profile that outgrew the prompt set, counting competitors added since approval", async () => {
    setup({
      competitors: [
        { id: "22222222-2222-4222-8222-222222222222", name: "New", createdAt: new Date("2026-08-15T00:00:00Z") },
        { id: "33333333-3333-4333-8333-333333333333", name: "Old", createdAt: new Date("2026-07-01T00:00:00Z") },
      ],
      profile: { category: "L", positioning: "P", userPersonas: [], updatedAt: new Date("2026-08-20T00:00:00Z") },
    });
    await renderPage();

    expect(captured.suggestions!.profileChangedNote).toBe(
      "Profile changed since prompts were generated — 1 competitor, an updated profile"
    );
  });

  it("reports no change when nothing moved since the last approval", async () => {
    setup();
    await renderPage();

    expect(captured.suggestions!.profileChangedNote).toBeNull();
  });
});
