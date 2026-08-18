import { describe, it, expect } from "vitest";
import { composeExtractPrompt } from "../../../src/lib/ai/compose-prompt";
import type { companyProfiles } from "../../../src/db/schema";

type BrandProfileRow = typeof companyProfiles.$inferSelect;

// Minimal brand profile — buildSystemPrompt only reads these fields.
const brandProfile = {
  tenantId: "tenant-1",
  guidelines: null,
  industry: null,
  userPersonas: [],
} as unknown as BrandProfileRow;

describe("composeExtractPrompt", () => {
  it("includes the excerpt and asks for a self-contained update with its own title", () => {
    const { system, prompt } = composeExtractPrompt({
      excerpt: "We also rebuilt CSV export.",
      instruction: "",
      brandProfile,
      personas: [],
      examples: [],
    });
    expect(prompt).toContain("We also rebuilt CSV export.");
    expect(system.toLowerCase()).toContain("self-contained");
    expect(system.toLowerCase()).toContain("its own title");
    // It must not leak the parent update: no back-references.
    expect(system.toLowerCase()).toContain("no reference to the update it came from");
  });

  it("carries the brand guidelines through buildSystemPrompt", () => {
    const { system } = composeExtractPrompt({
      excerpt: "Something shipped.",
      instruction: "",
      brandProfile: { ...brandProfile, guidelines: "Always be plain-spoken." },
      personas: [],
      examples: [],
    });
    expect(system).toContain("Always be plain-spoken.");
  });

  it("adds an instruction block only when an instruction is given", () => {
    const withInstruction = composeExtractPrompt({
      excerpt: "Something shipped.",
      instruction: "focus on the API change",
      brandProfile,
      personas: [],
      examples: [],
    });
    expect(withInstruction.prompt).toContain("focus on the API change");
    expect(withInstruction.prompt).toContain("Additional instruction from the editor:");

    const withoutInstruction = composeExtractPrompt({
      excerpt: "Something shipped.",
      instruction: "   ",
      brandProfile,
      personas: [],
      examples: [],
    });
    expect(withoutInstruction.prompt).not.toContain("Additional instruction from the editor:");
  });

  it("truncates an over-long excerpt rather than sending it whole", () => {
    const { prompt } = composeExtractPrompt({
      excerpt: "x".repeat(40000),
      instruction: "",
      brandProfile,
      personas: [],
      examples: [],
    });
    expect(prompt).toContain("…(truncated)");
    expect(prompt.length).toBeLessThan(30000);
  });
});
