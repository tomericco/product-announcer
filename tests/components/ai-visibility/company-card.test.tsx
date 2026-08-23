import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { Source } from "../../../src/db/schema";

const { setAiVisibilityWatching, refresh, toast } = vi.hoisted(() => ({
  setAiVisibilityWatching: vi.fn(async () => {}),
  refresh: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn() },
}));
const { router } = vi.hoisted(() => ({ router: {} as Record<string, unknown> }));
router.refresh = refresh;
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("sonner", () => ({ toast }));
vi.mock("../../../src/app/(dashboard)/company/actions", () => ({ setAiVisibilityWatching }));

import { AiVisibilityCard } from "../../../src/app/(dashboard)/company/ai-visibility-card";

function source(overrides: Partial<Source> = {}): Source {
  return {
    id: "src1",
    tenantId: "t1",
    type: "ai_visibility",
    label: "AI visibility",
    url: null,
    agentUrl: null,
    competitorId: null,
    status: "active",
    lastRunAt: new Date("2026-08-17T00:00:00.000Z"),
    lastSuccessAt: new Date("2026-08-17T00:00:00.000Z"),
    lastError: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  } as Source;
}

function card(props: Partial<Parameters<typeof AiVisibilityCard>[0]> = {}) {
  return render(
    <AiVisibilityCard
      source={source()}
      enabled
      promptCount={28}
      competitorCount={5}
      personaCount={3}
      newCompetitorCount={2}
      profileChanged={false}
      {...props}
    />
  );
}

beforeEach(() => vi.clearAllMocks());

describe("AiVisibilityCard", () => {
  it("reverts the optimistic flip when the save fails, and says so", async () => {
    setAiVisibilityWatching.mockRejectedValueOnce(new Error("nope"));
    card();

    const toggle = screen.getByRole("switch", { name: /track ai visibility/i });
    expect(toggle).toBeChecked();
    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(toggle).toBeChecked();
    expect(toast.error).toHaveBeenCalled();
  });

  it("says what off actually means, in the one place the switch is", () => {
    // Two promises the switch has to carry beside it: turning it off stops
    // the billing, and turning it off does not throw away what was measured.
    // Someone deciding whether to flip it should not have to go and find that
    // out somewhere else.
    card();
    const intro = screen.getByText(/Asks ChatGPT, Gemini and Claude/);
    expect(intro).toHaveTextContent("on a schedule you set in Settings");
    expect(intro).toHaveTextContent("Off means nothing runs and nothing is billed");
    expect(intro).toHaveTextContent("anything already measured is kept");
  });

  it("states what the prompts were derived from", () => {
    card();
    expect(
      screen.getByText("Prompts generated from 5 competitors, 3 personas")
    ).toBeInTheDocument();
  });

  it("names what has moved since, rather than summing it into a count", () => {
    // `companyProfiles.updatedAt` moves for a dozen writes that have nothing
    // to do with personas — a logo upload, a guidelines save — so an edited
    // profile is named, never counted alongside competitors. Same wording the
    // prompts page uses for the same derivation.
    card({ newCompetitorCount: 3, profileChanged: true });
    expect(
      screen.getByText("Profile changed since prompts were generated — 3 competitors, an updated profile")
    ).toBeInTheDocument();
  });

  it("says nothing at all when nothing has changed", () => {
    card({ newCompetitorCount: 0, profileChanged: false });
    expect(screen.queryByText(/Profile changed since/)).not.toBeInTheDocument();
  });

  it("is off for a workspace that has never turned it on, whatever the source row says", () => {
    // The source row is created by `planRun` and defaults to `active`, and an
    // earlier version of the page created it on render. Seeding the switch
    // from it showed a checked toggle and a green badge for a feature the
    // sweep never runs, because the sweep gates on `settings.enabled`.
    card({ enabled: false, source: source({ status: "active" }) });
    expect(screen.getByRole("switch", { name: /track ai visibility/i })).not.toBeChecked();
  });

  it("shows no health block at all before the feature has ever run", () => {
    card({ source: null, enabled: false });
    expect(screen.queryByText(/Not run yet/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Hasn't completed a clean run/)).not.toBeInTheDocument();
    // The switch is still there — turning it on is what creates the row.
    expect(screen.getByRole("switch", { name: /track ai visibility/i })).toBeInTheDocument();
  });

  it("keeps showing the last error after the switch is turned off", () => {
    // Turning it off after a failure must not hide the reason it failed —
    // that is the one moment an operator most wants to read it. Same rule
    // NewsToggle documents. `enabled: false` is load-bearing here: with the
    // switch left on, the health block renders for a reason that has nothing
    // to do with the rule under test.
    card({
      enabled: false,
      source: source({ status: "disabled", lastError: "Claude: 429 rate limited" }),
    });
    expect(screen.getByText("Claude: 429 rate limited")).toBeInTheDocument();
    // The rest of the health block survives with it — the date and the badge
    // are what tell the operator whether the error is current.
    expect(screen.getByText("Last ran Aug 17, 2026")).toBeInTheDocument();
  });

  it("reserves the destructive tone for a source that is actually failing", () => {
    // `sources.lastError` carries benign refusals for this source alone: the
    // sweep records "No active prompts…" and deliberately leaves the status
    // `active`. Colouring off the string painted that sentence red beside a
    // green Active badge, and `--destructive` owns real failures only.
    card({
      source: source({
        status: "active",
        lastError: "No active prompts — approve a prompt set to start measuring.",
      }),
    });
    const benign = screen.getByText(/No active prompts/);
    expect(benign).not.toHaveClass("text-destructive");
    expect(benign).toHaveClass("text-muted-foreground");

    card({ source: source({ status: "failing", lastError: "Gemini 500" }) });
    expect(screen.getByText("Gemini 500")).toHaveClass("text-destructive");
  });

  it("keeps the health block on screen the moment the switch is flipped off", async () => {
    // Not only for a page loaded already-off: the flip is optimistic, so the
    // block has to survive local state going false before any reload.
    card({ enabled: true, source: source({ status: "failing", lastError: "Gemini 500" }) });

    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: /track ai visibility/i }));
    });

    expect(screen.getByRole("switch", { name: /track ai visibility/i })).not.toBeChecked();
    expect(screen.getByText("Gemini 500")).toBeInTheDocument();
  });

  /**
   * The whole matrix of (source row × settings.enabled), because the blocker
   * this card shipped with existed precisely because every fixture passed one
   * shape: an `active` source row. The switch reports `settings.enabled` —
   * the column `sweep.ts` gates on — and NOTHING else, in all four states.
   */
  describe("what the switch says for each shape a workspace can be in", () => {
    const cases: {
      name: string;
      source: Source | null;
      enabled: boolean;
      checked: boolean;
    }[] = [
      { name: "a fresh tenant with no source row at all", source: null, enabled: false, checked: false },
      {
        name: "a source row planRun created, still never enabled",
        source: source({ status: "active" }),
        enabled: false,
        checked: false,
      },
      {
        name: "genuinely on",
        source: source({ status: "active" }),
        enabled: true,
        checked: true,
      },
      {
        name: "switched off, source row disabled",
        source: source({ status: "disabled" }),
        enabled: false,
        checked: false,
      },
      {
        name: "a failing source belonging to a workspace that is still switched on",
        source: source({ status: "failing", lastError: "Gemini 500" }),
        enabled: true,
        checked: true,
      },
      {
        name: "a settings row that says on while no source row exists yet",
        source: null,
        enabled: true,
        checked: true,
      },
    ];

    for (const testCase of cases) {
      it(`${testCase.name} → switch ${testCase.checked ? "checked" : "unchecked"}`, () => {
        card({ source: testCase.source, enabled: testCase.enabled });
        const toggle = screen.getByRole("switch", { name: /track ai visibility/i });
        if (testCase.checked) expect(toggle).toBeChecked();
        else expect(toggle).not.toBeChecked();
      });
    }
  });

  it("flips optimistically and refreshes when the save succeeds", async () => {
    // The other half of the revert case: without this, a card that never
    // flipped at all would pass the revert test for the wrong reason.
    card({ enabled: false, source: null });

    const toggle = screen.getByRole("switch", { name: /track ai visibility/i });
    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(setAiVisibilityWatching).toHaveBeenCalledWith(true);
    expect(toggle).toBeChecked();
    expect(refresh).toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("reverts an optimistic turn-ON too, not only a turn-off", async () => {
    setAiVisibilityWatching.mockRejectedValueOnce(new Error("nope"));
    card({ enabled: false, source: null });

    const toggle = screen.getByRole("switch", { name: /track ai visibility/i });
    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(toggle).not.toBeChecked();
    expect(toast.error).toHaveBeenCalled();
    // A failed save must not tell the page its data has moved on.
    expect(refresh).not.toHaveBeenCalled();
  });

  it("re-enables the switch after a failure, so the user can try again", async () => {
    setAiVisibilityWatching.mockRejectedValueOnce(new Error("nope"));
    card();

    const toggle = screen.getByRole("switch", { name: /track ai visibility/i });
    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(toggle).not.toBeDisabled();
  });

  it("says nothing about a derivation for a workspace with no prompts yet", () => {
    // "Prompts generated from 5 competitors" beside zero prompts is a claim
    // about something that has not happened.
    card({ promptCount: 0, newCompetitorCount: 4, profileChanged: true });
    expect(screen.queryByText(/Prompts generated from/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Profile changed since/)).not.toBeInTheDocument();
  });

  it("singularises one competitor and one persona", () => {
    card({ competitorCount: 1, personaCount: 1, newCompetitorCount: 1, profileChanged: false });
    expect(screen.getByText("Prompts generated from 1 competitor, 1 persona")).toBeInTheDocument();
    expect(
      screen.getByText("Profile changed since prompts were generated — 1 competitor")
    ).toBeInTheDocument();
  });

  it("names an edited profile on its own when no competitor was added", () => {
    card({ newCompetitorCount: 0, profileChanged: true });
    expect(
      screen.getByText("Profile changed since prompts were generated — an updated profile")
    ).toBeInTheDocument();
  });

  it("links to both halves of the feature", () => {
    card();
    expect(screen.getByRole("link", { name: "Edit prompts" })).toHaveAttribute(
      "href",
      "/ai-visibility/prompts"
    );
    expect(screen.getByRole("link", { name: "View results" })).toHaveAttribute(
      "href",
      "/ai-visibility"
    );
  });
});
