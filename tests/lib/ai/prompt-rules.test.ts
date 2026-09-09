import { describe, it, expect } from "vitest";
import { SIZE_RUBRIC, CATEGORY_RUBRIC, fenceGuidelines, truncateForPrompt } from "../../../src/lib/ai/prompt-rules";
import { SIZE_BANDS, SIZE_RANK } from "../../../src/lib/atomic-updates/sizes";

const BOTTOM_UP_SENTENCE =
  "Decide from the bottom up: if no user could notice it, 'xxs'; if a user could notice it but would not care, 'xs'; otherwise 's' or larger by how many users it reaches and how much it changes for them.";

describe("SIZE_RUBRIC", () => {
  it("names every band as 'key' (gloss), ascending (xxs first, xl last)", () => {
    const ascending = [...SIZE_BANDS].reverse();
    let searchFrom = 0;
    for (const band of ascending) {
      const needle = `'${band.key}' (${band.gloss})`;
      const at = SIZE_RUBRIC.indexOf(needle, searchFrom);
      expect(at).toBeGreaterThanOrEqual(0);
      searchFrom = at + needle.length;
    }
  });

  it("ends with the bottom-up decision sentence, verbatim", () => {
    expect(SIZE_RUBRIC.endsWith(BOTTOM_UP_SENTENCE)).toBe(true);
  });
});

describe("SIZE_RANK", () => {
  it("ranks descending by significance, matching SIZE_BANDS order", () => {
    for (let i = 0; i < SIZE_BANDS.length - 1; i++) {
      const higher = SIZE_BANDS[i].key;
      const lower = SIZE_BANDS[i + 1].key;
      expect(SIZE_RANK[higher]).toBeGreaterThan(SIZE_RANK[lower]);
    }
  });

  it("has an entry for every band and nothing else", () => {
    expect(Object.keys(SIZE_RANK).sort()).toEqual(SIZE_BANDS.map((b) => b.key).sort());
  });
});

describe("CATEGORY_RUBRIC", () => {
  it("names every category with its gloss", () => {
    for (const key of ["new", "improvement", "fix", "announcement"]) {
      expect(CATEGORY_RUBRIC).toContain(`'${key}'`);
    }
  });
});

describe("fenceGuidelines", () => {
  it("returns null for null, empty, and whitespace-only input", () => {
    expect(fenceGuidelines(null)).toBeNull();
    expect(fenceGuidelines("")).toBeNull();
    expect(fenceGuidelines("   \n  ")).toBeNull();
  });

  it("wraps trimmed guidelines in the brand-guidelines fence", () => {
    expect(fenceGuidelines("  Be brief.  ")).toBe("<brand-guidelines>\nBe brief.\n</brand-guidelines>");
  });

  it("truncates a very long document inside the fence", () => {
    const fenced = fenceGuidelines("x".repeat(7000));
    expect(fenced).toContain("…(truncated)");
    expect(fenced!.length).toBeLessThan(7000);
  });
});

describe("truncateForPrompt", () => {
  it("returns short text unchanged", () => {
    expect(truncateForPrompt("hello", 100)).toBe("hello");
  });

  it("returns text at exactly the limit unchanged", () => {
    expect(truncateForPrompt("abcde", 5)).toBe("abcde");
  });

  it("appends the truncation marker when over the limit", () => {
    expect(truncateForPrompt("abcdef", 5)).toBe("abcde\n…(truncated)");
  });
});
