import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, brandProfiles } from "../../../src/db/schema";

const NAME = "Brand Columns Test Tenant";

describe("brand_profiles updates-page columns", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, NAME));
  });

  it("defaults the new columns to null and round-trips values", async () => {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();

    const [defaulted] = await db.insert(brandProfiles).values({ tenantId: tenant.id }).returning();
    expect(defaulted.updatesPageUrl).toBeNull();
    expect(defaulted.updatesStyleSummary).toBeNull();

    const [updated] = await db
      .update(brandProfiles)
      .set({ updatesPageUrl: "https://acme.com/changelog", updatesStyleSummary: "Short, punchy, one bullet per change." })
      .where(eq(brandProfiles.id, defaulted.id))
      .returning();
    expect(updated.updatesPageUrl).toBe("https://acme.com/changelog");
    expect(updated.updatesStyleSummary).toBe("Short, punchy, one bullet per change.");
  });

  it("defaults guidelines to null and round-trips a markdown document", async () => {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();

    const [defaulted] = await db.insert(brandProfiles).values({ tenantId: tenant.id }).returning();
    expect(defaulted.guidelines).toBeNull();

    const doc = "## Voice and tone\n\nPlain and direct.\n\n## Don't\n\n- No hype.";
    const [updated] = await db
      .update(brandProfiles)
      .set({ guidelines: doc })
      .where(eq(brandProfiles.id, defaulted.id))
      .returning();
    expect(updated.guidelines).toBe(doc);
  });
});
