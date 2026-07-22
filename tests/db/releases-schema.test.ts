import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, releases, atomicUpdates } from "../../src/db/schema";

const TENANT = "Releases Rename Test Tenant";

describe("releases schema (renamed from updates)", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("inserts a release and defaults status to draft", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [release] = await db
      .insert(releases)
      .values({ tenantId: tenant.id, title: "T", body: "B" })
      .returning();
    expect(release.status).toBe("draft");
  });

  it("links an atomic update to a release and nulls the FK on release delete", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [release] = await db
      .insert(releases)
      .values({ tenantId: tenant.id, title: "T", body: "B" })
      .returning();
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "A", summary: "S", releaseId: release.id })
      .returning();
    expect(atomic.releaseId).toBe(release.id);

    await db.delete(releases).where(eq(releases.id, release.id));
    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomic.id));
    expect(after.releaseId).toBeNull();
  });
});
