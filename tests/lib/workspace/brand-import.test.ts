import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, companyProfiles } from "../../../src/db/schema";
import { importBrandStyleForTenant } from "../../../src/lib/workspace/brand-import";

const NAME = "Brand Import Test Tenant";

describe("importBrandStyleForTenant", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, NAME));
  });

  it("scrapes, analyzes, and writes the derived brand profile + url", async () => {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();

    const result = await importBrandStyleForTenant(tenant.id, "https://acme.com/changelog", {
      scrape: async () => ({
        text: "changelog text",
        html: "<html><body>changelog text</body></html>",
        finalUrl: "https://acme.com/changelog",
        contentType: "text/html",
        truncated: false,
      }),
      analyze: async () => ({
        guidelines: "## Voice and tone\n\nFriendly and plain.\n\n## Don't\n\n- No hype.",
        industry: "SaaS",
      }),
    });

    expect(result.ok).toBe(true);
    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile.guidelines).toBe("## Voice and tone\n\nFriendly and plain.\n\n## Don't\n\n- No hype.");
    expect(profile.industry).toBe("SaaS");
    expect(profile.updatesPageUrl).toBe("https://acme.com/changelog");
  });

  it("keeps existing guidelines and only updates industry when the derivation partially fails", async () => {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();
    await db.insert(companyProfiles).values({
      tenantId: tenant.id,
      guidelines: "## Voice and tone\n\nHand-written, do not overwrite.",
    });

    const result = await importBrandStyleForTenant(tenant.id, "https://acme.com/changelog", {
      scrape: async () => ({
        text: "changelog text",
        html: "<html><body>changelog text</body></html>",
        finalUrl: "https://acme.com/changelog",
        contentType: "text/html",
        truncated: false,
      }),
      analyze: async () => ({ guidelines: null, industry: "SaaS" }),
    });

    expect(result.ok).toBe(true);
    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile.guidelines).toBe("## Voice and tone\n\nHand-written, do not overwrite.");
    expect(profile.industry).toBe("SaaS");
  });

  it("writes nothing and reports analysis-empty when the derived profile is entirely empty", async () => {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();

    const result = await importBrandStyleForTenant(tenant.id, "https://acme.com/changelog", {
      scrape: async () => ({
        text: "changelog text",
        html: "<html><body>changelog text</body></html>",
        finalUrl: "https://acme.com/changelog",
        contentType: "text/html",
        truncated: false,
      }),
      analyze: async () => ({ guidelines: null, industry: null }),
    });

    expect(result).toEqual({ ok: false, reason: "analysis-empty" });
    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile).toBeUndefined();
  });

  it("treats a blank-string derivation the same as null: doesn't overwrite, and counts toward analysis-empty", async () => {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();

    const result = await importBrandStyleForTenant(tenant.id, "https://acme.com/changelog", {
      scrape: async () => ({
        text: "changelog text",
        html: "<html><body>changelog text</body></html>",
        finalUrl: "https://acme.com/changelog",
        contentType: "text/html",
        truncated: false,
      }),
      analyze: async () => ({ guidelines: "   ", industry: "" }),
    });

    expect(result).toEqual({ ok: false, reason: "analysis-empty" });
    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile).toBeUndefined();
  });

  it("writes nothing and reports the reason on a scrape error", async () => {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();

    const result = await importBrandStyleForTenant(tenant.id, "https://acme.com/changelog", {
      scrape: async () => ({ error: "insufficient-content" }),
      analyze: async () => { throw new Error("should not be called"); },
    });

    expect(result).toEqual({ ok: false, reason: "insufficient-content" });
    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    // no profile written (getOrCreate not invoked on the error path)
    expect(profile).toBeUndefined();
  });
});
