import { describe, it, expect } from "vitest";
import {
  CompanyContextSchema,
  buildCompanyContextPrompt,
  EMPTY_COMPANY_CONTEXT,
} from "../../../src/lib/workspace/analyze-company-context";

describe("company context schema", () => {
  it("accepts a fully populated context", () => {
    const parsed = CompanyContextSchema.safeParse({
      oneLiner: "Issue tracking for software teams.",
      category: "Project management",
      positioning: "Fast where incumbents are configurable.",
      topics: ["developer productivity", "issue tracking"],
      competitors: [{ name: "Jira", websiteUrl: "https://atlassian.com/jira" }],
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts nulls for prose fields the page did not support", () => {
    const parsed = CompanyContextSchema.safeParse({
      oneLiner: null,
      category: null,
      positioning: null,
      topics: [],
      competitors: [],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a competitor without a name", () => {
    const parsed = CompanyContextSchema.safeParse({
      oneLiner: null, category: null, positioning: null, topics: [],
      competitors: [{ websiteUrl: "https://atlassian.com" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("allows a competitor with no website", () => {
    const parsed = CompanyContextSchema.safeParse({
      oneLiner: null, category: null, positioning: null, topics: [],
      competitors: [{ name: "Jira", websiteUrl: null }],
    });
    expect(parsed.success).toBe(true);
  });

  it("EMPTY_COMPANY_CONTEXT is itself a valid, wholly-empty context", () => {
    expect(CompanyContextSchema.safeParse(EMPTY_COMPANY_CONTEXT).success).toBe(true);
    expect(EMPTY_COMPANY_CONTEXT.topics).toEqual([]);
    expect(EMPTY_COMPANY_CONTEXT.competitors).toEqual([]);
  });
});

describe("buildCompanyContextPrompt", () => {
  it("embeds the page text", () => {
    expect(buildCompanyContextPrompt("ACME builds widgets")).toContain("ACME builds widgets");
  });
});
