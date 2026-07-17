import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));

import { generateObject } from "ai";
import { buildAnalysisPrompt, analyzeBrandStyle } from "../../../src/lib/workspace/analyze-brand-style";

describe("buildAnalysisPrompt", () => {
  it("includes the page text", () => {
    expect(buildAnalysisPrompt("We shipped dark mode.")).toContain("We shipped dark mode.");
  });
});

describe("analyzeBrandStyle", () => {
  beforeEach(() => {
    vi.mocked(generateObject).mockReset();
  });

  it("returns the parsed derived profile", async () => {
    const derived = { tone: "friendly", readingLevel: "simple", doList: ["be concise"], dontList: ["hype"], examplePhrases: ["ship"], industry: "SaaS", updatesStyleSummary: "Short bullets." };
    vi.mocked(generateObject).mockResolvedValue({ object: derived } as never);
    expect(await analyzeBrandStyle("text")).toEqual(derived);
  });

  it("returns an all-empty derivation on model error", async () => {
    vi.mocked(generateObject).mockRejectedValue(new Error("model down"));
    expect(await analyzeBrandStyle("text")).toEqual({
      tone: null, readingLevel: null, doList: [], dontList: [], examplePhrases: [], industry: null, updatesStyleSummary: null,
    });
  });
});
