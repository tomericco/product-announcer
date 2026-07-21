import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("../../../../../src/lib/scheduling/run-schedule", () => ({ runBatchForWorkspace: vi.fn() }));
vi.mock("../../../../../src/lib/change-events/change-item-batch", () => ({ getBatchableChangeItems: vi.fn() }));

import { getServerSession } from "next-auth";
import { db } from "../../../../../src/db";
import { tenants } from "../../../../../src/db/schema";
import { runBatchForWorkspace } from "../../../../../src/lib/scheduling/run-schedule";
import { getBatchableChangeItems } from "../../../../../src/lib/change-events/change-item-batch";
import { POST } from "../../../../../src/app/api/pending/draft/route";

const TENANT_NAME = "Pending Draft Route Test Tenant";

async function readNdjson(res: Response) {
  const text = await res.text();
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

beforeEach(() => {
  vi.mocked(getServerSession).mockReset();
  vi.mocked(runBatchForWorkspace).mockReset();
  vi.mocked(getBatchableChangeItems).mockReset();
});

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT_NAME));
});

describe("POST /api/pending/draft", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null as never);
    const res = await POST(new Request("http://x/api/pending/draft", { method: "POST" }));
    expect(res.status).toBe(401);
  });

  // Regression coverage for the orphaned-session bug: a JWT can keep
  // carrying a tenantId whose row has since been deleted (or the DB was
  // restored from an older backup). Unlike page/layout callers of
  // requireSession(), this is a fetch-based JSON/ndjson API — it must
  // return a plain 401, not attempt a redirect the client-side fetch
  // wouldn't follow into a page render.
  it("returns 401 when the session's tenant no longer exists", async () => {
    const orphanedTenantId = "00000000-0000-0000-0000-000000000000";
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: orphanedTenantId } } as never);
    const res = await POST(new Request("http://x/api/pending/draft", { method: "POST" }));
    expect(res.status).toBe(401);
    expect(getBatchableChangeItems).not.toHaveBeenCalled();
    expect(runBatchForWorkspace).not.toHaveBeenCalled();
  });

  it("streams collecting + an error event when there are no pending changes", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id } } as never);
    vi.mocked(getBatchableChangeItems).mockResolvedValue([] as never);
    const res = await POST(new Request("http://x/api/pending/draft", { method: "POST" }));
    const events = await readNdjson(res);
    expect(events).toContainEqual({ type: "step", key: "collecting", status: "start" });
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(runBatchForWorkspace).not.toHaveBeenCalled();
  });

  it("forwards runBatchForWorkspace progress events to the stream", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id } } as never);
    vi.mocked(getBatchableChangeItems).mockResolvedValue([{ id: "c1" }] as never);
    vi.mocked(runBatchForWorkspace).mockImplementation(async (_t, _p, _db, onProgress) => {
      onProgress?.({ type: "step", key: "generating", status: "start" });
      onProgress?.({ type: "done", updateId: "u1" });
      return true;
    });
    const res = await POST(new Request("http://x/api/pending/draft", { method: "POST" }));
    const events = await readNdjson(res);
    expect(events).toContainEqual({ type: "step", key: "collecting", status: "done" });
    expect(events).toContainEqual({ type: "step", key: "generating", status: "start" });
    expect(events.at(-1)).toEqual({ type: "done", updateId: "u1" });
  });
});
