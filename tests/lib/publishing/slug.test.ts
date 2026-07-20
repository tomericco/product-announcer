import { describe, it, expect } from "vitest";
import { slugify, withSuffix, MAX_LENGTH } from "../../../src/lib/publishing/slug";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("strips punctuation and collapses repeats", () => {
    expect(slugify("New!  Faster --- Search?")).toBe("new-faster-search");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("  -- Launch --  ")).toBe("launch");
  });

  it("caps length at 200 characters without a trailing hyphen", () => {
    const slug = slugify("word ".repeat(100));
    expect(slug.length).toBeLessThanOrEqual(200);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("falls back when the title has no usable characters", () => {
    expect(slugify("!!!")).toBe("update");
    expect(slugify("")).toBe("update");
  });
});

describe("withSuffix", () => {
  it("returns the base slug on the first attempt", () => {
    expect(withSuffix("launch", 0)).toBe("launch");
  });

  it("appends an incrementing suffix on later attempts", () => {
    expect(withSuffix("launch", 1)).toBe("launch-2");
    expect(withSuffix("launch", 2)).toBe("launch-3");
  });

  it("keeps long slugs within the length cap when adding a single-digit suffix", () => {
    const longSlug = slugify("a".repeat(250));
    const result = withSuffix(longSlug, 1);
    expect(result.length).toBeLessThanOrEqual(MAX_LENGTH);
    expect(result.endsWith("-2")).toBe(true);
  });

  it("keeps long slugs within the cap even with multi-digit suffixes", () => {
    const longSlug = slugify("a".repeat(250));
    const result = withSuffix(longSlug, 11); // suffix is "-12"
    expect(result.length).toBeLessThanOrEqual(MAX_LENGTH);
    expect(result.endsWith("-12")).toBe(true);
  });

  it("does not produce double hyphens when truncating a slug ending with hyphens", () => {
    // Create a slug that ends with hyphens before truncation
    const baseSlug = "a-".repeat(100); // 200 chars ending with "-"
    const result = withSuffix(baseSlug, 1);
    expect(result).not.toMatch(/--/);
    expect(result.length).toBeLessThanOrEqual(MAX_LENGTH);
  });
});
