import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("../../../src/lib/ai/llm-usage", () => ({ recordLlmUsage: vi.fn() }));

import { generateObject } from "ai";
import { deriveUpdateTemplate } from "../../../src/lib/workspace/derive-update-template";

describe("deriveUpdateTemplate", () => {
  afterEach(() => vi.mocked(generateObject).mockReset());

  it("returns the derived skeleton", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { template: "# What's new in {month}\n\n## Highlights\n" },
      usage: {},
    } as never);

    expect(await deriveUpdateTemplate("page text", "tenant-1")).toBe(
      "# What's new in {month}\n\n## Highlights\n"
    );
  });

  it("returns null when the page shows no consistent structure", async () => {
    vi.mocked(generateObject).mockResolvedValue({ object: { template: null }, usage: {} } as never);
    expect(await deriveUpdateTemplate("page text", "tenant-1")).toBeNull();
  });

  it("normalizes a blank derivation to null", async () => {
    vi.mocked(generateObject).mockResolvedValue({ object: { template: "   \n " }, usage: {} } as never);
    expect(await deriveUpdateTemplate("page text", "tenant-1")).toBeNull();
  });

  it("returns null rather than throwing when the model call fails", async () => {
    vi.mocked(generateObject).mockRejectedValue(new Error("boom"));
    expect(await deriveUpdateTemplate("page text", "tenant-1")).toBeNull();
  });
});
