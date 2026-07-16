import { describe, it, expect, vi } from "vitest";
import { serializeBatchForPrompt } from "../../src/lib/generation";

type FakeChangeItem = {
  id: string;
  repoId: string;
  sourceType: "pr" | "commit";
  prNumber: number | null;
  prTitle: string | null;
  prDescription: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  diff: string | null;
};

function prItem(overrides: Partial<FakeChangeItem> = {}): FakeChangeItem {
  return {
    id: "ci_1",
    repoId: "repo_web",
    sourceType: "pr",
    prNumber: 1,
    prTitle: "Add dark mode",
    prDescription: "Adds a toggle.",
    commitSha: null,
    commitMessage: null,
    diff: null,
    ...overrides,
  };
}

function commitItem(overrides: Partial<FakeChangeItem> = {}): FakeChangeItem {
  return {
    id: "ci_2",
    repoId: "repo_api",
    sourceType: "commit",
    prNumber: null,
    prTitle: null,
    prDescription: null,
    commitSha: "abcdef1234567",
    commitMessage: "fix export timeout",
    diff: "diff --git a/x b/x\n+fix",
    ...overrides,
  };
}

const REPOS = new Map([
  ["repo_web", "acme/web"],
  ["repo_api", "acme/api"],
]);

describe("serializeBatchForPrompt", () => {
  it("prefixes each item with its source repo", () => {
    const result = serializeBatchForPrompt([prItem(), commitItem()] as never, REPOS);

    expect(result).toContain('1. [acme/web · PR #1] "Add dark mode" — Adds a toggle.');
    expect(result).toContain('2. [acme/api · commit abcdef1] "fix export timeout" — diff --git a/x b/x\n+fix');
  });

  it("drops diffs starting with the largest when the batch exceeds maxChars, keeping every item", () => {
    const bigDiff = "x".repeat(1000);
    const smallDiff = "y".repeat(10);
    const items = [
      commitItem({ id: "big", repoId: "repo_api", commitSha: "1111111111111", commitMessage: "big change", diff: bigDiff }),
      commitItem({ id: "small", repoId: "repo_api", commitSha: "2222222222222", commitMessage: "small change", diff: smallDiff }),
    ];

    const result = serializeBatchForPrompt(items as never, REPOS, 120);

    expect(result).not.toContain(bigDiff);
    expect(result).toContain("big change");
    expect(result).toContain("small change");
  });
});

vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

import { generateObject } from "ai";
import { generateUpdateDraft } from "../../src/lib/generation";

describe("generateUpdateDraft", () => {
  it("passes the repo-tagged batch and brand profile into the prompt, and returns the object", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "Faster search", body: "We rebuilt search.", category: "improved" },
    } as never);

    const items = [prItem()] as never;
    const brandProfile = {
      tone: "friendly",
      readingLevel: "simple",
      doList: ["be concise"],
      dontList: ["no jargon"],
      examplePhrases: [],
      industry: "B2B SaaS",
      userPersonas: [
        { name: "engineering managers", usage: "track shipped work", deliveredValue: "know what changed" },
      ],
    } as never;

    const draft = await generateUpdateDraft(items, brandProfile, REPOS);

    expect(draft).toEqual({ title: "Faster search", body: "We rebuilt search.", category: "improved" });

    const callArgs = vi.mocked(generateObject).mock.calls[0][0];
    expect(callArgs.system).toContain("Industry: B2B SaaS.");
    expect(callArgs.system).toContain("Audience personas: engineering managers");
    expect(callArgs.prompt).toContain("acme/web");
    expect(callArgs.prompt).toContain("Add dark mode");
  });
});
