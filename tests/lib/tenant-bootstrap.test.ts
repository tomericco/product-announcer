import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { users, tenants, tenantMembers } from "../../src/db/schema";
import { getOrCreateTenantForUser } from "../../src/lib/tenant-bootstrap";

describe("getOrCreateTenantForUser", () => {
  const githubId = "test-github-12345";

  afterEach(async () => {
    const [user] = await db.select().from(users).where(eq(users.githubId, githubId));
    if (!user) return;

    const memberships = await db.select().from(tenantMembers).where(eq(tenantMembers.userId, user.id));
    await db.delete(tenantMembers).where(eq(tenantMembers.userId, user.id));
    for (const membership of memberships) {
      await db.delete(tenants).where(eq(tenants.id, membership.tenantId));
    }
    await db.delete(users).where(eq(users.id, user.id));
  });

  it("creates a new user, tenant, and owner membership on first call", async () => {
    const result = await getOrCreateTenantForUser({
      email: "newperson@frontitude.com",
      name: "New Person",
      githubId,
    });

    expect(result.role).toBe("owner");

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, result.tenantId));
    expect(tenant.name).toBe("Frontitude's Workspace");

    const [membership] = await db
      .select()
      .from(tenantMembers)
      .where(eq(tenantMembers.userId, result.userId));
    expect(membership.tenantId).toBe(result.tenantId);
    expect(membership.role).toBe("owner");
  });

  it("is idempotent — a second call for the same githubId returns the same tenant", async () => {
    const first = await getOrCreateTenantForUser({
      email: "newperson@frontitude.com",
      name: "New Person",
      githubId,
    });
    const second = await getOrCreateTenantForUser({
      email: "newperson@frontitude.com",
      name: "New Person",
      githubId,
    });

    expect(second.userId).toBe(first.userId);
    expect(second.tenantId).toBe(first.tenantId);
    expect(second.role).toBe(first.role);

    const allTenants = await db.select().from(tenants).where(eq(tenants.id, first.tenantId));
    expect(allTenants).toHaveLength(1);
  });
});
