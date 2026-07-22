import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../../../src/lib/ai/compose-prompt";
import { serializeAtomicUpdates, composeReleasePrompt, composeMergePrompt } from "../../../src/lib/ai/compose-prompt";

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

const AUS = [
  { id: "a1", title: "CSV export", summary: "Export reports as CSV.", category: "new" as const },
  { id: "a2", title: "Faster search", summary: "Search returns in under a second.", category: "improved" as const },
];

describe("serializeAtomicUpdates", () => {
  it("renders each atomic update as a numbered title + summary line", () => {
    const text = serializeAtomicUpdates(AUS);
    expect(text).toContain("CSV export");
    expect(text).toContain("Export reports as CSV.");
    expect(text).toMatch(/1\./);
    expect(text).toMatch(/2\./);
  });

  it("drops trailing items past maxChars with a note, keeping at least one", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      id: `a${i}`, title: `Feature ${i}`, summary: "x".repeat(200), category: "new" as const,
    }));
    const text = serializeAtomicUpdates(many, 500);
    expect(text).toMatch(/more updates not shown/);
    expect(text).toContain("Feature 0");
  });
});

describe("composeReleasePrompt", () => {
  it("builds a system+prompt pair from atomic updates without a repo map", () => {
    const { system, prompt } = composeReleasePrompt({
      items: AUS,
      brandProfile: { tone: null, readingLevel: null, doList: [], dontList: [], examplePhrases: [], industry: null, updatesStyleSummary: null, userPersonas: [] } as never,
      personas: [],
      examples: [],
    });
    expect(system).toContain("product update");
    expect(prompt).toContain("CSV export");
  });
});

const BASE_BRAND = {
  tone: null,
  readingLevel: null,
  doList: [],
  dontList: [],
  examplePhrases: [],
  industry: null,
  updatesStyleSummary: null,
  userPersonas: [],
} as never;

describe("composeMergePrompt", () => {
  it("includes the current body and the new items in the prompt", () => {
    const { prompt } = composeMergePrompt({
      currentBody: "## What's new\nWe shipped CSV export last week.",
      newItems: [AUS[1]],
      changedItems: [],
      brandProfile: BASE_BRAND,
      personas: [],
      examples: [],
    });
    expect(prompt).toContain("We shipped CSV export last week.");
    expect(prompt).toContain("Faster search");
    expect(prompt).toContain("Search returns in under a second.");
  });

  it("includes changed items in the prompt when present", () => {
    const { prompt } = composeMergePrompt({
      currentBody: "Existing body.",
      newItems: [],
      changedItems: [AUS[0]],
      brandProfile: BASE_BRAND,
      personas: [],
      examples: [],
    });
    expect(prompt).toContain("CSV export");
    expect(prompt).toContain("Export reports as CSV.");
  });

  it("instructs the model to preserve existing wording and structure in the system prompt", () => {
    const { system } = composeMergePrompt({
      currentBody: "Existing body.",
      newItems: [AUS[0]],
      changedItems: [],
      brandProfile: BASE_BRAND,
      personas: [],
      examples: [],
    });
    expect(system).toContain("product update");
    expect(system.toLowerCase()).toContain("preserve");
    expect(system.toLowerCase()).toContain("existing wording");
  });
});
