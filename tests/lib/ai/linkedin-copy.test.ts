import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("../../../src/lib/ai/llm-usage", () => ({ recordLlmUsage: vi.fn() }));

import { generateObject } from "ai";
import { recordLlmUsage } from "../../../src/lib/ai/llm-usage";
import { buildLinkedinCopyPrompt, generateLinkedinCopy, LINKEDIN_MAX_CHARS } from "../../../src/lib/ai/linkedin-copy";

describe("linkedin copy generation", () => {
  beforeEach(() => {
    vi.mocked(generateObject).mockReset();
    vi.mocked(recordLlmUsage).mockReset();
  });

  it("builds a prompt that names the char limit and forbids markdown", () => {
    const { system, prompt } = buildLinkedinCopyPrompt({ title: "New dashboard", body: "We shipped X." });
    expect(system).toContain(String(LINKEDIN_MAX_CHARS));
    expect(system.toLowerCase()).toContain("no markdown");
    expect(prompt).toContain("New dashboard");
    expect(prompt).toContain("We shipped X.");
  });

  it("includes the many-updates rule pointing readers to the appended link", () => {
    const { system } = buildLinkedinCopyPrompt({ title: "T", body: "B" });
    expect(system.toLowerCase()).toContain("five or more");
    expect(system.toLowerCase()).toContain("linked release");
  });

  it("appends company guidelines when provided", () => {
    const { system } = buildLinkedinCopyPrompt({
      title: "T",
      body: "B",
      guidelines: "Always end with #ProductUpdate.",
    });
    expect(system).toContain("Always end with #ProductUpdate.");
    expect(system.toLowerCase()).toContain("company-specific");
  });

  it("omits the guidelines section when guidelines are absent or blank", () => {
    const none = buildLinkedinCopyPrompt({ title: "T", body: "B" }).system;
    const blank = buildLinkedinCopyPrompt({ title: "T", body: "B", guidelines: "   " }).system;
    expect(none.toLowerCase()).not.toContain("company-specific");
    expect(blank.toLowerCase()).not.toContain("company-specific");
  });

  it("passes guidelines through generateLinkedinCopy into the prompt", async () => {
    vi.mocked(generateObject).mockResolvedValue({ object: { post: "x" }, usage: {} } as never);
    await generateLinkedinCopy({ tenantId: "t1", title: "T", body: "B", guidelines: "Be bold." });
    const call = vi.mocked(generateObject).mock.calls[0][0] as { system: string };
    expect(call.system).toContain("Be bold.");
  });

  it("returns generated copy and records usage", async () => {
    vi.mocked(generateObject).mockResolvedValue({ object: { post: "Hook line.\n\nDetails." }, usage: { totalTokens: 42 } } as never);
    const copy = await generateLinkedinCopy({ tenantId: "t1", title: "T", body: "B" });
    expect(copy).toBe("Hook line.\n\nDetails.");
    expect(recordLlmUsage).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", operation: "linkedin_copy" }));
  });
});
