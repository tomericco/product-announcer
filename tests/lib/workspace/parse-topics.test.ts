import { describe, it, expect } from "vitest";
import { parseTopics } from "../../../src/lib/workspace/parse-topics";

describe("parseTopics", () => {
  it("splits on commas and newlines", () => {
    expect(parseTopics("ai agents, developer tools\nobservability")).toEqual([
      "ai agents",
      "developer tools",
      "observability",
    ]);
  });

  it("drops blanks and trims whitespace", () => {
    expect(parseTopics("  ai agents ,, \n\n , devtools  ")).toEqual(["ai agents", "devtools"]);
  });

  it("returns an empty array for empty or whitespace-only input", () => {
    expect(parseTopics("")).toEqual([]);
    expect(parseTopics("   \n  ")).toEqual([]);
  });

  it("deduplicates case-insensitively, keeping the first spelling", () => {
    expect(parseTopics("AI Agents, ai agents, AI agents")).toEqual(["AI Agents"]);
  });
});
