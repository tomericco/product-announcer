import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));

import { generateObject } from "ai";
import { buildEnrichmentPrompt, enrichChangeItem } from "../../../src/lib/ai/enrich-change-item";

describe("buildEnrichmentPrompt", () => {
  it("includes commit message and diff for commit-sourced items", () => {
    const prompt = buildEnrichmentPrompt({
      sourceType: "commit",
      repoName: "acme/api",
      commitMessage: "fix export timeout",
      diff: "diff --git a/x b/x\n+fix",
    });
    expect(prompt).toContain("acme/api");
    expect(prompt).toContain("fix export timeout");
    expect(prompt).toContain("diff --git a/x b/x");
  });

  it("includes PR title and description for pr-sourced items", () => {
    const prompt = buildEnrichmentPrompt({
      sourceType: "pr",
      repoName: "acme/web",
      prTitle: "Add dark mode",
      prDescription: "Adds a toggle.",
    });
    expect(prompt).toContain("acme/web");
    expect(prompt).toContain("Add dark mode");
    expect(prompt).toContain("Adds a toggle.");
  });
});

describe("enrichChangeItem", () => {
  // Reset AFTER each test, not before: resetting a mock in beforeEach makes
  // vitest surface an awaited-and-caught rejection as an unhandled error,
  // spuriously failing the fail-open test even though the module catches it.
  afterEach(() => vi.mocked(generateObject).mockReset());

  it("maps a user-facing model result through", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { userFacing: true, impactSummary: "Exports finish faster", suggestedCategory: "improved", confidence: 0.8 },
    } as never);

    const result = await enrichChangeItem({ sourceType: "commit", repoName: "acme/api", commitMessage: "x", diff: "y" });
    expect(result).toEqual({
      userFacing: true,
      impactSummary: "Exports finish faster",
      suggestedCategory: "improved",
      confidence: 0.8,
    });
  });

  it("nulls impact and category when the model says not user-facing", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { userFacing: false, impactSummary: "internal refactor", suggestedCategory: "improved", confidence: 0.95 },
    } as never);

    const result = await enrichChangeItem({ sourceType: "commit", repoName: "acme/api", commitMessage: "refactor", diff: "z" });
    expect(result).toEqual({ userFacing: false, impactSummary: null, suggestedCategory: null, confidence: 0.95 });
  });

  it("fails open to user-facing when the model throws", async () => {
    vi.mocked(generateObject).mockRejectedValue(new Error("model down"));

    const result = await enrichChangeItem({ sourceType: "pr", repoName: "acme/web", prTitle: "t", prDescription: "d" });
    expect(result).toEqual({ userFacing: true, impactSummary: null, suggestedCategory: null, confidence: null });
  });
});
