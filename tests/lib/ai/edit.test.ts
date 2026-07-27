import { describe, it, expect, vi, beforeEach } from "vitest";
import type { brandProfiles } from "../../../src/db/schema";

type BrandProfileRow = typeof brandProfiles.$inferSelect;

const generateObject = vi.fn();
vi.mock("ai", () => ({ generateObject: (...args: unknown[]) => generateObject(...args) }));
vi.mock("../../../src/lib/ai/model", () => ({
  resolveModel: vi.fn(() => "test-model"),
  modelId: vi.fn(() => "test-model-id"),
}));
vi.mock("../../../src/lib/ai/llm-usage", () => ({ recordLlmUsage: vi.fn(async () => {}) }));

import { editReleaseBody, stripWrapping } from "../../../src/lib/ai/edit";

const brandProfile = { tenantId: "t1", industry: null, tone: null, readingLevel: null, doList: [], dontList: [], examplePhrases: [], updatesStyleSummary: null, userPersonas: [] } as unknown as BrandProfileRow;

describe("stripWrapping", () => {
  it("removes a wrapping code fence", () => {
    expect(stripWrapping("```md\nhello world\n```")).toBe("hello world");
  });
  it("removes surrounding quotes", () => {
    expect(stripWrapping('"hello"')).toBe("hello");
  });
  it("leaves clean text untouched", () => {
    expect(stripWrapping("hello world")).toBe("hello world");
  });
});

describe("editReleaseBody", () => {
  beforeEach(() => generateObject.mockReset());

  it("uses the scoped prompt in selection mode and strips wrapping from the result", async () => {
    generateObject.mockResolvedValue({ object: { text: "```\nrevised excerpt\n```" }, usage: {} });
    const out = await editReleaseBody({
      mode: "selection", instruction: "punchier", currentBody: "full body", excerpt: "old excerpt", brandProfile,
    });
    expect(out).toBe("revised excerpt");
    const call = generateObject.mock.calls[0][0];
    expect(call.system.toLowerCase()).toContain("only the revised excerpt");
    expect(call.prompt).toContain("old excerpt");
  });

  it("uses the whole prompt in whole mode", async () => {
    generateObject.mockResolvedValue({ object: { text: "new full body" }, usage: {} });
    const out = await editReleaseBody({
      mode: "whole", instruction: "shorten", currentBody: "long body", excerpt: "", brandProfile,
    });
    expect(out).toBe("new full body");
    const call = generateObject.mock.calls[0][0];
    expect(call.system.toLowerCase()).toContain("full revised body");
    expect(call.prompt).toContain("long body");
  });
});
