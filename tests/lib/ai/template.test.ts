import { describe, it, expect } from "vitest";
import { parseTemplate, substituteVariables, roundDownToTen } from "../../../src/lib/ai/template";

const AUG = new Date("2026-08-20T00:00:00Z");
const SEP = new Date("2026-09-02T00:00:00Z");

describe("parseTemplate", () => {
  it("splits a leading H1 into the title pattern", () => {
    expect(parseTemplate("# Updates in {month}\n\n## Highlights\n")).toEqual({
      titlePattern: "Updates in {month}",
      bodySkeleton: "## Highlights",
    });
  });

  it("leaves the title untemplated when there is no leading H1", () => {
    expect(parseTemplate("## Highlights\n\n## Fixes\n")).toEqual({
      titlePattern: null,
      bodySkeleton: "## Highlights\n\n## Fixes",
    });
  });

  it("does not treat a later H1 as the title pattern", () => {
    const parsed = parseTemplate("## Highlights\n\n# Not the title\n");
    expect(parsed.titlePattern).toBeNull();
    expect(parsed.bodySkeleton).toContain("# Not the title");
  });

  it("takes a deeper first heading as the title when nothing below is its peer", () => {
    // A company whose entries are headed `## …` yields a template headed
    // `## …`. Requiring `#` here silently produced templates with no title
    // pattern while the derivation looked like it had worked — measured
    // against a real updates page on 2026-08-31.
    expect(parseTemplate("## {main feature} {month}\n\n{intro paragraph}\n\nTeam Acme")).toEqual({
      titlePattern: "{main feature} {month}",
      bodySkeleton: "{intro paragraph}\n\nTeam Acme",
    });
  });

  it("treats a first heading with same-level peers below as a section, not a title", () => {
    // Promoting it would drop a real section AND invent a title pattern from
    // its name.
    expect(parseTemplate("## Highlights\n\n## Fixes").titlePattern).toBeNull();
    expect(parseTemplate("# Highlights\n\n# Fixes").titlePattern).toBeNull();
  });

  it("keeps a title whose sections are deeper than it", () => {
    expect(parseTemplate("## Title\n\n### Fixes\n\n### Improvements").titlePattern).toBe("Title");
  });

  it("tolerates leading blank lines before the H1", () => {
    expect(parseTemplate("\n\n# Title\n\n## Body\n").titlePattern).toBe("Title");
  });
});

describe("roundDownToTen", () => {
  it("returns the exact count below ten", () => {
    expect(roundDownToTen(0)).toBe(0);
    expect(roundDownToTen(9)).toBe(9);
  });

  it("rounds down to the nearest ten at and above ten", () => {
    expect(roundDownToTen(10)).toBe(10);
    expect(roundDownToTen(23)).toBe(20);
    expect(roundDownToTen(29)).toBe(20);
    expect(roundDownToTen(30)).toBe(30);
  });
});

describe("substituteVariables", () => {
  const facts = {
    items: [
      { category: "new", size: "xl" },
      { category: "new", size: "m" },
      { category: "fix", size: "s" },
      { category: "improvement", size: "s" },
      { category: null, size: null },
    ],
    latestEvidenceAt: AUG,
    now: SEP,
  };

  it("substitutes counts", () => {
    expect(substituteVariables("{count} / {count_new} / {count_fix} / {count_s}", facts)).toBe("5 / 2 / 1 / 2");
  });

  it("substitutes the rounded count", () => {
    expect(substituteVariables("{count_rounded}+", facts)).toBe("5+");
  });

  it("takes the period from the latest evidence date, not from now", () => {
    expect(substituteVariables("{month} {year}", facts)).toBe("August 2026");
  });

  it("substitutes the day, so a day-dated title never needs one invented", () => {
    expect(substituteVariables("{month} {day}, {year}", facts)).toBe("August 20, 2026");
  });

  it("falls back to now when no item carries an evidence date", () => {
    expect(substituteVariables("{month}", { ...facts, latestEvidenceAt: null })).toBe("September");
  });

  it("leaves an unrecognised token untouched", () => {
    expect(substituteVariables("{count} {not_a_variable}", facts)).toBe("5 {not_a_variable}");
  });

  it("returns a template using no variables unchanged", () => {
    expect(substituteVariables("## Highlights\n", facts)).toBe("## Highlights\n");
  });

  it("substitutes every occurrence, not only the first", () => {
    expect(substituteVariables("{count} and {count}", facts)).toBe("5 and 5");
  });
});
