import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, briefs, briefSignals, signals, briefRuns } from "../../../src/db/schema";
import { listBriefs, latestBriefRun } from "../../../src/lib/briefs/query";

const TENANT = "Brief Query Test Tenant";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
});

async function seedTenant() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  return tenant;
}

async function seedBrief(
  tenantId: string,
  overrides: Partial<typeof briefs.$inferInsert> = {}
) {
  const [brief] = await db
    .insert(briefs)
    .values({
      tenantId,
      origin: "agent",
      contentType: "blog_post",
      title: "A title",
      angle: "An angle",
      whyNow: "Because",
      suggestedChannel: "blog",
      score: 0.8,
      lastEvidenceAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
      ...overrides,
    })
    .returning();
  return brief;
}

describe("listBriefs", () => {
  it("returns only the calling tenant's briefs", async () => {
    const mine = await seedTenant();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    await seedBrief(mine.id, { title: "Mine" });
    await seedBrief(other.id, { title: "Theirs" });

    const rows = await listBriefs(mine.id, {}, db);
    expect(rows.map((b) => b.title)).toEqual(["Mine"]);
  });

  it("defaults to new briefs only", async () => {
    const tenant = await seedTenant();
    await seedBrief(tenant.id, { title: "Open", status: "new" });
    await seedBrief(tenant.id, { title: "Gone", status: "dismissed" });

    const rows = await listBriefs(tenant.id, {}, db);
    expect(rows.map((b) => b.title)).toEqual(["Open"]);
  });

  it("reaches decided briefs through the status filter", async () => {
    const tenant = await seedTenant();
    await seedBrief(tenant.id, { title: "Open", status: "new" });
    await seedBrief(tenant.id, { title: "Gone", status: "dismissed" });

    const rows = await listBriefs(tenant.id, { status: "dismissed" }, db);
    expect(rows.map((b) => b.title)).toEqual(["Gone"]);
  });

  it("orders by score, then recency", async () => {
    const tenant = await seedTenant();
    // Two briefs share a score. The spike measured scores clustering at
    // 0.66-0.92, so score alone cannot order a real backlog — recency is what
    // breaks the ties, and this fixture is the tie.
    const older = await seedBrief(tenant.id, { title: "Older", score: 0.8 });
    await new Promise((r) => setTimeout(r, 10));
    const newer = await seedBrief(tenant.id, { title: "Newer", score: 0.8 });
    await seedBrief(tenant.id, { title: "Best", score: 0.95 });

    const rows = await listBriefs(tenant.id, {}, db);
    expect(rows.map((b) => b.title)).toEqual(["Best", "Newer", "Older"]);
    expect(newer.createdAt.getTime()).toBeGreaterThan(older.createdAt.getTime());
  });

  it("attaches the cited signals", async () => {
    const tenant = await seedTenant();
    const brief = await seedBrief(tenant.id);
    const [signal] = await db
      .insert(signals)
      .values({
        tenantId: tenant.id,
        kind: "market_news",
        externalId: "https://a.example.com/x",
        url: "https://a.example.com/x",
        title: "The evidence",
        occurredAt: new Date(),
      })
      .returning();
    await db.insert(briefSignals).values({ briefId: brief.id, signalId: signal.id });

    const [row] = await listBriefs(tenant.id, {}, db);
    // The evidence is the point: it is what lets a human tell reasoning from
    // confabulation before accepting.
    expect(row.signals).toHaveLength(1);
    expect(row.signals[0].title).toBe("The evidence");
    expect(row.signals[0].url).toBe("https://a.example.com/x");
  });

  it("returns an empty signal list rather than omitting an uncited brief", async () => {
    const tenant = await seedTenant();
    await seedBrief(tenant.id, { title: "Uncited" });

    const rows = await listBriefs(tenant.id, {}, db);
    // An inner join would silently drop briefs with no evidence rows.
    expect(rows).toHaveLength(1);
    expect(rows[0].signals).toEqual([]);
  });
});

describe("latestBriefRun", () => {
  it("returns the most recent run for the tenant", async () => {
    const tenant = await seedTenant();
    await db.insert(briefRuns).values({
      tenantId: tenant.id,
      assessment: "old",
      ranAt: new Date(Date.now() - 86_400_000),
    });
    await db.insert(briefRuns).values({ tenantId: tenant.id, assessment: "new" });

    const run = await latestBriefRun(tenant.id, db);
    expect(run?.assessment).toBe("new");
  });

  it("returns null when the agent has never run", async () => {
    const tenant = await seedTenant();
    expect(await latestBriefRun(tenant.id, db)).toBeNull();
  });

  it("does not read another tenant's run", async () => {
    const mine = await seedTenant();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    await db.insert(briefRuns).values({ tenantId: other.id, assessment: "theirs" });

    expect(await latestBriefRun(mine.id, db)).toBeNull();
  });
});
