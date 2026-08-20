import { describe, it, expect } from "vitest";
import { buildImagePrompt, IMAGE_ASPECT_RATIOS, IMAGE_SIZES, NO_TEXT_CLAUSE, NON_LITERAL_CLAUSE, NON_LITERAL_DIRECTIVE } from "../../../src/lib/images/prompt";

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

  it("exposes the two render sizes — both multiples of 16 (gpt-image-2 requires it)", () => {
    expect(IMAGE_SIZES).toEqual({ cover: "1200x624", body: "1200x896" });
    for (const size of Object.values(IMAGE_SIZES)) {
      const [w, h] = size.split("x").map(Number);
      expect(w % 16).toBe(0);
      expect(h % 16).toBe(0);
    }
  });

  it("exposes an aspect ratio for every size, in generateImage's {w}:{h} form", () => {
    // Covers are generated wide, never cropped (product owner decision 1), so
    // the request states the shape twice: `size` for providers that take exact
    // pixels, `aspectRatio` for providers that take a ratio. The two must
    // agree, or a provider honouring the ratio would return a different shape
    // from one honouring the size.
    expect(IMAGE_ASPECT_RATIOS).toEqual({ "1200x624": "25:13", "1200x896": "75:56" });
    for (const [size, ratio] of Object.entries(IMAGE_ASPECT_RATIOS)) {
      const [sw, sh] = size.split("x").map(Number);
      const [rw, rh] = ratio.split(":").map(Number);
      expect(Math.abs(sw / sh - rw / rh)).toBeLessThan(0.001);
    }
  });
});

describe("the non-literal house rule", () => {
  // The point of this block: the rule has to be unconditional. It is not a
  // brand setting and not a per-role choice — every render, every tenant.
  it("reaches every compiled prompt, cover and body, with or without a style block", () => {
    for (const role of ["cover", "body"] as const) {
      for (const styleBlock of ["Style: flat.", ""]) {
        for (const allowText of [true, false]) {
          expect(buildImagePrompt({ styleBlock, concept: "c", role, allowText })).toContain(NON_LITERAL_CLAUSE);
        }
      }
    }
  });

  it("sits between the concept and the style block, while the concept is still what's being read", () => {
    const prompt = buildImagePrompt({ styleBlock: "Style: flat.", concept: "a lighthouse", role: "cover", allowText: false });

    expect(prompt.indexOf(NON_LITERAL_CLAUSE)).toBeGreaterThan(prompt.indexOf("a lighthouse"));
    expect(prompt.indexOf(NON_LITERAL_CLAUSE)).toBeLessThan(prompt.indexOf("Style: flat."));
  });

  it("names the figures of speech it exists to stop, so the rule survives a reword", () => {
    // The examples ARE the mechanism — a directive that merely said "don't be
    // literal" gives the model nothing to pattern-match against.
    for (const word of ["upstream", "pipeline", "velocity", "unlock", "bridge"]) {
      expect(NON_LITERAL_DIRECTIVE).toContain(word);
    }
  });
});
