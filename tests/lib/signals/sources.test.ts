import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, competitors, sources } from "../../../src/db/schema";
import { listCompetitorSources } from "../../../src/lib/signals/sources";

const TENANT = "Sources Lib Test Tenant";

async function seedTenant() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  return tenant;
}

describe("listCompetitorSources", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("returns only this tenant's competitor_web sources", async () => {
    const mine = await seedTenant();
    const [other] = await db.insert(tenants).values({ name: TENANT + " Other" }).returning();
    try {
      const [rival] = await db.insert(competitors).values({ tenantId: mine.id, name: "Rival" }).returning();
      const [otherRival] = await db.insert(competitors).values({ tenantId: other.id, name: "Rival" }).returning();
      await db.insert(sources).values({
        tenantId: mine.id,
        type: "competitor_web",
        competitorId: rival.id,
        url: "https://rival.com/changelog",
        label: "Changelog",
      });
      await db.insert(sources).values({
        tenantId: other.id,
        type: "competitor_web",
        competitorId: otherRival.id,
        url: "https://otherrival.com/changelog",
        label: "Changelog",
      });

      const rows = await listCompetitorSources(mine.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].tenantId).toBe(mine.id);
    } finally {
      await db.delete(tenants).where(eq(tenants.id, other.id));
    }
  });

  it("excludes news sources, which have no competitor to attach to in this view", async () => {
    const tenant = await seedTenant();
    const [rival] = await db.insert(competitors).values({ tenantId: tenant.id, name: "Rival" }).returning();
    await db.insert(sources).values({
      tenantId: tenant.id,
      type: "competitor_web",
      competitorId: rival.id,
      url: "https://rival.com/changelog",
      label: "Changelog",
    });
    await db.insert(sources).values({
      tenantId: tenant.id,
      type: "news",
      url: null,
      label: "Market news",
    });

    const rows = await listCompetitorSources(tenant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("competitor_web");
  });

  it("groups sources for the same competitor together, ordered by label", async () => {
    const tenant = await seedTenant();
    const [rival] = await db.insert(competitors).values({ tenantId: tenant.id, name: "Rival" }).returning();
    await db.insert(sources).values({
      tenantId: tenant.id,
      type: "competitor_web",
      competitorId: rival.id,
      url: "https://rival.com/changelog",
      label: "Changelog",
    });
    await db.insert(sources).values({
      tenantId: tenant.id,
      type: "competitor_web",
      competitorId: rival.id,
      url: "https://rival.com/blog",
      label: "Blog",
    });

    const rows = await listCompetitorSources(tenant.id);
    expect(rows.map((r) => r.label)).toEqual(["Blog", "Changelog"]);
  });
});
