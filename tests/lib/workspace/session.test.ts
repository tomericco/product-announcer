import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { Session } from "next-auth";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => undefined, set: () => {} })) }));

import { getServerSession } from "next-auth";
import { db } from "../../../src/db";
import { users, tenants, tenantMembers } from "../../../src/db/schema";
import { hasValidSession, requireSession } from "../../../src/lib/workspace/session";

describe("hasValidSession", () => {
  it("returns false for a null session", () => {
    expect(hasValidSession(null)).toBe(false);
  });

  it("returns false when user.id is missing", () => {
    const session = { user: {}, expires: "" } as unknown as Session;
    expect(hasValidSession(session)).toBe(false);
  });

  it("returns true when user.id is present", () => {
    const session = { user: { id: "user-1" }, expires: "" } as unknown as Session;
    expect(hasValidSession(session)).toBe(true);
  });
});

// A session's JWT can outlive the tenant/membership it points at — e.g. the
// tenant was deleted, the membership was removed, or the database was
// restored from an older backup. Since the app uses the JWT session strategy
// with no database adapter, the token itself never notices: it keeps
// carrying stale tenantId/role for the life of the cookie (NextAuth's
// default maxAge is 30 days). requireSession() must resolve the active
// workspace from real membership rows on every call rather than trusting
// whatever tenantId/role happen to be baked into the token.
describe("requireSession", () => {
  const emails = ["session-guard-test@example.com"];

  beforeEach(() => {
    vi.mocked(getServerSession).mockReset();
  });

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

  it("stamps the resolved active tenant/role onto the session", async () => {
    const [user] = await db.insert(users).values({ email: emails[0] }).returning();
    const [tenant] = await db.insert(tenants).values({ name: "Session Guard Test Tenant" }).returning();
    await db.insert(tenantMembers).values({ tenantId: tenant.id, userId: user.id, role: "owner" });

    const session = {
      user: { id: user.id, tenantId: "stale-id", role: "member" },
      expires: "",
    } as unknown as Session;
    vi.mocked(getServerSession).mockResolvedValue(session as never);

    const resolved = await requireSession();
    expect(resolved.user.tenantId).toBe(tenant.id);
    expect(resolved.user.role).toBe("owner");
  });

  it("redirects to signout when the user has no membership", async () => {
    const [user] = await db.insert(users).values({ email: emails[0] }).returning();
    const session = { user: { id: user.id }, expires: "" } as unknown as Session;
    vi.mocked(getServerSession).mockResolvedValue(session as never);

    let caught: unknown;
    try {
      await requireSession();
    } catch (err) {
      caught = err;
    }

    // redirect() throws a special NEXT_REDIRECT error rather than returning —
    // assert on that digest instead of trying to follow the redirect.
    expect(caught).toBeTruthy();
    const digest = (caught as { digest?: unknown }).digest;
    expect(typeof digest).toBe("string");
    expect(digest as string).toMatch(/^NEXT_REDIRECT/);
    // Must NOT be a route that itself calls requireSession (e.g. signin),
    // or an authenticated-but-membership-less user would bounce forever.
    expect(digest as string).toContain("/api/auth/signout");
  });
});
