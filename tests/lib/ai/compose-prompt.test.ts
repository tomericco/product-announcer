import { describe, it, expect } from "vitest";
import { serializeBatch, buildSystemPrompt } from "../../../src/lib/ai/compose-prompt";

type FakeChangeItem = {
  id: string; repoId: string; sourceType: "pr" | "commit";
  prNumber: number | null; prTitle: string | null; prDescription: string | null;
  commitSha: string | null; commitMessage: string | null; diff: string | null;
  impactSummary: string | null;
};

function prItem(o: Partial<FakeChangeItem> = {}): FakeChangeItem {
  return { id: "ci_1", repoId: "repo_web", sourceType: "pr", prNumber: 1, prTitle: "Add dark mode",
    prDescription: "Adds a toggle.", commitSha: null, commitMessage: null, diff: "diff --git a/x b/x\n+dark",
    impactSummary: null, ...o };
}
function commitItem(o: Partial<FakeChangeItem> = {}): FakeChangeItem {
  return { id: "ci_2", repoId: "repo_api", sourceType: "commit", prNumber: null, prTitle: null,
    prDescription: null, commitSha: "abcdef1234567", commitMessage: "fix export timeout",
    diff: "diff --git a/y b/y\n+fix", impactSummary: null, ...o };
}

const REPOS = new Map([["repo_web", "acme/web"], ["repo_api", "acme/api"]]);

describe("serializeBatch", () => {
  it("leads with impactSummary when present and never emits the diff", () => {
    const result = serializeBatch([commitItem({ impactSummary: "Exports finish faster" })] as never, REPOS);
    expect(result).toContain('1. [acme/api · commit abcdef1] "fix export timeout" — Exports finish faster');
    expect(result).not.toContain("diff --git");
  });

  it("falls back to prDescription for a PR with no impactSummary", () => {
    const result = serializeBatch([prItem()] as never, REPOS);
    expect(result).toContain('1. [acme/web · PR #1] "Add dark mode" — Adds a toggle.');
    expect(result).not.toContain("diff --git");
  });

  it("shows only the title for a commit with no impactSummary (no trailing separator)", () => {
    const result = serializeBatch([commitItem()] as never, REPOS);
    expect(result).toBe('1. [acme/api · commit abcdef1] "fix export timeout"');
  });

  it("caps oversized batches by dropping trailing whole items with a note", () => {
    const items = [
      commitItem({ id: "a", commitSha: "aaaaaaa0000", impactSummary: "A".repeat(60) }),
      commitItem({ id: "b", commitSha: "bbbbbbb0000", impactSummary: "B".repeat(60) }),
      commitItem({ id: "c", commitSha: "ccccccc0000", impactSummary: "C".repeat(60) }),
    ];
    const result = serializeBatch(items as never, REPOS, 90);
    expect(result).toContain("A".repeat(60));
    expect(result).not.toContain("C".repeat(60));
    expect(result).toMatch(/more changes not shown\./);
  });
});

describe("buildSystemPrompt", () => {
  const baseBrand = { tone: null, readingLevel: null, doList: [], dontList: [], examplePhrases: [], industry: null, userPersonas: [] };

  it("includes an examplePhrases line when present and omits it when empty", () => {
    const withPhrases = buildSystemPrompt({ ...baseBrand, examplePhrases: ["ship it", "delightful"] } as never, [], []);
    expect(withPhrases).toContain("Prefer this vocabulary and phrasing where natural: ship it; delightful.");
    const without = buildSystemPrompt(baseBrand as never, [], []);
    expect(without).not.toContain("Prefer this vocabulary");
  });

  it("renders persona identity in parentheses when a description is present", () => {
    const withDesc = buildSystemPrompt(baseBrand as never, [{ name: "Developer", brief: "cares about APIs", description: "Engineers who integrate" }], []);
    expect(withDesc).toContain("Developer (Engineers who integrate): cares about APIs");
    const withoutDesc = buildSystemPrompt(baseBrand as never, [{ name: "Ops", brief: "runs infra" }], []);
    expect(withoutDesc).toContain("Ops: runs infra");
    expect(withoutDesc).not.toContain("Ops (");
  });

  it("includes the house-style line when updatesStyleSummary is set, omits it otherwise", () => {
    const withSummary = buildSystemPrompt({ ...baseBrand, updatesStyleSummary: "Short bullets, one per change." } as never, [], []);
    expect(withSummary).toContain("Match the house style of their existing updates: Short bullets, one per change.");
    const without = buildSystemPrompt({ ...baseBrand, updatesStyleSummary: null } as never, [], []);
    expect(without).not.toContain("Match the house style");
  });
});
