import { describe, it, expect, afterEach } from "vitest";
import { db } from "../../../src/db";
import { competitors, signals } from "../../../src/db/schema";
import { listSignals } from "../../../src/lib/signals/query";
import { seedTenant, dropTenant } from "../../helpers/fixtures";

const TENANT = "Signals Query Test Tenant";
const OTHER = "Signals Query Other Tenant";

let counter = 0;
async function seedSignal(tenantId: string, overrides: Partial<typeof signals.$inferInsert> = {}) {
  const [signal] = await db
    .insert(signals)
    .values({
      tenantId,
      kind: "competitor_move",
      externalId: `e${counter++}`,
      title: "T",
      occurredAt: new Date("2026-07-15"),
      ...overrides,
    })
    .returning();
  return signal;
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

describe("listSignals", () => {
  afterEach(async () => {
    await dropTenant(TENANT);
    await dropTenant(OTHER);
  });

  it("returns only the caller's tenant's signals", async () => {
    const mine = await seedTenant(TENANT);
    const theirs = await seedTenant(OTHER);
    const ours = await seedSignal(mine.id);
    await seedSignal(theirs.id);

    const rows = await listSignals(mine.id, {});
    expect(rows.map((r) => r.id)).toEqual([ours.id]);
  });

  it("filters by kind", async () => {
    const tenant = await seedTenant(TENANT);
    const shipped = await seedSignal(tenant.id, { kind: "shipped_work" });
    await seedSignal(tenant.id, { kind: "competitor_move" });

    const rows = await listSignals(tenant.id, { kind: "shipped_work" });
    expect(rows.map((r) => r.id)).toEqual([shipped.id]);
  });

  it("filters by competitor", async () => {
    const tenant = await seedTenant(TENANT);
    const [rival] = await db.insert(competitors).values({ tenantId: tenant.id, name: "Jira" }).returning();
    const theirs = await seedSignal(tenant.id, { competitorId: rival.id });
    await seedSignal(tenant.id);

    const rows = await listSignals(tenant.id, { competitorId: rival.id });
    expect(rows.map((r) => r.id)).toEqual([theirs.id]);
  });

  it("keeps unscored signals when a minimum score is set", async () => {
    const tenant = await seedTenant(TENANT);
    const unscored = await seedSignal(tenant.id, { relevanceScore: null });
    const high = await seedSignal(tenant.id, { relevanceScore: 0.9 });
    await seedSignal(tenant.id, { relevanceScore: 0.1 });

    const rows = await listSignals(tenant.id, { minScore: 0.5 });
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set([unscored.id, high.id]));
  });

  it("filters by occurredAt range", async () => {
    const tenant = await seedTenant(TENANT);
    const inRange = await seedSignal(tenant.id, { occurredAt: new Date("2026-07-15") });
    await seedSignal(tenant.id, { occurredAt: new Date("2026-05-01") });

    const rows = await listSignals(tenant.id, { from: new Date("2026-07-01"), to: new Date("2026-08-01") });
    expect(rows.map((r) => r.id)).toEqual([inRange.id]);
  });

  it("orders newest first by occurredAt", async () => {
    const tenant = await seedTenant(TENANT);
    const older = await seedSignal(tenant.id, { occurredAt: new Date("2026-07-01") });
    const newer = await seedSignal(tenant.id, { occurredAt: new Date("2026-07-20") });

    const rows = await listSignals(tenant.id, {});
    expect(rows.map((r) => r.id)).toEqual([newer.id, older.id]);
  });

  it("excludes stale signals unless asked for them", async () => {
    const tenant = await seedTenant(TENANT);
    const fresh = await seedSignal(tenant.id);
    const stale = await seedSignal(tenant.id, { status: "stale" });

    expect((await listSignals(tenant.id, {})).map((r) => r.id)).toEqual([fresh.id]);
    expect(new Set((await listSignals(tenant.id, { includeStale: true })).map((r) => r.id))).toEqual(
      new Set([fresh.id, stale.id])
    );
  });

  it("excludes signals created outside the 60-day window", async () => {
    const tenant = await seedTenant(TENANT);
    const inside = await seedSignal(tenant.id, { createdAt: daysAgo(59) });
    await seedSignal(tenant.id, { createdAt: daysAgo(70) });

    const rows = await listSignals(tenant.id, {});
    expect(rows.map((r) => r.id)).toEqual([inside.id]);
  });

  it("windows on createdAt, so a freshly-ingested old post is still visible", async () => {
    const tenant = await seedTenant(TENANT);
    const backfilled = await seedSignal(tenant.id, {
      createdAt: daysAgo(1),
      occurredAt: daysAgo(400),
    });

    const rows = await listSignals(tenant.id, {});
    expect(rows.map((r) => r.id)).toEqual([backfilled.id]);
  });
});
