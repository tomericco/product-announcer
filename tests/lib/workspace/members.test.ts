import { describe, it, expect, afterEach } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../../src/db";
import { users, tenants, tenantMembers, contentPieces } from "../../../src/db/schema";
import { listWorkspaceMembers, removeWorkspaceMember } from "../../../src/lib/workspace/members";

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

describe("removeWorkspaceMember", () => {
  const emails = ["rm-owner@example.com", "rm-member@example.com"];
  const tenantIds: string[] = [];

  afterEach(async () => {
    if (tenantIds.length) {
      await db.delete(tenantMembers).where(inArray(tenantMembers.tenantId, tenantIds));
      await db.delete(tenants).where(inArray(tenants.id, tenantIds));
      tenantIds.length = 0;
    }
    const us = await db.select().from(users).where(inArray(users.email, emails));
    for (const u of us) await db.delete(users).where(eq(users.id, u.id));
  });

  async function seed() {
    const [t] = await db.insert(tenants).values({ name: "Remove WS" }).returning();
    tenantIds.push(t.id);
    const [owner] = await db.insert(users).values({ email: "rm-owner@example.com" }).returning();
    const [member] = await db.insert(users).values({ email: "rm-member@example.com" }).returning();
    await db.insert(tenantMembers).values({ tenantId: t.id, userId: owner.id, role: "owner" });
    await db.insert(tenantMembers).values({ tenantId: t.id, userId: member.id, role: "member" });
    return { t, owner, member };
  }

  it("removes the target member's membership", async () => {
    const { t, owner, member } = await seed();
    const result = await removeWorkspaceMember(t.id, owner.id, member.id);
    expect(result).toEqual({ removed: true });
    const rows = await db
      .select()
      .from(tenantMembers)
      .where(and(eq(tenantMembers.tenantId, t.id), eq(tenantMembers.userId, member.id)));
    expect(rows).toHaveLength(0);
  });

  it("does not touch the removed user's memberships in other workspaces", async () => {
    const { t, owner, member } = await seed();
    const [other] = await db.insert(tenants).values({ name: "Remove WS" }).returning();
    tenantIds.push(other.id);
    await db.insert(tenantMembers).values({ tenantId: other.id, userId: member.id, role: "owner" });

    await removeWorkspaceMember(t.id, owner.id, member.id);

    const stillThere = await db
      .select()
      .from(tenantMembers)
      .where(and(eq(tenantMembers.tenantId, other.id), eq(tenantMembers.userId, member.id)));
    expect(stillThere).toHaveLength(1);
  });

  it("refuses self-removal and leaves the membership intact", async () => {
    const { t, owner } = await seed();
    await expect(removeWorkspaceMember(t.id, owner.id, owner.id)).rejects.toThrow();
    const rows = await db
      .select()
      .from(tenantMembers)
      .where(and(eq(tenantMembers.tenantId, t.id), eq(tenantMembers.userId, owner.id)));
    expect(rows).toHaveLength(1);
  });

  it("is a no-op when the target is not a member", async () => {
    const { t, owner } = await seed();
    // A syntactically valid UUID that belongs to no member of this workspace.
    const result = await removeWorkspaceMember(t.id, owner.id, "00000000-0000-0000-0000-000000000000");
    expect(result).toEqual({ removed: false });
  });

  it("clears assignedTo on this tenant's content pieces that named the removed member", async () => {
    const { t, owner, member } = await seed();
    const [piece] = await db
      .insert(contentPieces)
      .values({ tenantId: t.id, title: "T", body: "B", status: "draft", assignedTo: member.id })
      .returning();

    await removeWorkspaceMember(t.id, owner.id, member.id);

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    // Otherwise the board's assignee picker resolves assignedTo against the
    // live member list, renders "Unassigned", while its own <Select value>
    // still points at a user with no matching item.
    expect(after.assignedTo).toBeNull();

    await db.delete(contentPieces).where(eq(contentPieces.id, piece.id));
  });

  it("does not touch another tenant's content pieces assigned to the same user id", async () => {
    const { t, owner, member } = await seed();
    const [otherTenant] = await db.insert(tenants).values({ name: "Remove WS" }).returning();
    tenantIds.push(otherTenant.id);
    await db.insert(tenantMembers).values({ tenantId: otherTenant.id, userId: member.id, role: "owner" });
    const [otherPiece] = await db
      .insert(contentPieces)
      .values({ tenantId: otherTenant.id, title: "T", body: "B", status: "draft", assignedTo: member.id })
      .returning();

    await removeWorkspaceMember(t.id, owner.id, member.id);

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, otherPiece.id));
    expect(after.assignedTo).toBe(member.id);

    await db.delete(contentPieces).where(eq(contentPieces.id, otherPiece.id));
  });
});
