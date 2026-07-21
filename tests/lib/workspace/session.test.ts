import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Session } from "next-auth";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));

import { getServerSession } from "next-auth";
import { db } from "../../../src/db";
import { tenants } from "../../../src/db/schema";
import { hasValidSession, requireSession } from "../../../src/lib/workspace/session";

describe("hasValidSession", () => {
  it("returns false for a null session", () => {
    expect(hasValidSession(null)).toBe(false);
  });

  it("returns false when tenantId is missing", () => {
    const session = { user: {}, expires: "" } as unknown as Session;
    expect(hasValidSession(session)).toBe(false);
  });

  it("returns true when tenantId is present", () => {
    const session = { user: { tenantId: "tenant-1" }, expires: "" } as unknown as Session;
    expect(hasValidSession(session)).toBe(true);
  });
});

// A session's JWT can outlive the tenant row it points at — e.g. the tenant
// was deleted, or the database was restored from an older backup. Since the
// app uses the JWT session strategy with no database adapter, the token
// itself never notices: it keeps carrying the stale tenantId for the life of
// the cookie (NextAuth's default maxAge is 30 days). Every subsequent write
// then 500s on a Postgres foreign-key violation. requireSession() must catch
// this by confirming the tenant row still exists, not just that a tenantId
// is present on the token.
describe("requireSession", () => {
  const TENANT_NAME = "Session Guard Test Tenant";

  beforeEach(() => {
    vi.mocked(getServerSession).mockReset();
  });

  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT_NAME));
  });

  it("returns the session normally when the tenant exists", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
    const session = { user: { tenantId: tenant.id }, expires: "" } as unknown as Session;
    vi.mocked(getServerSession).mockResolvedValue(session as never);

    await expect(requireSession()).resolves.toBe(session);
  });

  it("redirects instead of throwing a raw DB error when the session's tenant no longer exists", async () => {
    // A syntactically valid UUID that was never inserted — simulates a
    // deleted tenant / stale-token scenario without needing to seed then
    // delete a row (which risks FK cascade timing issues in the test itself).
    const orphanedTenantId = "00000000-0000-0000-0000-000000000000";
    const session = { user: { tenantId: orphanedTenantId }, expires: "" } as unknown as Session;
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
    // or an authenticated-but-orphaned user would bounce forever.
    expect(digest as string).toContain("/api/auth/signout");
  });

  it("performs exactly one tenant lookup — no query-per-call-site regression", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
    const session = { user: { tenantId: tenant.id }, expires: "" } as unknown as Session;
    vi.mocked(getServerSession).mockResolvedValue(session as never);

    const selectSpy = vi.spyOn(db, "select");
    try {
      await requireSession();
      expect(selectSpy).toHaveBeenCalledTimes(1);
    } finally {
      selectSpy.mockRestore();
    }
  });
});
