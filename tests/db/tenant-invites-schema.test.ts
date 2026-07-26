import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, tenantInvites } from "../../src/db/schema";

describe("tenant_invites table", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, "Invite Schema Tenant"));
  });

  async function makeTenant() {
    const [t] = await db.insert(tenants).values({ name: "Invite Schema Tenant" }).returning();
    return t;
  }

  it("round-trips an invite row", async () => {
    const t = await makeTenant();
    const [row] = await db
      .insert(tenantInvites)
      .values({ tenantId: t.id, tokenHash: "hash-a", expiresAt: new Date(Date.now() + 86400000) })
      .returning();
    expect(row.revokedAt).toBeNull();
    expect(row.tenantId).toBe(t.id);
  });

  it("rejects a second active (non-revoked) invite for the same tenant", async () => {
    const t = await makeTenant();
    await db.insert(tenantInvites).values({ tenantId: t.id, tokenHash: "hash-b", expiresAt: new Date(Date.now() + 86400000) });
    await expect(
      db.insert(tenantInvites).values({ tenantId: t.id, tokenHash: "hash-c", expiresAt: new Date(Date.now() + 86400000) })
    ).rejects.toThrow();
  });

  it("allows a new active invite once the previous is revoked", async () => {
    const t = await makeTenant();
    const [first] = await db
      .insert(tenantInvites)
      .values({ tenantId: t.id, tokenHash: "hash-d", expiresAt: new Date(Date.now() + 86400000) })
      .returning();
    await db.update(tenantInvites).set({ revokedAt: new Date() }).where(eq(tenantInvites.id, first.id));
    const [second] = await db
      .insert(tenantInvites)
      .values({ tenantId: t.id, tokenHash: "hash-e", expiresAt: new Date(Date.now() + 86400000) })
      .returning();
    expect(second.id).not.toBe(first.id);
  });

  it("enforces tokenHash uniqueness", async () => {
    const t1 = await makeTenant();
    const t2 = await makeTenant();
    await db.insert(tenantInvites).values({ tenantId: t1.id, tokenHash: "dupe", expiresAt: new Date(Date.now() + 86400000) });
    await expect(
      db.insert(tenantInvites).values({ tenantId: t2.id, tokenHash: "dupe", expiresAt: new Date(Date.now() + 86400000) })
    ).rejects.toThrow();
  });
});
