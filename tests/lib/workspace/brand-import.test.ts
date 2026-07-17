import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, brandProfiles } from "../../../src/db/schema";
import { importBrandStyleForTenant } from "../../../src/lib/workspace/brand-import";

const NAME = "Brand Import Test Tenant";

describe("importBrandStyleForTenant", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, NAME));
  });

  it("scrapes, analyzes, and writes the derived brand profile + url", async () => {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();

    const result = await importBrandStyleForTenant(tenant.id, "https://acme.com/changelog", {
      scrape: async () => ({ text: "changelog text" }),
      analyze: async () => ({
        tone: "friendly", readingLevel: "simple", doList: ["be concise"], dontList: ["hype"],
        examplePhrases: ["ship"], industry: "SaaS", updatesStyleSummary: "Short bullets.",
      }),
    });

    expect(result.ok).toBe(true);
    const [profile] = await db.select().from(brandProfiles).where(eq(brandProfiles.tenantId, tenant.id));
    expect(profile.tone).toBe("friendly");
    expect(profile.doList).toEqual(["be concise"]);
    expect(profile.examplePhrases).toEqual(["ship"]);
    expect(profile.industry).toBe("SaaS");
    expect(profile.updatesStyleSummary).toBe("Short bullets.");
    expect(profile.updatesPageUrl).toBe("https://acme.com/changelog");
  });

  it("writes nothing and reports the reason on a scrape error", async () => {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();

    const result = await importBrandStyleForTenant(tenant.id, "https://acme.com/changelog", {
      scrape: async () => ({ error: "insufficient-content" }),
      analyze: async () => { throw new Error("should not be called"); },
    });

    expect(result).toEqual({ ok: false, reason: "insufficient-content" });
    const [profile] = await db.select().from(brandProfiles).where(eq(brandProfiles.tenantId, tenant.id));
    // no profile written (getOrCreate not invoked on the error path)
    expect(profile).toBeUndefined();
  });
});
