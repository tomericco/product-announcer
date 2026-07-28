import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../../src/db";
import { users, tenants, tenantMembers } from "../../../src/db/schema";
import { getOrCreateUserFromOAuth } from "../../../src/lib/workspace/tenant-bootstrap";

const EMAIL = "newperson@frontitude.com";
const PERSONAL_EMAIL = "newperson@gmail.com";

async function cleanupUser(email: string) {
  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) return;
  const memberships = await db.select().from(tenantMembers).where(eq(tenantMembers.userId, user.id));
  await db.delete(tenantMembers).where(eq(tenantMembers.userId, user.id));
  const tenantIds = memberships.map((m) => m.tenantId);
  if (tenantIds.length) await db.delete(tenants).where(inArray(tenants.id, tenantIds));
  await db.delete(users).where(eq(users.id, user.id));
}

describe("getOrCreateUserFromOAuth", () => {
  afterEach(async () => {
    await cleanupUser(EMAIL);
    await cleanupUser(PERSONAL_EMAIL);
    await db.delete(tenants).where(eq(tenants.name, "Invited Into"));
    delete process.env.ALLOWED_PERSONAL_EMAILS;
  });

  it("creates user + tenant + owner membership for a new Google user", async () => {
    const result = await getOrCreateUserFromOAuth({
      email: EMAIL, emailVerified: true, name: "New Person", provider: "google", providerAccountId: "g-1",
    });
    expect(result.role).toBe("owner");
    expect(result.tenantId).not.toBeNull();
    const tenantId = result.tenantId as string;
    const [user] = await db.select().from(users).where(eq(users.id, result.userId));
    expect(user.googleId).toBe("g-1");
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(tenant.name).toBe("Frontitude's Workspace");
  });

  it("creates the user but NO workspace for a personal email", async () => {
    const result = await getOrCreateUserFromOAuth({
      email: PERSONAL_EMAIL, emailVerified: true, name: "Personal", provider: "google", providerAccountId: "g-p1",
    });

    expect(result.tenantId).toBeNull();
    expect(result.role).toBeNull();

    // The user row IS created — that is what lets them accept an invite later.
    const [user] = await db.select().from(users).where(eq(users.id, result.userId));
    expect(user.email).toBe(PERSONAL_EMAIL);

    const memberships = await db.select().from(tenantMembers).where(eq(tenantMembers.userId, result.userId));
    expect(memberships).toHaveLength(0);
  });

  // The invitee case. Membership is looked up BEFORE the personal-email check,
  // so anyone who already belongs somewhere resolves normally. This ordering is
  // the entire mechanism for both invitees and grandfathered accounts.
  it("resolves normally for a personal email that already holds a membership", async () => {
    const first = await getOrCreateUserFromOAuth({
      email: PERSONAL_EMAIL, emailVerified: true, name: "Personal", provider: "google", providerAccountId: "g-p2",
    });
    const [tenant] = await db.insert(tenants).values({ name: "Invited Into" }).returning({ id: tenants.id });
    await db.insert(tenantMembers).values({ tenantId: tenant.id, userId: first.userId, role: "member" });

    const second = await getOrCreateUserFromOAuth({
      email: PERSONAL_EMAIL, emailVerified: true, name: "Personal", provider: "google", providerAccountId: "g-p2",
    });

    expect(second.userId).toBe(first.userId);
    expect(second.tenantId).toBe(tenant.id);
    expect(second.role).toBe("member");
  });

  it("honours ALLOWED_PERSONAL_EMAILS and creates a workspace anyway", async () => {
    process.env.ALLOWED_PERSONAL_EMAILS = PERSONAL_EMAIL;

    const result = await getOrCreateUserFromOAuth({
      email: PERSONAL_EMAIL, emailVerified: true, name: "Demo", provider: "google", providerAccountId: "g-p3",
    });

    expect(result.tenantId).not.toBeNull();
    expect(result.role).toBe("owner");
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
