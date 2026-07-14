import { describe, it, expect } from "vitest";
import { truncateDiff } from "../../src/lib/github";

describe("truncateDiff", () => {
  it("returns short diffs unchanged", () => {
    const diff = "line1\nline2\nline3";
    expect(truncateDiff(diff)).toBe(diff);
  });

  it("caps a long diff at maxLines and marks it truncated", () => {
    const lines = Array.from({ length: 250 }, (_, i) => `line${i}`);
    const diff = lines.join("\n");

    const result = truncateDiff(diff, 200);

    const resultLines = result.split("\n");
    expect(resultLines).toHaveLength(201); // 200 content lines + 1 marker
    expect(resultLines[200]).toBe("… (truncated, 50 more lines)");
  });
});
