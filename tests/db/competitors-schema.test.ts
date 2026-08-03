import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, competitors } from "../../src/db/schema";

const TENANT = "Competitors Schema Test Tenant";

describe("competitors schema", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("stores a competitor with an optional website", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [row] = await db
      .insert(competitors)
      .values({ tenantId: tenant.id, name: "Jira" })
      .returning();
    expect(row.name).toBe("Jira");
    expect(row.websiteUrl).toBeNull();
  });

  it("rejects two competitors with the same name in one tenant", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    await db.insert(competitors).values({ tenantId: tenant.id, name: "Jira" });
    await expect(
      db.insert(competitors).values({ tenantId: tenant.id, name: "Jira" })
    ).rejects.toThrow();
  });

  it("cascades when the tenant is deleted", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    await db.insert(competitors).values({ tenantId: tenant.id, name: "Jira" });
    await db.delete(tenants).where(eq(tenants.id, tenant.id));
    const rows = await db.select().from(competitors).where(eq(competitors.tenantId, tenant.id));
    expect(rows).toHaveLength(0);
  });
});
