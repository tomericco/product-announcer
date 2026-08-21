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
      promptCount={28}
      competitorCount={5}
      personaCount={3}
      changedSinceCount={2}
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

  it("states what the prompts were derived from, and what has moved since", () => {
    card();
    expect(
      screen.getByText("Prompts generated from 5 competitors, 3 personas — 2 changed since")
    ).toBeInTheDocument();
  });

  it("drops the trailing clause when nothing has changed", () => {
    card({ changedSinceCount: 0 });
    expect(
      screen.getByText("Prompts generated from 5 competitors, 3 personas")
    ).toBeInTheDocument();
  });

  it("keeps showing the last error after the switch is turned off", () => {
    // Turning it off after a failure must not hide the reason it failed —
    // that is the one moment an operator most wants to read it. Same rule
    // NewsToggle documents.
    card({ source: source({ status: "disabled", lastError: "Perplexity: 429 rate limited" }) });
    expect(screen.getByText("Perplexity: 429 rate limited")).toBeInTheDocument();
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
