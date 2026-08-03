import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, companyProfiles } from "../../../src/db/schema";
import { getOrCreateCompanyProfile } from "../../../src/lib/workspace/company-profile";

describe("getOrCreateCompanyProfile", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, "Company Profile Test Tenant"));
  });

  it("creates a default profile on first call and returns the same one after", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "Company Profile Test Tenant" }).returning();

    const first = await getOrCreateCompanyProfile(tenant.id);
    expect(first.tenantId).toBe(tenant.id);

    const second = await getOrCreateCompanyProfile(tenant.id);
    expect(second.id).toBe(first.id);

    const rows = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
  });
});
