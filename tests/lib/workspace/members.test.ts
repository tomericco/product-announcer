import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../../src/db";
import { users, tenants, tenantMembers } from "../../../src/db/schema";
import { listWorkspaceMembers } from "../../../src/lib/workspace/members";

describe("listWorkspaceMembers", () => {
  let tenantId: string | undefined;
  const emails = ["m-owner@example.com", "m-member@example.com"];
  afterEach(async () => {
    if (tenantId) {
      await db.delete(tenantMembers).where(eq(tenantMembers.tenantId, tenantId));
      await db.delete(tenants).where(eq(tenants.id, tenantId));
      tenantId = undefined;
    }
    const us = await db.select().from(users).where(inArray(users.email, emails));
    for (const u of us) await db.delete(users).where(eq(users.id, u.id));
  });

  it("returns each member with email, name, and role (owners first)", async () => {
    const [t] = await db.insert(tenants).values({ name: "Members WS" }).returning();
    tenantId = t.id;
    const [owner] = await db.insert(users).values({ email: "m-owner@example.com", name: "Owner" }).returning();
    const [member] = await db.insert(users).values({ email: "m-member@example.com", name: "Member" }).returning();
    await db.insert(tenantMembers).values({ tenantId: t.id, userId: owner.id, role: "owner" });
    await db.insert(tenantMembers).values({ tenantId: t.id, userId: member.id, role: "member" });

    const list = await listWorkspaceMembers(t.id);
    expect(list).toHaveLength(2);
    expect(list[0].role).toBe("owner");
    expect(list[0].email).toBe("m-owner@example.com");
    expect(list.map((m) => m.email).sort()).toEqual(emails.slice().sort());
  });
});
