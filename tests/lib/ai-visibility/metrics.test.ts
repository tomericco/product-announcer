import { describe, it, expect, afterEach } from "vitest";
import { db } from "../../../src/db";
import {
  competitors,
  aiVisibilityAggregates,
  aiVisibilityCitations,
  aiVisibilityPrompts,
  aiVisibilityRuns,
  aiVisibilitySamples,
} from "../../../src/db/schema";
import {
  wilsonPp,
  clampBand,
  brandMentionTotal,
  windowCounts,
  engineMetrics,
  promptMatrix,
  promptHistory,
  engineHistory,
  runEngineHealth,
  promptSamples,
  HISTORY_RUNS,
  MIN_N_AGGREGATE,
  WINDOW_RUNS,
} from "../../../src/lib/ai-visibility/metrics";
import { seedTenant, dropTenant } from "../../helpers/fixtures";

const TENANT = "AI Visibility Metrics Test Tenant";

afterEach(async () => {
  await dropTenant(TENANT);
});

async function seedRun(tenantId: string, startedAt: string, status = "complete", modelIds: Record<string, string> = {}) {
  const [run] = await db
    .insert(aiVisibilityRuns)
    .values({
      tenantId,
      trigger: "scheduled",
      engines: ["openai", "perplexity"],
      samplesPerPrompt: 3,
      status,
      modelIds,
      startedAt: new Date(startedAt),
    })
    .returning();
  return run;
}

async function seedAggregate(a: {
  runId: string;
  tenantId: string;
  engine: string;
  promptId?: string | null;
  n: number;
  tenantMentions: number;
  competitorMentions?: Record<string, number>;
  ownCitations?: number;
  recommendations?: number;
}) {
  await db.insert(aiVisibilityAggregates).values({
    runId: a.runId,
    tenantId: a.tenantId,
    engine: a.engine,
    promptId: a.promptId ?? null,
    n: a.n,
    tenantMentions: a.tenantMentions,
    competitorMentions: a.competitorMentions ?? {},
    ownCitations: a.ownCitations ?? 0,
    recommendations: a.recommendations ?? 0,
  });
}

describe("wilsonPp", () => {
  it("returns null for an empty sample", () => {
    expect(wilsonPp(0, 0)).toBeNull();
    expect(wilsonPp(3, -1)).toBeNull();
  });

  it("narrows as n grows", () => {
    const small = wilsonPp(5, 10)!;
    const large = wilsonPp(50, 100)!;
    expect(small).toBeGreaterThan(large);
  });

  it("matches the textbook half-width at p = 0.5, n = 100", () => {
    // Wilson half-width at p=.5, n=100, z=1.96 is ~9.6 pp.
    expect(wilsonPp(50, 100)).toBeCloseTo(9.6, 1);
  });

  it("is a percentage-point figure, not a proportion", () => {
    expect(wilsonPp(1, 4)!).toBeGreaterThan(1);
  });
});

describe("windowCounts", () => {
  it("sums the last WINDOW_RUNS complete runs and ignores older and incomplete ones", async () => {
    const tenant = await seedTenant(TENANT);
    const runs = [];
    for (let i = 0; i < 5; i++) {
      runs.push(await seedRun(tenant.id, `2026-0${i + 1}-01T09:00:00Z`));
    }
    const running = await seedRun(tenant.id, "2026-06-01T09:00:00Z", "running");

    for (const run of runs) {
      await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: 10, tenantMentions: 4, ownCitations: 1 });
    }
    await seedAggregate({ runId: running.id, tenantId: tenant.id, engine: "openai", n: 99, tenantMentions: 99 });

    const counts = await windowCounts(tenant.id, { engine: "openai" });
    expect(counts.n).toBe(WINDOW_RUNS * 10);
    expect(counts.tenantMentions).toBe(WINDOW_RUNS * 4);
    expect(counts.ownCitations).toBe(WINDOW_RUNS * 1);
  });

  it("pools engines when none is given", async () => {
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: 10, tenantMentions: 6 });
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "perplexity", n: 10, tenantMentions: 2 });

    const counts = await windowCounts(tenant.id, {});
    expect(counts.n).toBe(20);
    expect(counts.tenantMentions).toBe(8);
  });

  it("sums competitor mention maps across runs", async () => {
    const tenant = await seedTenant(TENANT);
    const [rival] = await db.insert(competitors).values({ tenantId: tenant.id, name: "Rival" }).returning();
    const a = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    const b = await seedRun(tenant.id, "2026-03-08T09:00:00Z");
    await seedAggregate({ runId: a.id, tenantId: tenant.id, engine: "openai", n: 10, tenantMentions: 1, competitorMentions: { [rival.id]: 7 } });
    await seedAggregate({ runId: b.id, tenantId: tenant.id, engine: "openai", n: 10, tenantMentions: 2, competitorMentions: { [rival.id]: 5 } });

    const counts = await windowCounts(tenant.id, { engine: "openai" });
    expect(counts.competitorMentions).toEqual({ [rival.id]: 12 });
  });

  it("reads only engine-level rows unless a promptId is given", async () => {
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    const [prompt] = await db
      .insert(aiVisibilityPrompts)
      .values({ tenantId: tenant.id, text: "p", intent: "discovery", origin: "generated", status: "active" })
      .returning();
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: 10, tenantMentions: 4 });
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", promptId: prompt.id, n: 3, tenantMentions: 2 });

    expect((await windowCounts(tenant.id, { engine: "openai" })).n).toBe(10);
    expect((await windowCounts(tenant.id, { engine: "openai", promptId: prompt.id })).n).toBe(3);
  });

  it("honours `before` so a 30-day-ago window can be computed", async () => {
    const tenant = await seedTenant(TENANT);
    const old = await seedRun(tenant.id, "2026-01-01T09:00:00Z");
    const recent = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    await seedAggregate({ runId: old.id, tenantId: tenant.id, engine: "openai", n: 10, tenantMentions: 1 });
    await seedAggregate({ runId: recent.id, tenantId: tenant.id, engine: "openai", n: 10, tenantMentions: 9 });

    const before = await windowCounts(tenant.id, { engine: "openai", before: new Date("2026-02-01T00:00:00Z") });
    expect(before.tenantMentions).toBe(1);
  });

  it("is all zeroes, never NaN, for a tenant with no runs", async () => {
    const tenant = await seedTenant(TENANT);
    expect(await windowCounts(tenant.id, {})).toEqual({
      n: 0,
      tenantMentions: 0,
      ownCitations: 0,
      recommendations: 0,
      competitorMentions: {},
    });
  });
});

describe("engineMetrics", () => {
  // Frozen clock for the 30-day delta window. Every call passes it: seeded
  // runs have fixed 2026 dates, and a real wall clock would silently move
  // both windows past them as the calendar advances.
  const CLOCK = () => new Date("2026-03-30T00:00:00Z");

  it("returns the four engines plus a pooled all row, in order", async () => {
    const tenant = await seedTenant(TENANT);
    const rows = await engineMetrics(tenant.id, db, CLOCK);
    expect(rows.map((r) => r.engine)).toEqual(["openai", "perplexity", "gemini", "anthropic", "all"]);
  });

  it("hides every rate below the aggregate threshold but still reports n", async () => {
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: 10, tenantMentions: 5, competitorMentions: { x: 5 } });

    const openai = (await engineMetrics(tenant.id, db, CLOCK)).find((r) => r.engine === "openai")!;
    expect(openai.n).toBe(10);
    expect(openai.mentionRate).toBeNull();
    expect(openai.shareOfVoice).toBeNull();
    expect(openai.citationRate).toBeNull();
    expect(openai.recommendationRate).toBeNull();
    expect(openai.wilsonPp).toBeNull();
  });

  it("computes all four rates as percentages once n reaches the threshold", async () => {
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    await seedAggregate({
      runId: run.id,
      tenantId: tenant.id,
      engine: "openai",
      n: MIN_N_AGGREGATE,
      tenantMentions: 15,
      competitorMentions: { rival: 45 },
      ownCitations: 6,
      recommendations: 3,
    });

    const openai = (await engineMetrics(tenant.id, db, CLOCK)).find((r) => r.engine === "openai")!;
    expect(openai.mentionRate).toBeCloseTo(50, 4);
    expect(openai.shareOfVoice).toBeCloseTo(25, 4); // 15 / (15 + 45)
    expect(openai.citationRate).toBeCloseTo(20, 4);
    expect(openai.recommendationRate).toBeCloseTo(10, 4);
    expect(openai.wilsonPp).not.toBeNull();
  });

  it("pools samples for the all row rather than averaging engine rates", async () => {
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    // 90% on a thin engine, 10% on a fat one. An average of rates would be 50%;
    // pooling gives 20%.
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: 10, tenantMentions: 9, competitorMentions: { r: 1 } });
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "perplexity", n: 90, tenantMentions: 9, competitorMentions: { r: 81 } });

    const all = (await engineMetrics(tenant.id, db, CLOCK)).find((r) => r.engine === "all")!;
    expect(all.n).toBe(100);
    expect(all.shareOfVoice).toBeCloseTo(18, 4); // 18 / (18 + 82)
  });

  it("returns a null share of voice when no brand at all was named", async () => {
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: MIN_N_AGGREGATE, tenantMentions: 0 });

    const openai = (await engineMetrics(tenant.id, db, CLOCK)).find((r) => r.engine === "openai")!;
    expect(openai.mentionRate).toBe(0);
    expect(openai.shareOfVoice).toBeNull();
  });

  it("computes a 30-day delta against the window as it stood then", async () => {
    const tenant = await seedTenant(TENANT);
    const then = await seedRun(tenant.id, "2026-01-05T09:00:00Z");
    const now = await seedRun(tenant.id, "2026-03-05T09:00:00Z");
    await seedAggregate({ runId: then.id, tenantId: tenant.id, engine: "openai", n: MIN_N_AGGREGATE, tenantMentions: 10, competitorMentions: { r: 90 } });
    await seedAggregate({ runId: now.id, tenantId: tenant.id, engine: "openai", n: MIN_N_AGGREGATE, tenantMentions: 30, competitorMentions: { r: 70 } });

    const openai = (await engineMetrics(tenant.id, db, CLOCK)).find((r) => r.engine === "openai")!;
    // At the frozen clock (2026-03-30) the delta cut is 2026-02-28: the
    // current window includes BOTH runs (40 / 200 = 20%); the 30-day-ago
    // window includes only the January one (10 / 100 = 10%).
    expect(openai.deltaPp).toBeCloseTo(10, 4);
  });

  it("has a null delta when there is no earlier window to compare against", async () => {
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-05T09:00:00Z");
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: MIN_N_AGGREGATE, tenantMentions: 15, competitorMentions: { r: 15 } });

    const openai = (await engineMetrics(tenant.id, db, CLOCK)).find((r) => r.engine === "openai")!;
    expect(openai.deltaPp).toBeNull();
  });
});

async function seedPromptRow(tenantId: string, overrides: Record<string, unknown> = {}) {
  const [prompt] = await db
    .insert(aiVisibilityPrompts)
    .values({
      tenantId,
      text: "best issue tracker for startups",
      intent: "discovery",
      origin: "generated",
      status: "active",
      ...overrides,
    })
    .returning();
  return prompt;
}

describe("promptMatrix", () => {
  it("returns one row per active prompt with a cell per engine, un-thresholded", async () => {
    const tenant = await seedTenant(TENANT);
    const prompt = await seedPromptRow(tenant.id);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", promptId: prompt.id, n: 3, tenantMentions: 2 });
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "perplexity", promptId: prompt.id, n: 1, tenantMentions: 0 });

    const rows = await promptMatrix(tenant.id);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ promptId: prompt.id, text: "best issue tracker for startups", intent: "discovery", branded: false });
    expect(rows[0].cells.map((c) => c.engine)).toEqual(["openai", "perplexity", "gemini", "anthropic"]);
    expect(rows[0].cells.find((c) => c.engine === "openai")).toEqual({ engine: "openai", hits: 2, n: 3 });
    // Below MIN_N_PROMPT, but still returned raw — the UI decides what to render.
    expect(rows[0].cells.find((c) => c.engine === "perplexity")).toEqual({ engine: "perplexity", hits: 0, n: 1 });
    expect(rows[0].cells.find((c) => c.engine === "gemini")).toEqual({ engine: "gemini", hits: 0, n: 0 });
  });

  it("omits paused, proposed and rejected prompts", async () => {
    const tenant = await seedTenant(TENANT);
    await seedPromptRow(tenant.id, { text: "active one" });
    await seedPromptRow(tenant.id, { text: "paused one", status: "paused" });
    await seedPromptRow(tenant.id, { text: "proposed one", status: "proposed" });

    const rows = await promptMatrix(tenant.id);
    expect(rows.map((r) => r.text)).toEqual(["active one"]);
  });
});

describe("promptHistory", () => {
  it("returns up to HISTORY_RUNS complete runs oldest first, with the engine's model id", async () => {
    const tenant = await seedTenant(TENANT);
    const prompt = await seedPromptRow(tenant.id);
    const a = await seedRun(tenant.id, "2026-01-05T09:00:00Z", "complete", { openai: "gpt-5.0" });
    const b = await seedRun(tenant.id, "2026-01-12T09:00:00Z", "complete", { openai: "gpt-5.1" });
    await seedAggregate({ runId: a.id, tenantId: tenant.id, engine: "openai", promptId: prompt.id, n: 3, tenantMentions: 1 });
    await seedAggregate({ runId: b.id, tenantId: tenant.id, engine: "openai", promptId: prompt.id, n: 3, tenantMentions: 3 });

    const points = await promptHistory(tenant.id, prompt.id, "openai");

    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({ runId: a.id, hits: 1, n: 3, modelId: "gpt-5.0" });
    expect(points[1]).toMatchObject({ runId: b.id, hits: 3, n: 3, modelId: "gpt-5.1" });
    expect(points[0].runDate).toBe("2026-01-05T09:00:00.000Z");
    expect(HISTORY_RUNS).toBe(12);
  });

  it("pools engines and reports a null model id for \"all\"", async () => {
    const tenant = await seedTenant(TENANT);
    const prompt = await seedPromptRow(tenant.id);
    const run = await seedRun(tenant.id, "2026-01-05T09:00:00Z", "complete", { openai: "gpt-5.0" });
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", promptId: prompt.id, n: 3, tenantMentions: 2 });
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "perplexity", promptId: prompt.id, n: 3, tenantMentions: 1 });

    const points = await promptHistory(tenant.id, prompt.id, "all");
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ hits: 3, n: 6, modelId: null });
  });
});

describe("engineHistory", () => {
  it("plots share of voice per run and breaks the line below the threshold", async () => {
    const tenant = await seedTenant(TENANT);
    const thin = await seedRun(tenant.id, "2026-01-05T09:00:00Z", "complete", { openai: "gpt-5.0" });
    const fat = await seedRun(tenant.id, "2026-01-12T09:00:00Z", "complete", { openai: "gpt-5.1" });
    await seedAggregate({ runId: thin.id, tenantId: tenant.id, engine: "openai", n: 10, tenantMentions: 5, competitorMentions: { r: 5 } });
    await seedAggregate({ runId: fat.id, tenantId: tenant.id, engine: "openai", n: MIN_N_AGGREGATE, tenantMentions: 20, competitorMentions: { r: 60 } });

    const points = await engineHistory(tenant.id, "openai");

    expect(points).toHaveLength(2);
    expect(points[0].sovPct).toBeNull();
    expect(points[0].modelId).toBe("gpt-5.0");
    expect(points[1].sovPct).toBeCloseTo(25, 4);
    expect(points[1].modelId).toBe("gpt-5.1");
  });

  it("pools every engine for \"all\" and carries no model id", async () => {
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-01-05T09:00:00Z", "complete", { openai: "gpt-5.0" });
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: 20, tenantMentions: 10, competitorMentions: { r: 10 } });
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "perplexity", n: 20, tenantMentions: 10, competitorMentions: { r: 30 } });

    const points = await engineHistory(tenant.id, "all");
    expect(points[0].sovPct).toBeCloseTo((20 / 60) * 100, 4);
    expect(points[0].modelId).toBeNull();
  });
});

describe("runEngineHealth", () => {
  it("counts ok, errored and refused samples per engine and names the failing prompts", async () => {
    const tenant = await seedTenant(TENANT);
    const p1 = await seedPromptRow(tenant.id, { text: "one" });
    const p2 = await seedPromptRow(tenant.id, { text: "two" });
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z", "complete");

    const add = (promptId: string, engine: string, sampleIndex: number, status: string, error: string | null) =>
      db.insert(aiVisibilitySamples).values({
        runId: run.id,
        tenantId: tenant.id,
        promptId,
        engine,
        sampleIndex,
        status,
        error,
        answerText: status === "ok" ? "text" : null,
      });

    await add(p1.id, "openai", 0, "ok", null);
    await add(p1.id, "perplexity", 0, "error", "429 rate limited");
    await add(p2.id, "perplexity", 0, "error", "429 rate limited");
    await add(p2.id, "perplexity", 1, "refused", "no search results");

    const health = await runEngineHealth(tenant.id, run.id);

    const pplx = health.find((h) => h.engine === "perplexity")!;
    expect(pplx).toMatchObject({
      totalSamples: 3,
      okSamples: 0,
      erroredSamples: 2,
      refusedSamples: 1,
      erroredPrompts: 2,
    });
    expect(pplx.lastError).toContain("429");
    expect(health.find((h) => h.engine === "openai")).toMatchObject({ okSamples: 1, erroredSamples: 0, erroredPrompts: 0 });
  });

  it("returns nothing for a run with no samples", async () => {
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    expect(await runEngineHealth(tenant.id, run.id)).toEqual([]);
  });
});

describe("promptSamples", () => {
  async function seedAnswered() {
    const tenant = await seedTenant(TENANT);
    const other = await seedTenant(TENANT);
    const prompt = await seedPromptRow(tenant.id);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z", "complete");

    const [sample] = await db
      .insert(aiVisibilitySamples)
      .values({
        runId: run.id,
        tenantId: tenant.id,
        promptId: prompt.id,
        engine: "openai",
        sampleIndex: 0,
        status: "ok",
        answerText: "Rival is strongest.",
        modelId: "gpt-5.1",
        askedAt: new Date("2026-03-01T09:01:00Z"),
        judged: true,
        extraction: {
          deterministic: { tenantMentioned: false, competitorIds: [], ownDomainCited: false },
          judged: {
            orderedBrands: ["Rival"],
            level: "absent",
            framing: "not named",
            quote: "Rival is strongest",
            positioningClaims: [],
            hallucinations: [],
            answerType: "list",
          },
        },
      })
      .returning();

    await db.insert(aiVisibilityCitations).values([
      { sampleId: sample.id, tenantId: tenant.id, runId: run.id, url: "https://rival.com/b", domain: "rival.com", position: 2, domainClass: "competitor" },
      { sampleId: sample.id, tenantId: tenant.id, runId: run.id, url: "https://g2.com/a", domain: "g2.com", position: 1, domainClass: "review" },
    ]);

    return { tenant, other, prompt, run, sample };
  }

  it("returns the answer with its judge labels and ordered citations", async () => {
    const { tenant, prompt, sample } = await seedAnswered();

    const rows = await promptSamples(tenant.id, prompt.id, {});

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: sample.id,
      engine: "openai",
      sampleIndex: 0,
      status: "ok",
      modelId: "gpt-5.1",
      answerText: "Rival is strongest.",
      framing: "not named",
      quote: "Rival is strongest",
      level: "absent",
      flagged: false,
      error: null,
    });
    expect(rows[0].citations.map((c) => c.domain)).toEqual(["g2.com", "rival.com"]);
    expect(rows[0].citations[0].position).toBe(1);
  });

  it("refuses to cross tenants even when handed a real promptId", async () => {
    const { other, prompt } = await seedAnswered();
    expect(await promptSamples(other.id, prompt.id, {})).toEqual([]);
  });

  it("filters by engine and honours the limit", async () => {
    const { tenant, prompt, run } = await seedAnswered();
    await db.insert(aiVisibilitySamples).values({
      runId: run.id,
      tenantId: tenant.id,
      promptId: prompt.id,
      engine: "perplexity",
      sampleIndex: 0,
      status: "refused",
      error: "no search results",
      askedAt: new Date("2026-03-01T09:02:00Z"),
    });

    expect(await promptSamples(tenant.id, prompt.id, { engine: "perplexity" })).toHaveLength(1);
    expect((await promptSamples(tenant.id, prompt.id, { engine: "perplexity" }))[0].error).toBe("no search results");
    expect(await promptSamples(tenant.id, prompt.id, { limit: 1 })).toHaveLength(2); // one per engine
  });
});

/**
 * Review fixes. Each block names the finding it pins so a later edit that
 * reintroduces the behaviour fails with the reason attached.
 */
describe("wilson band responds to evidence, not to the competitor roster", () => {
  const CLOCK = () => new Date("2026-03-30T00:00:00Z");

  /** 84 answers, 26 of them naming the tenant, with a chosen competitor spread. */
  async function withCompetitors(competitorMentions: Record<string, number>) {
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    await seedAggregate({
      runId: run.id,
      tenantId: tenant.id,
      engine: "openai",
      n: 84,
      tenantMentions: 26,
      competitorMentions,
    });
    return (await engineMetrics(tenant.id, db, CLOCK)).find((r) => r.engine === "openai")!;
  }

  it("anchors the interval to answers, not to total brand mentions", async () => {
    // Two competitors, 60 mentions between them: 86 brand mentions over 84
    // answers. Anchored to mentions this reads 9.53 pp; anchored to the 84
    // independent answers it is 9.64.
    const two = await withCompetitors({ a: 30, b: 30 });
    expect(two.wilsonPp).toBeCloseTo(9.643, 2);
  });

  it("does not shrink the band when competitors are added to the roster", async () => {
    await withCompetitors({ a: 30, b: 30 });
    await dropTenant(TENANT);
    // Same 84 answers, same 26 mentions, four more rivals tracked. Anchored to
    // brand mentions this would report 4.54 pp — settings alone would appear to
    // double the precision. Anchored to answers it WIDENS, which is correct:
    // the tenant's share fell, so 26 hits say less about it than before.
    const six = await withCompetitors({ a: 30, b: 30, c: 30, d: 30, e: 30, f: 30 });
    expect(six.wilsonPp).toBeCloseTo(7.134, 2);
    expect(six.wilsonPp!).toBeGreaterThan(4.6);
  });

  it("is unchanged when the same mentions are split across more competitors", async () => {
    const lumped = await withCompetitors({ a: 60 });
    await dropTenant(TENANT);
    const split = await withCompetitors({ a: 20, b: 20, c: 20 });
    // Identical evidence, differently attributed. The band is a property of the
    // answers and the share, so nothing about it may move.
    expect(split.shareOfVoice).toBeCloseTo(lumped.shareOfVoice!, 10);
    expect(split.wilsonPp).toBeCloseTo(lumped.wilsonPp!, 10);
  });

  it("never claims more trials than there were brand mentions", async () => {
    // 40 answers, 5 brand mentions in total: the band must be the wide one that
    // 5 observations support, not the narrow one 40 answers would give.
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: 40, tenantMentions: 4, competitorMentions: { a: 1 } });
    const openai = (await engineMetrics(tenant.id, db, CLOCK)).find((r) => r.engine === "openai")!;
    expect(openai.wilsonPp).toBeCloseTo(wilsonPp(4, 5)!, 10);
  });
});

describe("a null share of voice is discriminated by mentionRate", () => {
  const CLOCK = () => new Date("2026-03-30T00:00:00Z");

  it("reports known-zero (not unknown) when the window is fat and nobody was named", async () => {
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: 84, tenantMentions: 0 });

    const openai = (await engineMetrics(tenant.id, db, CLOCK)).find((r) => r.engine === "openai")!;
    // The discriminator: a measured zero, so mentionRate is a NUMBER.
    expect(openai.mentionRate).toBe(0);
    expect(openai.shareOfVoice).toBeNull();
    expect(openai.n).toBe(84);
    // No brand mentions at all, so there is no proportion to put a band on.
    expect(openai.wilsonPp).toBeNull();
  });

  it("reports unknown when the window is thin, with mentionRate null", async () => {
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: 10, tenantMentions: 0 });

    const openai = (await engineMetrics(tenant.id, db, CLOCK)).find((r) => r.engine === "openai")!;
    expect(openai.mentionRate).toBeNull();
    expect(openai.shareOfVoice).toBeNull();
  });
});

describe("clampBand", () => {
  it("keeps a range inside 0..100", () => {
    expect(clampBand(0, 5.7)).toEqual({ lowPp: 0, highPp: 5.7 });
    expect(clampBand(98, 5)).toEqual({ lowPp: 93, highPp: 100 });
  });

  it("leaves an interior range alone", () => {
    const band = clampBand(30, 9.6);
    expect(band.lowPp).toBeCloseTo(20.4, 6);
    expect(band.highPp).toBeCloseTo(39.6, 6);
  });
});

describe("brandMentionTotal", () => {
  it("counts the tenant plus every tracked brand, including ids no longer in the roster", () => {
    expect(
      brandMentionTotal({ n: 84, tenantMentions: 26, ownCitations: 0, recommendations: 0, competitorMentions: { a: 30, deleted: 30 } })
    ).toBe(86);
  });
});

describe("promptMatrix ordering", () => {
  it("breaks a createdAt tie on id so the matrix does not reshuffle", async () => {
    const tenant = await seedTenant(TENANT);
    // One batched insert: Postgres `now()` is the transaction timestamp, so all
    // three rows carry an identical created_at — the generated-set case.
    const stamp = new Date("2026-02-01T09:00:00Z");
    await db.insert(aiVisibilityPrompts).values(
      ["c prompt", "a prompt", "b prompt"].map((text) => ({
        tenantId: tenant.id,
        text,
        intent: "discovery",
        origin: "generated",
        status: "active",
        createdAt: stamp,
      }))
    );

    const first = await promptMatrix(tenant.id);
    const second = await promptMatrix(tenant.id);
    expect(first.map((r) => r.promptId)).toEqual(second.map((r) => r.promptId));
    expect(first.map((r) => r.promptId)).toEqual([...first.map((r) => r.promptId)].sort());
  });
});

describe("promptHistory tenant scoping", () => {
  it("returns nothing for another tenant's promptId", async () => {
    const tenant = await seedTenant(TENANT);
    const other = await seedTenant(TENANT);
    const prompt = await seedPromptRow(tenant.id);
    const run = await seedRun(tenant.id, "2026-01-05T09:00:00Z", "complete", { openai: "gpt-5.0" });
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", promptId: prompt.id, n: 3, tenantMentions: 2 });

    expect(await promptHistory(tenant.id, prompt.id, "openai")).toHaveLength(1);
    expect(await promptHistory(other.id, prompt.id, "openai")).toEqual([]);
  });
});

describe("runEngineHealth pending rows and tenant scoping", () => {
  it("ignores pending samples so an in-flight run does not read as a failure", async () => {
    const tenant = await seedTenant(TENANT);
    const prompt = await seedPromptRow(tenant.id);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z", "running");

    await db.insert(aiVisibilitySamples).values([
      { runId: run.id, tenantId: tenant.id, promptId: prompt.id, engine: "openai", sampleIndex: 0, status: "ok", answerText: "text" },
      { runId: run.id, tenantId: tenant.id, promptId: prompt.id, engine: "openai", sampleIndex: 1, status: "pending" },
      { runId: run.id, tenantId: tenant.id, promptId: prompt.id, engine: "openai", sampleIndex: 2, status: "pending" },
      // A whole engine not yet started drops out rather than reporting 0 of 3.
      { runId: run.id, tenantId: tenant.id, promptId: prompt.id, engine: "gemini", sampleIndex: 0, status: "pending" },
    ]);

    const health = await runEngineHealth(tenant.id, run.id);
    expect(health.map((h) => h.engine)).toEqual(["openai"]);
    expect(health[0]).toMatchObject({ totalSamples: 1, okSamples: 1, erroredSamples: 0, refusedSamples: 0 });
  });

  it("returns nothing for another tenant's runId", async () => {
    const tenant = await seedTenant(TENANT);
    const other = await seedTenant(TENANT);
    const prompt = await seedPromptRow(tenant.id);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z", "complete");
    await db.insert(aiVisibilitySamples).values({
      runId: run.id, tenantId: tenant.id, promptId: prompt.id, engine: "openai", sampleIndex: 0, status: "ok", answerText: "text",
    });

    expect(await runEngineHealth(tenant.id, run.id)).toHaveLength(1);
    expect(await runEngineHealth(other.id, run.id)).toEqual([]);
  });
});

describe("promptSamples per-engine bounding", () => {
  it("returns a full set for a quiet engine even when a loud one owns the newest rows", async () => {
    const tenant = await seedTenant(TENANT);
    const prompt = await seedPromptRow(tenant.id);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z", "complete");

    // Twelve recent openai answers and two older perplexity ones. Fetching
    // `limit * 4 = 8` rows newest-first would return openai's eight and leave
    // the perplexity tab empty.
    await db.insert(aiVisibilitySamples).values(
      Array.from({ length: 12 }, (_, i) => ({
        runId: run.id,
        tenantId: tenant.id,
        promptId: prompt.id,
        engine: "openai",
        sampleIndex: i,
        status: "ok",
        answerText: `openai ${i}`,
        askedAt: new Date(Date.UTC(2026, 2, 2, 9, i)),
      }))
    );
    await db.insert(aiVisibilitySamples).values(
      Array.from({ length: 2 }, (_, i) => ({
        runId: run.id,
        tenantId: tenant.id,
        promptId: prompt.id,
        engine: "perplexity",
        sampleIndex: i,
        status: "ok",
        answerText: `perplexity ${i}`,
        askedAt: new Date(Date.UTC(2026, 2, 1, 9, i)),
      }))
    );

    const rows = await promptSamples(tenant.id, prompt.id, { limit: 2 });
    expect(rows.filter((r) => r.engine === "openai")).toHaveLength(2);
    expect(rows.filter((r) => r.engine === "perplexity")).toHaveLength(2);
    // Newest first across the flattened list.
    expect(rows[0].engine).toBe("openai");
  });
});
