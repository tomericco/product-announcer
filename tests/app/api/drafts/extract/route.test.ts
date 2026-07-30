import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => undefined, set: () => {} })) }));
vi.mock("../../../../../src/lib/ai/extract-release", () => ({ runExtractForRelease: vi.fn() }));

import { getServerSession } from "next-auth";
import { db } from "../../../../../src/db";
import { users, tenants, tenantMembers, releases } from "../../../../../src/db/schema";
import { runExtractForRelease } from "../../../../../src/lib/ai/extract-release";
import { POST } from "../../../../../src/app/api/drafts/extract/route";

const TENANT_NAME = "Extract Route Test Tenant";
const OTHER_TENANT_NAME = "Extract Route Other Tenant";
const emails = ["extract-route-test@example.com"];

function postRequest(body: unknown) {
  return new Request("http://x/api/drafts/extract", { method: "POST", body: JSON.stringify(body) });
}

async function readNdjson(res: Response) {
  const text = await res.text();
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function makeAuthedUserAndTenant() {
  const [user] = await db.insert(users).values({ email: emails[0] }).returning();
  const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
  await db.insert(tenantMembers).values({ tenantId: tenant.id, userId: user.id, role: "owner" });
  return { user, tenant };
}

beforeEach(() => {
  vi.mocked(getServerSession).mockReset();
  vi.mocked(runExtractForRelease).mockReset();
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

describe("POST /api/drafts/extract", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null as never);
    const res = await POST(postRequest({ releaseId: "r", excerpt: "x", remainingBody: "y" }));
    expect(res.status).toBe(401);
    expect(runExtractForRelease).not.toHaveBeenCalled();
  });

  it("returns 401 when the user has no membership", async () => {
    const [user] = await db.insert(users).values({ email: emails[0] }).returning();
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: user.id } } as never);
    const res = await POST(postRequest({ releaseId: "r", excerpt: "x", remainingBody: "y" }));
    expect(res.status).toBe(401);
    expect(runExtractForRelease).not.toHaveBeenCalled();
  });

  it("streams an error and never runs the pipeline for another tenant's release", async () => {
    const { user } = await makeAuthedUserAndTenant();
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: user.id } } as never);

    const [other] = await db.insert(tenants).values({ name: OTHER_TENANT_NAME }).returning();
    const [foreign] = await db
      .insert(releases)
      .values({ tenantId: other.id, title: "T", body: "B" })
      .returning();

    const res = await POST(
      postRequest({ releaseId: foreign.id, excerpt: "x", remainingBody: "y", instruction: "" })
    );
    const events = await readNdjson(res);
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(runExtractForRelease).not.toHaveBeenCalled();
  });

  it("streams an error when the remaining body is blank", async () => {
    const { user, tenant } = await makeAuthedUserAndTenant();
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: user.id } } as never);
    const [release] = await db
      .insert(releases)
      .values({ tenantId: tenant.id, title: "T", body: "B" })
      .returning();

    const res = await POST(
      postRequest({ releaseId: release.id, excerpt: "x", remainingBody: "   ", instruction: "" })
    );
    const events = await readNdjson(res);
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(runExtractForRelease).not.toHaveBeenCalled();
  });

  it("runs the pipeline for an owned release and forwards its progress events", async () => {
    const { user, tenant } = await makeAuthedUserAndTenant();
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: user.id } } as never);
    const [release] = await db
      .insert(releases)
      .values({ tenantId: tenant.id, title: "T", body: "B" })
      .returning();

    vi.mocked(runExtractForRelease).mockImplementation(async (_args, _db, onProgress) => {
      onProgress?.({ type: "step", key: "preparing", status: "start" });
      onProgress?.({ type: "done", updateId: "new-release-id" });
      return { releaseId: "new-release-id", title: "Generated title" };
    });

    const res = await POST(
      postRequest({
        releaseId: release.id,
        excerpt: "Extracted paragraph.",
        remainingBody: "Kept paragraph.",
        instruction: "keep it short",
      })
    );
    const events = await readNdjson(res);
    expect(events).toContainEqual({ type: "step", key: "preparing", status: "start" });
    expect(events).toContainEqual({ type: "done", updateId: "new-release-id" });

    expect(runExtractForRelease).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runExtractForRelease).mock.calls[0][0]).toMatchObject({
      releaseId: release.id,
      excerpt: "Extracted paragraph.",
      remainingBody: "Kept paragraph.",
      instruction: "keep it short",
      editedBy: user.id,
    });
  });
});
