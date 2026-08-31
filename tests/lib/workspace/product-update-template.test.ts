import { describe, it, expect } from "vitest";
import {
  TEMPLATE_VARIABLES,
  DEFAULT_PRODUCT_UPDATE_TEMPLATE,
} from "../../../src/lib/workspace/product-update-template";

describe("TEMPLATE_VARIABLES", () => {
  it("lists every variable the composer substitutes", () => {
    expect([...TEMPLATE_VARIABLES]).toEqual([
      "count",
      "count_new",
      "count_improvement",
      "count_fix",
      "count_announcement",
      "count_s",
      "count_rounded",
      "month",
      "year",
    ]);
  });
});

describe("DEFAULT_PRODUCT_UPDATE_TEMPLATE", () => {
  it("opens with an H1 so the title pattern is demonstrated", () => {
    expect(DEFAULT_PRODUCT_UPDATE_TEMPLATE.startsWith("# ")).toBe(true);
  });

  it("demonstrates at least one variable", () => {
    expect(DEFAULT_PRODUCT_UPDATE_TEMPLATE).toContain("{month}");
  });
});
