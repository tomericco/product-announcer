import { describe, it, expect, afterEach } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../../../src/db";
import {
  aiVisibilityPrompts,
  aiVisibilityRuns,
  aiVisibilitySamples,
  aiVisibilityAggregates,
  aiVisibilityCitations,
  aiVisibilitySettings,
  competitors,
  llmUsage,
  signals,
  sources,
} from "../../../src/db/schema";
import type {
  EngineAnswer,
  EngineClient,
  EngineError,
  EngineId,
} from "../../../src/lib/ai-visibility/types";
import { cancelRun, finalizeRun, latestRun, planRun, runSlice } from "../../../src/lib/ai-visibility/run";
import { engineMetrics } from "../../../src/lib/ai-visibility/metrics";
import { MAX_ACTIVE_PROMPTS } from "../../../src/lib/ai-visibility/prompts";
import { seedTenant, dropTenant, seedEngineKey } from "../../helpers/fixtures";

const TENANT = "AI Visibility Run Test Tenant";

/** A clock that never moves. Enough for planning; D3 uses an advancing one. */
const frozen = (iso: string) => () => new Date(iso);

afterEach(async () => {
  await dropTenant(TENANT);
});

/**
 * Settings AND a verified key for every engine the row names.
 *
 * The keys are not incidental: under BYOK `planRun` gates on
 * `effectiveEngines`, which is `settings.engines` intersected with the engines
 * holding an enabled, verified key and does NOT fall back to all three when
 * that is empty. A settings row on its own now plans nothing, so seeding one
 * without keys would make every test in this file assert `no_engines`.
 *
 * Pass `withKeys: false` to get the un-keyed state deliberately — that is what
 * the `no_engines` refusal is tested against.
 */
async function seedSettings(
  tenantId: string,
  overrides: Partial<typeof aiVisibilitySettings.$inferInsert> = {},
  opts: { withKeys?: boolean } = {}
) {
  const engines = (overrides.engines as EngineId[] | undefined) ?? ["openai", "gemini"];
  await db.insert(aiVisibilitySettings).values({
    tenantId,
    enabled: true,
    engines,
    samplesPerPrompt: 3,
    monthlyCapUsd: 20,
    ...overrides,
  });
  if (opts.withKeys === false) return;
  for (const engine of engines) await seedEngineKey(tenantId, engine);
}

async function seedPrompt(
  tenantId: string,
  overrides: Partial<typeof aiVisibilityPrompts.$inferInsert> = {}
) {
  const [prompt] = await db
    .insert(aiVisibilityPrompts)
    .values({
      tenantId,
      text: overrides.text ?? `best tool for teams ${Math.random()}`,
      intent: "discovery",
      origin: "generated",
      status: "active",
      ...overrides,
    })
    .returning();
  return prompt;
}

describe("planRun — the prompt budget", () => {
  /**
   * A tenant seeded under the OLD 30-prompt ceiling. Lowering
   * `MAX_ACTIVE_PROMPTS` deactivates nothing, so this is the state every
   * existing tenant is in, and it is the state in which the cost cut either
   * lands or does not.
   */
  async function seedOverTheCap(tenantId: string, count: number) {
    const prompts = [];
    for (let index = 0; index < count; index += 1) {
      // One INSERT each, so `created_at` orders them: a single batched insert
      // would stamp one transaction timestamp across all of them and leave the
      // `id` tiebreak doing all the work. Both orders are stable; this one is
      // also readable.
      prompts.push(await seedPrompt(tenantId, { text: `capped prompt ${index}` }));
    }
    return prompts;
  }

  it("plans at most MAX_ACTIVE_PROMPTS, however many are active", async () => {
    const tenant = await seedTenant(TENANT);
    await seedSettings(tenant.id, { engines: ["openai"], samplesPerPrompt: 3 });
    await seedOverTheCap(tenant.id, 12);

    const result = await planRun(tenant.id, { trigger: "manual", now: frozen("2026-03-02T09:00:00Z") });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 5 prompts x 1 engine x 3 samples. Twelve would be 36.
    expect(result.plannedCalls).toBe(MAX_ACTIVE_PROMPTS * 3);
  });

  it("asks the SAME prompts every run, which is what makes the trend comparable", async () => {
    // The whole reason the selection is ordered rather than arbitrary: the
    // trend chart plots one series across twelve runs, and that series only
    // means anything if every run asked the same questions. A drifting pick
    // would leave the chart silently plotting a different question each week
    // under one unbroken line.
    const tenant = await seedTenant(TENANT);
    await seedSettings(tenant.id, { engines: ["openai"], samplesPerPrompt: 1 });
    const prompts = await seedOverTheCap(tenant.id, 9);

    const asked = async () => {
      const plan = await planRun(tenant.id, { trigger: "manual", now: frozen("2026-03-02T09:00:00Z") });
      if (!plan.ok) throw new Error(`planRun refused: ${plan.reason}`);
      const rows = await db
        .select({ promptId: aiVisibilitySamples.promptId })
        .from(aiVisibilitySamples)
        .where(eq(aiVisibilitySamples.runId, plan.runId));
      await db.update(aiVisibilityRuns).set({ status: "complete" }).where(eq(aiVisibilityRuns.id, plan.runId));
      return [...new Set(rows.map((row) => row.promptId))].sort();
    };

    const first = await asked();
    const second = await asked();

    expect(first).toHaveLength(MAX_ACTIVE_PROMPTS);
    expect(second).toEqual(first);
    // And they are the OLDEST five, not any five that happen to be stable.
    expect(first).toEqual(prompts.slice(0, MAX_ACTIVE_PROMPTS).map((p) => p.id).sort());
  });

  it("promotes the next prompt only when a human pauses one of the chosen five", async () => {
    // The one case where the series SHOULD change, and the prompts page
    // records why. Nothing a run does can cause it.
    const tenant = await seedTenant(TENANT);
    await seedSettings(tenant.id, { engines: ["openai"], samplesPerPrompt: 1 });
    const prompts = await seedOverTheCap(tenant.id, 7);
    await db
      .update(aiVisibilityPrompts)
      .set({ status: "paused" })
      .where(eq(aiVisibilityPrompts.id, prompts[0].id));

    const plan = await planRun(tenant.id, { trigger: "manual", now: frozen("2026-03-02T09:00:00Z") });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const rows = await db
      .select({ promptId: aiVisibilitySamples.promptId })
      .from(aiVisibilitySamples)
      .where(eq(aiVisibilitySamples.runId, plan.runId));

    expect([...new Set(rows.map((row) => row.promptId))].sort()).toEqual(
      prompts.slice(1, MAX_ACTIVE_PROMPTS + 1).map((p) => p.id).sort()
    );
  });
});

describe("planRun", () => {
  it("refuses when the feature is disabled", async () => {
    const tenant = await seedTenant(TENANT);
    await seedSettings(tenant.id, { enabled: false });
    await seedPrompt(tenant.id);

    const result = await planRun(tenant.id, { trigger: "scheduled", now: frozen("2026-03-02T09:00:00Z") });

    expect(result).toEqual({ ok: false, reason: "disabled" });
    expect(await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.tenantId, tenant.id))).toHaveLength(0);
  });

  it("refuses when there is no active prompt", async () => {
    const tenant = await seedTenant(TENANT);
    await seedSettings(tenant.id);
    await seedPrompt(tenant.id, { status: "proposed" });

    const result = await planRun(tenant.id, { trigger: "manual", now: frozen("2026-03-02T09:00:00Z") });

    expect(result).toEqual({ ok: false, reason: "no_prompts" });
  });

  it("refuses when a run is already in flight and names it", async () => {
    const tenant = await seedTenant(TENANT);
    await seedSettings(tenant.id);
    await seedPrompt(tenant.id);
    const [inFlight] = await db
      .insert(aiVisibilityRuns)
      .values({ tenantId: tenant.id, trigger: "scheduled", engines: ["openai"], samplesPerPrompt: 3, status: "running" })
      .returning();

    const result = await planRun(tenant.id, { trigger: "manual", now: frozen("2026-03-02T09:00:00Z") });

    expect(result).toEqual({ ok: false, reason: "run_in_flight", runId: inFlight.id });
  });

  it("refuses when the monthly cap would be crossed", async () => {
    const tenant = await seedTenant(TENANT);
    // MIN_MONTHLY_CAP_USD is 1 and `getAiVisibilitySettings` clamps to it, so a
    // sub-cent cap cannot be seeded. The month's spend is what puts this run
    // over instead — which is the gate as it actually fires in production.
    await seedSettings(tenant.id, { monthlyCapUsd: 1 });
    await seedPrompt(tenant.id);
    await db.insert(aiVisibilityRuns).values({
      tenantId: tenant.id,
      trigger: "scheduled",
      engines: ["openai", "gemini"],
      samplesPerPrompt: 3,
      status: "complete",
      costUsd: 0.95,
      startedAt: new Date("2026-03-01T09:00:00Z"),
    });

    const result = await planRun(tenant.id, { trigger: "scheduled", now: frozen("2026-03-02T09:00:00Z") });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("cap_reached");
  });

  it("inserts a pending run and one pending sample per prompt x engine x sample", async () => {
    const tenant = await seedTenant(TENANT);
    await seedSettings(tenant.id);
    const a = await seedPrompt(tenant.id, { text: "best issue tracker for startups" });
    const b = await seedPrompt(tenant.id, { text: "what is Versional", intent: "brand_check", branded: true });

    const result = await planRun(tenant.id, { trigger: "scheduled", now: frozen("2026-03-02T09:00:00Z") });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, result.runId));
    expect(run.status).toBe("pending");
    expect(run.trigger).toBe("scheduled");
    expect(run.engines.sort()).toEqual(["gemini", "openai"]);
    expect(run.samplesPerPrompt).toBe(3);
    // 1 discovery prompt x 2 engines x 3 samples + 1 brand_check x 2 engines x 1 sample
    expect(run.plannedCalls).toBe(8);
    expect(result.plannedCalls).toBe(8);

    const samples = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.runId, result.runId));
    expect(samples).toHaveLength(8);
    expect(samples.every((s) => s.status === "pending")).toBe(true);
    expect(samples.every((s) => s.tenantId === tenant.id)).toBe(true);

    const brandCheck = samples.filter((s) => s.promptId === b.id);
    expect(brandCheck).toHaveLength(2);
    expect(brandCheck.map((s) => s.sampleIndex).sort()).toEqual([0, 0]);

    const discovery = samples.filter((s) => s.promptId === a.id && s.engine === "openai");
    expect(discovery.map((s) => s.sampleIndex).sort()).toEqual([0, 1, 2]);
  });

  it("plans only the engines the tenant enabled", async () => {
    const tenant = await seedTenant(TENANT);
    await seedSettings(tenant.id, { engines: ["openai"] });
    await seedPrompt(tenant.id);

    const result = await planRun(tenant.id, { trigger: "manual", now: frozen("2026-03-02T09:00:00Z") });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const samples = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.runId, result.runId));
    expect(new Set(samples.map((s) => s.engine))).toEqual(new Set(["openai"]));
  });

  it("attaches the tenant's ai_visibility source to the run", async () => {
    const tenant = await seedTenant(TENANT);
    await seedSettings(tenant.id);
    await seedPrompt(tenant.id);

    const result = await planRun(tenant.id, { trigger: "scheduled", now: frozen("2026-03-02T09:00:00Z") });
    if (!result.ok) throw new Error("unreachable");

    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, result.runId));
    expect(run.sourceId).not.toBeNull();
  });

  it("plans exactly one run when two drivers plan at the same instant", async () => {
    const tenant = await seedTenant(TENANT);
    await seedSettings(tenant.id);
    await seedPrompt(tenant.id);

    // The cron sweep and a manual Run-now landing together. Reading before
    // writing cannot decide this on its own — both reads see no in-flight run —
    // so `ai_visibility_runs_tenant_in_flight_unique` is what actually holds.
    const [first, second] = await Promise.all([
      planRun(tenant.id, { trigger: "scheduled", now: frozen("2026-03-02T09:00:00Z") }),
      planRun(tenant.id, { trigger: "manual", now: frozen("2026-03-02T09:00:00Z") }),
    ]);

    const outcomes = [first, second];
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    const loser = outcomes.find((o) => !o.ok);
    expect(loser && !loser.ok && loser.reason).toBe("run_in_flight");

    const runs = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.tenantId, tenant.id));
    expect(runs).toHaveLength(1);
    // And the tenant is not billed for a second, half-inserted work list.
    const samples = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.tenantId, tenant.id));
    expect(samples).toHaveLength(runs[0].plannedCalls);

    // And the constraint itself holds, not merely the read-then-write check
    // above: with the winner still in flight, a second in-flight run for this
    // tenant is rejected by Postgres.
    await expect(
      db.insert(aiVisibilityRuns).values({
        tenantId: tenant.id,
        trigger: "manual",
        engines: ["openai"],
        samplesPerPrompt: 3,
        status: "running",
      })
    ).rejects.toThrow();
  });

  it("does not treat a completed run as in flight", async () => {
    const tenant = await seedTenant(TENANT);
    await seedSettings(tenant.id);
    await seedPrompt(tenant.id);
    await db.insert(aiVisibilityRuns).values({
      tenantId: tenant.id,
      trigger: "scheduled",
      engines: ["openai"],
      samplesPerPrompt: 3,
      status: "complete",
    });

    const result = await planRun(tenant.id, { trigger: "manual", now: frozen("2026-03-02T09:00:00Z") });
    expect(result.ok).toBe(true);
  });
});

/** A clock the test advances by hand, so budget expiry is deterministic. */
function advancingClock(startIso: string, stepMs: number) {
  let t = new Date(startIso).getTime();
  return () => {
    const current = new Date(t);
    t += stepMs;
    return current;
  };
}

function answer(overrides: Partial<EngineAnswer> = {}): EngineAnswer {
  return {
    text: "Acme and Rival are the usual picks.",
    modelId: "gpt-5.1-2026-01-01",
    citations: [{ url: "https://acme.com/pricing", position: 1 }],
    searchUsed: true,
    searchQueries: ["best issue tracker"],
    raw: { ok: true },
    costUsd: 0.01,
    ...overrides,
  };
}

function fakeEngine(
  id: "openai" | "gemini",
  reply: (prompt: string, call: number) => EngineAnswer | EngineError
): EngineClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    id,
    label: `${id} (fake)`,
    calls,
    async ask(prompt: string) {
      calls.push(prompt);
      return reply(prompt, calls.length);
    },
  };
}

describe("runSlice", () => {
  async function planned(overrides: Partial<typeof aiVisibilitySettings.$inferInsert> = {}) {
    const tenant = await seedTenant(TENANT);
    await seedSettings(tenant.id, { engines: ["openai"], samplesPerPrompt: 3, ...overrides });
    await seedPrompt(tenant.id, { text: "best issue tracker for startups" });
    const result = await planRun(tenant.id, { trigger: "manual", now: frozen("2026-03-02T09:00:00Z") });
    if (!result.ok) throw new Error(`planRun refused: ${result.reason}`);
    return { tenant, runId: result.runId };
  }

  it("processes every pending sample and records answers, cost and counters", async () => {
    const { tenant, runId } = await planned();
    const openai = fakeEngine("openai", () => answer());

    const outcome = await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 2, now: advancingClock("2026-03-02T09:00:00Z", 10) },
      { engines: { openai } }
    );

    expect(outcome).toEqual({ processed: 3, remaining: 0, budgetSpent: false, pausedByCap: false, cancelled: false });
    expect(openai.calls).toEqual([
      "best issue tracker for startups",
      "best issue tracker for startups",
      "best issue tracker for startups",
    ]);

    const samples = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.runId, runId));
    expect(samples.every((s) => s.status === "ok")).toBe(true);
    expect(samples.every((s) => s.answerText === "Acme and Rival are the usual picks.")).toBe(true);
    expect(samples.every((s) => s.modelId === "gpt-5.1-2026-01-01")).toBe(true);
    expect(samples.every((s) => s.searchUsed === true)).toBe(true);
    expect(samples.every((s) => s.askedAt !== null)).toBe(true);

    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
    expect(run.status).toBe("running");
    expect(run.completedCalls).toBe(3);
    expect(run.costUsd).toBeCloseTo(0.03, 5);
    expect(run.modelIds).toEqual({ openai: "gpt-5.1-2026-01-01" });
    expect(tenant.id).toBe(run.tenantId);
  });

  it("records each engine sample's token usage as ai_visibility_engine rows", async () => {
    const { tenant, runId } = await planned();
    const openai = fakeEngine("openai", () =>
      answer({ usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } })
    );

    await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 1, now: advancingClock("2026-03-02T09:00:00Z", 10) },
      { engines: { openai } }
    );

    const rows = await db
      .select()
      .from(llmUsage)
      .where(eq(llmUsage.tenantId, tenant.id));
    // samplesPerPrompt is 3 in planned()'s settings.
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.operation === "ai_visibility_engine")).toBe(true);
    expect(rows.every((r) => r.model === "gpt-5.1-2026-01-01")).toBe(true);
    expect(rows.every((r) => r.totalTokens === 120)).toBe(true);
  });

  it("records usage on a billed failure and skips samples that reported none", async () => {
    const { tenant, runId } = await planned();
    const openai = fakeEngine("openai", (_p, call) => {
      if (call === 1)
        return {
          kind: "refused" as const,
          code: "refused" as const,
          message: "declined",
          costUsd: 0.01,
          usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55 },
        };
      if (call === 2)
        return { kind: "error" as const, code: "provider_unavailable" as const, message: "down" };
      return answer(); // no usage on this one
    });

    await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 1, now: advancingClock("2026-03-02T09:00:00Z", 10) },
      { engines: { openai } }
    );

    const rows = await db.select().from(llmUsage).where(eq(llmUsage.tenantId, tenant.id));
    // Only the refusal carried usage; the transport-style error and the
    // usage-less answer record nothing.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      operation: "ai_visibility_engine",
      // A failure has no modelId; the engine id is the honest fallback.
      model: "openai",
      totalTokens: 55,
    });
  });

  it("stores a refusal as refused and an error as error, without failing the slice", async () => {
    const { runId } = await planned();
    const openai = fakeEngine("openai", (_p, call) => {
      if (call === 1) return { kind: "refused" as const, code: "refused" as const, message: "declined" };
      if (call === 2)
        return { kind: "error" as const, code: "rate_limited" as const, message: "rate limited" };
      return answer();
    });

    const outcome = await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 1, now: advancingClock("2026-03-02T09:00:00Z", 10) },
      { engines: { openai } }
    );

    expect(outcome.processed).toBe(3);
    expect(outcome.remaining).toBe(0);
    const samples = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.runId, runId));
    expect(samples.map((s) => s.status).sort()).toEqual(["error", "ok", "refused"]);
    expect(samples.find((s) => s.status === "error")?.error).toContain("rate limited");
    // Only the successful call is billed.
    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
    expect(run.costUsd).toBeCloseTo(0.01, 5);
  });

  it("banks what a failed call is known to have cost", async () => {
    const { runId } = await planned();
    // A truncated or refused answer ran the model to completion and is billed;
    // the client says so when the provider told it enough. Treating that as
    // free is how the monthly cap silently under-counts.
    const openai = fakeEngine("openai", (_p, call) =>
      call === 1
        ? {
            kind: "error" as const,
            code: "bad_response" as const,
            message: "cut off at the token ceiling",
            costUsd: 0.007,
          }
        : answer()
    );

    await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 1, now: advancingClock("2026-03-02T09:00:00Z", 10) },
      { engines: { openai } }
    );

    const samples = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.runId, runId));
    expect(samples.find((s) => s.status === "error")?.costUsd).toBeCloseTo(0.007, 5);
    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
    expect(run.costUsd).toBeCloseTo(0.027, 5);
  });

  it("records a thrown engine client as an error sample rather than throwing", async () => {
    const { runId } = await planned();
    const openai = fakeEngine("openai", () => {
      throw new Error("socket hang up");
    });

    const outcome = await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 1, now: advancingClock("2026-03-02T09:00:00Z", 10) },
      { engines: { openai } }
    );

    expect(outcome.processed).toBe(3);
    const samples = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.runId, runId));
    expect(samples.every((s) => s.status === "error")).toBe(true);
    expect(samples[0].error).toContain("socket hang up");
  });

  it("stops when the wall-clock budget is spent and leaves the rest pending", async () => {
    const { runId } = await planned();
    const openai = fakeEngine("openai", () => answer());

    // Each clock read advances 40ms; a 50ms budget survives the first batch's
    // pre-flight checks and is spent by the second batch's.
    const outcome = await runSlice(
      runId,
      { budgetMs: 50, concurrency: 1, now: advancingClock("2026-03-02T09:00:00Z", 40) },
      { engines: { openai } }
    );

    expect(outcome.budgetSpent).toBe(true);
    expect(outcome.processed).toBeLessThan(3);
    expect(outcome.remaining).toBe(3 - outcome.processed);
    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
    expect(run.status).toBe("running");
  });

  it("resumes exactly where the previous slice stopped", async () => {
    const { runId } = await planned();
    const openai = fakeEngine("openai", () => answer());

    const first = await runSlice(
      runId,
      { budgetMs: 50, concurrency: 1, now: advancingClock("2026-03-02T09:00:00Z", 40) },
      { engines: { openai } }
    );
    const second = await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 4, now: advancingClock("2026-03-02T09:05:00Z", 10) },
      { engines: { openai } }
    );

    expect(first.processed + second.processed).toBe(3);
    expect(second.remaining).toBe(0);
    expect(openai.calls).toHaveLength(3);
    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
    expect(run.completedCalls).toBe(3);
  });

  it("pauses the run and marks the source failing when the cap is reached mid-run", async () => {
    // Plan first, then push the month's spend up to just under the cap BEFORE
    // slicing. Tightening the cap itself cannot express this case:
    // MIN_MONTHLY_CAP_USD is 1 and `getAiVisibilitySettings` clamps to it, so
    // a sub-cent cap is unreachable. Earlier spend is what makes the mid-slice
    // `reached` gate fire: the check before batch 1 sees $0.995 (< $1) and
    // proceeds, batch 1 spends $0.01, and the check before batch 2 sees
    // $1.005 ≥ $1 and pauses with two samples still pending.
    const { tenant, runId } = await planned();
    await db
      .update(aiVisibilitySettings)
      .set({ monthlyCapUsd: 1 })
      .where(eq(aiVisibilitySettings.tenantId, tenant.id));
    await db.insert(aiVisibilityRuns).values({
      tenantId: tenant.id,
      trigger: "scheduled",
      status: "complete",
      engines: ["openai"],
      samplesPerPrompt: 3,
      costUsd: 0.995,
      startedAt: new Date("2026-03-01T09:00:00Z"),
    });
    const openai = fakeEngine("openai", () => answer());

    const outcome = await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 1, now: advancingClock("2026-03-02T09:00:00Z", 10) },
      { engines: { openai } }
    );

    expect(outcome.pausedByCap).toBe(true);
    expect(outcome.remaining).toBeGreaterThan(0);
    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
    expect(run.status).toBe("paused_by_cap");
    const [source] = await db
      .select()
      .from(sources)
      .where(and(eq(sources.tenantId, tenant.id), eq(sources.type, "ai_visibility")));
    expect(source.status).toBe("failing");
    expect(source.lastError).toContain("monthly engine budget");
  });

  it("aggregates what a cap-paused run already bought, so the samples still count", async () => {
    // The seam the phases left open: `runSlice` pauses, `finalizeRun` refuses a
    // `paused_by_cap` run, and `computeAggregates` has no other call site — so
    // without aggregating here every answer paid for before the cap tripped is
    // orphaned. It is charged against month-to-date spend and visible to no
    // metric and no signal, and the run is terminal so nothing ever resumes it.
    const { tenant, runId } = await planned();
    await db
      .update(aiVisibilitySettings)
      .set({ monthlyCapUsd: 1 })
      .where(eq(aiVisibilitySettings.tenantId, tenant.id));
    await db.insert(aiVisibilityRuns).values({
      tenantId: tenant.id,
      trigger: "scheduled",
      status: "complete",
      engines: ["openai"],
      samplesPerPrompt: 3,
      // Low enough that two batches clear the gate and the third does not:
      // $0.98, then $0.99, then $1.00 — which is `reached`. (`monthToDateSpend`
      // rounds to cents, so $0.995 would already read as $1.00 and pause before
      // a single sample was bought — the case this test exists to rule out.)
      costUsd: 0.98,
      startedAt: new Date("2026-03-01T09:00:00Z"),
    });
    const openai = fakeEngine("openai", () => answer());

    const outcome = await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 1, now: advancingClock("2026-03-02T09:00:00Z", 10) },
      { engines: { openai } }
    );

    expect(outcome.pausedByCap).toBe(true);
    expect(outcome.remaining).toBeGreaterThan(0);
    const ok = await db
      .select()
      .from(aiVisibilitySamples)
      .where(and(eq(aiVisibilitySamples.runId, runId), eq(aiVisibilitySamples.status, "ok")));
    expect(ok.length).toBeGreaterThan(0);

    const rows = await db
      .select()
      .from(aiVisibilityAggregates)
      .where(eq(aiVisibilityAggregates.runId, runId));
    expect(rows.length).toBeGreaterThan(0);

    // And the window has to admit the paused run, or the aggregates are written
    // to a row nothing reads.
    const metrics = (await engineMetrics(tenant.id, db, () => new Date("2026-03-02T10:00:00Z"))).metrics;
    expect(metrics.find((m) => m.engine === "openai")?.n).toBe(ok.length);
    expect(metrics.find((m) => m.engine === "all")?.n).toBe(ok.length);
  });

  it("is a no-op for a run that is already complete", async () => {
    const { runId } = await planned();
    await db.update(aiVisibilityRuns).set({ status: "complete" }).where(eq(aiVisibilityRuns.id, runId));
    const openai = fakeEngine("openai", () => answer());

    const outcome = await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 4, now: advancingClock("2026-03-02T09:00:00Z", 10) },
      { engines: { openai } }
    );

    expect(outcome).toEqual({ processed: 0, remaining: 0, budgetSpent: false, pausedByCap: false, cancelled: false });
    expect(openai.calls).toHaveLength(0);
  });

  it("does nothing while another driver holds the slice lease", async () => {
    const { runId } = await planned();
    const openai = fakeEngine("openai", () => answer());
    // A cron tick already driving this run; the manual Run-now arrives second.
    await db
      .update(aiVisibilityRuns)
      .set({ sliceLeaseUntil: new Date("2026-03-02T09:30:00Z") })
      .where(eq(aiVisibilityRuns.id, runId));

    const outcome = await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 2, now: advancingClock("2026-03-02T09:00:00Z", 10) },
      { engines: { openai } }
    );

    // Losing the race is a no-op, not an error — and above all not a second
    // set of engine calls for work the holder is already paying for.
    expect(outcome).toEqual({ processed: 0, remaining: 0, budgetSpent: false, pausedByCap: false, cancelled: false });
    expect(openai.calls).toHaveLength(0);
    const samples = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.runId, runId));
    expect(samples.every((s) => s.status === "pending")).toBe(true);
  });

  it("takes over a lease left behind by a driver that died", async () => {
    const { runId } = await planned();
    const openai = fakeEngine("openai", () => answer());
    await db
      .update(aiVisibilityRuns)
      .set({ sliceLeaseUntil: new Date("2026-03-02T08:00:00Z") })
      .where(eq(aiVisibilityRuns.id, runId));

    const outcome = await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 2, now: advancingClock("2026-03-02T09:00:00Z", 10) },
      { engines: { openai } }
    );

    // A lapsed lease is the point of an expiry rather than a boolean: a tick
    // killed mid-slice must not strand the run forever.
    expect(outcome.processed).toBe(3);
    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
    expect(run.sliceLeaseUntil).toBeNull();
  });

  it("stops handing out work when its lease lapses and another driver takes over", async () => {
    const { runId } = await planned();
    const stealer = "11111111-2222-3333-4444-555555555555";
    // Driver B takes the run while A is inside its first engine call — the
    // interleaving A's own clock can never observe on its own.
    const calls: string[] = [];
    const openai: EngineClient = {
      id: "openai",
      label: "openai (fake)",
      async ask(prompt: string) {
        calls.push(prompt);
        if (calls.length === 1) {
          // Awaited, not fired and forgotten: the steal has to have COMMITTED
          // before A's next renewal, or the test races its own premise.
          await db
            .update(aiVisibilityRuns)
            .set({ sliceLeaseUntil: new Date("2026-03-02T10:00:00Z"), sliceLeaseOwner: stealer })
            .where(eq(aiVisibilityRuns.id, runId));
        }
        return answer();
      },
    };

    const outcome = await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 1, now: advancingClock("2026-03-02T09:00:00Z", 10) },
      { engines: { openai } }
    );

    // A renews before each batch; the renewal is owner-scoped, so it is a
    // no-op once B holds the lease and A stops rather than paying a second
    // time for every sample B is already working through.
    expect(calls).toHaveLength(1);
    expect(outcome.processed).toBe(1);
    expect(outcome.remaining).toBe(2);

    // And A's exit does not free the claim B is working under.
    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
    expect(run.sliceLeaseOwner).toBe(stealer);
    expect(run.sliceLeaseUntil?.toISOString()).toBe("2026-03-02T10:00:00.000Z");
  });

  it("keeps a paid-for answer when extraction fails", async () => {
    const { runId } = await planned();
    const openai = fakeEngine("openai", () => answer());

    const outcome = await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 1, now: advancingClock("2026-03-02T09:00:00Z", 10) },
      {
        engines: { openai },
        extract: async () => {
          throw new Error("competitor deleted mid-slice");
        },
      }
    );

    // The answer is bought and stored. Rewriting it as `error` because a later,
    // re-runnable step failed invents a coverage gap AND loses the spend.
    expect(outcome.processed).toBe(3);
    const samples = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.runId, runId));
    expect(samples.every((s) => s.status === "ok")).toBe(true);
    expect(samples.every((s) => s.answerText === "Acme and Rival are the usual picks.")).toBe(true);
    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
    expect(run.costUsd).toBeCloseTo(0.03, 5);
  });

  it("extracts each successful sample as it is written", async () => {
    const { runId } = await planned();
    const openai = fakeEngine("openai", () => answer());
    const extracted: string[] = [];

    await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 1, now: advancingClock("2026-03-02T09:00:00Z", 10) },
      {
        engines: { openai },
        extract: async (sampleId) => {
          extracted.push(sampleId);
        },
      }
    );

    expect(extracted).toHaveLength(3);
    const samples = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.runId, runId));
    expect(new Set(extracted)).toEqual(new Set(samples.map((s) => s.id)));
    // The citation list is stored beside the engine's own payload so extraction
    // can be replayed from the row alone.
    expect((samples[0].raw as { citations: { url: string }[] }).citations[0].url).toBe("https://acme.com/pricing");
  });

  it("does not extract errored or refused samples", async () => {
    const { runId } = await planned();
    const openai = fakeEngine("openai", () => ({ kind: "error", code: "bad_response", message: "boom" }) as const);
    const extracted: string[] = [];

    await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 1, now: advancingClock("2026-03-02T09:00:00Z", 10) },
      { engines: { openai }, extract: async (id) => void extracted.push(id) }
    );

    expect(extracted).toEqual([]);
  });
});

describe("finalizeRun", () => {
  async function ran(sampleStatuses: string[]) {
    const tenant = await seedTenant(TENANT);
    await seedSettings(tenant.id, { engines: ["openai"], samplesPerPrompt: sampleStatuses.length });
    await seedPrompt(tenant.id, { text: "best issue tracker" });
    const planned = await planRun(tenant.id, { trigger: "manual", now: frozen("2026-03-02T09:00:00Z") });
    if (!planned.ok) throw new Error(`planRun refused: ${planned.reason}`);

    const rows = await db
      .select()
      .from(aiVisibilitySamples)
      .where(eq(aiVisibilitySamples.runId, planned.runId))
      .orderBy(asc(aiVisibilitySamples.sampleIndex));
    for (const [i, status] of sampleStatuses.entries()) {
      await db
        .update(aiVisibilitySamples)
        .set({
          status,
          answerText: status === "ok" ? "Rival is strongest." : null,
          error: status === "ok" ? null : "429 rate limited",
          extraction:
            status === "ok"
              ? { deterministic: { tenantMentioned: false, competitorIds: [], ownDomainCited: false } }
              : null,
        })
        .where(eq(aiVisibilitySamples.id, rows[i].id));
    }
    await db
      .update(aiVisibilityRuns)
      .set({ status: "running", completedCalls: sampleStatuses.length, costUsd: 0.05 })
      .where(eq(aiVisibilityRuns.id, planned.runId));
    return { tenant, runId: planned.runId };
  }

  const noopJudge = async () => ({ judged: 0, flagged: 0, remaining: 0, budgetSpent: false, errors: [] });

  it("judges, aggregates, emits and marks the run complete, in that order", async () => {
    const { runId } = await ran(["ok", "ok", "ok"]);
    const order: string[] = [];

    const out = await finalizeRun(
      runId,
      { budgetMs: 60_000, now: frozen("2026-03-02T09:10:00Z") },
      {
        judge: async () => {
          order.push("judge");
          return { judged: 3, flagged: 0, remaining: 0, budgetSpent: false, errors: [] };
        },
        aggregate: async () => {
          order.push("aggregate");
          return { engineRows: 1, promptRows: 1 };
        },
        emit: async () => {
          order.push("emit");
          return { written: 2, considered: 5 };
        },
      }
    );

    expect(order).toEqual(["judge", "aggregate", "emit"]);
    expect(out).toEqual({ status: "complete", judged: 3, signals: 2 });

    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
    expect(run.status).toBe("complete");
    expect(run.finishedAt?.toISOString()).toBe("2026-03-02T09:10:00.000Z");
  });

  it("runs the real aggregate pass when none is injected", async () => {
    const { runId } = await ran(["ok", "ok", "ok"]);

    await finalizeRun(
      runId,
      { budgetMs: 60_000, now: frozen("2026-03-02T09:10:00Z") },
      { judge: noopJudge, emit: async () => ({ written: 0, considered: 0 }) }
    );

    const rows = await db.select().from(aiVisibilityAggregates).where(eq(aiVisibilityAggregates.runId, runId));
    expect(rows.length).toBeGreaterThan(0);
  });

  it("stays running and does not aggregate when the judge budget runs out", async () => {
    const { runId } = await ran(["ok", "ok", "ok"]);
    let aggregated = false;

    const out = await finalizeRun(
      runId,
      { budgetMs: 60_000, now: frozen("2026-03-02T09:10:00Z") },
      {
        judge: async () => ({ judged: 1, flagged: 0, remaining: 2, budgetSpent: true, errors: [] }),
        aggregate: async () => {
          aggregated = true;
          return { engineRows: 0, promptRows: 0 };
        },
        emit: async () => ({ written: 0, considered: 0 }),
      }
    );

    expect(out).toEqual({ status: "running", judged: 1, signals: 0 });
    expect(aggregated).toBe(false);
    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
    expect(run.status).toBe("running");
    expect(run.finishedAt).toBeNull();
  });

  it("marks the source active with lastSuccessAt when the run produced answers", async () => {
    const { tenant, runId } = await ran(["ok", "ok", "ok"]);

    await finalizeRun(
      runId,
      { budgetMs: 60_000, now: frozen("2026-03-02T09:10:00Z") },
      { judge: noopJudge, emit: async () => ({ written: 0, considered: 0 }) }
    );

    const [source] = await db
      .select()
      .from(sources)
      .where(and(eq(sources.tenantId, tenant.id), eq(sources.type, "ai_visibility")));
    expect(source.status).toBe("active");
    expect(source.lastRunAt?.toISOString()).toBe("2026-03-02T09:10:00.000Z");
    expect(source.lastSuccessAt?.toISOString()).toBe("2026-03-02T09:10:00.000Z");
    expect(source.lastError).toBeNull();
  });

  it("stays active but records the partial failure when some engines failed", async () => {
    const { tenant, runId } = await ran(["ok", "error", "error"]);

    await finalizeRun(
      runId,
      { budgetMs: 60_000, now: frozen("2026-03-02T09:10:00Z") },
      { judge: noopJudge, emit: async () => ({ written: 0, considered: 0 }) }
    );

    const [source] = await db
      .select()
      .from(sources)
      .where(and(eq(sources.tenantId, tenant.id), eq(sources.type, "ai_visibility")));
    expect(source.status).toBe("active");
    expect(source.lastError).toContain("openai");
    expect(source.lastError).toContain("2 of 3");
  });

  it("marks the source failing when every answer failed", async () => {
    const { tenant, runId } = await ran(["error", "error", "error"]);

    await finalizeRun(
      runId,
      { budgetMs: 60_000, now: frozen("2026-03-02T09:10:00Z") },
      { judge: noopJudge, emit: async () => ({ written: 0, considered: 0 }) }
    );

    const [source] = await db
      .select()
      .from(sources)
      .where(and(eq(sources.tenantId, tenant.id), eq(sources.type, "ai_visibility")));
    expect(source.status).toBe("failing");
    expect(source.lastSuccessAt).toBeNull();
    // Still marks the run complete: it did all the work there was to do.
    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
    expect(run.status).toBe("complete");
  });

  it("marks the run failed and the source failing when a step throws, without rethrowing", async () => {
    const { tenant, runId } = await ran(["ok", "ok", "ok"]);

    const out = await finalizeRun(
      runId,
      { budgetMs: 60_000, now: frozen("2026-03-02T09:10:00Z") },
      {
        judge: noopJudge,
        aggregate: async () => {
          throw new Error("aggregate exploded");
        },
      }
    );

    expect(out.status).toBe("failed");
    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
    expect(run.status).toBe("failed");
    expect(run.error).toContain("aggregate exploded");
    const [source] = await db
      .select()
      .from(sources)
      .where(and(eq(sources.tenantId, tenant.id), eq(sources.type, "ai_visibility")));
    expect(source.status).toBe("failing");
  });

  it("refuses to finalize a run paused by the cap", async () => {
    const { runId } = await ran(["ok", "ok", "ok"]);
    await db.update(aiVisibilityRuns).set({ status: "paused_by_cap" }).where(eq(aiVisibilityRuns.id, runId));
    let judgedCalls = 0;

    const out = await finalizeRun(
      runId,
      { budgetMs: 60_000, now: frozen("2026-03-02T09:10:00Z") },
      {
        judge: async () => {
          judgedCalls++;
          return { judged: 0, flagged: 0, remaining: 0, budgetSpent: false, errors: [] };
        },
        emit: async () => ({ written: 0, considered: 0 }),
      }
    );

    // Un-pausing here would spend judge tokens on a run the cap stopped, and
    // silently move it out of the state the settings card explains.
    expect(judgedCalls).toBe(0);
    // Reported as itself, not as "running": the page owes the reader "raise
    // your cap or wait for the reset", not a spinner.
    expect(out.status).toBe("paused_by_cap");
    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
    expect(run.status).toBe("paused_by_cap");
  });

  it("does not aggregate a run that still has unanswered samples", async () => {
    const { runId } = await ran(["ok", "ok", "ok"]);
    const [sample] = await db
      .select()
      .from(aiVisibilitySamples)
      .where(eq(aiVisibilitySamples.runId, runId))
      .orderBy(asc(aiVisibilitySamples.sampleIndex));
    await db
      .update(aiVisibilitySamples)
      .set({ status: "pending", answerText: null, extraction: null })
      .where(eq(aiVisibilitySamples.id, sample.id));
    let aggregated = false;

    const out = await finalizeRun(
      runId,
      { budgetMs: 60_000, now: frozen("2026-03-02T09:10:00Z") },
      {
        judge: noopJudge,
        aggregate: async () => {
          aggregated = true;
          return { engineRows: 0, promptRows: 0 };
        },
        emit: async () => ({ written: 0, considered: 0 }),
      }
    );

    // Aggregates are the permanent record for a run; nothing recomputes them.
    // Writing them off a half-filled work list freezes a small `n` forever.
    expect(aggregated).toBe(false);
    expect(out.status).toBe("running");
  });

  it("does nothing while another driver holds the lease", async () => {
    const { runId } = await ran(["ok", "ok", "ok"]);
    await db
      .update(aiVisibilityRuns)
      .set({ sliceLeaseUntil: new Date("2026-03-02T09:30:00Z") })
      .where(eq(aiVisibilityRuns.id, runId));
    let aggregated = 0;

    const out = await finalizeRun(
      runId,
      { budgetMs: 60_000, now: frozen("2026-03-02T09:10:00Z") },
      {
        judge: noopJudge,
        aggregate: async () => {
          aggregated++;
          return { engineRows: 0, promptRows: 0 };
        },
        emit: async () => ({ written: 0, considered: 0 }),
      }
    );

    // Two concurrent finalizers both run `computeAggregates`, and the second
    // collides with the partial unique index — which the catch below would
    // record as a FAILED run that actually succeeded.
    expect(aggregated).toBe(0);
    expect(out.status).toBe("running");
    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
    expect(run.status).toBe("running");
  });

  it("re-derives spend and completed calls from the sample rows before freezing them", async () => {
    const { runId } = await ran(["ok", "ok", "error"]);
    // What a tick killed between a sample write and its batch total leaves
    // behind: real sample costs, a run total that never heard about them.
    await db
      .update(aiVisibilitySamples)
      .set({ costUsd: 0.011 })
      .where(eq(aiVisibilitySamples.runId, runId));
    await db
      .update(aiVisibilityRuns)
      .set({ costUsd: 0.011, completedCalls: 1 })
      .where(eq(aiVisibilityRuns.id, runId));

    await finalizeRun(
      runId,
      { budgetMs: 60_000, now: frozen("2026-03-02T09:10:00Z") },
      { judge: noopJudge, emit: async () => ({ written: 0, considered: 0 }) }
    );

    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
    // 3 × $0.011 = $0.033, rounded to cents like every other USD value the cap
    // is summed from. Under-reporting here is money the cap never sees.
    expect(run.costUsd).toBeCloseTo(0.03, 5);
    expect(run.completedCalls).toBe(3);
  });

  it("records why a run could not finish, instead of leaving a silent Running…", async () => {
    const { runId } = await ran(["ok", "ok", "ok"]);

    const out = await finalizeRun(
      runId,
      { budgetMs: 60_000, now: frozen("2026-03-02T09:10:00Z") },
      {
        judge: async () => ({
          judged: 0,
          flagged: 0,
          remaining: 3,
          budgetSpent: false,
          errors: ["Error: overloaded"],
        }),
        emit: async () => ({ written: 0, considered: 0 }),
      }
    );

    expect(out.status).toBe("running");
    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
    // Without this the header reads "Running…" beside a green badge for as long
    // as the chunk keeps failing, and the only visible symptom is that next
    // week's run never starts.
    expect(run.error).toContain("overloaded");
  });

  it("hands the lease back on both of the ways it leaves a run still running", async () => {
    // Every other exit releases; these two did not. A leaked lease makes the
    // run unresumable until it expires — and the lease was sized from the very
    // budget that just ran out, so the next tick would find it still held.
    const outOfJudgeBudget = await ran(["ok", "ok", "ok"]);
    const out = await finalizeRun(
      outOfJudgeBudget.runId,
      { budgetMs: 60_000, now: frozen("2026-03-02T09:10:00Z") },
      {
        judge: async () => ({ judged: 0, flagged: 0, remaining: 3, budgetSpent: true, errors: [] }),
        emit: async () => ({ written: 0, considered: 0 }),
      }
    );
    expect(out.status).toBe("running");
    const [judgeRun] = await db
      .select()
      .from(aiVisibilityRuns)
      .where(eq(aiVisibilityRuns.id, outOfJudgeBudget.runId));
    expect(judgeRun.sliceLeaseUntil).toBeNull();
    expect(judgeRun.sliceLeaseOwner).toBeNull();

    await dropTenant(TENANT);

    const stillAnswering = await ran(["ok", "ok", "ok"]);
    const [sample] = await db
      .select()
      .from(aiVisibilitySamples)
      .where(eq(aiVisibilitySamples.runId, stillAnswering.runId))
      .orderBy(asc(aiVisibilitySamples.sampleIndex));
    await db
      .update(aiVisibilitySamples)
      .set({ status: "pending", answerText: null, extraction: null })
      .where(eq(aiVisibilitySamples.id, sample.id));

    const pendingOut = await finalizeRun(
      stillAnswering.runId,
      { budgetMs: 60_000, now: frozen("2026-03-02T09:10:00Z") },
      { judge: noopJudge, emit: async () => ({ written: 0, considered: 0 }) }
    );
    expect(pendingOut.status).toBe("running");
    const [pendingRun] = await db
      .select()
      .from(aiVisibilityRuns)
      .where(eq(aiVisibilityRuns.id, stillAnswering.runId));
    expect(pendingRun.sliceLeaseUntil).toBeNull();
    expect(pendingRun.sliceLeaseOwner).toBeNull();
  });

  it("does not emit signals a second time for an already complete run", async () => {
    const { runId } = await ran(["ok", "ok", "ok"]);
    await db.update(aiVisibilityRuns).set({ status: "complete" }).where(eq(aiVisibilityRuns.id, runId));
    let emitted = 0;

    const out = await finalizeRun(
      runId,
      { budgetMs: 60_000, now: frozen("2026-03-02T09:10:00Z") },
      {
        judge: noopJudge,
        emit: async () => {
          emitted++;
          return { written: 0, considered: 0 };
        },
      }
    );

    expect(out.status).toBe("complete");
    expect(emitted).toBe(0);
  });

  it("writes a real ai_visibility signal end to end when a trigger fires", async () => {
    const { tenant, runId } = await ran(["ok", "ok", "ok"]);
    const [rival] = await db
      .insert(competitors)
      .values({ tenantId: tenant.id, name: "Rival" })
      .returning();
    const [prompt] = await db
      .select()
      .from(aiVisibilityPrompts)
      .where(eq(aiVisibilityPrompts.tenantId, tenant.id));

    // This run's answers all name the competitor and never us…
    await db
      .update(aiVisibilitySamples)
      .set({
        extraction: {
          deterministic: { tenantMentioned: false, competitorIds: [rival.id], ownDomainCited: false },
        },
      })
      .where(eq(aiVisibilitySamples.runId, runId));

    // …and so did the run before it, which is what makes the gap two runs old
    // rather than one run of noise.
    const [previous] = await db
      .insert(aiVisibilityRuns)
      .values({
        tenantId: tenant.id,
        trigger: "scheduled",
        engines: ["openai"],
        samplesPerPrompt: 3,
        status: "complete",
        modelIds: { openai: "gpt-5.1" },
        startedAt: new Date("2026-02-23T09:00:00Z"),
      })
      .returning();
    await db.insert(aiVisibilityAggregates).values({
      runId: previous.id,
      tenantId: tenant.id,
      engine: "openai",
      promptId: prompt.id,
      n: 3,
      tenantMentions: 0,
      competitorMentions: { [rival.id]: 3 },
      ownCitations: 0,
      recommendations: 0,
    });

    const out = await finalizeRun(
      runId,
      { budgetMs: 60_000, now: frozen("2026-03-02T09:10:00Z") },
      { judge: noopJudge }
    );

    expect(out.signals).toBe(1);
    const rows = await db
      .select()
      .from(signals)
      .where(and(eq(signals.tenantId, tenant.id), eq(signals.kind, "ai_visibility")));
    expect(rows).toHaveLength(1);
    expect(rows[0].payload?.signalType).toBe("gap_vs_competitor");
    expect(rows[0].competitorId).toBe(rival.id);
    expect(rows[0].title).toContain("Rival");
  });

  it("calls the real emitSignals when none is injected", async () => {
    const { tenant, runId } = await ran(["ok", "ok", "ok"]);

    await finalizeRun(runId, { budgetMs: 60_000, now: frozen("2026-03-02T09:10:00Z") }, { judge: noopJudge });

    // Nothing here should trigger, but the call must have happened and must not
    // have thrown — the stub this replaced would have silently produced nothing
    // forever.
    const rows = await db
      .select()
      .from(signals)
      .where(and(eq(signals.tenantId, tenant.id), eq(signals.kind, "ai_visibility")));
    expect(rows).toEqual([]);
    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
    expect(run.status).toBe("complete");
  });
});

describe("latestRun", () => {
  it("returns the most recent run whatever its status, and null when there are none", async () => {
    const tenant = await seedTenant(TENANT);
    expect(await latestRun(tenant.id)).toBeNull();

    await db.insert(aiVisibilityRuns).values([
      {
        tenantId: tenant.id,
        trigger: "scheduled",
        engines: ["openai"],
        samplesPerPrompt: 3,
        status: "complete",
        startedAt: new Date("2026-03-01T09:00:00Z"),
      },
      {
        tenantId: tenant.id,
        trigger: "manual",
        engines: ["openai"],
        samplesPerPrompt: 3,
        status: "paused_by_cap",
        startedAt: new Date("2026-03-08T09:00:00Z"),
      },
    ]);

    const run = await latestRun(tenant.id);
    expect(run?.status).toBe("paused_by_cap");
    expect(run?.trigger).toBe("manual");
  });
});

describe("planRun guards not covered above", () => {
  it("treats a run still `pending` as in flight, not only a `running` one", async () => {
    const tenant = await seedTenant(TENANT);
    await seedSettings(tenant.id);
    await seedPrompt(tenant.id);
    // A run planned by an earlier tick that no slice has picked up yet. It owns
    // this tenant's work list just as much as a running one does — planning a
    // second would double the month's bill for the same prompt set.
    const [pending] = await db
      .insert(aiVisibilityRuns)
      .values({ tenantId: tenant.id, trigger: "scheduled", engines: ["openai"], samplesPerPrompt: 3, status: "pending" })
      .returning();

    const result = await planRun(tenant.id, { trigger: "manual", now: frozen("2026-03-02T09:00:00Z") });

    expect(result).toEqual({ ok: false, reason: "run_in_flight", runId: pending.id });
    // And the partial unique index agrees with the read-then-write guard about
    // which statuses count: `pending` is in the index predicate too.
    await expect(
      db.insert(aiVisibilityRuns).values({
        tenantId: tenant.id,
        trigger: "scheduled",
        engines: ["openai"],
        samplesPerPrompt: 3,
        status: "pending",
      })
    ).rejects.toThrow();
  });

  it("still reads an empty engine list as all three — the keys are what narrow it", async () => {
    const tenant = await seedTenant(TENANT);
    await seedSettings(tenant.id, { engines: [] }, { withKeys: false });
    await seedPrompt(tenant.id);
    for (const engine of ["openai", "gemini", "anthropic"] as const) {
      await seedEngineKey(tenant.id, engine);
    }

    const result = await planRun(tenant.id, { trigger: "manual", now: frozen("2026-03-02T09:00:00Z") });

    // `normalizeSettingsRow` still substitutes the full engine list for an
    // empty or entirely-unrecognised one, and that substitution is deliberately
    // NOT what BYOK changed: `effectiveEngines` is a second, separate narrowing
    // by key. Pinned here because the two are easy to conflate — with all three
    // keyed, an empty engines column plans all three exactly as it always did.
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const samples = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.runId, result.runId));
    expect(new Set(samples.map((s) => s.engine))).toEqual(
      new Set(["openai", "gemini", "anthropic"])
    );
  });

  it("refuses with `no_engines` when nothing is keyed — no fallback to all three", async () => {
    const tenant = await seedTenant(TENANT);
    // The migration state, and every existing tenant on ship day: three
    // engines switched on, zero keys. `normalizeSettingsRow` hands back all
    // three; `effectiveEngines` intersects them with nothing and, unlike that
    // function, does NOT fall back. Empty means empty — falling back here
    // would plan a ~$6.20 run on OUR keys for a tenant who connected nothing,
    // which is the one thing the hard gate exists to prevent.
    await seedSettings(tenant.id, { engines: ["openai", "gemini", "anthropic"] }, { withKeys: false });
    await seedPrompt(tenant.id);

    expect(await planRun(tenant.id, { trigger: "manual", now: frozen("2026-03-02T09:00:00Z") })).toEqual({
      ok: false,
      reason: "no_engines",
    });
    // Nothing was planned, and nothing was charged.
    expect(await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.tenantId, tenant.id))).toEqual([]);
  });

  it("plans only the keyed engines, not every engine the settings row names", async () => {
    const tenant = await seedTenant(TENANT);
    await seedSettings(
      tenant.id,
      { engines: ["openai", "gemini", "anthropic"], samplesPerPrompt: 1 },
      { withKeys: false }
    );
    await seedPrompt(tenant.id);
    await seedEngineKey(tenant.id, "gemini");

    const result = await planRun(tenant.id, { trigger: "manual", now: frozen("2026-03-02T09:00:00Z") });

    // The design's own worked example: "A tenant with `engines: [openai,
    // gemini, anthropic]` and one Gemini key runs Gemini, is quoted Gemini's
    // price, and sees one tile."
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const samples = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.runId, result.runId));
    expect(new Set(samples.map((s) => s.engine))).toEqual(new Set(["gemini"]));
    // And the run row records what it will actually ask, so the trend chart and
    // the tiles read the same engine list the planner used.
    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, result.runId));
    expect(run.engines).toEqual(["gemini"]);
  });

  it("ignores a key that is stored but switched off, and one that is not verified", async () => {
    const tenant = await seedTenant(TENANT);
    await seedSettings(tenant.id, { engines: ["openai", "gemini"] }, { withKeys: false });
    await seedPrompt(tenant.id);
    // "Saved, not in use" — the tenant paused ChatGPT for a month because it is
    // 3.7x Gemini per call. Off must mean not sampled, not merely not billed.
    await seedEngineKey(tenant.id, "openai", { enabled: false });
    // Rejected by the provider on the last run. A non-verified status is the
    // whole auto-pause mechanism: there is no separate paused flag.
    await seedEngineKey(tenant.id, "gemini", { status: "invalid_key" });

    expect(await planRun(tenant.id, { trigger: "manual", now: frozen("2026-03-02T09:00:00Z") })).toEqual({
      ok: false,
      reason: "no_engines",
    });
  });
});

describe("runSlice edge cases", () => {
  async function planned(overrides: Partial<typeof aiVisibilitySettings.$inferInsert> = {}) {
    const tenant = await seedTenant(TENANT);
    await seedSettings(tenant.id, { engines: ["openai"], samplesPerPrompt: 3, ...overrides });
    await seedPrompt(tenant.id, { text: "best issue tracker for startups" });
    const result = await planRun(tenant.id, { trigger: "manual", now: frozen("2026-03-02T09:00:00Z") });
    if (!result.ok) throw new Error(`planRun refused: ${result.reason}`);
    return { tenant, runId: result.runId };
  }

  it("is a no-op for a run id that does not exist", async () => {
    const outcome = await runSlice(
      crypto.randomUUID(),
      { budgetMs: 60_000, concurrency: 2, now: advancingClock("2026-03-02T09:00:00Z", 10) },
      { engines: { openai: fakeEngine("openai", () => answer()) } }
    );

    expect(outcome).toEqual({ processed: 0, remaining: 0, budgetSpent: false, pausedByCap: false, cancelled: false });
  });

  it("does not restart a run the cap already paused", async () => {
    const { runId } = await planned();
    await db.update(aiVisibilityRuns).set({ status: "paused_by_cap" }).where(eq(aiVisibilityRuns.id, runId));
    const openai = fakeEngine("openai", () => answer());

    const outcome = await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 2, now: advancingClock("2026-03-02T09:00:00Z", 10) },
      { engines: { openai } }
    );

    // Only `pending` and `running` are drivable. Resuming a cap-paused run here
    // would spend past a cap the tenant set on purpose, and un-say the message
    // the settings card is showing them.
    expect(outcome).toEqual({ processed: 0, remaining: 0, budgetSpent: false, pausedByCap: false, cancelled: false });
    expect(openai.calls).toHaveLength(0);
  });

  it("pauses before the first batch, and spends nothing, when the cap is already reached", async () => {
    const { tenant, runId } = await planned();
    await db
      .update(aiVisibilitySettings)
      .set({ monthlyCapUsd: 1 })
      .where(eq(aiVisibilitySettings.tenantId, tenant.id));
    await db.insert(aiVisibilityRuns).values({
      tenantId: tenant.id,
      trigger: "scheduled",
      status: "complete",
      engines: ["openai"],
      samplesPerPrompt: 3,
      costUsd: 1.5,
      startedAt: new Date("2026-03-01T09:00:00Z"),
    });
    const openai = fakeEngine("openai", () => answer());

    const outcome = await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 2, now: advancingClock("2026-03-02T09:00:00Z", 10) },
      { engines: { openai } }
    );

    // The cap check runs at the top of the loop, before any rows are claimed —
    // a run planned under the cap and sliced after the month has already blown
    // through it must not buy a single answer.
    expect(openai.calls).toHaveLength(0);
    expect(outcome.processed).toBe(0);
    expect(outcome.pausedByCap).toBe(true);
    expect(outcome.remaining).toBe(3);
    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
    expect(run.status).toBe("paused_by_cap");
  });

  it("records a sample whose engine has no client as an error, not as a crash", async () => {
    const { runId } = await planned();
    // What a retired engine id left in an already-planned work list looks like.
    const [orphan] = await db
      .select()
      .from(aiVisibilitySamples)
      .where(eq(aiVisibilitySamples.runId, runId))
      .orderBy(asc(aiVisibilitySamples.id))
      .limit(1);
    await db
      .update(aiVisibilitySamples)
      .set({ engine: "retired-engine" })
      .where(eq(aiVisibilitySamples.id, orphan.id));
    const openai = fakeEngine("openai", () => answer());

    const outcome = await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 1, now: advancingClock("2026-03-02T09:00:00Z", 10) },
      { engines: { openai } }
    );

    expect(outcome.processed).toBe(3);
    expect(outcome.remaining).toBe(0);
    const [updated] = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.id, orphan.id));
    expect(updated.status).toBe("error");
    expect(updated.error).toContain('no client for engine "retired-engine"');
    expect(updated.askedAt).not.toBeNull();
    // Billed as nothing, because nothing was asked — and the other two samples
    // still got their turn.
    expect(updated.costUsd).toBe(0);
    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
    expect(run.costUsd).toBeCloseTo(0.02, 5);
  });

  it("takes a lease that outlives its own budget by minutes, not milliseconds", async () => {
    const { runId } = await planned();
    const start = new Date("2026-03-02T09:00:00Z").getTime();
    const budgetMs = 60_000;
    let leaseSeenMidSlice: Date | null = null;
    const openai: EngineClient = {
      id: "openai",
      label: "openai (fake)",
      async ask() {
        if (leaseSeenMidSlice === null) {
          const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
          leaseSeenMidSlice = run.sliceLeaseUntil;
        }
        return answer();
      },
    };

    await runSlice(
      runId,
      { budgetMs, concurrency: 1, now: advancingClock("2026-03-02T09:00:00Z", 10) },
      { engines: { openai } }
    );

    // The budget bounds when the slice stops HANDING OUT work; the engine calls
    // already in flight still have to land. A lease that expired the instant
    // the budget did would be free for a second driver to take while the first
    // was still writing sample rows — the exact double-spend it exists to stop.
    expect(leaseSeenMidSlice).not.toBeNull();
    expect(leaseSeenMidSlice!.getTime() - (start + budgetMs)).toBeGreaterThanOrEqual(60_000);
  });

  it("remembers each engine's model id across slices instead of overwriting the map", async () => {
    const tenant = await seedTenant(TENANT);
    await seedSettings(tenant.id, { engines: ["openai", "gemini"], samplesPerPrompt: 1 });
    await seedPrompt(tenant.id, { text: "best issue tracker for startups" });
    const plan = await planRun(tenant.id, { trigger: "manual", now: frozen("2026-03-02T09:00:00Z") });
    if (!plan.ok) throw new Error(`planRun refused: ${plan.reason}`);

    // A clock that stands still until the first answer lands and then jumps
    // past the budget. Counting clock READS instead would be a hostage to how
    // many times `runSlice` happens to consult it per batch — this pins the
    // thing the test is actually about: exactly one batch, then a stop.
    const start = new Date("2026-03-02T09:00:00Z").getTime();
    let elapsedMs = 0;
    const burnTheBudget = () => {
      elapsedMs = 120_000;
    };
    const openai = fakeEngine("openai", () => {
      burnTheBudget();
      return answer({ modelId: "gpt-5.1-2026-01-01" });
    });
    const gemini = fakeEngine("gemini", () => {
      burnTheBudget();
      return answer({ modelId: "gemini-3.7-flash-2026-02-01" });
    });

    const first = await runSlice(
      plan.runId,
      { budgetMs: 60_000, concurrency: 1, now: () => new Date(start + elapsedMs) },
      { engines: { openai, gemini } }
    );
    expect(first.processed).toBe(1);
    expect(first.budgetSpent).toBe(true);

    await runSlice(
      plan.runId,
      { budgetMs: 60_000, concurrency: 1, now: advancingClock("2026-03-02T09:05:00Z", 10) },
      { engines: { openai, gemini } }
    );

    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, plan.runId));
    // The second slice seeds its map from the row rather than starting empty —
    // otherwise the model-version annotation loses whichever engine answered
    // first, and a model jump looks like a change in visibility.
    expect(run.modelIds).toEqual({
      openai: "gpt-5.1-2026-01-01",
      gemini: "gemini-3.7-flash-2026-02-01",
    });
  });

  it("keeps the paid-for answers when a competitor is deleted out from under extraction", async () => {
    const tenant = await seedTenant(TENANT);
    await seedSettings(tenant.id, { engines: ["openai"], samplesPerPrompt: 3 });
    await seedPrompt(tenant.id, { text: "best issue tracker for startups" });
    const [rival] = await db
      .insert(competitors)
      .values({ tenantId: tenant.id, name: "Rival", websiteUrl: "https://rival.com" })
      .returning();
    const plan = await planRun(tenant.id, { trigger: "manual", now: frozen("2026-03-02T09:00:00Z") });
    if (!plan.ok) throw new Error(`planRun refused: ${plan.reason}`);

    // The real mechanism, not a thrown stub: brand context is loaded ONCE at
    // slice start, so a competitor removed while the slice is running leaves
    // extraction inserting a citation row whose competitorId no longer has a
    // parent — a foreign-key violation, mid-batch, on answers already bought.
    let deleted = false;
    const openai: EngineClient = {
      id: "openai",
      label: "openai (fake)",
      async ask() {
        if (!deleted) {
          await db.delete(competitors).where(eq(competitors.id, rival.id));
          deleted = true;
        }
        return answer({ citations: [{ url: "https://rival.com/compare", position: 1 }] });
      },
    };

    const outcome = await runSlice(
      plan.runId,
      { budgetMs: 60_000, concurrency: 1, now: advancingClock("2026-03-02T09:00:00Z", 10) },
      { engines: { openai } }
    );

    expect(outcome.processed).toBe(3);
    const samples = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.runId, plan.runId));
    expect(samples.every((s) => s.status === "ok")).toBe(true);
    expect(samples.every((s) => s.answerText === "Acme and Rival are the usual picks.")).toBe(true);
    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, plan.runId));
    // The spend is recorded whatever extraction did — the money left the
    // building the moment the engine answered.
    expect(run.costUsd).toBeCloseTo(0.03, 5);
    // Nothing half-written: the citation rows this sample would have had are
    // simply absent, and `extractSample` is idempotent so they can be replayed.
    const citations = await db
      .select()
      .from(aiVisibilityCitations)
      .where(eq(aiVisibilityCitations.runId, plan.runId));
    expect(citations.every((c) => c.competitorId !== rival.id)).toBe(true);
  });
});

describe("finalizeRun preconditions and lease handling", () => {
  async function ran(sampleStatuses: string[]) {
    const tenant = await seedTenant(TENANT);
    await seedSettings(tenant.id, { engines: ["openai"], samplesPerPrompt: sampleStatuses.length });
    await seedPrompt(tenant.id, { text: "best issue tracker" });
    const planned = await planRun(tenant.id, { trigger: "manual", now: frozen("2026-03-02T09:00:00Z") });
    if (!planned.ok) throw new Error(`planRun refused: ${planned.reason}`);

    const rows = await db
      .select()
      .from(aiVisibilitySamples)
      .where(eq(aiVisibilitySamples.runId, planned.runId))
      .orderBy(asc(aiVisibilitySamples.sampleIndex));
    for (const [i, status] of sampleStatuses.entries()) {
      await db
        .update(aiVisibilitySamples)
        .set({
          status,
          answerText: status === "ok" ? "Rival is strongest." : null,
          error: status === "ok" ? null : "429 rate limited",
          extraction:
            status === "ok"
              ? { deterministic: { tenantMentioned: false, competitorIds: [], ownDomainCited: false } }
              : null,
        })
        .where(eq(aiVisibilitySamples.id, rows[i].id));
    }
    await db
      .update(aiVisibilityRuns)
      .set({ status: "running", completedCalls: sampleStatuses.length, costUsd: 0.05 })
      .where(eq(aiVisibilityRuns.id, planned.runId));
    return { tenant, runId: planned.runId };
  }

  const noopJudge = async () => ({ judged: 0, flagged: 0, remaining: 0, budgetSpent: false, errors: [] });

  it("reports a run that does not exist as failed rather than throwing", async () => {
    let judged = 0;

    const out = await finalizeRun(
      crypto.randomUUID(),
      { budgetMs: 60_000, now: frozen("2026-03-02T09:10:00Z") },
      {
        judge: async () => {
          judged++;
          return { judged: 0, flagged: 0, remaining: 0, budgetSpent: false, errors: [] };
        },
      }
    );

    expect(out).toEqual({ status: "failed", judged: 0, signals: 0 });
    expect(judged).toBe(0);
  });

  it("does not resurrect a run already recorded as failed", async () => {
    const { runId } = await ran(["ok", "ok", "ok"]);
    await db.update(aiVisibilityRuns).set({ status: "failed", error: "aggregate exploded" }).where(eq(aiVisibilityRuns.id, runId));
    let judged = 0;

    const out = await finalizeRun(
      runId,
      { budgetMs: 60_000, now: frozen("2026-03-02T09:10:00Z") },
      {
        judge: async () => {
          judged++;
          return { judged: 0, flagged: 0, remaining: 0, budgetSpent: false, errors: [] };
        },
        emit: async () => ({ written: 0, considered: 0 }),
      }
    );

    // Reported as itself. Quietly re-driving a failed run would spend judge
    // tokens on it and overwrite the error a human still has to read.
    expect(out).toEqual({ status: "failed", judged: 0, signals: 0 });
    expect(judged).toBe(0);
    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
    expect(run.status).toBe("failed");
    expect(run.error).toBe("aggregate exploded");
  });

  it("hands the lease back when it completes, so nothing waits out a claim nobody holds", async () => {
    const { runId } = await ran(["ok", "ok", "ok"]);

    await finalizeRun(
      runId,
      { budgetMs: 60_000, now: frozen("2026-03-02T09:10:00Z") },
      { judge: noopJudge, emit: async () => ({ written: 0, considered: 0 }) }
    );

    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
    expect(run.status).toBe("complete");
    expect(run.sliceLeaseUntil).toBeNull();
    expect(run.sliceLeaseOwner).toBeNull();
  });

  it("hands the lease back when it fails too", async () => {
    const { runId } = await ran(["ok", "ok", "ok"]);

    await finalizeRun(
      runId,
      { budgetMs: 60_000, now: frozen("2026-03-02T09:10:00Z") },
      {
        judge: noopJudge,
        aggregate: async () => {
          throw new Error("aggregate exploded");
        },
      }
    );

    // A failed finalize that kept its lease would block the retry for the whole
    // grace window, on the one run that most needs another look.
    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
    expect(run.status).toBe("failed");
    expect(run.sliceLeaseUntil).toBeNull();
    expect(run.sliceLeaseOwner).toBeNull();
  });

  it("keeps the judge's errors on a run it does complete, beside the engine summary", async () => {
    const { tenant, runId } = await ran(["ok", "error", "error"]);

    const out = await finalizeRun(
      runId,
      { budgetMs: 60_000, now: frozen("2026-03-02T09:10:00Z") },
      {
        judge: async () => ({
          judged: 1,
          flagged: 0,
          remaining: 0,
          budgetSpent: false,
          errors: ["gave up judging 2 sample(s) after 3 attempts"],
        }),
        emit: async () => ({ written: 0, considered: 0 }),
      }
    );

    expect(out.status).toBe("complete");
    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
    // Both halves of the story, on the row and on the source. A run that gave
    // up on two labels finished, but not cleanly, and the only place that fact
    // can be read is here.
    expect(run.error).toContain("openai failed on 2 of 3");
    expect(run.error).toContain("gave up judging");
    const [source] = await db
      .select()
      .from(sources)
      .where(and(eq(sources.tenantId, tenant.id), eq(sources.type, "ai_visibility")));
    expect(source.status).toBe("active");
    expect(source.lastError).toContain("gave up judging");
  });
});

describe("cancelRun", () => {
  /** A planned, un-driven run for the tenant, with `prompts` prompts on one engine. */
  async function plannedRun(prompts = 1) {
    const tenant = await seedTenant(TENANT);
    await seedSettings(tenant.id, { engines: ["openai"], samplesPerPrompt: 3 });
    for (let i = 0; i < prompts; i++) {
      await seedPrompt(tenant.id, { text: `best issue tracker for startups ${i}` });
    }
    const result = await planRun(tenant.id, { trigger: "manual", now: frozen("2026-03-02T09:00:00Z") });
    if (!result.ok) throw new Error(`planRun refused: ${result.reason}`);
    return { tenant, runId: result.runId, plannedCalls: result.plannedCalls };
  }

  /** Signals are a whole subsystem of their own; these tests are about the stop. */
  const noEmit = async () => ({ written: 0, considered: 0 });

  /**
   * An engine that answers normally, and whose FIRST call stops the run before
   * it returns — which is where a real Stop lands, mid-wave.
   *
   * The cancel is AWAITED inside `ask` rather than left floating, so the status
   * flip is committed before `mapWithConcurrency` resolves the wave and the
   * slice comes back round to its status check. A floating promise makes the
   * test a race against the connection pool, which is not the thing under test.
   */
  function stoppingEngine(tenantId: string): EngineClient & { calls: string[] } {
    const calls: string[] = [];
    let stopped = false;
    return {
      id: "openai",
      label: "openai (stops the run)",
      calls,
      async ask(prompt: string) {
        calls.push(prompt);
        if (!stopped) {
          stopped = true;
          await cancelRun(tenantId, { now: frozen("2026-03-02T09:05:00Z") }, { emit: noEmit });
        }
        return answer();
      },
    };
  }

  it("frees the tenant to plan a new run immediately", async () => {
    // The point of the whole feature. `cancelled` is outside the partial unique
    // index on `(tenant_id) WHERE status IN ('pending','running')`, so the next
    // plan is allowed the moment the stop lands — not after the monthly cap
    // lapses, which is the only exit that existed before.
    const { tenant, runId } = await plannedRun();

    const stopped = await cancelRun(tenant.id, { now: frozen("2026-03-02T09:05:00Z") }, { emit: noEmit });
    expect(stopped).toMatchObject({ ok: true, runId });

    const replanned = await planRun(tenant.id, { trigger: "manual", now: frozen("2026-03-02T09:06:00Z") });
    expect(replanned.ok).toBe(true);
    if (!replanned.ok) throw new Error("unreachable");
    expect(replanned.runId).not.toBe(runId);
  });

  it("releases the slice lease", async () => {
    // Nothing should have to wait out a lease on a run that will never resume —
    // and a driver still mid-slice fails its next renewal, which stops it even
    // if it somehow missed the status check.
    const { tenant, runId } = await plannedRun();
    await db
      .update(aiVisibilityRuns)
      .set({ sliceLeaseUntil: new Date("2026-03-02T09:30:00Z"), sliceLeaseOwner: crypto.randomUUID() })
      .where(eq(aiVisibilityRuns.id, runId));

    await cancelRun(tenant.id, { now: frozen("2026-03-02T09:05:00Z") }, { emit: noEmit });

    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
    expect(run.sliceLeaseUntil).toBeNull();
    expect(run.sliceLeaseOwner).toBeNull();
  });

  it("refuses cleanly when there is nothing in flight", async () => {
    const tenant = await seedTenant(TENANT);
    await seedSettings(tenant.id);

    expect(await cancelRun(tenant.id, { now: frozen("2026-03-02T09:05:00Z") }, { emit: noEmit })).toEqual({
      ok: false,
      reason: "not_in_flight",
    });
  });

  it("cannot be cancelled twice into a different state", async () => {
    // Two operators, or one impatient double-click. The flip is a single
    // conditional UPDATE, so the second press matches no row: it must not
    // re-stamp `finishedAt`, must not re-run the settle, and must not move the
    // run out of `cancelled`.
    const { tenant, runId } = await plannedRun();
    await cancelRun(tenant.id, { now: frozen("2026-03-02T09:05:00Z") }, { emit: noEmit });
    const [first] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));

    const second = await cancelRun(tenant.id, { now: frozen("2026-03-02T09:09:00Z") }, { emit: noEmit });

    expect(second).toEqual({ ok: false, reason: "not_in_flight" });
    const [after] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
    expect(after.status).toBe("cancelled");
    expect(after.finishedAt).toEqual(first.finishedAt);
  });

  it("stops runSlice handing out work after the current wave", async () => {
    // The stop that actually halts spending. The wave already handed to the
    // engines is bought either way — nothing aborts an HTTP call in flight — so
    // it lands; the batch after it is never claimed.
    const { tenant, runId, plannedCalls } = await plannedRun(3);
    expect(plannedCalls).toBe(9);

    const openai = stoppingEngine(tenant.id);

    const outcome = await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 3, now: advancingClock("2026-03-02T09:00:00Z", 10) },
      { engines: { openai } }
    );

    // One full wave of three, and not one call more out of nine.
    expect(openai.calls).toHaveLength(3);
    expect(outcome.cancelled).toBe(true);
    expect(outcome.processed).toBe(3);

    const samples = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.runId, runId));
    expect(samples.filter((s) => s.status === "ok")).toHaveLength(3);
    // The six that were never asked stay pending forever. That is what makes
    // `remaining` useless as a "is it over?" test and `cancelled` necessary.
    expect(samples.filter((s) => s.status === "pending")).toHaveLength(6);

    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
    expect(run.status).toBe("cancelled");
  });

  it("does not spend anything when the stop lands before any wave", async () => {
    const { tenant, runId } = await plannedRun();
    await cancelRun(tenant.id, { now: frozen("2026-03-02T09:05:00Z") }, { emit: noEmit });
    const openai = fakeEngine("openai", () => answer());

    const outcome = await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 3, now: advancingClock("2026-03-02T09:06:00Z", 10) },
      { engines: { openai } }
    );

    expect(openai.calls).toHaveLength(0);
    expect(outcome.cancelled).toBe(true);
  });

  it("keeps what the run bought, aggregates it, and admits it to the window", async () => {
    // Same admission rule as `paused_by_cap`: these are real answers that were
    // really paid for, and `isEligible` has already dropped the errored and
    // refused ones. Throwing the rest away would charge the tenant for
    // measurements and then refuse to show them.
    const { tenant, runId } = await plannedRun(3);
    const openai = stoppingEngine(tenant.id);

    await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 3, now: advancingClock("2026-03-02T09:00:00Z", 10) },
      { engines: { openai } }
    );

    const ok = await db
      .select()
      .from(aiVisibilitySamples)
      .where(and(eq(aiVisibilitySamples.runId, runId), eq(aiVisibilitySamples.status, "ok")));
    expect(ok).toHaveLength(3);

    const rows = await db
      .select()
      .from(aiVisibilityAggregates)
      .where(eq(aiVisibilityAggregates.runId, runId));
    expect(rows.length).toBeGreaterThan(0);

    // And the window admits it, or the aggregates are written where nothing
    // reads them — the exact bug `SETTLED_RUN_STATUSES` exists to prevent.
    const metrics = (await engineMetrics(tenant.id, db, () => new Date("2026-03-02T10:00:00Z"))).metrics;
    expect(metrics.find((m) => m.engine === "openai")?.n).toBe(ok.length);

    // Counters re-derived from the sample rows, not left on the per-batch tally.
    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
    expect(run.completedCalls).toBe(3);
    expect(run.costUsd).toBeCloseTo(0.03, 5);
    expect(run.error).toContain("Stopped after 3 of 9 calls");
    expect(run.finishedAt).not.toBeNull();
  });

  it("finalizeRun settles a cancelled run rather than resurrecting or judging it", async () => {
    const { tenant, runId } = await plannedRun();
    const openai = fakeEngine("openai", () => answer());
    await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 3, now: advancingClock("2026-03-02T09:00:00Z", 10) },
      { engines: { openai } }
    );
    // Cancel a drained run: it never reached finalize, and the sweep will never
    // look at it again, so `finalizeRun` is the only thing that could.
    await db.delete(aiVisibilityAggregates).where(eq(aiVisibilityAggregates.runId, runId));
    await db
      .update(aiVisibilityRuns)
      .set({ status: "running" })
      .where(eq(aiVisibilityRuns.id, runId));
    await cancelRun(tenant.id, { now: frozen("2026-03-02T09:05:00Z") }, { emit: noEmit });
    await db.delete(aiVisibilityAggregates).where(eq(aiVisibilityAggregates.runId, runId));

    const judge = async () => {
      throw new Error("the judge must not run after a human pressed Stop");
    };
    const result = await finalizeRun(
      runId,
      { budgetMs: 30_000, now: frozen("2026-03-02T09:06:00Z") },
      { judge: judge as never, emit: noEmit }
    );

    expect(result.status).toBe("cancelled");
    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
    expect(run.status).toBe("cancelled");
    const rows = await db
      .select()
      .from(aiVisibilityAggregates)
      .where(eq(aiVisibilityAggregates.runId, runId));
    expect(rows.length).toBeGreaterThan(0);
  });
});
