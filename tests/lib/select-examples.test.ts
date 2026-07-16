import { describe, it, expect } from "vitest";
import { selectExamples } from "../../src/lib/select-examples";
import type { systemUpdateExamples } from "../../src/db/schema";

type ExampleRow = typeof systemUpdateExamples.$inferSelect;

function ex(overrides: Partial<ExampleRow>): ExampleRow {
  return {
    id: "id",
    key: "k",
    industry: null,
    personaKey: null,
    category: "new",
    title: "t",
    body: "b",
    sortOrder: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("selectExamples", () => {
  it("ranks a both-tag match above a single-tag match", () => {
    const both = ex({ key: "both", industry: "SaaS", personaKey: "developer" });
    const industryOnly = ex({ key: "ind", industry: "SaaS", personaKey: "product-manager" });
    const result = selectExamples([industryOnly, both], { industry: "SaaS", personaKeys: ["developer"] });
    expect(result.map((r) => r.key)).toEqual(["both", "ind"]);
  });

  it("includes industry-only and persona-only matches, matching industry case-insensitively", () => {
    const industryOnly = ex({ key: "ind", industry: "saas", personaKey: "support-lead" });
    const personaOnly = ex({ key: "per", industry: "Fintech", personaKey: "developer" });
    const result = selectExamples([industryOnly, personaOnly], { industry: "SaaS", personaKeys: ["developer"] });
    expect(result.map((r) => r.key).sort()).toEqual(["ind", "per"]);
  });

  it("returns empty when nothing matches", () => {
    const none = ex({ key: "n", industry: "Fintech", personaKey: "support-lead" });
    expect(selectExamples([none], { industry: "SaaS", personaKeys: ["developer"] })).toEqual([]);
  });

  it("caps the result at the limit", () => {
    const rows = [1, 2, 3, 4].map((n) => ex({ key: `k${n}`, industry: "SaaS", sortOrder: n }));
    const result = selectExamples(rows, { industry: "SaaS", personaKeys: [] }, 2);
    expect(result).toHaveLength(2);
  });

  it("breaks equal-score ties by sort_order ascending", () => {
    const later = ex({ key: "later", industry: "SaaS", sortOrder: 20 });
    const earlier = ex({ key: "earlier", industry: "SaaS", sortOrder: 10 });
    const result = selectExamples([later, earlier], { industry: "SaaS", personaKeys: [] });
    expect(result.map((r) => r.key)).toEqual(["earlier", "later"]);
  });

  it("treats a null criteria industry as no industry match", () => {
    const industryRow = ex({ key: "ind", industry: "SaaS" });
    expect(selectExamples([industryRow], { industry: null, personaKeys: [] })).toEqual([]);
  });
});
