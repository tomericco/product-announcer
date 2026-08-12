import { describe, it, expect } from "vitest";
import { DRAFT_STEPS } from "../../src/lib/drafting/draft-progress";
import {
  statusesForStep,
  statusesForGaveUp,
  shouldStopPolling,
  hasExceededPollLimit,
  terminalOutcome,
  MAX_POLL_ATTEMPTS,
} from "../../src/components/generation-checklist";
import type { GenerationProgress } from "../../src/lib/content/generation-progress";

// No jsdom/testing-library in this project (vitest.config.ts runs the
// "node" environment) — component rendering is verified indirectly, by
// exercising the same pure derivation functions the component renders from,
// the way tests/components/brand/mark-path.test.ts pins shared values rather
// than rendering anything.

function progress(overrides: Partial<GenerationProgress>): GenerationProgress {
  return {
    generationStep: null,
    generatedAt: null,
    generationError: null,
    status: "brief",
    ...overrides,
  };
}

describe("statusesForStep", () => {
  it("marks every step before the current one done, and the rest pending", () => {
    const statuses = statusesForStep("generating");
    const index = DRAFT_STEPS.findIndex((s) => s.key === "generating");

    DRAFT_STEPS.forEach((step, i) => {
      if (i < index) expect(statuses[step.key]).toBe("done");
      else if (i > index) expect(statuses[step.key]).toBe("pending");
    });
  });

  it("marks the current step active", () => {
    const statuses = statusesForStep("generating");
    expect(statuses.generating).toBe("active");
  });

  it("marks everything pending when nothing is in flight", () => {
    const statuses = statusesForStep(null);
    for (const step of DRAFT_STEPS) expect(statuses[step.key]).toBe("pending");
  });

  it("renders an unrecognized step key as no step in flight, not a throw", () => {
    // A build newer than this client could persist a step key this
    // DRAFT_STEPS list doesn't know about. That must render as "nothing in
    // flight", never crash the checklist.
    expect(() => statusesForStep("some-future-step" as never)).not.toThrow();
    const statuses = statusesForStep("some-future-step" as never);
    for (const step of DRAFT_STEPS) expect(statuses[step.key]).toBe("pending");
  });

  it("marks every step done for the 'complete' sentinel", () => {
    // Finding 1: the poll loop substitutes "complete" once a run lands,
    // rather than passing the server's now-null generationStep straight
    // through — that null used to make a successful run render as if it had
    // never started.
    const statuses = statusesForStep("complete");
    for (const step of DRAFT_STEPS) expect(statuses[step.key]).toBe("done");
  });
});

describe("statusesForGaveUp", () => {
  // The give-up branch must not keep rendering the last-known step as
  // "active" — ProgressChecklist renders "active" with an animate-spin
  // Loader2 that keeps spinning regardless of the interval being cleared,
  // which is exactly the misleading "still working" UI the poll cap was
  // introduced to eliminate. "stalled" reads as frozen instead of moving.
  it("downgrades the active step to stalled", () => {
    const statuses = statusesForStep("generating");
    const frozen = statusesForGaveUp(statuses);
    expect(frozen.generating).toBe("stalled");
  });

  it("leaves done and pending steps unchanged", () => {
    const statuses = statusesForStep("generating");
    const frozen = statusesForGaveUp(statuses);
    for (const step of DRAFT_STEPS) {
      if (statuses[step.key] !== "active") {
        expect(frozen[step.key]).toBe(statuses[step.key]);
      }
    }
  });

  it("is a no-op when nothing is active (nothing was ever in flight)", () => {
    const statuses = statusesForStep(null);
    expect(statusesForGaveUp(statuses)).toEqual(statuses);
  });

  it("is a no-op on the 'complete' sentinel (already all done)", () => {
    const statuses = statusesForStep("complete");
    expect(statusesForGaveUp(statuses)).toEqual(statuses);
  });
});

describe("hasExceededPollLimit", () => {
  it("allows polling below the cap", () => {
    expect(hasExceededPollLimit(1)).toBe(false);
    expect(hasExceededPollLimit(MAX_POLL_ATTEMPTS - 1)).toBe(false);
  });

  it("stops at and beyond the cap", () => {
    // Finding 2: shouldStopPolling returns false forever for a wedged
    // generation (the interrupted marker leaves step="generating" with no
    // further write, and a pre-marker throw leaves step=null/error=null
    // indistinguishable from "not started"). This cap is what actually
    // bounds the loop in both cases.
    expect(hasExceededPollLimit(MAX_POLL_ATTEMPTS)).toBe(true);
    expect(hasExceededPollLimit(MAX_POLL_ATTEMPTS + 1)).toBe(true);
  });
});

describe("terminalOutcome", () => {
  // Finding 1: a landed failure must render distinctly from a completed
  // run — it must not resolve to the same "complete" outcome, which is what
  // used to paint five green checkmarks over a failed generation.
  it("is 'complete' when generatedAt is set", () => {
    expect(terminalOutcome(progress({ generatedAt: new Date(), generationStep: null }))).toBe("complete");
  });

  it("is 'failed' for a landed failure — error set, step already cleared", () => {
    expect(terminalOutcome(progress({ generationError: "boom", generationStep: null }))).toBe("failed");
  });

  it("is 'gone' when the piece disappeared from under the poll", () => {
    expect(terminalOutcome(null)).toBe("gone");
  });
});

describe("shouldStopPolling", () => {
  it("stops once generatedAt is set", () => {
    expect(shouldStopPolling(progress({ generatedAt: new Date(), generationStep: null }))).toBe(true);
  });

  it("keeps polling while a step is in flight and nothing terminal is set", () => {
    expect(shouldStopPolling(progress({ generationStep: "generating" }))).toBe(false);
  });

  it("stops on a landed failure — an error with the in-flight step already cleared", () => {
    expect(shouldStopPolling(progress({ generationError: "boom", generationStep: null }))).toBe(true);
  });

  it("keeps polling on an error that still has a step set — the failure hasn't landed yet", () => {
    expect(shouldStopPolling(progress({ generationError: "boom", generationStep: "generating" }))).toBe(false);
  });

  it("stops when the piece is gone", () => {
    expect(shouldStopPolling(null)).toBe(true);
  });
});
