import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import type { EngineId } from "../../../src/lib/ai-visibility/types";
import {
  AiVisibilityForm,
  monthlyEstimateUsd,
} from "../../../src/app/(dashboard)/settings/ai-visibility-form";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../../../src/app/(dashboard)/settings/actions", () => ({
  saveAiVisibilityConfig: vi.fn(async () => {}),
}));

// The real constants from `engines/*.ts`. Gemini was 0 here, which exercised a
// "free within its allowance" branch production can never produce.
const COST: Record<EngineId, number> = {
  openai: 0.012,
  perplexity: 0.008,
  gemini: 0.014,
  anthropic: 0.012,
};

const DEFAULTS = {
  enabled: true,
  cadence: "weekly" as const,
  dayOfWeek: 1,
  engines: ["openai", "perplexity", "gemini", "anthropic"] as EngineId[],
  samplesPerPrompt: 3 as const,
  monthlyCapUsd: 20,
};

function form(props: Partial<Parameters<typeof AiVisibilityForm>[0]> = {}) {
  return render(
    <AiVisibilityForm defaults={DEFAULTS} promptCount={28} costPerCall={COST} spentUsd={4.1} {...props} />
  );
}

beforeEach(() => vi.clearAllMocks());

describe("monthlyEstimateUsd", () => {
  it("multiplies prompts × samples × per-engine cost × runs per month", () => {
    // 28 prompts × 3 samples × 4.333 weekly runs = 364 calls per engine.
    const estimate = monthlyEstimateUsd({
      promptCount: 28,
      engines: ["openai"],
      samplesPerPrompt: 3,
      cadence: "weekly",
      costPerCall: COST,
    });
    expect(estimate).toBeCloseTo(28 * 3 * (52 / 12) * 0.012, 2);
  });

  it("halves for fortnightly and is zero when off", () => {
    const weekly = monthlyEstimateUsd({
      promptCount: 28,
      engines: ["openai"],
      samplesPerPrompt: 3,
      cadence: "weekly",
      costPerCall: COST,
    });
    const fortnightly = monthlyEstimateUsd({
      promptCount: 28,
      engines: ["openai"],
      samplesPerPrompt: 3,
      cadence: "fortnightly",
      costPerCall: COST,
    });
    expect(fortnightly).toBeCloseTo(weekly / 2, 2);
    expect(
      monthlyEstimateUsd({
        promptCount: 28,
        engines: ["openai"],
        samplesPerPrompt: 3,
        cadence: "off",
        costPerCall: COST,
      })
    ).toBe(0);
  });

  it("charges brand-check prompts one sample, exactly as the cap gate does", () => {
    // `capExceeded` counts brand_check at one sample and everything else at
    // the samples setting. An estimate that charged all 28 at 3 read ~5% high
    // against the gate it is supposed to be describing.
    const withBrandChecks = monthlyEstimateUsd({
      promptCount: 28,
      brandCheckCount: 2,
      engines: ["openai"],
      samplesPerPrompt: 3,
      cadence: "weekly",
      costPerCall: COST,
    });
    // 26 prompts × 3 samples + 2 brand checks × 1 = 80 calls per run.
    expect(withBrandChecks).toBeCloseTo(80 * (52 / 12) * 0.012, 2);
    expect(withBrandChecks).toBeLessThan(
      monthlyEstimateUsd({
        promptCount: 28,
        engines: ["openai"],
        samplesPerPrompt: 3,
        cadence: "weekly",
        costPerCall: COST,
      })
    );
  });

  it("sums the engines that are on, and only those", () => {
    const both = monthlyEstimateUsd({
      promptCount: 10,
      engines: ["openai", "perplexity"],
      samplesPerPrompt: 1,
      cadence: "weekly",
      costPerCall: COST,
    });
    const one = monthlyEstimateUsd({
      promptCount: 10,
      engines: ["openai"],
      samplesPerPrompt: 1,
      cadence: "weekly",
      costPerCall: COST,
    });
    expect(both).toBeGreaterThan(one);
  });
});

describe("AiVisibilityForm", () => {
  it("recomputes the estimate as engines are switched off", async () => {
    form();
    const before = screen.getByTestId("ai-visibility-estimate").textContent;

    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: /Gemini API, grounded/ }));
      fireEvent.click(screen.getByRole("switch", { name: /Perplexity Sonar API/ }));
    });

    expect(screen.getByTestId("ai-visibility-estimate").textContent).not.toBe(before);
  });

  it("shows spend against the cap in dollars, never credits", () => {
    form();
    expect(screen.getByText("Spent this month $4.10 of $20.00")).toBeInTheDocument();
  });

  it("says plainly that the cap does not cover the judge", () => {
    // Judge tokens bill to `llm_usage` and are outside this cap — a cap that
    // silently does not cover everything is worse than no cap.
    form();
    expect(screen.getByText(/only engine calls count/i)).toBeInTheDocument();
  });

  it("recommends 3 samples whether or not one is already chosen", () => {
    // A standing recommendation, not a warning that fires on a bad choice —
    // asserted at both settings so the test says what the component does.
    form({ defaults: { ...DEFAULTS, samplesPerPrompt: 1 } });
    expect(screen.getByText(/3 recommended — single samples are noisy/)).toBeInTheDocument();

    cleanup();
    form({ defaults: { ...DEFAULTS, samplesPerPrompt: 3 } });
    expect(screen.getByText(/3 recommended — single samples are noisy/)).toBeInTheDocument();
  });

  it("refuses to save with every engine off, since that silently measures nothing", async () => {
    // `saveAiVisibilitySettings` rejects an empty engines array with
    // { ok:false, error:"engines" } — an enabled feature with zero engines
    // would look on and measure nothing, so "stop running" is spelled
    // cadence "off" or the /company switch. This client-side guard exists so
    // the human reads WHY before submitting, instead of a failed save.
    form({ defaults: { ...DEFAULTS, engines: [] } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByText(/Turn on at least one engine/)).toBeInTheDocument();
  });

  it("refuses a cap the server would reject, instead of letting it throw an error page", () => {
    // `saveAiVisibilitySettings` rejects anything over $500 and the action
    // throws on it, which reached the user as a blank error boundary with no
    // hint that the number was the problem.
    form({ defaults: { ...DEFAULTS, monthlyCapUsd: 600 } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByText(/between \$1 and \$500/)).toBeInTheDocument();
  });

  it("refuses an empty or zero cap for the same reason", () => {
    form({ defaults: { ...DEFAULTS, monthlyCapUsd: 0 } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("says the estimate exceeds the cap before the save, not after the run is paused", async () => {
    form({ promptCount: 30, defaults: { ...DEFAULTS, monthlyCapUsd: 1 } });
    expect(screen.getByText(/above your \$1\.00 cap/)).toBeInTheDocument();
  });
});
