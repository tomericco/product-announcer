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
// Must be mocked for the same reason: the real `sweepCompetitorSources` is an
// unscoped, cross-tenant sweep against the shared test database. Its own
// isolation is covered by `tests/lib/signals/sweep.test.ts`; nothing here
// should ever exercise the real sweep.
vi.mock("../../../../../src/lib/signals/sweep", () => ({ sweepCompetitorSources: vi.fn() }));
// Must be mocked for the same reason, and one more: the real
// `sweepNewsSources` is an unscoped, cross-tenant sweep that *writes* —
// it UPDATEs status/lastRunAt/lastError on every tenant's news source, so it
// would clobber rows `news-agent.test.ts`, `news-sweep.test.ts` and
// `company-actions.test.ts` create in parallel. It also reaches the network:
// with a TAVILY_API_KEY present (as `.env.example` invites) `npm test` would
// make real paid Tavily searches, real outbound article fetches, and real
// model calls. Its own isolation is covered by
// `tests/lib/signals/news-sweep.test.ts`.
vi.mock("../../../../../src/lib/signals/news-sweep", () => ({ sweepNewsSources: vi.fn() }));
// Must be mocked for the same reason, and one more: the real `sweepIdeation`
// is an unscoped, cross-tenant sweep against the shared test database, and it
// makes a paid model call per tenant via `runIdeation`. Its own isolation is
// covered by `tests/lib/briefs/sweep.test.ts`; nothing here should ever
// exercise the real sweep.
vi.mock("../../../../../src/lib/briefs/sweep", () => ({
  expireStaleBriefs: vi.fn(),
  sweepIdeation: vi.fn(),
}));

import { retryFailedDeliveries } from "../../../../../src/lib/publishing/dispatch";
import { sweepUnresolvedEvents } from "../../../../../src/lib/change-events/resolve-sweep";
import { syncShippedWorkSignals } from "../../../../../src/lib/signals/shipped-work";
import { sweepCompetitorSources } from "../../../../../src/lib/signals/sweep";
import { sweepNewsSources } from "../../../../../src/lib/signals/news-sweep";
import { expireStaleBriefs, sweepIdeation } from "../../../../../src/lib/briefs/sweep";
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
    vi.mocked(sweepCompetitorSources).mockReset().mockResolvedValue(undefined);
    vi.mocked(sweepNewsSources).mockReset().mockResolvedValue(undefined);
    vi.mocked(expireStaleBriefs).mockReset().mockResolvedValue(0);
    vi.mocked(sweepIdeation).mockReset().mockResolvedValue(undefined);
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
    expect(sweepCompetitorSources).not.toHaveBeenCalled();
    expect(sweepNewsSources).not.toHaveBeenCalled();
    expect(expireStaleBriefs).not.toHaveBeenCalled();
    expect(sweepIdeation).not.toHaveBeenCalled();
  });

  it("returns 401 and runs nothing when the bearer token is wrong", async () => {
    const res = await GET(request("Bearer not-the-secret") as never);
    expect(res.status).toBe(401);
    expect(retryFailedDeliveries).not.toHaveBeenCalled();
    expect(sweepUnresolvedEvents).not.toHaveBeenCalled();
    expect(syncShippedWorkSignals).not.toHaveBeenCalled();
    expect(sweepCompetitorSources).not.toHaveBeenCalled();
    expect(sweepNewsSources).not.toHaveBeenCalled();
    expect(expireStaleBriefs).not.toHaveBeenCalled();
    expect(sweepIdeation).not.toHaveBeenCalled();
  });

  it("returns 200 and runs the delivery retry, event sweep, shipped-work sync, competitor sweep, news sweep, brief expiry, and ideation sweep when the bearer token matches CRON_SECRET", async () => {
    const res = await GET(request("Bearer test-cron-secret") as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(retryFailedDeliveries).toHaveBeenCalledTimes(1);
    expect(sweepUnresolvedEvents).toHaveBeenCalledTimes(1);
    expect(syncShippedWorkSignals).toHaveBeenCalledTimes(1);
    expect(sweepCompetitorSources).toHaveBeenCalledTimes(1);
    expect(sweepNewsSources).toHaveBeenCalledTimes(1);
    expect(expireStaleBriefs).toHaveBeenCalledTimes(1);
    expect(sweepIdeation).toHaveBeenCalledTimes(1);
  });

  it("runs the shipped-work sync after the event sweep, the competitor sweep after the shipped-work sync, the news sweep after that, and brief expiry then the ideation sweep last, since each step depends on the previous one having landed", async () => {
    const order: string[] = [];
    vi.mocked(sweepUnresolvedEvents).mockImplementation(async () => {
      order.push("sweepUnresolvedEvents");
    });
    vi.mocked(syncShippedWorkSignals).mockImplementation(async () => {
      order.push("syncShippedWorkSignals");
    });
    vi.mocked(sweepCompetitorSources).mockImplementation(async () => {
      order.push("sweepCompetitorSources");
    });
    vi.mocked(sweepNewsSources).mockImplementation(async () => {
      order.push("sweepNewsSources");
    });
    vi.mocked(expireStaleBriefs).mockImplementation(async () => {
      order.push("expireStaleBriefs");
      return 0;
    });
    vi.mocked(sweepIdeation).mockImplementation(async () => {
      order.push("sweepIdeation");
    });

    await GET(request("Bearer test-cron-secret") as never);

    expect(order).toEqual([
      "sweepUnresolvedEvents",
      "syncShippedWorkSignals",
      "sweepCompetitorSources",
      "sweepNewsSources",
      "expireStaleBriefs",
      "sweepIdeation",
    ]);
  });
});
