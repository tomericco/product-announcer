import { describe, it, expect, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { sources, aiVisibilityRuns, aiVisibilitySettings } from "../../../src/db/schema";
import { sweepAiVisibility, cadenceDue } from "../../../src/lib/ai-visibility/sweep";
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
});

describe("sweepAiVisibility", () => {
  it("starts a run when the cadence is due, then slices and finalizes it", async () => {
    const { tenant } = await seedSource();
    const plan = vi.fn().mockResolvedValue({ ok: true, runId: "run-1", plannedCalls: 3, estimateUsd: 0.03 });
    const slice = vi.fn().mockResolvedValue({ processed: 3, remaining: 0, budgetSpent: false, pausedByCap: false });
    const finalize = vi.fn().mockResolvedValue({ status: "complete", judged: 3, signals: 1 });

    await sweepAiVisibility({ now: clock(MONDAY), plan, slice, finalize });

    expect(plan).toHaveBeenCalledTimes(1);
    expect(plan.mock.calls[0][0]).toBe(tenant.id);
    expect(plan.mock.calls[0][1]).toMatchObject({ trigger: "scheduled" });
    expect(slice).toHaveBeenCalledTimes(1);
    expect(slice.mock.calls[0][0]).toBe("run-1");
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("does nothing on a day the cadence does not fall on", async () => {
    await seedSource();
    const plan = vi.fn();
    const slice = vi.fn();

    await sweepAiVisibility({ now: clock(TUESDAY), plan, slice, finalize: vi.fn() });

    expect(plan).not.toHaveBeenCalled();
    expect(slice).not.toHaveBeenCalled();
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
    const plan = vi.fn();
    const slice = vi.fn().mockResolvedValue({ processed: 10, remaining: 0, budgetSpent: false, pausedByCap: false });
    const finalize = vi.fn().mockResolvedValue({ status: "complete", judged: 0, signals: 0 });

    await sweepAiVisibility({ now: clock(TUESDAY), plan, slice, finalize });

    expect(plan).not.toHaveBeenCalled();
    expect(slice.mock.calls[0][0]).toBe(run.id);
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("does not finalize a run that still has pending samples", async () => {
    const { tenant, source } = await seedSource();
    await db.insert(aiVisibilityRuns).values({
      tenantId: tenant.id,
      sourceId: source.id,
      trigger: "scheduled",
      engines: ["openai"],
      samplesPerPrompt: 3,
      status: "running",
    });
    const slice = vi.fn().mockResolvedValue({ processed: 5, remaining: 40, budgetSpent: true, pausedByCap: false });
    const finalize = vi.fn();

    await sweepAiVisibility({ now: clock(TUESDAY), plan: vi.fn(), slice, finalize });

    expect(finalize).not.toHaveBeenCalled();
  });

  it("does not finalize a run the cap paused", async () => {
    const { tenant, source } = await seedSource();
    await db.insert(aiVisibilityRuns).values({
      tenantId: tenant.id,
      sourceId: source.id,
      trigger: "scheduled",
      engines: ["openai"],
      samplesPerPrompt: 3,
      status: "running",
    });
    const slice = vi.fn().mockResolvedValue({ processed: 5, remaining: 40, budgetSpent: false, pausedByCap: true });
    const finalize = vi.fn();

    await sweepAiVisibility({ now: clock(TUESDAY), plan: vi.fn(), slice, finalize });

    expect(finalize).not.toHaveBeenCalled();
  });

  it("records a cap refusal on the source instead of silently skipping", async () => {
    const { tenant } = await seedSource();
    const plan = vi.fn().mockResolvedValue({
      ok: false,
      reason: "cap_reached",
      spentUsd: 20,
      estimateUsd: 3,
      capUsd: 20,
    });

    await sweepAiVisibility({ now: clock(MONDAY), plan, slice: vi.fn(), finalize: vi.fn() });

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
    const plan = vi.fn().mockResolvedValue({ ok: false, reason: "no_prompts" });

    await sweepAiVisibility({ now: clock(MONDAY), plan, slice: vi.fn(), finalize: vi.fn() });

    const [source] = await db
      .select()
      .from(sources)
      .where(and(eq(sources.tenantId, tenant.id), eq(sources.type, "ai_visibility")));
    expect(source.lastError).toContain("prompt");
  });

  it("skips disabled sources entirely", async () => {
    const { tenant } = await seedSource();
    await db.update(sources).set({ status: "disabled" }).where(eq(sources.tenantId, tenant.id));
    const plan = vi.fn();

    await sweepAiVisibility({ now: clock(MONDAY), plan, slice: vi.fn(), finalize: vi.fn() });

    expect(plan).not.toHaveBeenCalled();
  });

  it("includes failing sources so a recovered tenant is picked up again", async () => {
    const { tenant } = await seedSource();
    await db.update(sources).set({ status: "failing" }).where(eq(sources.tenantId, tenant.id));
    const plan = vi.fn().mockResolvedValue({ ok: true, runId: "run-1", plannedCalls: 3, estimateUsd: 0.03 });

    await sweepAiVisibility({
      now: clock(MONDAY),
      plan,
      slice: vi.fn().mockResolvedValue({ processed: 3, remaining: 0, budgetSpent: false, pausedByCap: false }),
      finalize: vi.fn().mockResolvedValue({ status: "complete", judged: 0, signals: 0 }),
    });

    expect(plan).toHaveBeenCalledTimes(1);
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

    const plan = vi.fn().mockResolvedValue({ ok: true, runId: "run-x", plannedCalls: 3, estimateUsd: 0.03 });
    const slice = vi.fn().mockResolvedValue({ processed: 3, remaining: 0, budgetSpent: false, pausedByCap: false });

    await sweepAiVisibility({
      now: clock(MONDAY),
      budgetMs: 100_000,
      plan,
      slice,
      finalize: vi.fn().mockResolvedValue({ status: "complete", judged: 0, signals: 0 }),
    });

    expect(plan).toHaveBeenCalledTimes(2);
    expect(slice).toHaveBeenCalledTimes(2);
    for (const call of slice.mock.calls) {
      expect(call[1].budgetMs).toBeLessThanOrEqual(50_000);
      expect(call[1].budgetMs).toBeGreaterThan(0);
    }
    expect(first.id).not.toBe(second.id);
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
    const plan = vi.fn().mockImplementation(async (tenantId: string) => {
      seen.push(tenantId);
      return { ok: false, reason: "no_prompts" } as const;
    });

    await sweepAiVisibility({ now: clock(MONDAY), plan, slice: vi.fn(), finalize: vi.fn() });

    expect(seen[0]).toBe(never.id);
  });
});
