import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, brandProfiles } from "../../../src/db/schema";
import { getOrCreateBrandProfile } from "../../../src/lib/workspace/brand-profile";

describe("getOrCreateBrandProfile", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, "Brand Profile Test Tenant"));
  });

  it("creates a default profile on first call and returns the same one after", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "Brand Profile Test Tenant" }).returning();

    const first = await getOrCreateBrandProfile(tenant.id);
    expect(first.tenantId).toBe(tenant.id);
    expect(first.doList).toEqual([]);

    const second = await getOrCreateBrandProfile(tenant.id);
    expect(second.id).toBe(first.id);

    const rows = await db.select().from(brandProfiles).where(eq(brandProfiles.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
  });
});
