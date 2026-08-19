import { describe, it, expect } from "vitest";
import { buildImagePrompt, IMAGE_ASPECT_RATIOS, IMAGE_SIZES, NO_TEXT_CLAUSE } from "../../../src/lib/images/prompt";

describe("buildImagePrompt", () => {
  it("orders concept, style block, composition, aspect, then the no-text clause for a cover", () => {
    const prompt = buildImagePrompt({ styleBlock: "Style: flat.", concept: "a lighthouse guiding ships", role: "cover", allowText: false });
    const i = (s: string) => prompt.indexOf(s);
    expect(i("a lighthouse guiding ships")).toBe(0);
    expect(i("Style: flat.")).toBeGreaterThan(i("a lighthouse"));
    expect(i("Wide hero composition")).toBeGreaterThan(i("Style: flat."));
    expect(i("safe zone")).toBeGreaterThan(0);
    expect(i("1.91:1")).toBeGreaterThan(i("Wide hero"));
    expect(prompt.endsWith(NO_TEXT_CLAUSE)).toBe(true);
    expect(prompt).not.toContain("\n");
  });

  it("uses the single-concept composition and 4:3 aspect for a body image", () => {
    const prompt = buildImagePrompt({ styleBlock: "S.", concept: "c", role: "body", allowText: false });
    expect(prompt).toContain("Single-concept illustration");
    expect(prompt).toContain("4:3");
    expect(prompt).not.toContain("Wide hero");
  });

  it("drops the no-text clause when text is allowed", () => {
    const prompt = buildImagePrompt({ styleBlock: "S.", concept: "c", role: "body", allowText: true });
    expect(prompt).not.toContain(NO_TEXT_CLAUSE);
  });

  it("exposes the two render sizes", () => {
    expect(IMAGE_SIZES).toEqual({ cover: "1200x630", body: "1200x900" });
  });

  it("exposes an aspect ratio for every size, in generateImage's {w}:{h} form", () => {
    // Covers are generated wide, never cropped (product owner decision 1), so
    // the request states the shape twice: `size` for providers that take exact
    // pixels, `aspectRatio` for providers that take a ratio. The two must
    // agree, or a provider honouring the ratio would return a different shape
    // from one honouring the size.
    expect(IMAGE_ASPECT_RATIOS).toEqual({ "1200x630": "40:21", "1200x900": "4:3" });
    for (const [size, ratio] of Object.entries(IMAGE_ASPECT_RATIOS)) {
      const [sw, sh] = size.split("x").map(Number);
      const [rw, rh] = ratio.split(":").map(Number);
      expect(Math.abs(sw / sh - rw / rh)).toBeLessThan(0.001);
    }
  });
});
