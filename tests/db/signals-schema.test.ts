import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, signals, atomicUpdates } from "../../src/db/schema";

const TENANT = "Signals Schema Test Tenant";

describe("signals schema", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("defaults status to new and topics to an empty array", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [signal] = await db
      .insert(signals)
      .values({
        tenantId: tenant.id,
        kind: "competitor_move",
        externalId: "e1",
        title: "They shipped SSO",
        occurredAt: new Date("2026-07-01"),
      })
      .returning();
    expect(signal.status).toBe("new");
    expect(signal.topics).toEqual([]);
    expect(signal.relevanceScore).toBeNull();
  });

  it("rejects a duplicate externalId within the same tenant and kind", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const base = { tenantId: tenant.id, kind: "competitor_move" as const, externalId: "dup", title: "T", occurredAt: new Date() };
    await db.insert(signals).values(base);
    await expect(db.insert(signals).values(base)).rejects.toThrow();
  });

  it("allows the same externalId under a different kind", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    await db.insert(signals).values({ tenantId: tenant.id, kind: "competitor_move", externalId: "x", title: "T", occurredAt: new Date() });
    await expect(
      db.insert(signals).values({ tenantId: tenant.id, kind: "market_news", externalId: "x", title: "T", occurredAt: new Date() })
    ).resolves.toBeDefined();
  });

  it("nulls atomicUpdateId when the atomic update is deleted, keeping the signal", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [atomic] = await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "A", summary: "S" }).returning();
    const [signal] = await db
      .insert(signals)
      .values({ tenantId: tenant.id, kind: "shipped_work", externalId: atomic.id, title: "A", occurredAt: new Date(), atomicUpdateId: atomic.id })
      .returning();

    await db.delete(atomicUpdates).where(eq(atomicUpdates.id, atomic.id));
    const [after] = await db.select().from(signals).where(eq(signals.id, signal.id));
    expect(after).toBeDefined();
    expect(after.atomicUpdateId).toBeNull();
  });
});
