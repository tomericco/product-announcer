import { describe, it, expect, vi } from "vitest";

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
      userPersonas: [],
    } as never;

    const personas = [
      { name: "engineering managers", brief: "track shipped work; care about what changed" },
    ];

    const draft = await generateUpdateDraft(items, brandProfile, REPOS, personas);

    expect(draft).toEqual({ title: "Faster search", body: "We rebuilt search.", category: "improved" });

    const callArgs = vi.mocked(generateObject).mock.calls[0][0];
    expect(callArgs.system).toContain("Industry: B2B SaaS.");
    expect(callArgs.system).toContain("engineering managers: track shipped work");
    expect(callArgs.prompt).toContain("acme/web");
    expect(callArgs.prompt).toContain("Add dark mode");
  });

  it("injects an examples block into the system prompt when examples are provided", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "x", body: "y", category: "new" },
    } as never);

    const items = [prItem()] as never;
    const brandProfile = {
      tone: null, readingLevel: null, doList: [], dontList: [], examplePhrases: [], industry: null, userPersonas: [],
    } as never;
    const examples = [
      { id: "1", key: "devtools-developer-new", industry: "Developer Tools", personaKey: "developer", category: "improved", title: "Cursor pagination", body: "Use next_cursor.", sortOrder: 0, createdAt: new Date() },
    ] as never;

    await generateUpdateDraft(items, brandProfile, REPOS, [], examples);

    const system = vi.mocked(generateObject).mock.calls.at(-1)![0].system as string;
    expect(system).toContain("mirror their structure");
    expect(system).toContain("Example (improved):");
    expect(system).toContain("Cursor pagination");
    expect(system).toContain("Use next_cursor.");
  });

  it("omits the examples block when no examples are provided", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "x", body: "y", category: "new" },
    } as never);
    const brandProfile = {
      tone: null, readingLevel: null, doList: [], dontList: [], examplePhrases: [], industry: null, userPersonas: [],
    } as never;

    await generateUpdateDraft([prItem()] as never, brandProfile, REPOS, []);

    const system = vi.mocked(generateObject).mock.calls.at(-1)![0].system as string;
    expect(system).not.toContain("Example (");
    expect(system).not.toContain("mirror their structure");
  });
});
