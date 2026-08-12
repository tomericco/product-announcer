import { describe, it, expect } from "vitest";
import { DRAFT_STEPS } from "../../src/lib/drafting/draft-progress";
import { statusesForStep, shouldStopPolling } from "../../src/app/(dashboard)/board/generation-checklist";
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
