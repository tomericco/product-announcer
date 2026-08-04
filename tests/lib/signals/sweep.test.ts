import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, competitors, sources } from "../../../src/db/schema";
import { sweepCompetitorSources } from "../../../src/lib/signals/sweep";

const A = "Sweep Test Tenant A";
const B = "Sweep Test Tenant B";

async function seedTenantWithSource(name: string, url: string) {
  const [tenant] = await db.insert(tenants).values({ name }).returning();
  const [rival] = await db.insert(competitors).values({ tenantId: tenant.id, name: "Rival" }).returning();
  await db.insert(sources).values({
    tenantId: tenant.id,
    type: "competitor_web",
    competitorId: rival.id,
    url,
    label: "Changelog",
  });
  return tenant;
}

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, A));
  await db.delete(tenants).where(eq(tenants.name, B));
});

describe("sweepCompetitorSources", () => {
  it("one tenant's failure does not stop another tenant's sources", async () => {
    const tenantA = await seedTenantWithSource(A, "https://a.com/changelog");
    await seedTenantWithSource(B, "https://b.com/changelog");

    const run = vi.fn(async (source: { tenantId: string }) => {
      if (source.tenantId === tenantA.id) throw new Error("boom");
      return { written: 1, dropped: 0, baseline: false };
    });

    await expect(sweepCompetitorSources({ runSource: run })).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("skips disabled sources", async () => {
    const tenant = await seedTenantWithSource(A, "https://a.com/changelog");
    await db.update(sources).set({ status: "disabled" }).where(eq(sources.tenantId, tenant.id));

    const run = vi.fn(async () => ({ written: 0, dropped: 0, baseline: false }));
    await sweepCompetitorSources({ runSource: run });
    expect(run).not.toHaveBeenCalled();
  });

  it("still runs sources previously marked failing, so they can recover", async () => {
    const tenant = await seedTenantWithSource(A, "https://a.com/changelog");
    await db.update(sources).set({ status: "failing" }).where(eq(sources.tenantId, tenant.id));

    const run = vi.fn(async () => ({ written: 0, dropped: 0, baseline: false }));
    await sweepCompetitorSources({ runSource: run });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
