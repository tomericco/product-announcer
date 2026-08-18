import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, companyProfiles } from "../../../src/db/schema";

const TENANT = "Company Profile Columns Test Tenant";

describe("company_profiles schema", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("defaults topics to an empty array and leaves context columns null", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [profile] = await db.insert(companyProfiles).values({ tenantId: tenant.id }).returning();
    expect(profile.topics).toEqual([]);
    expect(profile.websiteUrl).toBeNull();
    expect(profile.oneLiner).toBeNull();
    expect(profile.category).toBeNull();
    expect(profile.positioning).toBeNull();
  });

  it("round-trips positioning and topics", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [profile] = await db
      .insert(companyProfiles)
      .values({
        tenantId: tenant.id,
        websiteUrl: "https://example.com",
        oneLiner: "Issue tracking for software teams.",
        category: "Project management",
        positioning: "Fast where incumbents are configurable.",
        topics: ["developer productivity", "issue tracking"],
      })
      .returning();
    expect(profile.positioning).toBe("Fast where incumbents are configurable.");
    expect(profile.topics).toEqual(["developer productivity", "issue tracking"]);
  });

  it("allows only one profile per tenant", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    await db.insert(companyProfiles).values({ tenantId: tenant.id });
    await expect(db.insert(companyProfiles).values({ tenantId: tenant.id })).rejects.toThrow();
  });

  it("defaults updatesPageUrl to null and round-trips a URL", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [defaulted] = await db.insert(companyProfiles).values({ tenantId: tenant.id }).returning();
    expect(defaulted.updatesPageUrl).toBeNull();

    const [updated] = await db
      .update(companyProfiles)
      .set({ updatesPageUrl: "https://acme.com/changelog" })
      .where(eq(companyProfiles.id, defaulted.id))
      .returning();
    expect(updated.updatesPageUrl).toBe("https://acme.com/changelog");
  });

  it("defaults guidelines to null and round-trips a markdown document", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [defaulted] = await db.insert(companyProfiles).values({ tenantId: tenant.id }).returning();
    expect(defaulted.guidelines).toBeNull();

    const doc = "## Voice and tone\n\nPlain and direct.\n\n## Don't\n\n- No hype.";
    const [updated] = await db
      .update(companyProfiles)
      .set({ guidelines: doc })
      .where(eq(companyProfiles.id, defaulted.id))
      .returning();
    expect(updated.guidelines).toBe(doc);
  });
});
