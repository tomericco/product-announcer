import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, companyProfiles } from "../../../src/db/schema";
import { importBrandStyleForTenant } from "../../../src/lib/workspace/brand-import";
import { getOrCreateCompanyProfile } from "../../../src/lib/workspace/company-profile";
import { seedTenant, dropTenant } from "../../helpers/fixtures";

const NAME = "Brand Import Test Tenant";
const TEMPLATE_TENANT_NAME = "Brand Import Template Tenant";
const KEEP_TEMPLATE_TENANT_NAME = "Brand Import Keep Template Tenant";

describe("importBrandStyleForTenant", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, NAME));
    await dropTenant(TEMPLATE_TENANT_NAME);
    await dropTenant(KEEP_TEMPLATE_TENANT_NAME);
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
      deriveTemplate: async () => null,
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
      deriveTemplate: async () => null,
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
      deriveTemplate: async () => null,
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
      deriveTemplate: async () => null,
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

  it("writes the derived template", async () => {
    const tenant = await seedTenant(TEMPLATE_TENANT_NAME);
    await importBrandStyleForTenant(tenant.id, "https://acme.com/changelog", {
      scrape: async () => ({ text: "page", html: "", finalUrl: "u", contentType: "text/html", truncated: false }),
      analyze: async () => ({ guidelines: "Be brief.", industry: "SaaS" }),
      deriveTemplate: async () => "# What's new\n\n## Highlights\n",
    });

    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile.productUpdateTemplate).toBe("# What's new\n\n## Highlights\n");
  });

  it("a null derivation never clears an existing template", async () => {
    const tenant = await seedTenant(KEEP_TEMPLATE_TENANT_NAME);
    const profile = await getOrCreateCompanyProfile(tenant.id);
    await db
      .update(companyProfiles)
      .set({ productUpdateTemplate: "# Hand written\n" })
      .where(eq(companyProfiles.id, profile.id));

    await importBrandStyleForTenant(tenant.id, "https://acme.com/changelog", {
      scrape: async () => ({ text: "page", html: "", finalUrl: "u", contentType: "text/html", truncated: false }),
      analyze: async () => ({ guidelines: "Be brief.", industry: "SaaS" }),
      deriveTemplate: async () => null,
    });

    const [after] = await db.select().from(companyProfiles).where(eq(companyProfiles.id, profile.id));
    expect(after.productUpdateTemplate).toBe("# Hand written\n");
  });
});
