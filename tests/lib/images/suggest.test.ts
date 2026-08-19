import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("../../../src/lib/ai/llm-usage", () => ({ recordLlmUsage: vi.fn(async () => {}) }));

import { generateObject } from "ai";
import { recordLlmUsage } from "../../../src/lib/ai/llm-usage";
import { suggestImageConcept } from "../../../src/lib/images/suggest";

// Reset between cases: without this the second test's "the default generator
// was not used" assertion depends on how many times the FIRST test called it,
// which makes it fail the moment a case is added, reordered, or run with
// `-t`. Assert "not called since this test began", not a cumulative count.
beforeEach(() => {
  vi.mocked(generateObject).mockReset();
  vi.mocked(recordLlmUsage).mockClear();
});

describe("suggestImageConcept", () => {
  it("asks the text model for a concept and alt text grounded in the surrounding markdown", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { concept: "A magnifying glass over a grid of documents", altText: "Magnifying glass over documents" },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    } as never);

    const out = await suggestImageConcept({
      tenantId: "t1",
      title: "Faster search",
      surroundingMarkdown: "## Search\n\nSearch returns in under a second.",
      role: "body",
    });

    expect(out).toEqual({
      concept: "A magnifying glass over a grid of documents",
      altText: "Magnifying glass over documents",
    });
    const args = vi.mocked(generateObject).mock.calls.at(-1)![0];
    expect(args.prompt).toContain("Search returns in under a second.");
    expect(args.prompt).toContain("Faster search");
    expect(args.system).toMatch(/no text/i);
    expect(recordLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "t1", operation: "illustration_plan" }),
      expect.anything()
    );
  });

  it("uses an injected generator and says 'cover' composition for covers", async () => {
    const generate = vi.fn(async () => ({
      object: { concept: "c", altText: "a" },
      usage: {},
    })) as never;
    await suggestImageConcept(
      { tenantId: "t1", title: "T", surroundingMarkdown: "body", role: "cover" },
      { generate }
    );
    const args = (generate as ReturnType<typeof vi.fn>).mock.calls[0][0] as { system: string };
    expect(args.system).toMatch(/cover/i);
    // The injected generator was used INSTEAD of the module default — an
    // absolute assertion, not a cumulative call count.
    expect(vi.mocked(generateObject)).not.toHaveBeenCalled();
  });

  it("records usage against the caller's database handle, not the default one", async () => {
    const database = {} as never;
    const generate = vi.fn(async () => ({ object: { concept: "c", altText: "a" }, usage: { totalTokens: 7 } })) as never;
    await suggestImageConcept({ tenantId: "t1", title: "T", surroundingMarkdown: "b", role: "body", database }, { generate });
    expect(recordLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "t1", operation: "illustration_plan", usage: { totalTokens: 7 } }),
      database
    );
  });

  it("trims the model's concept and alt text", async () => {
    const generate = vi.fn(async () => ({ object: { concept: "  A compass  ", altText: "  Compass  " }, usage: {} })) as never;
    const out = await suggestImageConcept({ tenantId: "t1", title: "T", surroundingMarkdown: "b", role: "body" }, { generate });
    expect(out).toEqual({ concept: "A compass", altText: "Compass" });
  });

  it("lets a model failure propagate — the caller's panel shows the error, it does not silently return an empty concept", async () => {
    const generate = vi.fn(async () => {
      throw new Error("model down");
    }) as never;
    await expect(
      suggestImageConcept({ tenantId: "t1", title: "T", surroundingMarkdown: "b", role: "body" }, { generate })
    ).rejects.toThrow("model down");
    expect(recordLlmUsage).not.toHaveBeenCalled();
  });
});
