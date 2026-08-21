import { describe, it, expect, afterEach } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../../../src/db";
import {
  aiVisibilityPrompts,
  aiVisibilityRuns,
  aiVisibilitySamples,
  aiVisibilityAggregates,
  aiVisibilitySettings,
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
