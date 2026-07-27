import { describe, it, expect } from "vitest";
import { composeScopedEditPrompt, composeWholeEditPrompt } from "../../../src/lib/ai/compose-prompt";
import type { brandProfiles } from "../../../src/db/schema";

type BrandProfileRow = typeof brandProfiles.$inferSelect;

// Minimal brand profile — buildSystemPrompt only reads these fields.
const brandProfile = {
  tenantId: "tenant-1",
  industry: null,
  tone: null,
  readingLevel: null,
  doList: [],
  dontList: [],
  examplePhrases: [],
  updatesStyleSummary: null,
  userPersonas: [],
} as unknown as BrandProfileRow;

describe("composeScopedEditPrompt", () => {
  it("includes the excerpt, instruction and full body, and constrains output to the excerpt only", () => {
    const { system, prompt } = composeScopedEditPrompt({
      fullBody: "Para one.\n\nThe old sentence.\n\nPara three.",
      excerpt: "The old sentence.",
      instruction: "make it punchier",
      brandProfile,
      personas: [],
      examples: [],
    });
    expect(prompt).toContain("The old sentence.");
    expect(prompt).toContain("make it punchier");
    expect(prompt).toContain("Para one.");
    expect(system.toLowerCase()).toContain("only the revised excerpt");
    expect(system.toLowerCase()).toContain("no code fences");
  });
});

describe("composeWholeEditPrompt", () => {
  it("includes the instruction and current body, and asks for the full revised body preserving wording", () => {
    const { system, prompt } = composeWholeEditPrompt({
      currentBody: "The whole update body.",
      instruction: "shorten everything",
      brandProfile,
      personas: [],
      examples: [],
    });
    expect(prompt).toContain("shorten everything");
    expect(prompt).toContain("The whole update body.");
    expect(system.toLowerCase()).toContain("full revised body");
    expect(system.toLowerCase()).toContain("rather than rewrite");
  });
});
