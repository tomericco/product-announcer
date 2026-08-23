import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { sources, aiVisibilityRuns, aiVisibilitySettings } from "../../../src/db/schema";
import {
  sweepAiVisibility,
  cadenceDue,
  MIN_SOURCE_BUDGET_MS,
} from "../../../src/lib/ai-visibility/sweep";
import type { PlanRunResult } from "../../../src/lib/ai-visibility/run";
import { seedTenant, dropTenant } from "../../helpers/fixtures";

const TENANT = "AI Visibility Sweep Test Tenant";

afterEach(async () => {
  await dropTenant(TENANT);
});

const clock = (iso: string) => () => new Date(iso);

// 2026-03-02 is a Monday, 2026-03-03 a Tuesday.
const MONDAY = "2026-03-02T09:00:00Z";
const TUESDAY = "2026-03-03T09:00:00Z";

async function seedSource(overrides: Partial<typeof aiVisibilitySettings.$inferInsert> = {}) {
  const tenant = await seedTenant(TENANT);
  const [source] = await db
    .insert(sources)
    .values({ tenantId: tenant.id, type: "ai_visibility", label: "AI visibility" })
    .returning();
  await db.insert(aiVisibilitySettings).values({
    tenantId: tenant.id,
    enabled: true,
    cadence: "weekly",
    dayOfWeek: 1,
    engines: ["openai"],
    samplesPerPrompt: 3,
    monthlyCapUsd: 20,
    ...overrides,
  });
  return { tenant, source };
}

describe("cadenceDue", () => {
  const monday = new Date(MONDAY);

  it("is false when cadence is off, whatever the day", () => {
    expect(cadenceDue({ cadence: "off", dayOfWeek: 1 }, null, monday)).toBe(false);
  });

  it("weekly fires on the configured UTC weekday", () => {
    expect(cadenceDue({ cadence: "weekly", dayOfWeek: 1 }, null, monday)).toBe(true);
    expect(cadenceDue({ cadence: "weekly", dayOfWeek: 2 }, null, monday)).toBe(false);
  });

  it("weekly does not fire twice on the same day", () => {
    expect(cadenceDue({ cadence: "weekly", dayOfWeek: 1 }, new Date("2026-03-02T04:00:00Z"), monday)).toBe(false);
    expect(cadenceDue({ cadence: "weekly", dayOfWeek: 1 }, new Date("2026-02-23T09:00:00Z"), monday)).toBe(true);
  });

  it("fortnightly waits nearly two weeks, and tolerates an early tick", () => {
    expect(cadenceDue({ cadence: "fortnightly", dayOfWeek: 1 }, new Date("2026-02-23T09:00:00Z"), monday)).toBe(false);
    expect(cadenceDue({ cadence: "fortnightly", dayOfWeek: 1 }, new Date("2026-02-16T09:05:00Z"), monday)).toBe(true);
    expect(cadenceDue({ cadence: "fortnightly", dayOfWeek: 1 }, null, monday)).toBe(true);
  });

  it("fortnightly still respects the weekday", () => {
    expect(cadenceDue({ cadence: "fortnightly", dayOfWeek: 2 }, null, monday)).toBe(false);
  });

  // The catch-up arm. Without it the feature promises "a run a week" and
  // delivers "an attempt a week": one cron tick that dies, times out, or is
  // never fired costs the tenant a whole week, and every tenant defaults to
  // dayOfWeek 1, so a truncated Monday is the likeliest tick to lose.
  it("weekly catches up on a later day when the scheduled one was missed", () => {
    const tuesday = new Date(TUESDAY);
    // Ran a week last Monday, then Monday's tick never happened.
    expect(cadenceDue({ cadence: "weekly", dayOfWeek: 1 }, new Date("2026-02-23T09:00:00Z"), tuesday)).toBe(
      true
    );
  });

  it("weekly does not catch up before a whole period, so the schedule cannot drift earlier", () => {
    // Six days after a Monday run is Sunday. A `period - 1` catch-up would fire
    // here, and then five days later, walking the run backwards through the
    // week until it had no relationship to the day the tenant chose.
    const sunday = new Date("2026-03-08T09:05:00Z");
    expect(cadenceDue({ cadence: "weekly", dayOfWeek: 1 }, new Date("2026-03-02T09:00:00Z"), sunday)).toBe(
      false
    );
  });

  it("weekly does not catch up the day after a run it just did", () => {
    const tuesday = new Date(TUESDAY);
    expect(cadenceDue({ cadence: "weekly", dayOfWeek: 1 }, new Date("2026-03-02T09:00:00Z"), tuesday)).toBe(
      false
    );
  });

  it("fortnightly catches up only after a whole fortnight off-weekday", () => {
    const tuesday = new Date(TUESDAY);
    // 15 days: the Monday two weeks on was missed.
    expect(
      cadenceDue({ cadence: "fortnightly", dayOfWeek: 1 }, new Date("2026-02-16T09:00:00Z"), tuesday)
    ).toBe(true);
    // 13 days, off-weekday: the scheduled Monday has not come round yet, and
    // the weekday tolerance is for an early tick ON the day, not for any day.
    expect(
      cadenceDue({ cadence: "fortnightly", dayOfWeek: 1 }, new Date("2026-02-18T09:00:00Z"), tuesday)
    ).toBe(false);
  });

  it("never fires twice in one UTC day, catch-up included", () => {
    // A month overdue, but it already ran at 04:00 today.
    expect(
      cadenceDue(
        { cadence: "weekly", dayOfWeek: 1 },
        new Date("2026-03-03T04:00:00Z"),
        new Date(TUESDAY)
      )
    ).toBe(false);
  });

  it("treats an unknown cadence as weekly for the catch-up, not as never", () => {
    // Not reachable through the sweep — `getAiVisibilitySettingsForTenants`
    // coerces the column first — but `cadenceDue` is exported and takes a bare
    // string, and the fallback decides what a hand-written row does. Weekly is
    // the safe reading: the alternative is a row that can never catch up.
    const tuesday = new Date(TUESDAY);
    expect(
      cadenceDue({ cadence: "hourly", dayOfWeek: 1 }, new Date("2026-02-23T09:00:00Z"), tuesday)
    ).toBe(true);
  });

  it("is false for a cadence nobody can save, rather than firing every day", () => {
    // A hand-written row. `getAiVisibilitySettings` coerces it before the sweep
    // ever sees it; this is the belt to that braces.
    expect(cadenceDue({ cadence: "off", dayOfWeek: 2 }, new Date("2026-01-01T00:00:00Z"), monday)).toBe(
      false
    );
  });
});

// NOTE: this sweep reads the whole shared test database, and other test files
// (`run.test.ts`, `signals.test.ts`, `settings.test.ts`, `prompts.test.ts`)
// insert `ai_visibility` sources and in-flight runs concurrently. Every
// assertion below is therefore scoped to ids this test created — never to a raw
// call count — which is the rule `tests/lib/signals/news-sweep.test.ts` sets for
// exactly the same reason. And every foreign candidate the sweep picks up is
// answered with a plan that makes the sweep write nothing, so this file cannot
// clobber another file's source rows either.
const FOREIGN_RUN = "foreign-run";

/** The answer a tenant this test did not create gets: a run that writes nothing. */
const FOREIGN_PLAN: PlanRunResult = {
  ok: true,
  runId: FOREIGN_RUN,
  plannedCalls: 0,
  estimateUsd: 0,
};

/** A `plan` that answers `tenantId` with `result` and everyone else harmlessly. */
function planOnly(tenantId: string, result: PlanRunResult) {
  return vi.fn(async (id: string): Promise<PlanRunResult> => (id === tenantId ? result : FOREIGN_PLAN));
}

/** A `slice` that always reports work left, so nothing reaches `finalize`. */
const idleSlice = () =>
  vi.fn().mockResolvedValue({ processed: 0, remaining: 1, budgetSpent: true, pausedByCap: false, cancelled: false });

/** The calls whose subject (tenant id or run id) is one this test created. */
const mine = (calls: unknown[][], id: string) => calls.filter((call) => call[0] === id);

describe("sweepAiVisibility", () => {
  it("starts a run when the cadence is due, then slices and finalizes it", async () => {
    const { tenant } = await seedSource();
    const plan = planOnly(tenant.id, { ok: true, runId: "run-1", plannedCalls: 3, estimateUsd: 0.03 });
    const slice = vi.fn().mockResolvedValue({ processed: 3, remaining: 0, budgetSpent: false, pausedByCap: false, cancelled: false });
    const finalize = vi.fn().mockResolvedValue({ status: "complete", judged: 3, signals: 1 });

    await sweepAiVisibility({ now: clock(MONDAY), plan, slice, finalize });

    const planned = mine(plan.mock.calls, tenant.id);
    expect(planned).toHaveLength(1);
    expect(planned[0][1]).toMatchObject({ trigger: "scheduled" });
    expect(mine(slice.mock.calls, "run-1")).toHaveLength(1);
    expect(mine(finalize.mock.calls, "run-1")).toHaveLength(1);
  });

  it("does nothing on a day the cadence does not fall on", async () => {
    const { tenant } = await seedSource();
    const plan = planOnly(tenant.id, { ok: true, runId: "run-1", plannedCalls: 3, estimateUsd: 0.03 });
    const slice = idleSlice();

    await sweepAiVisibility({ now: clock(TUESDAY), plan, slice, finalize: vi.fn() });

    // Nothing planned for this tenant, so nothing of ours could reach the slice.
    expect(mine(plan.mock.calls, tenant.id)).toHaveLength(0);
    expect(mine(slice.mock.calls, "run-1")).toHaveLength(0);
  });

  it("resumes an in-flight run instead of planning a new one, on any day", async () => {
    const { tenant, source } = await seedSource();
    const [run] = await db
      .insert(aiVisibilityRuns)
      .values({
        tenantId: tenant.id,
        sourceId: source.id,
        trigger: "scheduled",
        engines: ["openai"],
        samplesPerPrompt: 3,
        status: "running",
      })
      .returning();
    const plan = planOnly(tenant.id, { ok: true, runId: "run-1", plannedCalls: 3, estimateUsd: 0.03 });
    const slice = vi.fn().mockResolvedValue({ processed: 10, remaining: 0, budgetSpent: false, pausedByCap: false, cancelled: false });
    const finalize = vi.fn().mockResolvedValue({ status: "complete", judged: 0, signals: 0 });

    await sweepAiVisibility({ now: clock(TUESDAY), plan, slice, finalize });

    expect(mine(plan.mock.calls, tenant.id)).toHaveLength(0);
    expect(mine(slice.mock.calls, run.id)).toHaveLength(1);
    expect(mine(finalize.mock.calls, run.id)).toHaveLength(1);
  });

  it("does not finalize a run that still has pending samples", async () => {
    const { tenant, source } = await seedSource();
    const [run] = await db
      .insert(aiVisibilityRuns)
      .values({
        tenantId: tenant.id,
        sourceId: source.id,
        trigger: "scheduled",
        engines: ["openai"],
        samplesPerPrompt: 3,
        status: "running",
      })
      .returning();
    const slice = vi.fn().mockResolvedValue({ processed: 5, remaining: 40, budgetSpent: true, pausedByCap: false, cancelled: false });
    const finalize = vi.fn();

    await sweepAiVisibility({
      now: clock(TUESDAY),
      plan: planOnly(tenant.id, FOREIGN_PLAN),
      slice,
      finalize,
    });

    expect(mine(slice.mock.calls, run.id)).toHaveLength(1);
    expect(mine(finalize.mock.calls, run.id)).toHaveLength(0);
  });

  it("does not finalize a run the cap paused", async () => {
    const { tenant, source } = await seedSource();
    const [run] = await db
      .insert(aiVisibilityRuns)
      .values({
        tenantId: tenant.id,
        sourceId: source.id,
        trigger: "scheduled",
        engines: ["openai"],
        samplesPerPrompt: 3,
        status: "running",
      })
      .returning();
    const slice = vi.fn().mockResolvedValue({ processed: 5, remaining: 40, budgetSpent: false, pausedByCap: true, cancelled: false });
    const finalize = vi.fn();

    await sweepAiVisibility({
      now: clock(TUESDAY),
      plan: planOnly(tenant.id, FOREIGN_PLAN),
      slice,
      finalize,
    });

    expect(mine(slice.mock.calls, run.id)).toHaveLength(1);
    expect(mine(finalize.mock.calls, run.id)).toHaveLength(0);
  });

  it("records a cap refusal on the source instead of silently skipping", async () => {
    const { tenant } = await seedSource();
    const plan = planOnly(tenant.id, {
      ok: false,
      reason: "cap_reached",
      spentUsd: 20,
      estimateUsd: 3,
      capUsd: 20,
    });

    await sweepAiVisibility({ now: clock(MONDAY), plan, slice: idleSlice(), finalize: vi.fn() });

    const [source] = await db
      .select()
      .from(sources)
      .where(and(eq(sources.tenantId, tenant.id), eq(sources.type, "ai_visibility")));
    expect(source.status).toBe("failing");
    expect(source.lastError).toContain("monthly cap");
    // A refusal is recorded but must NOT re-anchor the cadence: `lastRunAt`
    // is what the fortnight-elapsed test measures from, and only real runs
    // move it. A stamped refusal would make a cap-refused fortnightly tenant
    // re-wait 13 days after the month resets.
    expect(source.lastRunAt).toBeNull();
  });

  it("records a disabled or empty prompt set on the source without failing the sweep", async () => {
    const { tenant } = await seedSource();
    const plan = planOnly(tenant.id, { ok: false, reason: "no_prompts" });

    await sweepAiVisibility({ now: clock(MONDAY), plan, slice: idleSlice(), finalize: vi.fn() });

    const [source] = await db
      .select()
      .from(sources)
      .where(and(eq(sources.tenantId, tenant.id), eq(sources.type, "ai_visibility")));
    expect(source.lastError).toContain("prompt");
  });

  it("skips disabled sources entirely", async () => {
    const { tenant } = await seedSource();
    await db.update(sources).set({ status: "disabled" }).where(eq(sources.tenantId, tenant.id));
    const plan = planOnly(tenant.id, { ok: true, runId: "run-1", plannedCalls: 3, estimateUsd: 0.03 });

    await sweepAiVisibility({ now: clock(MONDAY), plan, slice: idleSlice(), finalize: vi.fn() });

    expect(mine(plan.mock.calls, tenant.id)).toHaveLength(0);
  });

  it("includes failing sources so a recovered tenant is picked up again", async () => {
    const { tenant } = await seedSource();
    await db.update(sources).set({ status: "failing" }).where(eq(sources.tenantId, tenant.id));
    const plan = planOnly(tenant.id, { ok: true, runId: "run-1", plannedCalls: 3, estimateUsd: 0.03 });

    await sweepAiVisibility({
      now: clock(MONDAY),
      plan,
      slice: vi.fn().mockResolvedValue({ processed: 3, remaining: 0, budgetSpent: false, pausedByCap: false, cancelled: false }),
      finalize: vi.fn().mockResolvedValue({ status: "complete", judged: 0, signals: 0 }),
    });

    expect(mine(plan.mock.calls, tenant.id)).toHaveLength(1);
  });

  it("never throws when one source blows up, and keeps going", async () => {
    await seedSource();
    const plan = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(
      sweepAiVisibility({ now: clock(MONDAY), plan, slice: vi.fn(), finalize: vi.fn() })
    ).resolves.toBeUndefined();
  });

  it("splits the budget across sources so one tenant cannot starve the rest", async () => {
    const { tenant: first } = await seedSource();
    // A second tenant under the same cleanup name — dropTenant removes both.
    const second = await seedTenant(TENANT);
    await db.insert(sources).values({ tenantId: second.id, type: "ai_visibility", label: "AI visibility" });
    await db.insert(aiVisibilitySettings).values({
      tenantId: second.id,
      enabled: true,
      cadence: "weekly",
      dayOfWeek: 1,
      engines: ["openai"],
      samplesPerPrompt: 3,
      monthlyCapUsd: 20,
    });

    // A run id per tenant, so the slice calls this test made can be told apart
    // from the ones a concurrently-seeded tenant made.
    const plan = vi.fn(async (id: string): Promise<PlanRunResult> => ({
      ok: true,
      runId: `run-${id}`,
      plannedCalls: 3,
      estimateUsd: 0.03,
    }));
    const slice = vi.fn().mockResolvedValue({ processed: 3, remaining: 0, budgetSpent: false, pausedByCap: false, cancelled: false });

    await sweepAiVisibility({
      now: clock(MONDAY),
      budgetMs: 100_000,
      plan,
      slice,
      finalize: vi.fn().mockResolvedValue({ status: "complete", judged: 0, signals: 0 }),
    });

    expect(first.id).not.toBe(second.id);
    expect(mine(plan.mock.calls, first.id)).toHaveLength(1);
    expect(mine(plan.mock.calls, second.id)).toHaveLength(1);
    const ourSlices = [
      ...mine(slice.mock.calls, `run-${first.id}`),
      ...mine(slice.mock.calls, `run-${second.id}`),
    ];
    expect(ourSlices).toHaveLength(2);
    for (const call of ourSlices) {
      // Two candidates at a 100s budget is 50s each; a third tenant seeded by
      // another file only makes each share smaller, never larger.
      const opts = call[1] as { budgetMs: number };
      expect(opts.budgetMs).toBeLessThanOrEqual(50_000);
      expect(opts.budgetMs).toBeGreaterThan(0);
    }
  });

  it("orders candidates never-run first, then least-recently-run", async () => {
    const { tenant: recent } = await seedSource();
    await db
      .update(sources)
      .set({ lastRunAt: new Date("2026-03-01T09:00:00Z") })
      .where(eq(sources.tenantId, recent.id));

    const never = await seedTenant(TENANT);
    await db.insert(sources).values({ tenantId: never.id, type: "ai_visibility", label: "AI visibility" });
    await db.insert(aiVisibilitySettings).values({
      tenantId: never.id,
      enabled: true,
      cadence: "weekly",
      dayOfWeek: 1,
      engines: ["openai"],
      samplesPerPrompt: 3,
      monthlyCapUsd: 20,
    });

    const seen: string[] = [];
    const plan = vi.fn(async (tenantId: string): Promise<PlanRunResult> => {
      seen.push(tenantId);
      if (tenantId !== never.id && tenantId !== recent.id) return FOREIGN_PLAN;
      return { ok: false, reason: "no_prompts" };
    });

    await sweepAiVisibility({ now: clock(MONDAY), plan, slice: idleSlice(), finalize: vi.fn() });

    // Relative order, not absolute position: a tenant another file seeded a
    // moment ago has a null `lastRunAt` too and sorts in among ours.
    expect(seen.filter((id) => id === never.id || id === recent.id)).toEqual([never.id, recent.id]);
  });

  it("leaves a source that is not due out of the work list entirely", async () => {
    // Not due (Tuesday's tenant on a Monday) and not in flight, so it is not a
    // worker — which is also what keeps it out of the budget divisor, since the
    // divisor IS this list.
    const { tenant } = await seedSource({ dayOfWeek: 2 });
    const due = await seedTenant(TENANT);
    await db.insert(sources).values({ tenantId: due.id, type: "ai_visibility", label: "AI visibility" });
    await db.insert(aiVisibilitySettings).values({
      tenantId: due.id,
      enabled: true,
      cadence: "weekly",
      dayOfWeek: 1,
      engines: ["openai"],
      samplesPerPrompt: 3,
      monthlyCapUsd: 20,
    });
    const plan = vi.fn(async (id: string): Promise<PlanRunResult> => ({
      ok: true,
      runId: `run-${id}`,
      plannedCalls: 3,
      estimateUsd: 0.03,
    }));
    const slice = vi.fn().mockResolvedValue({ processed: 3, remaining: 0, budgetSpent: false, pausedByCap: false, cancelled: false });

    await sweepAiVisibility({
      now: clock(MONDAY),
      plan,
      slice,
      finalize: vi.fn().mockResolvedValue({ status: "complete", judged: 0, signals: 0 }),
    });

    expect(mine(plan.mock.calls, tenant.id)).toHaveLength(0);
    expect(mine(slice.mock.calls, `run-${tenant.id}`)).toHaveLength(0);
    expect(mine(plan.mock.calls, due.id)).toHaveLength(1);
  });

  it("skips a source whose settings row is missing rather than treating it as enabled", async () => {
    const tenant = await seedTenant(TENANT);
    await db.insert(sources).values({ tenantId: tenant.id, type: "ai_visibility", label: "AI visibility" });
    const plan = planOnly(tenant.id, { ok: true, runId: "run-1", plannedCalls: 3, estimateUsd: 0.03 });

    await sweepAiVisibility({ now: clock(MONDAY), plan, slice: idleSlice(), finalize: vi.fn() });

    expect(mine(plan.mock.calls, tenant.id)).toHaveLength(0);
  });

  it("stops at its deadline instead of running until the platform kills it", async () => {
    await seedSource();
    await seedSource();
    // Every slice burns a minute of a ten-second tick, so whoever goes first is
    // the only one who goes at all. A global count is safe to assert here for
    // once: however many tenants another file seeded, exactly one slice fits.
    let elapsedMs = 0;
    const now = () => new Date(new Date(MONDAY).getTime() + elapsedMs);
    const slice = vi.fn(async () => {
      elapsedMs += 60_000;
      return { processed: 3, remaining: 0, budgetSpent: false, pausedByCap: false, cancelled: false };
    });

    await sweepAiVisibility({
      now,
      budgetMs: 10_000,
      plan: vi.fn(async (id: string): Promise<PlanRunResult> => ({
        ok: true,
        runId: `run-${id}`,
        plannedCalls: 3,
        estimateUsd: 0.03,
      })),
      slice,
      finalize: vi.fn().mockResolvedValue({ status: "complete", judged: 0, signals: 0 }),
    });

    expect(slice).toHaveBeenCalledTimes(1);
  });

  it("never hands a source more time than the tick has left", async () => {
    const { tenant } = await seedSource();
    const slice = vi.fn().mockResolvedValue({ processed: 3, remaining: 0, budgetSpent: false, pausedByCap: false, cancelled: false });

    await sweepAiVisibility({
      now: clock(MONDAY),
      // Below MIN_SOURCE_BUDGET_MS, so the floor and the deadline disagree and
      // the deadline has to win.
      budgetMs: 1_000,
      plan: planOnly(tenant.id, { ok: true, runId: "run-1", plannedCalls: 3, estimateUsd: 0.03 }),
      slice,
      finalize: vi.fn().mockResolvedValue({ status: "complete", judged: 0, signals: 0 }),
    });

    const [call] = mine(slice.mock.calls, "run-1");
    expect((call[1] as { budgetMs: number }).budgetMs).toBeLessThanOrEqual(1_000);
  });

  it("resumes the run a plan-time race refuses, instead of painting the source red", async () => {
    const { tenant, source } = await seedSource();
    let raced: string | null = null;
    // The race this covers: classification found no in-flight run (there was
    // none), and a manual "Run now" started one before `planRun` was reached.
    // The refusal carries the run id, and the slice lease makes driving it
    // safe — so it is resumed, not written into the health block as an error a
    // user would find there a week later.
    const plan = vi.fn(async (id: string): Promise<PlanRunResult> => {
      if (id !== tenant.id) return FOREIGN_PLAN;
      const [run] = await db
        .insert(aiVisibilityRuns)
        .values({
          tenantId: tenant.id,
          sourceId: source.id,
          trigger: "manual",
          engines: ["openai"],
          samplesPerPrompt: 3,
          status: "running",
        })
        .returning();
      raced = run.id;
      return { ok: false, reason: "run_in_flight", runId: run.id };
    });
    const slice = vi.fn().mockResolvedValue({ processed: 1, remaining: 3, budgetSpent: true, pausedByCap: false, cancelled: false });

    await sweepAiVisibility({ now: clock(MONDAY), plan, slice, finalize: vi.fn() });

    expect(raced).not.toBeNull();
    expect(mine(slice.mock.calls, raced as unknown as string)).toHaveLength(1);
    const [row] = await db
      .select()
      .from(sources)
      .where(and(eq(sources.tenantId, tenant.id), eq(sources.type, "ai_visibility")));
    expect(row.lastError).toBeNull();
    expect(row.status).toBe("active");
  });

  it("does not resurrect a source a human disabled while the sweep was running", async () => {
    const { tenant } = await seedSource();
    const plan = vi.fn(async (id: string): Promise<PlanRunResult> => {
      if (id !== tenant.id) return FOREIGN_PLAN;
      // The window this guards: classification read `status: "active"`, and a
      // human turns the feature off before the refusal is recorded. Echoing the
      // status read earlier would flip it back to active.
      await db.update(sources).set({ status: "disabled" }).where(eq(sources.tenantId, tenant.id));
      return { ok: false, reason: "no_prompts" };
    });

    await sweepAiVisibility({ now: clock(MONDAY), plan, slice: idleSlice(), finalize: vi.fn() });

    const [row] = await db
      .select()
      .from(sources)
      .where(and(eq(sources.tenantId, tenant.id), eq(sources.type, "ai_visibility")));
    expect(row.status).toBe("disabled");
    expect(row.lastError).toContain("prompt");
  });
});

describe("the budget knobs", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function reload() {
    vi.resetModules();
    return import("../../../src/lib/ai-visibility/sweep");
  }

  it("falls back to the default when a knob is malformed", async () => {
    // `Number("12s")` is NaN, `Math.max(5_000, NaN)` is NaN, and
    // `elapsed >= NaN` is false forever — the budget would silently stop
    // existing and one slice would run the whole work list in one invocation.
    vi.stubEnv("AI_VISIBILITY_SWEEP_BUDGET_MS", "12s");
    vi.stubEnv("AI_VISIBILITY_CONCURRENCY", "");
    const mod = await reload();
    expect(mod.SWEEP_BUDGET_MS).toBe(120_000);
    expect(mod.SWEEP_CONCURRENCY).toBe(12);
  });

  it("falls back when a knob is zero or negative", async () => {
    vi.stubEnv("AI_VISIBILITY_SWEEP_BUDGET_MS", "0");
    vi.stubEnv("AI_VISIBILITY_CONCURRENCY", "-4");
    const mod = await reload();
    expect(mod.SWEEP_BUDGET_MS).toBe(120_000);
    expect(mod.SWEEP_CONCURRENCY).toBe(12);
  });

  it("uses a value that parses", async () => {
    vi.stubEnv("AI_VISIBILITY_SWEEP_BUDGET_MS", "45000");
    vi.stubEnv("AI_VISIBILITY_CONCURRENCY", "20");
    const mod = await reload();
    expect(mod.SWEEP_BUDGET_MS).toBe(45_000);
    expect(mod.SWEEP_CONCURRENCY).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// The review fixes: the budget divisor, the deadline clamp, the resume-before-
// cadence rule, and the two failure paths that must never reject the cron
// handler. Same scoping rule as above — assertions filter to ids this test
// created, and every foreign candidate is answered with `FOREIGN_PLAN`.
// ---------------------------------------------------------------------------

/** A due, enabled tenant of ours, with its own `ai_visibility` source. */
async function seedRunningRun(tenantId: string, sourceId: string) {
  const [run] = await db
    .insert(aiVisibilityRuns)
    .values({
      tenantId,
      sourceId,
      trigger: "scheduled",
      engines: ["openai"],
      samplesPerPrompt: 3,
      status: "running",
    })
    .returning();
  return run;
}

/** A plan that answers every tenant of ours with its own run id. */
const planPerTenant = () =>
  vi.fn(
    async (id: string): Promise<PlanRunResult> => ({
      ok: true,
      runId: `run-${id}`,
      plannedCalls: 3,
      estimateUsd: 0.03,
    })
  );

const drainedSlice = () =>
  vi.fn().mockResolvedValue({ processed: 3, remaining: 0, budgetSpent: false, pausedByCap: false, cancelled: false });

const completeFinalize = () =>
  vi.fn().mockResolvedValue({ status: "complete", judged: 0, signals: 0 });

describe("sweepAiVisibility — the tick's ceiling", () => {
  it("divides the budget by the sources that will do work, not by every row", async () => {
    // Two workers of ours: one due today, and one holding an in-flight run
    // whose cadence would never fire on its own. Fourteen rows of ours that
    // will do nothing: not due, `off`, and the feature switched off.
    //
    // Every tenant defaults to `dayOfWeek = 1`, so the ordinary Monday is the
    // day they are ALL due and the ordinary Tuesday the day none are. A
    // divisor counting rows rather than work would size Monday's share for a
    // week in which nobody runs.
    const { tenant: due } = await seedSource();
    const { tenant: resumed, source: resumedSource } = await seedSource({ cadence: "off" });
    const resumedRun = await seedRunningRun(resumed.id, resumedSource.id);
    const { tenant: notDue } = await seedSource({ dayOfWeek: 2 });
    const { tenant: off } = await seedSource({ cadence: "off" });
    const { tenant: switchedOff } = await seedSource({ enabled: false });
    for (let i = 0; i < 11; i += 1) await seedSource({ dayOfWeek: 2 });
    // 2 workers, 16 candidates — ours alone.
    const OUR_CANDIDATES = 16;
    const BUDGET_MS = 1_000_000;

    const plan = planPerTenant();
    const slice = drainedSlice();

    await sweepAiVisibility({
      now: clock(MONDAY),
      budgetMs: BUDGET_MS,
      plan,
      slice,
      finalize: completeFinalize(),
    });

    expect(mine(plan.mock.calls, due.id)).toHaveLength(1);
    for (const idle of [notDue, off, switchedOff, resumed]) {
      // `resumed` included: an in-flight run is driven, never re-planned.
      expect(mine(plan.mock.calls, idle.id)).toHaveLength(0);
    }
    const ourSlices = [
      ...mine(slice.mock.calls, `run-${due.id}`),
      ...mine(slice.mock.calls, resumedRun.id),
    ];
    expect(ourSlices).toHaveLength(2);
    for (const call of ourSlices) {
      const { budgetMs } = call[1] as { budgetMs: number };
      // Dividing by the candidate list could not exceed this, however few
      // tenants another file seeded; dividing by the work list cannot fall
      // below it unless a dozen foreign tenants are due in this same instant.
      expect(budgetMs).toBeGreaterThan(BUDGET_MS / OUR_CANDIDATES);
      // Two workers of ours, so no share can be more than half the tick.
      expect(budgetMs).toBeLessThanOrEqual(BUDGET_MS / 2);
    }
  });

  it("clamps a later source's share to the time the tick actually has left", async () => {
    // First one burns almost the whole tick. The second is still worth
    // starting — there is time left — but only with the time that is left, not
    // with the share the divisor promised it.
    const { tenant: first } = await seedSource();
    const { tenant: second } = await seedSource();
    await db
      .update(sources)
      .set({ lastRunAt: new Date("2026-02-23T09:00:00Z") })
      .where(eq(sources.tenantId, second.id));

    let elapsedMs = 0;
    const now = () => new Date(new Date(MONDAY).getTime() + elapsedMs);
    const slice = vi.fn(async (runId: string) => {
      // Only ours moves the clock, so a foreign tenant sliced in between
      // cannot change the arithmetic this asserts.
      if (runId === `run-${first.id}`) elapsedMs += 90_000;
      return { processed: 3, remaining: 0, budgetSpent: false, pausedByCap: false, cancelled: false };
    });

    await sweepAiVisibility({
      now,
      budgetMs: 100_000,
      plan: planPerTenant(),
      slice,
      finalize: completeFinalize(),
    });

    // `lastRunAt ASC NULLS FIRST`: the never-run tenant goes first.
    const [firstCall] = mine(slice.mock.calls, `run-${first.id}`);
    const [secondCall] = mine(slice.mock.calls, `run-${second.id}`);
    expect(firstCall).toBeDefined();
    expect(secondCall).toBeDefined();
    expect((secondCall[1] as { budgetMs: number }).budgetMs).toBeLessThanOrEqual(10_000);
  });

  it("hands finalize what this source's own budget has left, floored", async () => {
    const { tenant } = await seedSource();
    let elapsedMs = 0;
    const now = () => new Date(new Date(MONDAY).getTime() + elapsedMs);
    const slice = vi.fn(async (runId: string) => {
      if (runId === "run-1") elapsedMs += 20_000;
      return { processed: 3, remaining: 0, budgetSpent: false, pausedByCap: false, cancelled: false };
    });
    const finalize = completeFinalize();

    await sweepAiVisibility({
      now,
      // Large enough that no foreign tenant sliced before ours can push the
      // deadline into this assertion.
      budgetMs: 1_000_000,
      plan: planOnly(tenant.id, { ok: true, runId: "run-1", plannedCalls: 3, estimateUsd: 0.03 }),
      slice,
      finalize,
    });

    const sliceBudget = (mine(slice.mock.calls, "run-1")[0][1] as { budgetMs: number }).budgetMs;
    const [finalizeCall] = mine(finalize.mock.calls, "run-1");
    // Whatever the share was, finalize gets it MINUS what the slice spent —
    // the two together are one source's budget, not two.
    expect((finalizeCall[1] as { budgetMs: number }).budgetMs).toBe(
      Math.max(MIN_SOURCE_BUDGET_MS, sliceBudget - 20_000)
    );
  });
});

describe("sweepAiVisibility — resuming, refusing, and surviving", () => {
  it("resumes an in-flight run for a tenant whose cadence would never fire", async () => {
    // The in-flight check comes BEFORE the settings lookup on purpose: the run
    // was already authorised and paid for, and a tenant who switched the
    // feature off mid-run would otherwise leave the dashboard showing a
    // permanent "Running…" with nothing able to close it out.
    const { tenant, source } = await seedSource({ enabled: false, cadence: "off" });
    const run = await seedRunningRun(tenant.id, source.id);
    const plan = planOnly(tenant.id, { ok: true, runId: "run-1", plannedCalls: 3, estimateUsd: 0.03 });
    const slice = vi.fn().mockResolvedValue({ processed: 1, remaining: 9, budgetSpent: true, pausedByCap: false, cancelled: false });

    await sweepAiVisibility({ now: clock(TUESDAY), plan, slice, finalize: vi.fn() });

    expect(mine(plan.mock.calls, tenant.id)).toHaveLength(0);
    expect(mine(slice.mock.calls, run.id)).toHaveLength(1);
  });

  it("records the `disabled` refusal in words a user can act on", async () => {
    const { tenant } = await seedSource();
    const plan = planOnly(tenant.id, { ok: false, reason: "disabled" });

    await sweepAiVisibility({ now: clock(MONDAY), plan, slice: idleSlice(), finalize: vi.fn() });

    const [row] = await db
      .select()
      .from(sources)
      .where(and(eq(sources.tenantId, tenant.id), eq(sources.type, "ai_visibility")));
    expect(row.lastError).toContain("turned off");
    // Only the cap paints a source red; everything else keeps its status and
    // just explains itself in the health block.
    expect(row.status).toBe("active");
    expect(row.lastRunAt).toBeNull();
  });

  it("keeps sweeping the sources after the one that blew up", async () => {
    // The try/catch is per source, not around the loop. One tenant's broken
    // run must cost that tenant a tick, not cost every tenant behind it a week.
    const { tenant: broken } = await seedSource();
    const { tenant: healthy } = await seedSource();
    await db
      .update(sources)
      .set({ lastRunAt: new Date("2026-02-23T09:00:00Z") })
      .where(eq(sources.tenantId, healthy.id));

    const plan = vi.fn(async (id: string): Promise<PlanRunResult> => {
      // `lastRunAt ASC NULLS FIRST` puts `broken` first.
      if (id === broken.id) throw new Error("boom");
      if (id !== healthy.id) return FOREIGN_PLAN;
      return { ok: true, runId: `run-${healthy.id}`, plannedCalls: 3, estimateUsd: 0.03 };
    });
    const slice = drainedSlice();

    await expect(
      sweepAiVisibility({
        now: clock(MONDAY),
        plan,
        slice,
        finalize: completeFinalize(),
      })
    ).resolves.toBeUndefined();

    expect(mine(plan.mock.calls, broken.id)).toHaveLength(1);
    expect(mine(slice.mock.calls, `run-${healthy.id}`)).toHaveLength(1);
  });

  it("does not finalize a run the cap paused on its last batch", async () => {
    // `remaining: 0` AND `pausedByCap: true` together is reachable, not a
    // contradiction: `runSlice` re-checks the cap at the TOP of each iteration,
    // so a final batch that drains the work list and tips the month over the
    // cap breaks out with nothing pending and the pause set. Finalizing there
    // would spend judge tokens on a run the cap stopped on purpose —
    // `finalizeRun` refuses a `paused_by_cap` run itself, and this is the
    // caller-side half of that same rule.
    const { tenant, source } = await seedSource();
    const run = await seedRunningRun(tenant.id, source.id);
    const slice = vi
      .fn()
      .mockResolvedValue({ processed: 12, remaining: 0, budgetSpent: false, pausedByCap: true, cancelled: false });
    const finalize = vi.fn();

    await sweepAiVisibility({
      now: clock(TUESDAY),
      plan: planOnly(tenant.id, FOREIGN_PLAN),
      slice,
      finalize,
    });

    expect(mine(slice.mock.calls, run.id)).toHaveLength(1);
    expect(mine(finalize.mock.calls, run.id)).toHaveLength(0);
  });

  it.each(["complete", "running", "paused_by_cap", "failed"] as const)(
    "leaves the source alone whatever finalize reports (%s)",
    async (status) => {
      // `finalizeRun` is resumable and records its own failures on the run.
      // The sweep reads none of its arms, and must not invent a second opinion
      // about them in the source's health block.
      const { tenant } = await seedSource();
      const finalize = vi.fn().mockResolvedValue({ status, judged: 0, signals: 0 });

      await sweepAiVisibility({
        now: clock(MONDAY),
        plan: planOnly(tenant.id, { ok: true, runId: "run-1", plannedCalls: 3, estimateUsd: 0.03 }),
        slice: drainedSlice(),
        finalize,
      });

      expect(mine(finalize.mock.calls, "run-1")).toHaveLength(1);
      const [row] = await db
        .select()
        .from(sources)
        .where(and(eq(sources.tenantId, tenant.id), eq(sources.type, "ai_visibility")));
      expect(row.status).toBe("active");
      expect(row.lastError).toBeNull();
    }
  );
});

describe("sweepAiVisibility — a database that is down", () => {
  // A throw out of either query would reject the cron handler, and every step
  // that ran BEFORE this one (delivery retries, three signal sweeps) would be
  // reported as a failed invocation while brief expiry and ideation never run
  // at all. Both are logged and returned from instead.
  let errors: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errors.mockRestore();
  });

  it("returns instead of throwing when the candidate query fails", async () => {
    const database = {
      select: () => ({
        from: () => ({
          where: () => ({ orderBy: () => Promise.reject(new Error("connection terminated")) }),
        }),
      }),
    } as never;
    const plan = vi.fn();

    await expect(
      sweepAiVisibility({ database, now: clock(MONDAY), plan, slice: vi.fn(), finalize: vi.fn() })
    ).resolves.toBeUndefined();

    expect(plan).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalled();
  });

  it("returns instead of throwing when classifying the candidates fails", async () => {
    let selects = 0;
    const database = {
      select: () => {
        selects += 1;
        // 1: the candidate list. 2: the in-flight runs, which is where a
        // connection dropped between the two queries surfaces.
        if (selects === 1) {
          return {
            from: () => ({
              where: () => ({
                orderBy: async () => [{ id: "source-1", tenantId: "tenant-1", lastRunAt: null }],
              }),
            }),
          };
        }
        return { from: () => ({ where: async () => Promise.reject(new Error("connection terminated")) }) };
      },
    } as never;
    const plan = vi.fn();

    await expect(
      sweepAiVisibility({ database, now: clock(MONDAY), plan, slice: vi.fn(), finalize: vi.fn() })
    ).resolves.toBeUndefined();

    expect(plan).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalled();
  });
});
