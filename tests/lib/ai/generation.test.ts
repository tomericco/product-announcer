import { describe, it, expect, vi } from "vitest";

vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

import { generateObject } from "ai";
import { generateReleaseDraft, generateExtractedDraft } from "../../../src/lib/ai/generation";

describe("generateReleaseDraft", () => {
  it("passes atomic updates (no repo map) and brand profile into the prompt, and returns the object", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "Faster search", body: "We rebuilt search." },
    } as never);

    const items = [
      { id: "a1", title: "CSV export", summary: "Export reports as CSV.", category: "new" as const, size: "m" as const },
      { id: "a2", title: "Faster search", summary: "Search returns in under a second.", category: "improvement" as const, size: "m" as const },
    ];

    const brandProfile = {
      tenantId: "tenant_1",
      guidelines: "## Voice and tone\n\nFriendly and plain.\n\n## Do\n\n- Be concise.",
      industry: "B2B SaaS",
      userPersonas: [],
    } as never;

    const personas = [
      { name: "engineering managers", brief: "track shipped work; care about what changed" },
    ];

    const draft = await generateReleaseDraft(items, brandProfile, personas);

    expect(draft).toEqual({ title: "Faster search", body: "We rebuilt search." });

    const callArgs = vi.mocked(generateObject).mock.calls.at(-1)![0];
    expect(callArgs.system).toContain("Industry: B2B SaaS.");
    expect(callArgs.system).toContain("engineering managers: track shipped work");
    expect(callArgs.prompt).toContain("CSV export");
    expect(callArgs.prompt).toContain("Export reports as CSV.");
  });
});

describe("generateExtractedDraft", () => {
  it("passes the excerpt and instruction into the prompt and returns the object", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "CSV export", body: "You can now export reports as CSV." },
    } as never);

    const brandProfile = {
      tenantId: "tenant_1",
      guidelines: null,
      industry: "B2B SaaS",
      userPersonas: [],
    } as never;

    const draft = await generateExtractedDraft({
      excerpt: "We also rebuilt CSV export so reports download in seconds.",
      instruction: "lead with the speed",
      brandProfile,
    });

    expect(draft).toEqual({ title: "CSV export", body: "You can now export reports as CSV." });

    const callArgs = vi.mocked(generateObject).mock.calls.at(-1)![0];
    expect(callArgs.prompt).toContain("We also rebuilt CSV export so reports download in seconds.");
    expect(callArgs.prompt).toContain("lead with the speed");
    expect(callArgs.system).toContain("Industry: B2B SaaS.");
    expect(typeof callArgs.system).toBe("string");
    if (typeof callArgs.system === "string") {
      expect(callArgs.system.toLowerCase()).toContain("self-contained");
    }
  });
});
