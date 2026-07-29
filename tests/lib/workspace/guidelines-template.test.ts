import { describe, it, expect } from "vitest";
import { GUIDELINES_TEMPLATE, GUIDELINES_HEADINGS } from "../../../src/lib/workspace/guidelines-template";

describe("GUIDELINES_TEMPLATE", () => {
  it("is a non-empty markdown document", () => {
    expect(GUIDELINES_TEMPLATE.trim().length).toBeGreaterThan(0);
  });

  // The analysis prompt asks the model for these exact headings and the editor
  // seeds an empty workspace with them. If the two drift apart, an imported
  // document and a hand-written one stop looking like the same artifact.
  it("contains every heading listed in GUIDELINES_HEADINGS", () => {
    for (const heading of GUIDELINES_HEADINGS) {
      expect(GUIDELINES_TEMPLATE).toContain(`## ${heading}`);
    }
  });

  it("lists five headings", () => {
    expect(GUIDELINES_HEADINGS).toHaveLength(5);
  });
});
