import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, sources, type Source } from "../../../src/db/schema";
import { sweepNewsSources } from "../../../src/lib/signals/news-sweep";

const TENANT = "News Sweep Test Tenant";
const OTHER = "News Sweep Other Test Tenant";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
  await db.delete(tenants).where(eq(tenants.name, OTHER));
  vi.restoreAllMocks();
});

async function seedTenant(name: string) {
  const [tenant] = await db.insert(tenants).values({ name }).returning();
  return tenant;
}

async function seedNews(tenantId: string, status: "active" | "failing" | "disabled" = "active"): Promise<Source> {
  const [row] = await db
    .insert(sources)
    .values({ tenantId, type: "news", url: null, label: "Industry news", status })
    .returning();
  return row;
}

// NOTE: this sweep reads the whole shared test database, and other test files
// insert sources concurrently. Every assertion below is scoped to ids this
// test created — never to a raw call count.
describe("sweepNewsSources", () => {
  it("runs a tenant's active news source", async () => {
    const tenant = await seedTenant(TENANT);
    await seedNews(tenant.id);
    const seen: string[] = [];

    await sweepNewsSources({
      database: db,
      runSource: async (source) => {
        seen.push(source.tenantId);
        return { written: 0, dropped: 0, skipped: 0, credits: 0, selected: 0, stale: 0, alreadyRejected: 0 };
      },
    });

    expect(seen).toContain(tenant.id);
  });

  it("skips disabled sources", async () => {
    const tenant = await seedTenant(TENANT);
    await seedNews(tenant.id, "disabled");
    const seen: string[] = [];

    await sweepNewsSources({
      database: db,
      runSource: async (source) => {
        seen.push(source.tenantId);
        return { written: 0, dropped: 0, skipped: 0, credits: 0, selected: 0, stale: 0, alreadyRejected: 0 };
      },
    });

    expect(seen).not.toContain(tenant.id);
  });

  it("still runs a failing source, so one that recovers is picked up again", async () => {
    const tenant = await seedTenant(TENANT);
    await seedNews(tenant.id, "failing");
    const seen: string[] = [];

    await sweepNewsSources({
      database: db,
      runSource: async (source) => {
        seen.push(source.tenantId);
        return { written: 0, dropped: 0, skipped: 0, credits: 0, selected: 0, stale: 0, alreadyRejected: 0 };
      },
    });

    expect(seen).toContain(tenant.id);
  });

  it("does not touch competitor sources", async () => {
    const tenant = await seedTenant(TENANT);
    const [competitorSource] = await db
      .insert(sources)
      .values({ tenantId: tenant.id, type: "competitor_web", url: "https://rival.example.com/x", label: "Rival" })
      .returning();
    const seen: string[] = [];

    await sweepNewsSources({
      database: db,
      runSource: async (source) => {
        seen.push(source.id);
        return { written: 0, dropped: 0, skipped: 0, credits: 0, selected: 0, stale: 0, alreadyRejected: 0 };
      },
    });

    expect(seen).not.toContain(competitorSource.id);
  });

  it("one source's failure does not stop another tenant's", async () => {
    const angry = await seedTenant(TENANT);
    const calm = await seedTenant(OTHER);
    const angrySource = await seedNews(angry.id);
    const calmSource = await seedNews(calm.id);
    const mySources = new Set([angrySource.id, calmSource.id]);
    const myTenants = new Set([angry.id, calm.id]);
    const seen: string[] = [];
    let thrownForMine = false;

    await expect(
      sweepNewsSources({
        database: db,
        runSource: async (source) => {
          // Throw for the FIRST of OUR OWN two sources the sweep reaches,
          // whichever it is. Keying on a specific id makes the test a coin
          // flip on ordering — if the healthy source happens to be swept
          // first it passes even with a single catch around the whole loop.
          if (mySources.has(source.id) && !thrownForMine) {
            thrownForMine = true;
            throw new Error("boom");
          }
          seen.push(source.tenantId);
          return { written: 0, dropped: 0, skipped: 0, credits: 0, selected: 0, stale: 0, alreadyRejected: 0 };
        },
      })
    ).resolves.toBeUndefined();

    // With the per-source catch: one of ours throws, the other is recorded.
    // With a single catch around the whole loop: the throw aborts the loop
    // before the second of ours is reached, in either order.
    expect(seen.filter((id) => myTenants.has(id))).toHaveLength(1);
  });
});
