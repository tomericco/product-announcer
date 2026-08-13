import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { companyProfiles, competitors } from "../../../src/db/schema";
import { bootstrapCompanyContext } from "../../../src/lib/workspace/company-bootstrap";
import { EMPTY_COMPANY_CONTEXT } from "../../../src/lib/workspace/analyze-company-context";
import { seedTenant, dropTenant } from "../../helpers/fixtures";

const TENANT = "Company Bootstrap Test Tenant";

const FULL = {
  oneLiner: "Issue tracking for software teams.",
  category: "Project management",
  positioning: "Fast where incumbents are configurable.",
  topics: ["developer productivity"],
  competitors: [{ name: "Jira", websiteUrl: "https://atlassian.com/jira" }],
};

describe("bootstrapCompanyContext", () => {
  afterEach(async () => {
    await dropTenant(TENANT);
  });

  it("persists the drafted context, the url, and the competitors", async () => {
    const tenant = await seedTenant(TENANT);
    const result = await bootstrapCompanyContext(tenant.id, "https://acme.com", {
      crawl: async () => ({ text: "site text", pages: ["https://acme.com"] }),
      analyze: async () => FULL,
    });
    expect(result.ok).toBe(true);

    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile.oneLiner).toBe(FULL.oneLiner);
    expect(profile.category).toBe(FULL.category);
    expect(profile.positioning).toBe(FULL.positioning);
    expect(profile.topics).toEqual(["developer productivity"]);
    expect(profile.websiteUrl).toBe("https://acme.com");

    const rows = await db.select().from(competitors).where(eq(competitors.tenantId, tenant.id));
    expect(rows.map((r) => r.name)).toEqual(["Jira"]);
  });

  it("returns the crawl error and writes nothing", async () => {
    const tenant = await seedTenant(TENANT);
    const result = await bootstrapCompanyContext(tenant.id, "https://acme.com", {
      crawl: async () => ({ error: "blocked" as const }),
      analyze: async () => FULL,
    });
    expect(result).toEqual({ ok: false, reason: "blocked" });
    const rows = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(rows).toHaveLength(0);
  });

  it("reports an empty analysis without writing", async () => {
    const tenant = await seedTenant(TENANT);
    const result = await bootstrapCompanyContext(tenant.id, "https://acme.com", {
      crawl: async () => ({ text: "site text", pages: ["https://acme.com"] }),
      analyze: async () => EMPTY_COMPANY_CONTEXT,
    });
    expect(result).toEqual({ ok: false, reason: "analysis-empty" });
  });

  it("never overwrites a hand-written field with a null derivation", async () => {
    const tenant = await seedTenant(TENANT);
    await db.insert(companyProfiles).values({ tenantId: tenant.id, positioning: "written by a human" });

    await bootstrapCompanyContext(tenant.id, "https://acme.com", {
      crawl: async () => ({ text: "site text", pages: ["https://acme.com"] }),
      analyze: async () => ({ ...EMPTY_COMPANY_CONTEXT, oneLiner: "Inferred." }),
    });

    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile.positioning).toBe("written by a human");
    expect(profile.oneLiner).toBe("Inferred.");
  });

  it("is idempotent on competitors across two runs", async () => {
    const tenant = await seedTenant(TENANT);
    const deps = {
      crawl: async () => ({ text: "site text", pages: ["https://acme.com"] }),
      analyze: async () => FULL,
    };
    await bootstrapCompanyContext(tenant.id, "https://acme.com", deps);
    await bootstrapCompanyContext(tenant.id, "https://acme.com", deps);
    const rows = await db.select().from(competitors).where(eq(competitors.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
  });
});
