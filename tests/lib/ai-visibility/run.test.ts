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
  sources,
} from "../../../src/db/schema";
import type { EngineAnswer, EngineClient, EngineError } from "../../../src/lib/ai-visibility/types";
import { finalizeRun, latestRun, planRun, runSlice } from "../../../src/lib/ai-visibility/run";
import { seedTenant, dropTenant } from "../../helpers/fixtures";

const TENANT = "AI Visibility Run Test Tenant";

/** A clock that never moves. Enough for planning; D3 uses an advancing one. */
const frozen = (iso: string) => () => new Date(iso);

afterEach(async () => {
  await dropTenant(TENANT);
});

async function seedSettings(
  tenantId: string,
  overrides: Partial<typeof aiVisibilitySettings.$inferInsert> = {}
) {
  await db.insert(aiVisibilitySettings).values({
    tenantId,
    enabled: true,
    engines: ["openai", "perplexity"],
    samplesPerPrompt: 3,
    monthlyCapUsd: 20,
    ...overrides,
  });
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
      engines: ["openai", "perplexity"],
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
    expect(run.engines.sort()).toEqual(["openai", "perplexity"]);
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
  id: "openai" | "perplexity",
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

    expect(outcome).toEqual({ processed: 3, remaining: 0, budgetSpent: false, pausedByCap: false });
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

  it("stores a refusal as refused and an error as error, without failing the slice", async () => {
    const { runId } = await planned();
    const openai = fakeEngine("openai", (_p, call) => {
      if (call === 1) return { kind: "refused", message: "no search results" };
      if (call === 2) return { kind: "error", message: "429 rate limited" };
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
    expect(samples.find((s) => s.status === "error")?.error).toContain("429");
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
      call === 1 ? { kind: "error", message: "cut off at the token ceiling", costUsd: 0.007 } : answer()
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
    expect(source.lastError).toContain("monthly cap");
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

    expect(outcome).toEqual({ processed: 0, remaining: 0, budgetSpent: false, pausedByCap: false });
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
    expect(outcome).toEqual({ processed: 0, remaining: 0, budgetSpent: false, pausedByCap: false });
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
    const openai = fakeEngine("openai", () => ({ kind: "error", message: "boom" }) as const);
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

  it("plans every engine when the settings row holds an empty engine list", async () => {
    const tenant = await seedTenant(TENANT);
    await seedSettings(tenant.id, { engines: [] });
    await seedPrompt(tenant.id);

    const result = await planRun(tenant.id, { trigger: "manual", now: frozen("2026-03-02T09:00:00Z") });

    // `getAiVisibilitySettings` substitutes the full engine list for an empty
    // or entirely-unrecognised one, which is why `planRun` has no zero-engine
    // refusal to reach. Pinned here because that substitution is the reason an
    // enabled feature never plans zero calls behind a green badge — a change to
    // it should show up as a failure here rather than as a tenant whose weekly
    // run quietly does nothing.
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const samples = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.runId, result.runId));
    expect(new Set(samples.map((s) => s.engine))).toEqual(
      new Set(["openai", "perplexity", "gemini", "anthropic"])
    );
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

    expect(outcome).toEqual({ processed: 0, remaining: 0, budgetSpent: false, pausedByCap: false });
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
    expect(outcome).toEqual({ processed: 0, remaining: 0, budgetSpent: false, pausedByCap: false });
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
    await seedSettings(tenant.id, { engines: ["openai", "perplexity"], samplesPerPrompt: 1 });
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
    const perplexity = fakeEngine("perplexity", () => {
      burnTheBudget();
      return answer({ modelId: "sonar-pro-2026-02-01" });
    });

    const first = await runSlice(
      plan.runId,
      { budgetMs: 60_000, concurrency: 1, now: () => new Date(start + elapsedMs) },
      { engines: { openai, perplexity } }
    );
    expect(first.processed).toBe(1);
    expect(first.budgetSpent).toBe(true);

    await runSlice(
      plan.runId,
      { budgetMs: 60_000, concurrency: 1, now: advancingClock("2026-03-02T09:05:00Z", 10) },
      { engines: { openai, perplexity } }
    );

    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, plan.runId));
    // The second slice seeds its map from the row rather than starting empty —
    // otherwise the model-version annotation loses whichever engine answered
    // first, and a model jump looks like a change in visibility.
    expect(run.modelIds).toEqual({
      openai: "gpt-5.1-2026-01-01",
      perplexity: "sonar-pro-2026-02-01",
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
