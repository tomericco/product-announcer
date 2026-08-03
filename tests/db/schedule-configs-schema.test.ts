import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, scheduleConfigs } from "../../src/db/schema";

const TENANT = "Schedule Configs Schema Test Tenant";

describe("schedule_configs after the scheduler retirement", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("keeps only the ideation hour", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [config] = await db.insert(scheduleConfigs).values({ tenantId: tenant.id }).returning();
    expect(config.hour).toBe(9);
    expect(config).not.toHaveProperty("cadence");
    expect(config).not.toHaveProperty("threshold");
    expect(config).not.toHaveProperty("thresholdEnabled");
    expect(config).not.toHaveProperty("dayOfWeek");
    expect(config).not.toHaveProperty("dayOfMonth");
  });
});
