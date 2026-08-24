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
  gemini: 0.014,
  anthropic: 0.012,
};

const DEFAULTS = {
  enabled: true,
  cadence: "weekly" as const,
  dayOfWeek: 1,
  samplesPerPrompt: 3 as const,
  monthlyCapUsd: 20,
};

/**
 * `engines` is a PROP now, not form state.
 *
 * The switches moved into the AI-engines card beside the key each engine
 * depends on (design Decision 2), so what this form receives is the EFFECTIVE
 * list — settings.engines intersected with the engines holding a verified key —
 * and its only use for it is pricing.
 */
const ENGINES: EngineId[] = ["openai", "gemini", "anthropic"];

function form(props: Partial<Parameters<typeof AiVisibilityForm>[0]> = {}) {
  return render(
    <AiVisibilityForm
      defaults={DEFAULTS}
      engines={ENGINES}
      promptCount={28}
      costPerCall={COST}
      spentUsd={4.1}
      {...props}
    />
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
      engines: ["openai", "gemini"],
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
  it("prices only the engines that will actually run", () => {
    // The design's worked example: a tenant with three engines named on the
    // settings row and one Gemini key runs Gemini and is quoted Gemini's price.
    // The estimate reads the EFFECTIVE list, so a card quoting three engines'
    // worth of spend to that tenant is the failure this pins.
    form({ engines: ["gemini"] });
    const one = screen.getByTestId("ai-visibility-estimate").textContent;

    cleanup();
    form({ engines: ENGINES });
    expect(screen.getByTestId("ai-visibility-estimate").textContent).not.toBe(one);
  });

  it("renders no engine switches at all — there is exactly one place to enable an engine", () => {
    // Decision 2. "Is ChatGPT part of my measurement?" and "do we have a
    // working ChatGPT key?" are the same question, and two controls for one
    // decision is a contradiction waiting to be rendered. The switches live in
    // the AI-engines card now, beside the key each depends on.
    form();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.queryByRole("group", { name: "Engines" })).not.toBeInTheDocument();
  });

  it("shows spend against the cap in dollars, never credits", () => {
    form();
    expect(screen.getByText("Spent this month $4.10 of $20.00")).toBeInTheDocument();
  });

  it("says plainly that the budget does not cover the judge", () => {
    // BYOK moves the ENGINE share of the cost and nothing else: the judge and
    // prompt generation still run on our Anthropic key. Copy that let a reader
    // infer "my keys pay for all of it" would be contradicted by their next
    // invoice — from us.
    form();
    expect(screen.getByText(/Only the engine calls hit your keys/i)).toBeInTheDocument();
  });

  it("frames the budget as their money, and the estimate as an estimate", () => {
    // The cap did not stop being useful under BYOK; it stopped being ours. It
    // is also an estimate against an invoice we cannot see, and saying so is
    // the difference between a budget and a promise.
    form();
    expect(screen.getByText("Monthly engine budget")).toBeInTheDocument();
    expect(
      screen.getByText(/your provider.s invoice is the record/i)
    ).toBeInTheDocument();
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

  it("still saves with no effective engines — that is a BYOK state, not invalid input", async () => {
    // The old guard blocked Save on an empty engines list, because the list was
    // this form's own input and an enabled feature with none would plan zero
    // calls behind a green badge. Under BYOK zero engines is the ORDINARY
    // opening state — every tenant has it on ship day — it is fixed in the
    // AI-engines card, and it has its own empty state on /ai-visibility.
    // Blocking a cadence save over it would strand someone in a card that
    // cannot fix the thing it is complaining about.
    form({ engines: [] });
    expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
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
    expect(screen.getByText(/above your \$1\.00 budget/)).toBeInTheDocument();
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
      const input = screen.getByLabelText("Monthly engine budget");
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
      const input = screen.getByLabelText("Monthly engine budget");
      act(() => {
        fireEvent.change(input, { target: { value: "abc" } });
      });

      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    });

    it("re-enables Save once the number is back in range", () => {
      form({ defaults: { ...DEFAULTS, monthlyCapUsd: 600 } });
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

      act(() => {
        fireEvent.change(screen.getByLabelText("Monthly engine budget"), { target: { value: "50" } });
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
  });

  it("posts NO engines field at all", () => {
    // The second half of Decision 2. `saveAiVisibilitySettings` reads an absent
    // list as "leave it alone", so a stale tab saving a cadence here cannot
    // undo a switch flipped in the AI-engines card. Posting the list — even the
    // correct one — would reintroduce exactly that race.
    form();
    expect(submit().getAll("engines")).toEqual([]);
  });
});
