import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, releases, scheduleConfigs } from "../../src/db/schema";

describe("scheduler/generation schema", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, "Scheduler Schema Test Tenant"));
  });

  it("allows a cross-repo update (null repoId) and one schedule config per tenant", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "Scheduler Schema Test Tenant" }).returning();

    const [update] = await db
      .insert(releases)
      .values({ tenantId: tenant.id, title: "T", body: "B" })
      .returning();
    expect(update.repoId).toBeNull();

    const [config] = await db
      .insert(scheduleConfigs)
      .values({ tenantId: tenant.id, cadence: "weekly" })
      .returning();
    expect(config.tenantId).toBe(tenant.id);
  });
});
