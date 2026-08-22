import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, cleanup, within } from "@testing-library/react";
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

/**
 * What the form would actually POST. Read off the rendered `<form>` rather
 * than by driving React's action plumbing, because the thing under test is
 * whether each control (and each stand-in hidden input) carries its value into
 * the FormData the action destructures.
 */
function submit(): FormData {
  const element = document.querySelector("form");
  if (!element) throw new Error("no form rendered");
  return new FormData(element);
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

  it("groups the four engine switches under one named group", () => {
    form();
    // They were four bare switches under a <Label> with no control and no
    // labelable descendant, so a screen-reader user met "GPT-5.x API + web
    // search" with nothing saying it was one of a set of engines.
    const engines = screen.getByRole("group", { name: "Engines" });
    expect(within(engines).getAllByRole("switch")).toHaveLength(4);
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

  /**
   * The cap bounds, at both edges and one step outside each. $600 reached the
   * user as a blank error boundary because the form only guarded the floor —
   * so the edges are where this has to be pinned, not the middle.
   */
  describe("the cap's legal range", () => {
    const cases: { cap: number; accepted: boolean }[] = [
      { cap: 0, accepted: false },
      { cap: 0.5, accepted: false },
      { cap: 1, accepted: true },
      { cap: 500, accepted: true },
      { cap: 501, accepted: false },
      { cap: -20, accepted: false },
    ];

    for (const testCase of cases) {
      it(`$${testCase.cap} is ${testCase.accepted ? "accepted" : "refused before the submit"}`, () => {
        form({ defaults: { ...DEFAULTS, monthlyCapUsd: testCase.cap } });
        const save = screen.getByRole("button", { name: "Save" });
        if (testCase.accepted) {
          expect(save).not.toBeDisabled();
          expect(screen.queryByText(/between \$1 and \$500/)).not.toBeInTheDocument();
        } else {
          expect(save).toBeDisabled();
          expect(screen.getByText(/between \$1 and \$500/)).toBeInTheDocument();
        }
      });
    }

    it("refuses an emptied field rather than reading it as zero", () => {
      form();
      const input = screen.getByLabelText("Monthly cap");
      act(() => {
        fireEvent.change(input, { target: { value: "" } });
      });

      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
      expect(screen.getByText(/between \$1 and \$500/)).toBeInTheDocument();
      // `Number("")` is 0, which would otherwise render as "of $0.00" — a
      // number the user never typed, presented as their cap.
      expect(screen.getByText("Spent this month $4.10 of $—")).toBeInTheDocument();
    });

    it("refuses a value that is not a number at all", () => {
      form();
      const input = screen.getByLabelText("Monthly cap");
      act(() => {
        fireEvent.change(input, { target: { value: "abc" } });
      });

      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    });

    it("re-enables Save once the number is back in range", () => {
      form({ defaults: { ...DEFAULTS, monthlyCapUsd: 600 } });
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

      act(() => {
        fireEvent.change(screen.getByLabelText("Monthly cap"), { target: { value: "50" } });
      });

      expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
    });

    it("does not also claim the estimate is over an illegal cap", () => {
      // Two red paragraphs for one bad number is one too many, and "above
      // your $0.00 cap" is not a sentence about anything.
      form({ defaults: { ...DEFAULTS, monthlyCapUsd: 0 } });
      expect(screen.queryByText(/above your/)).not.toBeInTheDocument();
    });
  });

  it("keeps posting the chosen day while the cadence is off", async () => {
    // The day Select unmounts when cadence is "off". Without the hidden input
    // the saved day silently resets to Sunday the next time someone turns the
    // schedule back on — a setting lost to a control that was not on screen.
    form({ defaults: { ...DEFAULTS, cadence: "off", dayOfWeek: 4 } });

    expect(screen.queryByLabelText("Day of week")).not.toBeInTheDocument();
    const posted = submit();
    expect(posted.get("cadence")).toBe("off");
    expect(posted.get("dayOfWeek")).toBe("4");
  });

  it("posts every field the action reads, for an ordinary weekly save", () => {
    form({ defaults: { ...DEFAULTS, cadence: "weekly", dayOfWeek: 2, monthlyCapUsd: 35 } });

    const posted = submit();
    expect(posted.get("cadence")).toBe("weekly");
    expect(posted.get("dayOfWeek")).toBe("2");
    expect(posted.get("samplesPerPrompt")).toBe("3");
    expect(posted.get("monthlyCapUsd")).toBe("35");
    // The array the Switches stand in for — a Switch is not a form control.
    expect(posted.getAll("engines")).toEqual(["openai", "perplexity", "gemini", "anthropic"]);
  });

  it("posts only the engines still switched on", async () => {
    form();

    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: /Gemini API, grounded/ }));
    });

    expect(submit().getAll("engines")).not.toContain("gemini");
  });
});
