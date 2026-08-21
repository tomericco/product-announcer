import { describe, it, expect, afterEach } from "vitest";
import { db } from "../../../src/db";
import {
  competitors,
  aiVisibilityAggregates,
  aiVisibilityPrompts,
  aiVisibilityRuns,
} from "../../../src/db/schema";
import {
  wilsonPp,
  windowCounts,
  engineMetrics,
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
