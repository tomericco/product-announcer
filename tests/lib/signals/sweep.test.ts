import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, competitors, sources, type Source } from "../../../src/db/schema";
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
  // The candidate select is unscoped by design (that's what makes it a
  // sweep), so `run` sees every competitor_web source live in the shared
  // test database while these tests run in parallel with other files that
  // seed their own -- `discover-sources.test.ts` and
  // `competitor-agent.test.ts` both insert real active sources with no
  // rollback wrapper. Asserting raw call counts or "never called" would be
  // racy against that traffic. Every assertion below is instead scoped to
  // the rows this test itself seeded, by inspecting the arguments `run`
  // received rather than how many times it fired.

  it("one tenant's failure does not stop another tenant's sources", async () => {
    const tenantA = await seedTenantWithSource(A, "https://a.com/changelog");
    await seedTenantWithSource(B, "https://b.com/changelog");

    const run = vi.fn(async (source: Source) => {
      if (source.tenantId === tenantA.id) throw new Error("boom");
      return { written: 1, dropped: 0, baseline: false };
    });

    await expect(sweepCompetitorSources({ runSource: run })).resolves.toBeUndefined();
    const urlsCalled = run.mock.calls.map(([source]) => source.url);
    expect(urlsCalled).toContain("https://a.com/changelog");
    expect(urlsCalled).toContain("https://b.com/changelog");
  });

  it("skips disabled sources", async () => {
    const tenant = await seedTenantWithSource(A, "https://a.com/changelog");
    await db.update(sources).set({ status: "disabled" }).where(eq(sources.tenantId, tenant.id));

    const run = vi.fn(async (_source: Source) => ({ written: 0, dropped: 0, baseline: false }));
    await sweepCompetitorSources({ runSource: run });
    const tenantsCalled = run.mock.calls.map(([source]) => source.tenantId);
    expect(tenantsCalled).not.toContain(tenant.id);
  });

  it("still runs sources previously marked failing, so they can recover", async () => {
    const tenant = await seedTenantWithSource(A, "https://a.com/changelog");
    await db.update(sources).set({ status: "failing" }).where(eq(sources.tenantId, tenant.id));

    const run = vi.fn(async (_source: Source) => ({ written: 0, dropped: 0, baseline: false }));
    await sweepCompetitorSources({ runSource: run });
    const tenantsCalled = run.mock.calls.map(([source]) => source.tenantId);
    expect(tenantsCalled).toContain(tenant.id);
  });

  it("one source's failure does not stop the same tenant's other sources", async () => {
    const tenant = await seedTenantWithSource(A, "https://a.com/changelog");
    const [rival] = await db.select().from(competitors).where(eq(competitors.tenantId, tenant.id));
    await db.insert(sources).values({
      tenantId: tenant.id,
      type: "competitor_web",
      competitorId: rival.id,
      url: "https://a.com/blog",
      label: "Blog",
    });

    const run = vi.fn(async (source: Source) => {
      if (source.url === "https://a.com/changelog") throw new Error("boom");
      return { written: 1, dropped: 0, baseline: false };
    });

    await expect(sweepCompetitorSources({ runSource: run })).resolves.toBeUndefined();
    const urlsCalled = run.mock.calls.map(([source]) => source.url);
    expect(urlsCalled).toContain("https://a.com/changelog");
    expect(urlsCalled).toContain("https://a.com/blog");
  });

  it("visits never-run sources first, then least-recently-run, for fair rotation", async () => {
    // The full candidate list is a total order (ORDER BY last_run_at ASC
    // NULLS FIRST) shared with every other row live in the database while
    // this test runs in parallel with the rest of the suite -- so this
    // filters the observed call order down to just this test's own three
    // URLs rather than asserting on the raw sequence or a call count.
    // Filtering a totally-ordered sequence preserves the relative order of
    // any subsequence, so this still catches an unordered (or wrongly
    // ordered) select.
    const tenant = await seedTenantWithSource(A, "https://a.com/never-run");
    const [rival] = await db.select().from(competitors).where(eq(competitors.tenantId, tenant.id));
    const older = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const newer = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    await db.insert(sources).values({
      tenantId: tenant.id,
      type: "competitor_web",
      competitorId: rival.id,
      url: "https://a.com/older",
      label: "Older",
      lastRunAt: older,
    });
    await db.insert(sources).values({
      tenantId: tenant.id,
      type: "competitor_web",
      competitorId: rival.id,
      url: "https://a.com/newer",
      label: "Newer",
      lastRunAt: newer,
    });

    const ourUrls = new Set(["https://a.com/never-run", "https://a.com/older", "https://a.com/newer"]);
    const order: string[] = [];
    const run = vi.fn(async (source: Source) => {
      if (source.url && ourUrls.has(source.url)) order.push(source.url);
      return { written: 0, dropped: 0, baseline: false };
    });

    await sweepCompetitorSources({ runSource: run });

    expect(order).toEqual(["https://a.com/never-run", "https://a.com/older", "https://a.com/newer"]);
  });
});
