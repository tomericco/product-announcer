import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, signals, briefs, briefSignals } from "../../../src/db/schema";
import { deleteSignals } from "../../../src/lib/signals/delete";
import { seedTenant, dropTenant } from "../../helpers/fixtures";

const TENANT = "Delete Signals Test Tenant";

afterEach(async () => {
  await dropTenant(TENANT);
});

async function seedSignal(tenantId: string, title: string) {
  const [row] = await db
    .insert(signals)
    .values({
      tenantId,
      kind: "manual",
      externalId: crypto.randomUUID(),
      title,
      occurredAt: new Date("2026-08-01T00:00:00.000Z"),
    })
    .returning();
  return row;
}

describe("deleteSignals", () => {
  it("deletes the given signals under the tenant", async () => {
    const tenant = await seedTenant(TENANT);
    const a = await seedSignal(tenant.id, "A");
    const b = await seedSignal(tenant.id, "B");

    const result = await deleteSignals(tenant.id, [a.id, b.id], db);

    expect(result).toEqual({ ok: true, deletedCount: 2 });
    expect(await db.select().from(signals).where(eq(signals.tenantId, tenant.id))).toHaveLength(0);
  });

  it("leaves signals not in the id list alone", async () => {
    const tenant = await seedTenant(TENANT);
    const a = await seedSignal(tenant.id, "A");
    const b = await seedSignal(tenant.id, "B");

    await deleteSignals(tenant.id, [a.id], db);

    const remaining = await db.select().from(signals).where(eq(signals.tenantId, tenant.id));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(b.id);
  });

  it("does not delete another tenant's signal, and reports it as not deleted", async () => {
    const mine = await seedTenant(TENANT);
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const theirs = await seedSignal(other.id, "Theirs");

    const result = await deleteSignals(mine.id, [theirs.id], db);

    expect(result).toEqual({ ok: true, deletedCount: 0 });
    expect(await db.select().from(signals).where(eq(signals.id, theirs.id))).toHaveLength(1);
  });

  it("refuses an empty id list", async () => {
    const tenant = await seedTenant(TENANT);
    const result = await deleteSignals(tenant.id, [], db);
    expect(result).toEqual({ ok: false, error: "No signals selected." });
  });

  it("drops the brief's evidence link but leaves the brief itself", async () => {
    const tenant = await seedTenant(TENANT);
    const signal = await seedSignal(tenant.id, "Cited");
    const [brief] = await db
      .insert(briefs)
      .values({
        tenantId: tenant.id,
        origin: "manual",
        contentType: "product_update",
        title: "A brief",
        angle: "An angle",
        whyNow: "Because",
        suggestedChannel: "blog",
        score: 0.8,
        lastEvidenceAt: new Date("2026-08-01T00:00:00.000Z"),
      })
      .returning();
    await db.insert(briefSignals).values({ briefId: brief.id, signalId: signal.id });

    const result = await deleteSignals(tenant.id, [signal.id], db);

    expect(result).toEqual({ ok: true, deletedCount: 1 });
    expect(await db.select().from(briefSignals).where(eq(briefSignals.briefId, brief.id))).toHaveLength(0);
    expect(await db.select().from(briefs).where(eq(briefs.id, brief.id))).toHaveLength(1);

    await db.delete(briefs).where(eq(briefs.id, brief.id));
  });
});
