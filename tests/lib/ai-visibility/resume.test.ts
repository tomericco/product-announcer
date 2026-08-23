import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import {
  aiVisibilityPrompts,
  aiVisibilityRuns,
  aiVisibilitySamples,
  aiVisibilitySettings,
} from "../../../src/db/schema";
import type { EngineAnswer, EngineClient } from "../../../src/lib/ai-visibility/types";
import {
  STALL_GRACE_MS,
  driveRun,
  findResumableRun,
  planRun,
  runIsStalled,
  type RunSliceResult,
} from "../../../src/lib/ai-visibility/run";
import { seedTenant, dropTenant } from "../../helpers/fixtures";

/**
 * Resuming a stalled run.
 *
 * "Stalled" means in flight with no live slice lease — the state a Run-now
 * leaves behind when its 240s budget runs out with samples still pending, and
 * the state that used to sit under a "Running…" header until the next daily
 * sweep.
 */

const TENANT = "AI Visibility Resume Test Tenant";

afterEach(async () => {
  await dropTenant(TENANT);
});

const NOW = new Date("2026-03-02T12:00:00Z");
/** Well past `STALL_GRACE_MS`, so the plan-to-first-lease window is not in play. */
const STARTED = new Date(NOW.getTime() - 10 * 60_000);

function clock(startIso: string, stepMs = 10) {
  let t = new Date(startIso).getTime();
  return () => {
    const current = new Date(t);
    t += stepMs;
    return current;
  };
}

function answer(): EngineAnswer {
  return {
    text: "Acme and Rival are the usual picks.",
    modelId: "gpt-5.5-2026-04-23",
    citations: [],
    searchUsed: true,
    searchQueries: ["best issue tracker"],
    raw: { ok: true },
    costUsd: 0.01,
  };
}

const engine: EngineClient = {
  id: "openai",
  label: "openai (fake)",
  async ask() {
    return answer();
  },
};

const noopJudge = async () => ({ judged: 0, flagged: 0, remaining: 0, budgetSpent: false, errors: [] });
const noopEmit = async () => ({ written: 0, considered: 0 });

async function plannedRun(samplesPerPrompt = 3) {
  const tenant = await seedTenant(TENANT);
  await db.insert(aiVisibilitySettings).values({
    tenantId: tenant.id,
    enabled: true,
    engines: ["openai"],
    samplesPerPrompt,
    monthlyCapUsd: 20,
  });
  await db.insert(aiVisibilityPrompts).values({
    tenantId: tenant.id,
    text: "best issue tracker for startups",
    intent: "discovery",
    origin: "generated",
    status: "active",
  });
  const planned = await planRun(tenant.id, { trigger: "manual", now: () => STARTED });
  if (!planned.ok) throw new Error(`planRun refused: ${planned.reason}`);
  return { tenant, runId: planned.runId };
}

/** Puts the run in the state a driver that ran out of budget leaves behind. */
async function makeStalled(runId: string) {
  await db
    .update(aiVisibilityRuns)
    .set({ status: "running", startedAt: STARTED, sliceLeaseUntil: null, sliceLeaseOwner: null })
    .where(eq(aiVisibilityRuns.id, runId));
}

const DRIVE = {
  totalBudgetMs: 240_000,
  sliceBudgetMs: 60_000,
  finalizeMinBudgetMs: 10_000,
  concurrency: 4,
};

function sliceResult(overrides: Partial<RunSliceResult> = {}): RunSliceResult {
  return {
    processed: 1,
    remaining: 1,
    budgetSpent: false,
    pausedByCap: false,
    cancelled: false,
    ...overrides,
  };
}

describe("runIsStalled", () => {
  const base = { status: "running", sliceLeaseUntil: null as Date | null, startedAt: STARTED };

  it("is false for a run somebody is driving", () => {
    expect(runIsStalled({ ...base, sliceLeaseUntil: new Date(NOW.getTime() + 60_000) }, NOW)).toBe(false);
  });

  it("is true once the lease has lapsed", () => {
    expect(runIsStalled({ ...base, sliceLeaseUntil: new Date(NOW.getTime() - 1) }, NOW)).toBe(true);
  });

  it("is true when no lease was ever taken and the grace has passed", () => {
    expect(runIsStalled(base, NOW)).toBe(true);
  });

  it("is false inside the grace — a run planned a second ago has not stalled, it has not started", () => {
    // The window between `planRun` inserting the row and the driver's first
    // `acquireSliceLease`. Without the grace the header flashes "Stalled" at
    // the person who just pressed Run now.
    const justPlanned = { ...base, status: "pending", startedAt: new Date(NOW.getTime() - 1_000) };
    expect(runIsStalled(justPlanned, NOW)).toBe(false);
    expect(runIsStalled({ ...justPlanned, startedAt: new Date(NOW.getTime() - STALL_GRACE_MS - 1) }, NOW)).toBe(true);
  });

  it("is false for a run that is not in flight at all", () => {
    for (const status of ["complete", "failed", "cancelled", "paused_by_cap"]) {
      expect(runIsStalled({ ...base, status }, NOW)).toBe(false);
    }
  });
});

describe("findResumableRun", () => {
  it("refuses when nothing is in flight", async () => {
    const { tenant, runId } = await plannedRun();
    await db.update(aiVisibilityRuns).set({ status: "complete" }).where(eq(aiVisibilityRuns.id, runId));

    expect(await findResumableRun(tenant.id, { now: () => NOW })).toEqual({
      ok: false,
      reason: "not_in_flight",
    });
  });

  it("refuses a run whose lease is live — somebody is already driving it", async () => {
    const { tenant, runId } = await plannedRun();
    await db
      .update(aiVisibilityRuns)
      .set({
        status: "running",
        startedAt: STARTED,
        sliceLeaseUntil: new Date(NOW.getTime() + 60_000),
        sliceLeaseOwner: crypto.randomUUID(),
      })
      .where(eq(aiVisibilityRuns.id, runId));

    expect(await findResumableRun(tenant.id, { now: () => NOW })).toEqual({
      ok: false,
      reason: "lease_held",
    });
  });

  it("hands back the run when the lease is gone", async () => {
    const { tenant, runId } = await plannedRun();
    await makeStalled(runId);

    expect(await findResumableRun(tenant.id, { now: () => NOW })).toEqual({ ok: true, runId });
  });
});

describe("driveRun", () => {
  it("drives a stalled run to completion and finalizes it", async () => {
    const { runId } = await plannedRun();
    await makeStalled(runId);

    await driveRun(runId, { ...DRIVE, now: clock("2026-03-02T12:00:00Z") }, {
      engines: { openai: engine },
      judge: noopJudge,
      emit: noopEmit,
    });

    const rows = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.runId, runId));
    expect(rows.every((row) => row.status === "ok")).toBe(true);
    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
    expect(run.status).toBe("complete");
    // Released, not left held: a completed run must not keep a claim that
    // would make it look driven to anything reading the lease.
    expect(run.sliceLeaseUntil).toBeNull();
  });

  it("stops on a stop, and does NOT finalize it", async () => {
    // A stopped run is already settled by `cancelRun`; finalizing would judge
    // and re-emit it. And its pending samples stay pending forever, so
    // `remaining` never reaches 0 — checking `cancelled` first is what keeps
    // the loop from spinning on a run nobody will ever drive again.
    const { runId } = await plannedRun();
    await makeStalled(runId);
    let slices = 0;
    let finalized = false;

    await driveRun(runId, { ...DRIVE, now: clock("2026-03-02T12:00:00Z") }, {
      slice: async () => {
        slices += 1;
        return sliceResult({ cancelled: true, remaining: 2 });
      },
      finalize: async () => {
        finalized = true;
        return { status: "complete" as const, judged: 0, signals: 0 };
      },
    });

    expect(slices).toBe(1);
    expect(finalized).toBe(false);
  });

  it("stops on a cap pause without finalizing a half-run", async () => {
    const { runId } = await plannedRun();
    await makeStalled(runId);
    let finalized = false;

    await driveRun(runId, { ...DRIVE, now: clock("2026-03-02T12:00:00Z") }, {
      slice: async () => sliceResult({ pausedByCap: true, remaining: 5 }),
      finalize: async () => {
        finalized = true;
        return { status: "complete" as const, judged: 0, signals: 0 };
      },
    });

    expect(finalized).toBe(false);
  });

  it("gives up when the total budget is gone, leaving the run for the sweep", async () => {
    const { runId } = await plannedRun();
    await makeStalled(runId);
    let slices = 0;

    // Each clock read jumps a minute, so the 240s total is spent after a
    // handful of slices however many samples are notionally left.
    await driveRun(runId, { ...DRIVE, now: clock("2026-03-02T12:00:00Z", 60_000) }, {
      slice: async () => {
        slices += 1;
        return sliceResult({ processed: 4, remaining: 40 });
      },
      finalize: async () => {
        throw new Error("must not finalize a run with work left");
      },
    });

    expect(slices).toBeGreaterThan(0);
    expect(slices).toBeLessThan(6);
  });

  it("stops rather than spinning when every remaining row is in backoff", async () => {
    // A slice that hands out nothing while work remains means the whole
    // remaining work list is waiting out a retry backoff. Looping would
    // re-query it as fast as the loop runs for the rest of the 240s.
    const { runId } = await plannedRun();
    await makeStalled(runId);
    let slices = 0;

    await driveRun(runId, { ...DRIVE, now: clock("2026-03-02T12:00:00Z") }, {
      slice: async () => {
        slices += 1;
        return sliceResult({ processed: 0, remaining: 3 });
      },
      finalize: async () => {
        throw new Error("must not finalize a run with work left");
      },
    });

    expect(slices).toBe(1);
  });

  it("swallows a thrown driver failure — it runs inside after(), where a rejection has nowhere to go", async () => {
    const { runId } = await plannedRun();
    await makeStalled(runId);

    await expect(
      driveRun(runId, { ...DRIVE, now: clock("2026-03-02T12:00:00Z") }, {
        slice: async () => {
          throw new Error("database went away");
        },
      })
    ).resolves.toBeUndefined();
  });
});
