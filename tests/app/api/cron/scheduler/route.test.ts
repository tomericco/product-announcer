import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../../../src/lib/publishing/dispatch", () => ({ retryFailedDeliveries: vi.fn() }));
vi.mock("../../../../../src/lib/change-events/resolve-sweep", () => ({ sweepUnresolvedEvents: vi.fn() }));

import { retryFailedDeliveries } from "../../../../../src/lib/publishing/dispatch";
import { sweepUnresolvedEvents } from "../../../../../src/lib/change-events/resolve-sweep";
import { GET } from "../../../../../src/app/api/cron/scheduler/route";

function request(authorization?: string) {
  return new Request("https://app.example.com/api/cron/scheduler", {
    headers: authorization !== undefined ? { authorization } : undefined,
  });
}

describe("GET /api/cron/scheduler", () => {
  beforeEach(() => {
    vi.mocked(retryFailedDeliveries).mockReset().mockResolvedValue(undefined);
    vi.mocked(sweepUnresolvedEvents).mockReset().mockResolvedValue(undefined);
  });

  it("returns 401 and runs nothing when the authorization header is missing", async () => {
    const res = await GET(request() as never);
    expect(res.status).toBe(401);
    expect(retryFailedDeliveries).not.toHaveBeenCalled();
    expect(sweepUnresolvedEvents).not.toHaveBeenCalled();
  });

  it("returns 401 and runs nothing when the bearer token is wrong", async () => {
    const res = await GET(request("Bearer not-the-secret") as never);
    expect(res.status).toBe(401);
    expect(retryFailedDeliveries).not.toHaveBeenCalled();
    expect(sweepUnresolvedEvents).not.toHaveBeenCalled();
  });

  it("returns 200 and runs the delivery retry and event sweep when the bearer token matches CRON_SECRET", async () => {
    const res = await GET(request(`Bearer ${process.env.CRON_SECRET}`) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(retryFailedDeliveries).toHaveBeenCalledTimes(1);
    expect(sweepUnresolvedEvents).toHaveBeenCalledTimes(1);
  });
});
