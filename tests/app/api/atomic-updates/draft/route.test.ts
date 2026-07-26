import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => undefined, set: () => {} })) }));
vi.mock("../../../../../src/lib/scheduling/run-schedule", () => ({ runBatchForWorkspace: vi.fn() }));
vi.mock("../../../../../src/lib/change-events/release-claim", () => ({ getOpenAtomicUpdates: vi.fn() }));

import { getServerSession } from "next-auth";
import { db } from "../../../../../src/db";
import { users, tenants, tenantMembers } from "../../../../../src/db/schema";
import { runBatchForWorkspace } from "../../../../../src/lib/scheduling/run-schedule";
import { getOpenAtomicUpdates } from "../../../../../src/lib/change-events/release-claim";
import { POST } from "../../../../../src/app/api/atomic-updates/draft/route";

const TENANT_NAME = "Atomic Updates Draft Route Test Tenant";
const emails = ["atomic-updates-draft-route-test@example.com"];

function postRequest(body: unknown) {
  return new Request("http://x/api/atomic-updates/draft", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function readNdjson(res: Response) {
  const text = await res.text();
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// Seeds a real user + tenant + owner membership so resolveActiveTenant()
// (called inside the route) resolves to a real, membership-checked tenant.
async function makeAuthedUserAndTenant() {
  const [user] = await db.insert(users).values({ email: emails[0] }).returning();
  const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
  await db.insert(tenantMembers).values({ tenantId: tenant.id, userId: user.id, role: "owner" });
  return { user, tenant };
}

beforeEach(() => {
  vi.mocked(getServerSession).mockReset();
  vi.mocked(runBatchForWorkspace).mockReset();
  vi.mocked(getOpenAtomicUpdates).mockReset();
});

afterEach(async () => {
  const us = await db.select().from(users).where(inArray(users.email, emails));
  for (const u of us) {
    await db.delete(tenantMembers).where(eq(tenantMembers.userId, u.id));
    await db.delete(users).where(eq(users.id, u.id));
  }
  await db.delete(tenants).where(eq(tenants.name, TENANT_NAME));
});

describe("POST /api/atomic-updates/draft", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null as never);
    const res = await POST(postRequest({ atomicUpdateIds: ["a1"] }));
    expect(res.status).toBe(401);
  });

  // Regression coverage for the orphaned-session bug: a JWT can keep
  // carrying a user id whose memberships have since disappeared (tenant
  // deleted, membership removed, or the DB was restored from an older
  // backup). Unlike page/layout callers of requireSession(), this is a
  // fetch-based JSON/ndjson API — it must return a plain 401, not attempt a
  // redirect the client-side fetch wouldn't follow into a page render.
  it("returns 401 when the user has no membership", async () => {
    const [user] = await db.insert(users).values({ email: emails[0] }).returning();
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: user.id } } as never);
    const res = await POST(postRequest({ atomicUpdateIds: ["a1"] }));
    expect(res.status).toBe(401);
    expect(getOpenAtomicUpdates).not.toHaveBeenCalled();
    expect(runBatchForWorkspace).not.toHaveBeenCalled();
  });

  it("streams collecting + an error event when none of the requested ids are open", async () => {
    const { user } = await makeAuthedUserAndTenant();
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: user.id } } as never);
    vi.mocked(getOpenAtomicUpdates).mockResolvedValue([] as never);
    const res = await POST(postRequest({ atomicUpdateIds: ["a1"] }));
    const events = await readNdjson(res);
    expect(events).toContainEqual({ type: "step", key: "collecting", status: "start" });
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(runBatchForWorkspace).not.toHaveBeenCalled();
  });

  it("filters the requested ids down to the tenant's owned, open atomic updates before drafting", async () => {
    const { user } = await makeAuthedUserAndTenant();
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: user.id } } as never);
    // Only "a1" is open for this tenant; "a2" in the request is foreign/stale
    // and must be dropped rather than passed through to generation.
    vi.mocked(getOpenAtomicUpdates).mockResolvedValue([{ id: "a1", title: "T", summary: "S", category: null }] as never);
    vi.mocked(runBatchForWorkspace).mockResolvedValue(true);

    const res = await POST(postRequest({ atomicUpdateIds: ["a1", "a2"] }));
    await readNdjson(res);

    expect(runBatchForWorkspace).toHaveBeenCalledTimes(1);
    const [, selected] = vi.mocked(runBatchForWorkspace).mock.calls[0];
    expect((selected as { id: string }[]).map((s) => s.id)).toEqual(["a1"]);
  });

  it("forwards runBatchForWorkspace progress events to the stream", async () => {
    const { user } = await makeAuthedUserAndTenant();
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: user.id } } as never);
    vi.mocked(getOpenAtomicUpdates).mockResolvedValue([{ id: "a1", title: "T", summary: "S", category: null }] as never);
    vi.mocked(runBatchForWorkspace).mockImplementation(async (_t, _items, _db, onProgress) => {
      onProgress?.({ type: "step", key: "generating", status: "start" });
      onProgress?.({ type: "done", updateId: "u1" });
      return true;
    });
    const res = await POST(postRequest({ atomicUpdateIds: ["a1"] }));
    const events = await readNdjson(res);
    expect(events).toContainEqual({ type: "step", key: "collecting", status: "done" });
    expect(events).toContainEqual({ type: "step", key: "generating", status: "start" });
    expect(events.at(-1)).toEqual({ type: "done", updateId: "u1" });
  });
});
