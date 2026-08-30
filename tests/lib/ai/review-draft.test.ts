import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));

import { generateObject } from "ai";
import { buildReviewPrompt, buildRevisionPrompt, reviewAndReconcile, REVISION_SYSTEM } from "../../../src/lib/ai/review-draft";
import { GROUNDING_RULE, NO_INVENTED_LINKS_RULE } from "../../../src/lib/ai/prompt-rules";

const draft = { title: "Big news!!!", body: "Buy now." };
const brand = { guidelines: "Tone: calm. Do: be factual. Avoid: hype.", industry: null, userPersonas: [] };

function ok(object: unknown) { return { object } as never; }
const critique = (compliant: boolean, issues: string[] = []) => ok({ compliant, issues });
const revision = (title: string, body: string) => ok({ title, body });

describe("buildReviewPrompt", () => {
  it("includes the guidelines document, delimited, and the draft", () => {
    const prompt = buildReviewPrompt(draft, brand as never);
    expect(prompt).toContain("<brand-guidelines>\nTone: calm. Do: be factual. Avoid: hype.\n</brand-guidelines>");
    expect(prompt).toContain("Big news!!!");
    expect(prompt).toContain("Buy now.");
  });

  it("falls back to a stated absence when no guidelines are configured", () => {
    const prompt = buildReviewPrompt(draft, { guidelines: null, industry: null, userPersonas: [] } as never);
    expect(prompt).toContain("No specific brand requirements are configured.");
  });
});

describe("buildRevisionPrompt", () => {
  it("includes the brand rules delimited, the draft, and the specific issues to fix", () => {
    const prompt = buildRevisionPrompt(draft, ["too hypey", "no exclamation marks"], brand as never);
    expect(prompt).toContain("<brand-guidelines>\nTone: calm. Do: be factual. Avoid: hype.\n</brand-guidelines>");
    expect(prompt).toContain("Big news!!!");
    expect(prompt).toContain("- too hypey");
    expect(prompt).toContain("- no exclamation marks");
  });
});

describe("reviewAndReconcile", () => {
  beforeEach(() => {
    vi.mocked(generateObject).mockReset();
  });
  afterEach(() => {
    delete process.env.REVIEW_MAX_ROUNDS;
  });

  it("returns passed on a compliant first review, without revising", async () => {
    vi.mocked(generateObject).mockResolvedValue(critique(true));
    const out = await reviewAndReconcile(draft, brand as never);
    expect(out).toEqual({ finalDraft: draft, status: "passed", issues: [] });
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it("revises once and returns 'passed' when the fix becomes compliant", async () => {
    vi.mocked(generateObject)
      .mockResolvedValueOnce(critique(false, ["too hypey"]))    // review 1
      .mockResolvedValueOnce(revision("News", "We shipped X.")) // revise 1
      .mockResolvedValueOnce(critique(true));                   // review 2
    const out = await reviewAndReconcile(draft, brand as never);
    expect(out.status).toBe("passed");
    expect(out.finalDraft).toEqual({ title: "News", body: "We shipped X." });
    expect(out.issues).toEqual([]);
    expect(generateObject).toHaveBeenCalledTimes(3);
  });

  it("loops for a second round when the first fix is still non-compliant", async () => {
    vi.mocked(generateObject)
      .mockResolvedValueOnce(critique(false, ["hype"]))        // review 1
      .mockResolvedValueOnce(revision("R1", "b1"))             // revise 1
      .mockResolvedValueOnce(critique(false, ["still hype"]))  // review 2
      .mockResolvedValueOnce(revision("R2", "b2"))             // revise 2
      .mockResolvedValueOnce(critique(true));                  // review 3
    const out = await reviewAndReconcile(draft, brand as never);
    expect(out.status).toBe("passed");
    expect(out.finalDraft).toEqual({ title: "R2", body: "b2" });
    expect(generateObject).toHaveBeenCalledTimes(5);
  });

  it("returns 'failed' with the last revision and last issues after exhausting maxRounds (default 2)", async () => {
    vi.mocked(generateObject)
      .mockResolvedValueOnce(critique(false, ["hype"]))   // review 1
      .mockResolvedValueOnce(revision("R1", "b1"))        // revise 1
      .mockResolvedValueOnce(critique(false, ["still"]))  // review 2
      .mockResolvedValueOnce(revision("R2", "b2"))        // revise 2
      .mockResolvedValueOnce(critique(false, ["nope"]));  // review 3
    const out = await reviewAndReconcile(draft, brand as never);
    expect(out.status).toBe("failed");
    expect(out.issues).toEqual(["nope"]);
    expect(out.finalDraft).toEqual({ title: "R2", body: "b2" });
    expect(generateObject).toHaveBeenCalledTimes(5);
  });

  it("treats REVIEW_MAX_ROUNDS=0 as a pure gate: fails a non-compliant draft without revising", async () => {
    process.env.REVIEW_MAX_ROUNDS = "0";
    vi.mocked(generateObject).mockResolvedValue(critique(false, ["bad"]));
    const out = await reviewAndReconcile(draft, brand as never);
    expect(out).toEqual({ finalDraft: draft, status: "failed", issues: ["bad"] });
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it("respects REVIEW_MAX_ROUNDS=1: stops after one revision round", async () => {
    process.env.REVIEW_MAX_ROUNDS = "1";
    vi.mocked(generateObject)
      .mockResolvedValueOnce(critique(false, ["hype"]))   // review 1
      .mockResolvedValueOnce(revision("R1", "b1"))        // revise 1
      .mockResolvedValueOnce(critique(false, ["still"])); // review 2
    const out = await reviewAndReconcile(draft, brand as never);
    expect(out.status).toBe("failed");
    expect(out.finalDraft).toEqual({ title: "R1", body: "b1" });
    expect(generateObject).toHaveBeenCalledTimes(3);
  });

  it("retries a failing review once, then holds the draft as 'error'", async () => {
    vi.mocked(generateObject).mockRejectedValue(new Error("review down"));
    const out = await reviewAndReconcile(draft, brand as never);
    expect(out).toEqual({ finalDraft: draft, status: "error", issues: [] });
    expect(generateObject).toHaveBeenCalledTimes(2);
  });

  it("holds as 'error' when a revision call keeps failing after its retry", async () => {
    vi.mocked(generateObject)
      .mockResolvedValueOnce(critique(false, ["hype"]))  // review 1
      .mockRejectedValueOnce(new Error("revise down"))   // revise attempt 1
      .mockRejectedValueOnce(new Error("revise down"));  // revise retry
    const out = await reviewAndReconcile(draft, brand as never);
    expect(out.status).toBe("error");
    expect(out.finalDraft).toEqual(draft);
    expect(generateObject).toHaveBeenCalledTimes(3);
  });
});

describe("REVISION_SYSTEM", () => {
  it("carries the grounding rule", () => {
    expect(REVISION_SYSTEM).toContain(GROUNDING_RULE);
  });

  it("carries the no-invented-links rule", () => {
    expect(REVISION_SYSTEM).toContain(NO_INVENTED_LINKS_RULE);
  });
});
