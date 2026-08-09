import { describe, it, expect, afterEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, signals } from "../../../src/db/schema";
import { createManualSignal } from "../../../src/lib/signals/manual";

const TENANT = "Manual Signal Test Tenant";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
});

async function seedTenant() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  return tenant;
}

describe("createManualSignal", () => {
  it("writes a manual signal keyed on the normalised url", async () => {
    const tenant = await seedTenant();
    const result = await createManualSignal(
      tenant.id,
      { title: "A webinar", url: "https://Example.com/talk/?utm_source=x", excerpt: "Notes." },
      db
    );
    expect(result.ok).toBe(true);

    const [row] = await db.select().from(signals).where(eq(signals.tenantId, tenant.id));
    expect(row.kind).toBe("manual");
    expect(row.title).toBe("A webinar");
    // Same normalisation as every other signal, so the same link entered twice
    // is one signal rather than two.
    expect(row.externalId).toBe("https://example.com/talk");
    expect(row.occurredAt).toBeInstanceOf(Date);
  });

  it("generates an id when there is no url, so two untitled-source signals never collide", async () => {
    const tenant = await seedTenant();
    await createManualSignal(tenant.id, { title: "A conference talk" }, db);
    const second = await createManualSignal(tenant.id, { title: "A conference talk" }, db);
    expect(second.ok).toBe(true);

    const rows = await db.select().from(signals).where(eq(signals.tenantId, tenant.id));
    expect(rows).toHaveLength(2);
    expect(rows[0].externalId).not.toBe(rows[1].externalId);
  });

  it("reports a duplicate url instead of writing a second row", async () => {
    const tenant = await seedTenant();
    await createManualSignal(tenant.id, { title: "First", url: "https://example.com/a" }, db);
    const second = await createManualSignal(tenant.id, { title: "Second", url: "https://example.com/a/" }, db);

    expect(second.ok).toBe(false);
    const rows = await db.select().from(signals).where(eq(signals.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("First");
  });

  it("refuses a blank title", async () => {
    const tenant = await seedTenant();
    const result = await createManualSignal(tenant.id, { title: "   " }, db);
    expect(result.ok).toBe(false);
    expect(await db.select().from(signals).where(eq(signals.tenantId, tenant.id))).toHaveLength(0);
  });

  it("scopes the signal to the calling tenant", async () => {
    const mine = await seedTenant();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    await createManualSignal(mine.id, { title: "Mine" }, db);

    const theirs = await db
      .select()
      .from(signals)
      .where(and(eq(signals.tenantId, other.id), eq(signals.kind, "manual")));
    expect(theirs).toHaveLength(0);
  });
});
