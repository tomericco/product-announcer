import { describe, it, expect } from "vitest";
import { listH2Headings, spliceImageAfterHeading } from "../../../src/lib/images/splice";

const BODY = [
  "# Title",
  "",
  "Intro paragraph.",
  "",
  "## First Section",
  "",
  "First paragraph.",
  "",
  "```md",
  "## Not A Heading",
  "```",
  "",
  "##   Second section  ",
  "Second paragraph.",
  "",
  "### Deeper heading",
  "",
  "## Closing",
  "",
  "Bye.",
].join("\n");

describe("listH2Headings", () => {
  it("returns trimmed H2 texts in order and ignores fenced code and other levels", () => {
    expect(listH2Headings(BODY)).toEqual(["First Section", "Second section", "Closing"]);
  });

  it("returns [] for a body with no H2", () => {
    expect(listH2Headings("# Only a title\n\nText.")).toEqual([]);
  });
});

describe("spliceImageAfterHeading", () => {
  const IMG = "![Gears turning](https://blob.example/gears.png)";

  it("inserts the image on its own paragraph directly after the matched heading line", () => {
    const out = spliceImageAfterHeading(BODY, "First Section", IMG);
    expect(out).toContain(`## First Section\n\n${IMG}\n\nFirst paragraph.`);
    // Nothing else moved.
    expect(out.replace(`${IMG}\n\n`, "")).toBe(BODY);
  });

  it("matches case-insensitively and trims both sides", () => {
    const out = spliceImageAfterHeading(BODY, "  second SECTION ", IMG);
    expect(out).toContain(`##   Second section  \n\n${IMG}\nSecond paragraph.`);
  });

  it("does not match a heading inside a code fence", () => {
    expect(spliceImageAfterHeading(BODY, "Not A Heading", IMG)).toBe(BODY);
  });

  it("is a no-op when the heading is not found", () => {
    expect(spliceImageAfterHeading(BODY, "Missing", IMG)).toBe(BODY);
  });

  it("uses only the first match when a heading text repeats", () => {
    const dup = "## Same\n\nA.\n\n## Same\n\nB.";
    const out = spliceImageAfterHeading(dup, "Same", IMG);
    expect(out).toBe(`## Same\n\n${IMG}\n\nA.\n\n## Same\n\nB.`);
  });

  it("splices two images after two headings without disturbing each other", () => {
    const one = spliceImageAfterHeading(BODY, "First Section", IMG);
    const two = spliceImageAfterHeading(one, "Closing", "![Wave](https://blob.example/wave.png)");
    expect(two).toContain(`## First Section\n\n${IMG}\n\nFirst paragraph.`);
    expect(two).toContain("## Closing\n\n![Wave](https://blob.example/wave.png)\n\nBye.");
    // Both headings still listed once each.
    expect(listH2Headings(two)).toEqual(["First Section", "Second section", "Closing"]);
  });

  it("does not match a heading that is only a prefix of another", () => {
    expect(spliceImageAfterHeading(BODY, "First", IMG)).toBe(BODY);
  });
});
