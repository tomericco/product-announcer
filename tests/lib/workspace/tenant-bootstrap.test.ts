import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../../src/db";
import { users, tenants, tenantMembers } from "../../../src/db/schema";
import { getOrCreateUserFromOAuth } from "../../../src/lib/workspace/tenant-bootstrap";

const EMAIL = "newperson@frontitude.com";

describe("getOrCreateUserFromOAuth", () => {
  afterEach(async () => {
    const [user] = await db.select().from(users).where(eq(users.email, EMAIL));
    if (!user) return;
    const memberships = await db.select().from(tenantMembers).where(eq(tenantMembers.userId, user.id));
    await db.delete(tenantMembers).where(eq(tenantMembers.userId, user.id));
    const tenantIds = memberships.map((m) => m.tenantId);
    if (tenantIds.length) await db.delete(tenants).where(inArray(tenants.id, tenantIds));
    await db.delete(users).where(eq(users.id, user.id));
  });

  it("creates user + tenant + owner membership for a new Google user", async () => {
    const result = await getOrCreateUserFromOAuth({
      email: EMAIL, emailVerified: true, name: "New Person", provider: "google", providerAccountId: "g-1",
    });
    expect(result.role).toBe("owner");
    const [user] = await db.select().from(users).where(eq(users.id, result.userId));
    expect(user.googleId).toBe("g-1");
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, result.tenantId));
    expect(tenant.name).toBe("Frontitude's Workspace");
  });

  it("links a matching verified email to the existing account instead of duplicating", async () => {
    const first = await getOrCreateUserFromOAuth({
      email: EMAIL, emailVerified: true, name: "GH", provider: "github", providerAccountId: "gh-9",
    });
    const second = await getOrCreateUserFromOAuth({
      email: EMAIL, emailVerified: true, name: "GO", provider: "google", providerAccountId: "go-9",
    });
    expect(second.userId).toBe(first.userId);
    expect(second.tenantId).toBe(first.tenantId); // no new tenant
    const [user] = await db.select().from(users).where(eq(users.id, first.userId));
    expect(user.githubId).toBe("gh-9");
    expect(user.googleId).toBe("go-9");
    const allUsers = await db.select().from(users).where(eq(users.email, EMAIL));
    expect(allUsers).toHaveLength(1);
  });

  it("rejects an unverified email", async () => {
    await expect(
      getOrCreateUserFromOAuth({ email: EMAIL, emailVerified: false, name: "x", provider: "google", providerAccountId: "go-x" })
    ).rejects.toThrow();
  });
});
