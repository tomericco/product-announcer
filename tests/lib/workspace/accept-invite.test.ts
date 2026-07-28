import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../../src/db";
import { users, tenants, tenantMembers } from "../../../src/db/schema";
import { createInvite } from "../../../src/lib/workspace/invites";
import { acceptInviteForUser } from "../../../src/lib/workspace/accept-invite";

async function makeUser(email: string) {
  const [u] = await db.insert(users).values({ email }).returning();
  return u;
}

describe("acceptInviteForUser", () => {
  const emails = ["accept-a@example.com", "accept-b@example.com", "accept-personal@gmail.com"];
  let tenantId: string | undefined;
  afterEach(async () => {
    if (tenantId) {
      await db.delete(tenantMembers).where(eq(tenantMembers.tenantId, tenantId));
      await db.delete(tenants).where(eq(tenants.id, tenantId));
      tenantId = undefined;
    }
    const us = await db.select().from(users).where(inArray(users.email, emails));
    for (const u of us) await db.delete(users).where(eq(users.id, u.id));
  });

  async function setup() {
    const [t] = await db.insert(tenants).values({ name: "Accept WS" }).returning();
    tenantId = t.id;
    const { token } = await createInvite(t.id, null as unknown as string);
    return { t, token };
  }

  it("adds a non-member as a member", async () => {
    const { t, token } = await setup();
    const u = await makeUser("accept-a@example.com");
    const res = await acceptInviteForUser(u.id, token);
    expect(res).toEqual({ status: "joined", tenantId: t.id });
    const rows = await db.select().from(tenantMembers).where(eq(tenantMembers.userId, u.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("member");
  });

  it("is a no-op for an existing member (not added twice)", async () => {
    const { t, token } = await setup();
    const u = await makeUser("accept-a@example.com");
    await acceptInviteForUser(u.id, token);
    const res = await acceptInviteForUser(u.id, token);
    expect(res).toEqual({ status: "already_member", tenantId: t.id });
    const rows = await db.select().from(tenantMembers).where(eq(tenantMembers.userId, u.id));
    expect(rows).toHaveLength(1);
  });

  it("creates exactly one membership under concurrent accepts", async () => {
    const { token } = await setup();
    const u = await makeUser("accept-b@example.com");
    await Promise.all([acceptInviteForUser(u.id, token), acceptInviteForUser(u.id, token), acceptInviteForUser(u.id, token)]);
    const rows = await db.select().from(tenantMembers).where(eq(tenantMembers.userId, u.id));
    expect(rows).toHaveLength(1);
  });

  it("returns the validation error for an unknown token", async () => {
    const u = await makeUser("accept-a@example.com");
    expect(await acceptInviteForUser(u.id, "nope")).toEqual({ status: "invalid" });
  });

  // The invitee path for a personal-email account: it has a user row but no
  // workspace — exactly the state the work-email gate leaves it in.
  it("joins a user who belongs to no workspace at all", async () => {
    const { t, token } = await setup();
    const u = await makeUser("accept-personal@gmail.com");
    const before = await db.select().from(tenantMembers).where(eq(tenantMembers.userId, u.id));
    expect(before).toHaveLength(0);

    const res = await acceptInviteForUser(u.id, token);

    expect(res).toEqual({ status: "joined", tenantId: t.id });
  });
});
