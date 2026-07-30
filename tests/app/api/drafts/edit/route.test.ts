import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => undefined, set: () => {} })) }));
vi.mock("../../../../../src/lib/ai/edit-release", () => ({ runWholeEditForRelease: vi.fn() }));

import { getServerSession } from "next-auth";
import { db } from "../../../../../src/db";
import { users, tenants, tenantMembers, releases } from "../../../../../src/db/schema";
import { runWholeEditForRelease } from "../../../../../src/lib/ai/edit-release";
import { POST } from "../../../../../src/app/api/drafts/edit/route";

const TENANT_NAME = "Edit Route Test Tenant";
const OTHER_TENANT_NAME = "Edit Route Other Tenant";
const emails = ["edit-route-test@example.com"];

function postRequest(body: unknown) {
  return new Request("http://x/api/drafts/edit", { method: "POST", body: JSON.stringify(body) });
}

async function readNdjson(res: Response) {
  const text = await res.text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// Seeds a real user + tenant + owner membership so resolveActiveTenant()
// (called inside the route) resolves against real membership rows.
async function makeAuthedUserAndTenant() {
  const [user] = await db.insert(users).values({ email: emails[0] }).returning();
  const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
  await db.insert(tenantMembers).values({ tenantId: tenant.id, userId: user.id, role: "owner" });
  return { user, tenant };
}

beforeEach(() => {
  vi.mocked(getServerSession).mockReset();
  vi.mocked(runWholeEditForRelease).mockReset();
});

afterEach(async () => {
  const us = await db.select().from(users).where(inArray(users.email, emails));
  for (const u of us) {
    await db.delete(tenantMembers).where(eq(tenantMembers.userId, u.id));
    await db.delete(users).where(eq(users.id, u.id));
  }
  for (const name of [TENANT_NAME, OTHER_TENANT_NAME]) {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.name, name));
    if (tenant) {
      await db.delete(releases).where(eq(releases.tenantId, tenant.id));
      await db.delete(tenants).where(eq(tenants.id, tenant.id));
    }
  }
});

describe("POST /api/drafts/edit", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null as never);
    const res = await POST(postRequest({ releaseId: "r", instruction: "shorten it" }));
    expect(res.status).toBe(401);
    expect(runWholeEditForRelease).not.toHaveBeenCalled();
  });

  it("returns 401 when the user has no membership", async () => {
    const [user] = await db.insert(users).values({ email: emails[0] }).returning();
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: user.id } } as never);
    const res = await POST(postRequest({ releaseId: "r", instruction: "shorten it" }));
    expect(res.status).toBe(401);
    expect(runWholeEditForRelease).not.toHaveBeenCalled();
  });

  it("streams an error and never runs the pipeline for another tenant's release", async () => {
    const { user } = await makeAuthedUserAndTenant();
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: user.id } } as never);

    const [other] = await db.insert(tenants).values({ name: OTHER_TENANT_NAME }).returning();
    const [foreign] = await db
      .insert(releases)
      .values({ tenantId: other.id, title: "T", body: "B" })
      .returning();

    const res = await POST(postRequest({ releaseId: foreign.id, instruction: "shorten it", fullBody: "B" }));
    const events = await readNdjson(res);
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(runWholeEditForRelease).not.toHaveBeenCalled();
  });

  // A published release's stored body is what already went out to users; a
  // whole-body rewrite would silently change it.
  it("streams an error for a published release and never runs the pipeline", async () => {
    const { user, tenant } = await makeAuthedUserAndTenant();
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: user.id } } as never);
    const [release] = await db
      .insert(releases)
      .values({ tenantId: tenant.id, title: "T", body: "B", status: "published", publishedAt: new Date() })
      .returning();

    const res = await POST(postRequest({ releaseId: release.id, instruction: "shorten it", fullBody: "B" }));
    const events = await readNdjson(res);
    expect(events.some((e) => e.type === "error" && /already been published/i.test(e.message))).toBe(true);
    expect(runWholeEditForRelease).not.toHaveBeenCalled();
  });

  it("streams an error for a rejected release and never runs the pipeline", async () => {
    const { user, tenant } = await makeAuthedUserAndTenant();
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: user.id } } as never);
    const [release] = await db
      .insert(releases)
      .values({ tenantId: tenant.id, title: "T", body: "B", status: "rejected" })
      .returning();

    const res = await POST(postRequest({ releaseId: release.id, instruction: "shorten it", fullBody: "B" }));
    const events = await readNdjson(res);
    expect(events.some((e) => e.type === "error" && /rejected/i.test(e.message))).toBe(true);
    expect(runWholeEditForRelease).not.toHaveBeenCalled();
  });

  it("runs the pipeline for an owned draft and forwards its progress events", async () => {
    const { user, tenant } = await makeAuthedUserAndTenant();
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: user.id } } as never);
    const [release] = await db
      .insert(releases)
      .values({ tenantId: tenant.id, title: "T", body: "B" })
      .returning();

    vi.mocked(runWholeEditForRelease).mockImplementation(async (_args, _db, onProgress) => {
      onProgress?.({ type: "step", key: "preparing", status: "start" });
      onProgress?.({ type: "done", updateId: release.id, body: "revised body" });
      return { body: "revised body" };
    });

    const res = await POST(
      postRequest({ releaseId: release.id, instruction: "shorten it", fullBody: "live body" })
    );
    const events = await readNdjson(res);
    expect(events).toContainEqual({ type: "step", key: "preparing", status: "start" });
    expect(events).toContainEqual({ type: "done", updateId: release.id, body: "revised body" });

    expect(runWholeEditForRelease).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runWholeEditForRelease).mock.calls[0][0]).toMatchObject({
      releaseId: release.id,
      instruction: "shorten it",
      fullBody: "live body",
      editedBy: user.id,
    });
  });
});
