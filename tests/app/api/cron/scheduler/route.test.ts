import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../../../src/lib/publishing/dispatch", () => ({ retryFailedDeliveries: vi.fn() }));
vi.mock("../../../../../src/lib/change-events/resolve-sweep", () => ({ sweepUnresolvedEvents: vi.fn() }));
// Must be mocked: the real `syncShippedWorkSignals` is an unscoped,
// cross-tenant query against the shared test database. Vitest runs test
// files in parallel, and `tests/db/signals-schema.test.ts` creates a
// shipped_work signal, deletes its atomic update, and asserts the signal
// survives — if the real reconciler fired from this route test in that
// window, it could race that assertion. Nothing here should ever exercise the
// real reconciler; that's what `tests/lib/signals/shipped-work.test.ts` is for.
vi.mock("../../../../../src/lib/signals/shipped-work", () => ({ syncShippedWorkSignals: vi.fn() }));

import { retryFailedDeliveries } from "../../../../../src/lib/publishing/dispatch";
import { sweepUnresolvedEvents } from "../../../../../src/lib/change-events/resolve-sweep";
import { syncShippedWorkSignals } from "../../../../../src/lib/signals/shipped-work";
import { GET } from "../../../../../src/app/api/cron/scheduler/route";

function request(authorization?: string) {
  return new Request("https://app.example.com/api/cron/scheduler", {
    headers: authorization !== undefined ? { authorization } : undefined,
  });
}

describe("GET /api/cron/scheduler", () => {
  const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

  beforeEach(() => {
    // Set an explicit, known secret rather than relying on whatever (if
    // anything) is in the environment — otherwise an unset CRON_SECRET makes
    // the success case compare "Bearer undefined" to itself and pass vacuously.
    process.env.CRON_SECRET = "test-cron-secret";
    vi.mocked(retryFailedDeliveries).mockReset().mockResolvedValue(undefined);
    vi.mocked(sweepUnresolvedEvents).mockReset().mockResolvedValue(undefined);
    vi.mocked(syncShippedWorkSignals).mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
  });

  it("returns 401 and runs nothing when the authorization header is missing", async () => {
    const res = await GET(request() as never);
    expect(res.status).toBe(401);
    expect(retryFailedDeliveries).not.toHaveBeenCalled();
    expect(sweepUnresolvedEvents).not.toHaveBeenCalled();
    expect(syncShippedWorkSignals).not.toHaveBeenCalled();
  });

  it("returns 401 and runs nothing when the bearer token is wrong", async () => {
    const res = await GET(request("Bearer not-the-secret") as never);
    expect(res.status).toBe(401);
    expect(retryFailedDeliveries).not.toHaveBeenCalled();
    expect(sweepUnresolvedEvents).not.toHaveBeenCalled();
    expect(syncShippedWorkSignals).not.toHaveBeenCalled();
  });

  it("returns 200 and runs the delivery retry, event sweep, and shipped-work sync when the bearer token matches CRON_SECRET", async () => {
    const res = await GET(request("Bearer test-cron-secret") as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(retryFailedDeliveries).toHaveBeenCalledTimes(1);
    expect(sweepUnresolvedEvents).toHaveBeenCalledTimes(1);
    expect(syncShippedWorkSignals).toHaveBeenCalledTimes(1);
  });

  it("runs the shipped-work sync after the event sweep, since the sweep can create atomic updates the reconciler must see", async () => {
    const order: string[] = [];
    vi.mocked(sweepUnresolvedEvents).mockImplementation(async () => {
      order.push("sweepUnresolvedEvents");
    });
    vi.mocked(syncShippedWorkSignals).mockImplementation(async () => {
      order.push("syncShippedWorkSignals");
    });

    await GET(request("Bearer test-cron-secret") as never);

    expect(order).toEqual(["sweepUnresolvedEvents", "syncShippedWorkSignals"]);
  });
});
