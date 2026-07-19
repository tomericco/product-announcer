import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("../../../../../src/lib/scheduling/run-schedule", () => ({ runBatchForWorkspace: vi.fn() }));
vi.mock("../../../../../src/lib/change-items/change-item-batch", () => ({ getBatchableChangeItems: vi.fn() }));

import { getServerSession } from "next-auth";
import { runBatchForWorkspace } from "../../../../../src/lib/scheduling/run-schedule";
import { getBatchableChangeItems } from "../../../../../src/lib/change-items/change-item-batch";
import { POST } from "../../../../../src/app/api/pending/draft/route";

async function readNdjson(res: Response) {
  const text = await res.text();
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

beforeEach(() => {
  vi.mocked(getServerSession).mockReset();
  vi.mocked(runBatchForWorkspace).mockReset();
  vi.mocked(getBatchableChangeItems).mockReset();
});

describe("POST /api/pending/draft", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null as never);
    const res = await POST(new Request("http://x/api/pending/draft", { method: "POST" }));
    expect(res.status).toBe(401);
  });

  it("streams collecting + an error event when there are no pending changes", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: "t1" } } as never);
    vi.mocked(getBatchableChangeItems).mockResolvedValue([] as never);
    const res = await POST(new Request("http://x/api/pending/draft", { method: "POST" }));
    const events = await readNdjson(res);
    expect(events).toContainEqual({ type: "step", key: "collecting", status: "start" });
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(runBatchForWorkspace).not.toHaveBeenCalled();
  });

  it("forwards runBatchForWorkspace progress events to the stream", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: "t1" } } as never);
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
