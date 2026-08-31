import { describe, it, expect } from "vitest";
import {
  SIZE_BANDS,
  SIZE_RANK,
  SIZE_RUBRIC,
  CATEGORY_RUBRIC,
  fenceGuidelines,
  truncateForPrompt,
} from "../../../src/lib/ai/prompt-rules";

// The exact string this replaces, copied from resolve-atomic-updates.ts:57-61
// and regenerate-atomic-summary.ts:29-33 (byte-identical in both). This
// extraction MUST NOT change behaviour, so the snapshot is the whole point of
// the test — if you change SIZE_BANDS' glosses, this fails and that is correct.
const CURRENT_SIZE_RUBRIC = [
  "Also pick a size by USER-FACING SIGNIFICANCE (not amount of code): 's' (a minor fix, tweak, or polish —",
  "small individual user impact), 'm' (a standard improvement or small feature noticeable to users of that",
  "area), 'l' (a significant feature or major improvement worth calling out to many users), 'xl' (a flagship",
  "or headline change — a major new capability or overhaul you would lead an announcement with).",
].join(" ");

describe("SIZE_RUBRIC", () => {
  it("renders byte-identically to the text it replaces", () => {
    expect(SIZE_RUBRIC).toBe(CURRENT_SIZE_RUBRIC);
  });
});

describe("SIZE_RANK", () => {
  it("ranks descending by significance, matching SIZE_BANDS order", () => {
    expect(SIZE_RANK.xl).toBeGreaterThan(SIZE_RANK.l);
    expect(SIZE_RANK.l).toBeGreaterThan(SIZE_RANK.m);
    expect(SIZE_RANK.m).toBeGreaterThan(SIZE_RANK.s);
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
