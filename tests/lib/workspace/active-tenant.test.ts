import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../../src/db";
import { users, tenants, tenantMembers } from "../../../src/db/schema";
import { resolveActiveTenant, listUserMemberships } from "../../../src/lib/workspace/active-tenant";

async function makeUser(email: string) {
  const [u] = await db.insert(users).values({ email }).returning();
  return u;
}
async function makeMembership(userId: string, name: string, role: "owner" | "member") {
  const [t] = await db.insert(tenants).values({ name }).returning();
  await db.insert(tenantMembers).values({ tenantId: t.id, userId, role });
  return t;
}

describe("resolveActiveTenant", () => {
  const emails = ["at-user@example.com"];
  afterEach(async () => {
    const us = await db.select().from(users).where(inArray(users.email, emails));
    for (const u of us) {
      const ms = await db.select().from(tenantMembers).where(eq(tenantMembers.userId, u.id));
      await db.delete(tenantMembers).where(eq(tenantMembers.userId, u.id));
      const ids = ms.map((m) => m.tenantId);
      if (ids.length) await db.delete(tenants).where(inArray(tenants.id, ids));
      await db.delete(users).where(eq(users.id, u.id));
    }
  });

  it("returns null when the user has no memberships", async () => {
    const u = await makeUser("at-user@example.com");
    expect(await resolveActiveTenant(u.id, undefined)).toBeNull();
  });

  it("honors a valid cookie tenant the user belongs to", async () => {
    const u = await makeUser("at-user@example.com");
    await makeMembership(u.id, "A", "owner");
    const b = await makeMembership(u.id, "B", "member");
    const resolved = await resolveActiveTenant(u.id, b.id);
    expect(resolved).toEqual({ tenantId: b.id, role: "member" });
  });

  it("falls back to the earliest membership when the cookie points at a non-member tenant", async () => {
    const u = await makeUser("at-user@example.com");
    const a = await makeMembership(u.id, "A", "owner");
    await makeMembership(u.id, "B", "member");
    const [stranger] = await db.insert(tenants).values({ name: "Stranger" }).returning();
    const resolved = await resolveActiveTenant(u.id, stranger.id);
    expect(resolved).toEqual({ tenantId: a.id, role: "owner" }); // earliest, ignores stranger
    await db.delete(tenants).where(eq(tenants.id, stranger.id));
  });

  it("lists memberships earliest-first", async () => {
    const u = await makeUser("at-user@example.com");
    const a = await makeMembership(u.id, "A", "owner");
    await makeMembership(u.id, "B", "member");
    const list = await listUserMemberships(u.id);
    expect(list[0].tenantId).toBe(a.id);
  });
});
