import { describe, it, expect } from "vitest";
import { slugify, withSuffix } from "../../../src/lib/publishing/slug";

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
});
