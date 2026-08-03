import { describe, it, expect, afterEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, atomicUpdates, signals } from "../../../src/db/schema";
import { syncShippedWorkSignals } from "../../../src/lib/signals/shipped-work";

const TENANT = "Shipped Work Signals Test Tenant";

async function seedTenant() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  return tenant;
}

async function shippedSignals(tenantId: string) {
  return db.select().from(signals).where(and(eq(signals.tenantId, tenantId), eq(signals.kind, "shipped_work")));
}

describe("syncShippedWorkSignals", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("projects an open atomic update into a signal", async () => {
    const tenant = await seedTenant();
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "SAML SSO", summary: "Teams can log in with SAML." })
      .returning();

    await syncShippedWorkSignals();

    const rows = await shippedSignals(tenant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe(atomic.id);
    expect(rows[0].atomicUpdateId).toBe(atomic.id);
    expect(rows[0].title).toBe("SAML SSO");
    expect(rows[0].excerpt).toBe("Teams can log in with SAML.");
  });

  it("is idempotent across runs", async () => {
    const tenant = await seedTenant();
    await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "A", summary: "S" });
    await syncShippedWorkSignals();
    const [first] = await shippedSignals(tenant.id);

    await syncShippedWorkSignals();

    const rows = await shippedSignals(tenant.id);
    expect(rows).toHaveLength(1);
    // Same row, not a delete-and-reinsert: a plain insert (rather than an
    // upsert) would violate the unique constraint on the second run, and if
    // that violation were swallowed the row count alone wouldn't catch it.
    expect(rows[0].id).toBe(first.id);
    expect(rows[0].createdAt).toEqual(first.createdAt);
  });

  it("refreshes title and excerpt when the atomic update changes", async () => {
    const tenant = await seedTenant();
    const [atomic] = await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "Old", summary: "Old summary" }).returning();
    await syncShippedWorkSignals();

    await db.update(atomicUpdates).set({ title: "New", summary: "New summary" }).where(eq(atomicUpdates.id, atomic.id));
    await syncShippedWorkSignals();

    const rows = await shippedSignals(tenant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("New");
    expect(rows[0].excerpt).toBe("New summary");
  });

  it("removes the signal when the atomic update is hidden, and restores it when unhidden", async () => {
    const tenant = await seedTenant();
    const [atomic] = await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "A", summary: "S" }).returning();
    await syncShippedWorkSignals();
    expect(await shippedSignals(tenant.id)).toHaveLength(1);

    await db.update(atomicUpdates).set({ status: "hidden" }).where(eq(atomicUpdates.id, atomic.id));
    await syncShippedWorkSignals();
    expect(await shippedSignals(tenant.id)).toHaveLength(0);

    await db.update(atomicUpdates).set({ status: "open" }).where(eq(atomicUpdates.id, atomic.id));
    await syncShippedWorkSignals();
    expect(await shippedSignals(tenant.id)).toHaveLength(1);
  });

  it("projects released atomic updates too — shipping is exactly what makes them signal", async () => {
    const tenant = await seedTenant();
    await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "A", summary: "S", status: "released" });
    await syncShippedWorkSignals();
    expect(await shippedSignals(tenant.id)).toHaveLength(1);
  });
});
