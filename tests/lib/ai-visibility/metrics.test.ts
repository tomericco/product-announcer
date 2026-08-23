import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
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
  MIN_N_HISTORY,
  MIN_N_PROMPT,
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
      engines: ["openai", "gemini"],
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
  /** Defaults to `n` — every sample grounded, the pre-ungrounded-answers world. */
  nGrounded?: number;
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
    nGrounded: a.nGrounded ?? a.n,
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
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "gemini", n: 10, tenantMentions: 2 });

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
      nGrounded: 0,
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

  it("returns the three engines plus a pooled all row, in order", async () => {
    const tenant = await seedTenant(TENANT);
    const rows = (await engineMetrics(tenant.id, db, CLOCK)).metrics;
    expect(rows.map((r) => r.engine)).toEqual(["openai", "gemini", "anthropic", "all"]);
  });

  it("hides every rate below the aggregate threshold but still reports n", async () => {
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: 10, tenantMentions: 5, competitorMentions: { x: 5 } });

    const openai = (await engineMetrics(tenant.id, db, CLOCK)).metrics.find((r) => r.engine === "openai")!;
    expect(openai.n).toBe(10);
    expect(openai.mentionRate).toBeNull();
    expect(openai.shareOfVoice).toBeNull();
    expect(openai.citationRate).toBeNull();
    expect(openai.recommendationRate).toBeNull();
    expect(openai.sovWilsonPp).toBeNull();
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

    const openai = (await engineMetrics(tenant.id, db, CLOCK)).metrics.find((r) => r.engine === "openai")!;
    expect(openai.mentionRate).toBeCloseTo(50, 4);
    expect(openai.shareOfVoice).toBeCloseTo(25, 4); // 15 / (15 + 45)
    expect(openai.citationRate).toBeCloseTo(20, 4);
    expect(openai.recommendationRate).toBeCloseTo(10, 4);
    expect(openai.sovWilsonPp).not.toBeNull();
  });

  it("divides citation rate by the grounded samples, and every other rate by n", async () => {
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    // 60 answers, 40 of them grounded — Gemini answering the discovery half of
    // the prompt set from memory. Six own-domain citations out of the 40 that
    // could have carried one is 15%; over all 60 it would read 10%, which
    // charges the tenant for answers where nothing at all was cited.
    await seedAggregate({
      runId: run.id,
      tenantId: tenant.id,
      engine: "gemini",
      n: 60,
      nGrounded: 40,
      tenantMentions: 30,
      competitorMentions: { rival: 30 },
      ownCitations: 6,
      recommendations: 12,
    });

    const gemini = (await engineMetrics(tenant.id, db, CLOCK)).metrics.find((r) => r.engine === "gemini")!;
    expect(gemini.n).toBe(60);
    expect(gemini.citationRate).toBeCloseTo(15, 4);
    expect(gemini.mentionRate).toBeCloseTo(50, 4);
    expect(gemini.recommendationRate).toBeCloseTo(20, 4);
    expect(gemini.shareOfVoice).toBeCloseTo(50, 4);
  });

  it("nulls citation rate on a thin grounded window while the mention rates stay real", async () => {
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    // Plenty of answers, too few searched ones to say anything about sourcing.
    // The old doc block promised these were null together; they are not, and
    // "—" for citation rate beside a real 50% mention rate is the honest render.
    await seedAggregate({
      runId: run.id,
      tenantId: tenant.id,
      engine: "gemini",
      n: 90,
      nGrounded: MIN_N_AGGREGATE - 1,
      tenantMentions: 45,
      competitorMentions: { rival: 45 },
      ownCitations: 10,
      recommendations: 9,
    });

    const gemini = (await engineMetrics(tenant.id, db, CLOCK)).metrics.find((r) => r.engine === "gemini")!;
    expect(gemini.mentionRate).toBeCloseTo(50, 4);
    expect(gemini.citationRate).toBeNull();
  });

  it("pools the grounded counts for the all row too", async () => {
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    // Neither engine clears the grounded floor alone; pooled they do, and the
    // pooled rate is over the pooled grounded count, not over pooled n.
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: 40, nGrounded: 20, tenantMentions: 10, ownCitations: 4 });
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "gemini", n: 40, nGrounded: 20, tenantMentions: 10, ownCitations: 4 });

    const rows = (await engineMetrics(tenant.id, db, CLOCK)).metrics;
    expect(rows.find((r) => r.engine === "openai")!.citationRate).toBeNull();
    expect(rows.find((r) => r.engine === "all")!.citationRate).toBeCloseTo(20, 4);
  });

  it("pools samples for the all row rather than averaging engine rates", async () => {
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    // 90% on a thin engine, 10% on a fat one. An average of rates would be 50%;
    // pooling gives 20%.
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: 10, tenantMentions: 9, competitorMentions: { r: 1 } });
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "gemini", n: 90, tenantMentions: 9, competitorMentions: { r: 81 } });

    const all = (await engineMetrics(tenant.id, db, CLOCK)).metrics.find((r) => r.engine === "all")!;
    expect(all.n).toBe(100);
    expect(all.shareOfVoice).toBeCloseTo(18, 4); // 18 / (18 + 82)
  });

  it("returns a null share of voice when no brand at all was named", async () => {
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: MIN_N_AGGREGATE, tenantMentions: 0 });

    const openai = (await engineMetrics(tenant.id, db, CLOCK)).metrics.find((r) => r.engine === "openai")!;
    expect(openai.mentionRate).toBe(0);
    expect(openai.shareOfVoice).toBeNull();
  });

  it("computes a 30-day delta against the window as it stood then", async () => {
    const tenant = await seedTenant(TENANT);
    const then = await seedRun(tenant.id, "2026-01-05T09:00:00Z");
    const now = await seedRun(tenant.id, "2026-03-05T09:00:00Z");
    await seedAggregate({ runId: then.id, tenantId: tenant.id, engine: "openai", n: MIN_N_AGGREGATE, tenantMentions: 10, competitorMentions: { r: 90 } });
    await seedAggregate({ runId: now.id, tenantId: tenant.id, engine: "openai", n: MIN_N_AGGREGATE, tenantMentions: 30, competitorMentions: { r: 70 } });

    const openai = (await engineMetrics(tenant.id, db, CLOCK)).metrics.find((r) => r.engine === "openai")!;
    // At the frozen clock (2026-03-30) the delta cut is 2026-02-28: the
    // current window includes BOTH runs (40 / 200 = 20%); the 30-day-ago
    // window includes only the January one (10 / 100 = 10%).
    expect(openai.deltaPp).toBeCloseTo(10, 4);
  });

  it("has a null delta when there is no earlier window to compare against", async () => {
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-05T09:00:00Z");
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: MIN_N_AGGREGATE, tenantMentions: 15, competitorMentions: { r: 15 } });

    const openai = (await engineMetrics(tenant.id, db, CLOCK)).metrics.find((r) => r.engine === "openai")!;
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
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", promptId: prompt.id, n: 3, tenantMentions: 2, competitorMentions: { rival: 3 } });
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "gemini", promptId: prompt.id, n: 1, tenantMentions: 0 });

    const rows = await promptMatrix(tenant.id);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ promptId: prompt.id, text: "best issue tracker for startups", intent: "discovery", branded: false });
    expect(rows[0].cells.map((c) => c.engine)).toEqual(["openai", "gemini", "anthropic"]);
    expect(rows[0].cells.find((c) => c.engine === "openai")).toEqual({ engine: "openai", hits: 2, n: 3, competitorsNamed: 1 });
    // Below MIN_N_PROMPT, but still returned raw — the UI decides what to render.
    expect(rows[0].cells.find((c) => c.engine === "gemini")).toEqual({ engine: "gemini", hits: 0, n: 1, competitorsNamed: 0 });
    expect(rows[0].cells.find((c) => c.engine === "anthropic")).toEqual({ engine: "anthropic", hits: 0, n: 0, competitorsNamed: 0 });
  });

  it("counts DISTINCT competitors across the window, not one per run", async () => {
    // The same rival is named in every run of a four-run window. Summing the
    // jsonb keys would report one competitor as four, and the cell would claim
    // a crowd where there is one name.
    const tenant = await seedTenant(TENANT);
    const prompt = await seedPromptRow(tenant.id);
    for (const day of ["2026-02-08", "2026-02-15", "2026-02-22", "2026-03-01"]) {
      const run = await seedRun(tenant.id, `${day}T09:00:00Z`);
      await seedAggregate({
        runId: run.id,
        tenantId: tenant.id,
        engine: "openai",
        promptId: prompt.id,
        n: 3,
        tenantMentions: 0,
        competitorMentions: { rival: 3 },
      });
    }

    const rows = await promptMatrix(tenant.id);
    expect(rows[0].cells.find((c) => c.engine === "openai")!.competitorsNamed).toBe(1);
  });

  it("separates the two zeroes: rivals named here, and nobody named at all", async () => {
    const tenant = await seedTenant(TENANT);
    const gap = await seedPromptRow(tenant.id, { text: "best tools for teams" });
    const emptySpace = await seedPromptRow(tenant.id, { text: "how do teams do this" });
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    await seedAggregate({
      runId: run.id,
      tenantId: tenant.id,
      engine: "openai",
      promptId: gap.id,
      n: 3,
      tenantMentions: 0,
      competitorMentions: { a: 3, b: 2, c: 1 },
    });
    await seedAggregate({
      runId: run.id,
      tenantId: tenant.id,
      engine: "openai",
      promptId: emptySpace.id,
      n: 3,
      tenantMentions: 0,
    });

    const rows = await promptMatrix(tenant.id);
    const cellFor = (text: string) =>
      rows.find((r) => r.text === text)!.cells.find((c) => c.engine === "openai")!;
    // Identical `hits` and `n` — the whole finding is in the third number.
    expect(cellFor("best tools for teams")).toMatchObject({ hits: 0, n: 3, competitorsNamed: 3 });
    expect(cellFor("how do teams do this")).toMatchObject({ hits: 0, n: 3, competitorsNamed: 0 });
  });

  it("does not count a competitor an aggregate wrote down with a zero", async () => {
    const tenant = await seedTenant(TENANT);
    const prompt = await seedPromptRow(tenant.id);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    await seedAggregate({
      runId: run.id,
      tenantId: tenant.id,
      engine: "openai",
      promptId: prompt.id,
      n: 3,
      tenantMentions: 1,
      competitorMentions: { seen: 2, unseen: 0 },
    });

    const rows = await promptMatrix(tenant.id);
    expect(rows[0].cells.find((c) => c.engine === "openai")!.competitorsNamed).toBe(1);
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
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "gemini", promptId: prompt.id, n: 3, tenantMentions: 1 });

    const points = await promptHistory(tenant.id, prompt.id, "all");
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ hits: 3, n: 6, modelId: null });
  });
});

describe("engineHistory", () => {
  it("plots both series per run and breaks the line below the threshold", async () => {
    const tenant = await seedTenant(TENANT);
    const thin = await seedRun(tenant.id, "2026-01-05T09:00:00Z", "complete", { openai: "gpt-5.0" });
    const fat = await seedRun(tenant.id, "2026-01-12T09:00:00Z", "complete", { openai: "gpt-5.1" });
    await seedAggregate({ runId: thin.id, tenantId: tenant.id, engine: "openai", n: 10, tenantMentions: 5, competitorMentions: { r: 5 } });
    await seedAggregate({ runId: fat.id, tenantId: tenant.id, engine: "openai", n: MIN_N_AGGREGATE, tenantMentions: 20, competitorMentions: { r: 60 } });

    const points = await engineHistory(tenant.id, "openai");

    expect(points).toHaveLength(2);
    // Below n >= 30 NEITHER series has a number: a thin run drawn at 0% is
    // indistinguishable from losing every mention.
    expect(points[0].sovPct).toBeNull();
    expect(points[0].mentionPct).toBeNull();
    expect(points[0].modelId).toBe("gpt-5.0");
    expect(points[1].sovPct).toBeCloseTo(25, 4);
    // 20 of 30 answers named us — the series the tile plots, and deliberately
    // not the same number as the share beside it.
    expect(points[1].mentionPct).toBeCloseTo((20 / 30) * 100, 4);
    expect(points[1].modelId).toBe("gpt-5.1");
  });

  it("moves the two series independently — a share can fall while the mention rate holds", async () => {
    // The reason the tile may not plot one and headline the other. Same 30
    // answers naming us in both runs; in the second a rival starts appearing
    // beside us, which halves the share and leaves the mention rate untouched.
    const tenant = await seedTenant(TENANT);
    const before = await seedRun(tenant.id, "2026-01-05T09:00:00Z", "complete", { openai: "gpt-5.0" });
    const after = await seedRun(tenant.id, "2026-01-12T09:00:00Z", "complete", { openai: "gpt-5.0" });
    await seedAggregate({ runId: before.id, tenantId: tenant.id, engine: "openai", n: 30, tenantMentions: 30 });
    await seedAggregate({
      runId: after.id,
      tenantId: tenant.id,
      engine: "openai",
      n: 30,
      tenantMentions: 30,
      competitorMentions: { rival: 30 },
    });

    const points = await engineHistory(tenant.id, "openai");
    expect(points.map((point) => point.mentionPct)).toEqual([100, 100]);
    expect(points.map((point) => point.sovPct)).toEqual([100, 50]);
  });

  it("plots a cap-paused run, so the chart cannot say \"No runs yet\" over tiles full of numbers", async () => {
    // The bug this fixes: `historyRuns` filtered `status = "complete"` while
    // `windowRunIds` deliberately also takes `paused_by_cap`. A tenant whose
    // ONLY run stopped at the cost cap got real numbers on every tile above a
    // trend chart claiming there had never been a run.
    const tenant = await seedTenant(TENANT);
    const prompt = await seedPromptRow(tenant.id);
    const paused = await seedRun(tenant.id, "2026-01-05T09:00:00Z", "paused_by_cap", { openai: "gpt-5.1" });
    await seedAggregate({
      runId: paused.id,
      tenantId: tenant.id,
      engine: "openai",
      n: MIN_N_AGGREGATE,
      tenantMentions: 15,
    });
    await seedAggregate({
      runId: paused.id,
      tenantId: tenant.id,
      engine: "openai",
      promptId: prompt.id,
      n: MIN_N_PROMPT,
      tenantMentions: 2,
    });

    // The metrics window already counted it...
    expect((await windowCounts(tenant.id, { engine: "openai" })).n).toBe(MIN_N_AGGREGATE);
    // ...and now the history window agrees, for the pooled series and the
    // per-prompt one, both of which read the same run list.
    const points = await engineHistory(tenant.id, "openai");
    expect(points).toHaveLength(1);
    expect(points[0].runId).toBe(paused.id);
    expect(points[0].mentionPct).toBeCloseTo((15 / MIN_N_AGGREGATE) * 100, 4);
    expect(await engineHistory(tenant.id, "all")).toHaveLength(1);
    expect(await promptHistory(tenant.id, prompt.id, "openai")).toHaveLength(1);
  });

  it("still leaves an in-flight run out of the history, whose aggregates are partial", async () => {
    const tenant = await seedTenant(TENANT);
    const done = await seedRun(tenant.id, "2026-01-05T09:00:00Z", "complete");
    await seedAggregate({ runId: done.id, tenantId: tenant.id, engine: "openai", n: 30, tenantMentions: 15 });
    // One in-flight run per tenant at a time — a unique index enforces it — so
    // `running` stands for the whole in-flight family here.
    for (const [day, status] of [["12", "failed"], ["19", "running"]] as const) {
      const other = await seedRun(tenant.id, `2026-01-${day}T09:00:00Z`, status);
      await seedAggregate({ runId: other.id, tenantId: tenant.id, engine: "openai", n: 30, tenantMentions: 30 });
    }

    const points = await engineHistory(tenant.id, "openai");
    expect(points.map((point) => point.runId)).toEqual([done.id]);
  });

  describe("the history floor is MIN_N_HISTORY, not the tiles' MIN_N_AGGREGATE", () => {
    // The floor `engineHistory` applies is per RUN — it does not pool a window
    // the way the tiles do — and one run at the current shape
    // (MAX_ACTIVE_PROMPTS 5 x samplesPerPrompt 3) is 15 samples per engine. At
    // the strict 30 every per-engine point came back null and all three engine
    // lines on the trend chart never drew.
    it("is exactly one run's worth of samples, and the tiles' floor is untouched", () => {
      expect(MIN_N_HISTORY).toBe(15);
      expect(MIN_N_AGGREGATE).toBe(30);
      expect(MIN_N_HISTORY).toBeLessThan(MIN_N_AGGREGATE);
    });

    it("plots a per-engine point at 15 — one run — where the old floor drew nothing", async () => {
      const tenant = await seedTenant(TENANT);
      const run = await seedRun(tenant.id, "2026-01-05T09:00:00Z", "complete", { openai: "gpt-5.1" });
      await seedAggregate({
        runId: run.id,
        tenantId: tenant.id,
        engine: "openai",
        n: MIN_N_HISTORY,
        tenantMentions: 6,
        competitorMentions: { r: 9 },
      });

      const points = await engineHistory(tenant.id, "openai");
      expect(points).toHaveLength(1);
      expect(points[0].mentionPct).toBeCloseTo((6 / MIN_N_HISTORY) * 100, 4);
      expect(points[0].sovPct).toBeCloseTo((6 / 15) * 100, 4);
    });

    it("still BREAKS the line below 15 — a null, never a zero", async () => {
      // The bug the floor exists to prevent: a thin run rendered as 0% is
      // pixel-identical to losing every mention. `tenantMentions: 0` is the
      // sharp case — the honest-looking wrong answer is exactly the number
      // this run would produce if it were published.
      const tenant = await seedTenant(TENANT);
      const run = await seedRun(tenant.id, "2026-01-05T09:00:00Z");
      await seedAggregate({
        runId: run.id,
        tenantId: tenant.id,
        engine: "openai",
        n: MIN_N_HISTORY - 1,
        tenantMentions: 0,
        competitorMentions: { r: 14 },
      });

      const points = await engineHistory(tenant.id, "openai");
      expect(points).toHaveLength(1);
      expect(points[0].mentionPct).toBeNull();
      expect(points[0].sovPct).toBeNull();
      // And not by accident of the counts: a zero would be falsy too.
      expect(points[0].mentionPct).not.toBe(0);
    });

    it("holds the pooled \"all\" series to the SAME floor as the engine lines", async () => {
      // One chart, one evidentiary standard. Pooling three engines clears 15
      // and 30 alike on a normal run, so the choice only shows on a run thin
      // enough to sit between them: at n=20 pooled the combined line must draw,
      // because a gap there — while the engine lines carry on — reads to a
      // viewer as data loss rather than as a stricter standard.
      const tenant = await seedTenant(TENANT);
      const run = await seedRun(tenant.id, "2026-01-05T09:00:00Z");
      for (const engine of ["openai", "gemini"]) {
        await seedAggregate({ runId: run.id, tenantId: tenant.id, engine, n: 10, tenantMentions: 4 });
      }

      // Each engine alone is below the floor and breaks...
      expect((await engineHistory(tenant.id, "openai"))[0].mentionPct).toBeNull();
      // ...and the pooled 20 is above it, though still short of MIN_N_AGGREGATE.
      const pooled = await engineHistory(tenant.id, "all");
      expect(pooled[0].mentionPct).toBeCloseTo((8 / 20) * 100, 4);
    });

    it("does not lower the tiles: one 15-sample run plots but headlines nothing", async () => {
      // The whole trade in one assertion. The line gets its shape; the big
      // number beside it still refuses to be a number until n >= 30.
      const clock = () => new Date("2026-03-30T00:00:00Z");
      const tenant = await seedTenant(TENANT);
      const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
      await seedAggregate({
        runId: run.id,
        tenantId: tenant.id,
        engine: "openai",
        n: MIN_N_HISTORY,
        tenantMentions: 6,
        competitorMentions: { r: 9 },
      });

      expect((await engineHistory(tenant.id, "openai"))[0].mentionPct).not.toBeNull();

      const tile = (await engineMetrics(tenant.id, db, clock)).metrics.find((r) => r.engine === "openai")!;
      expect(tile.n).toBe(MIN_N_HISTORY);
      expect(tile.mentionRate).toBeNull();
      expect(tile.shareOfVoice).toBeNull();
    });
  });

  it("pools every engine for \"all\" and carries no model id", async () => {
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-01-05T09:00:00Z", "complete", { openai: "gpt-5.0" });
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: 20, tenantMentions: 10, competitorMentions: { r: 10 } });
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "gemini", n: 20, tenantMentions: 10, competitorMentions: { r: 30 } });

    const points = await engineHistory(tenant.id, "all");
    expect(points[0].sovPct).toBeCloseTo((20 / 60) * 100, 4);
    expect(points[0].mentionPct).toBeCloseTo((20 / 40) * 100, 4);
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
    await add(p1.id, "gemini", 0, "error", "429 rate limited");
    await add(p2.id, "gemini", 0, "error", "429 rate limited");
    await add(p2.id, "gemini", 1, "refused", "no search results");

    const health = await runEngineHealth(tenant.id, run.id);

    const gem = health.find((h) => h.engine === "gemini")!;
    expect(gem).toMatchObject({
      totalSamples: 3,
      okSamples: 0,
      erroredSamples: 2,
      refusedSamples: 1,
      erroredPrompts: 2,
    });
    expect(gem.lastError).toContain("429");
    // The ids, not only the count: the matrix dashes the cells that actually
    // failed, and a count cannot tell it which those are.
    expect([...gem.erroredPromptIds].sort()).toEqual([p1.id, p2.id].sort());
    expect(health.find((h) => h.engine === "openai")!.erroredPromptIds).toEqual([]);
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
      engine: "gemini",
      sampleIndex: 0,
      status: "refused",
      error: "no search results",
      askedAt: new Date("2026-03-01T09:02:00Z"),
    });

    expect(await promptSamples(tenant.id, prompt.id, { engine: "gemini" })).toHaveLength(1);
    expect((await promptSamples(tenant.id, prompt.id, { engine: "gemini" }))[0].error).toBe("no search results");
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
    return (await engineMetrics(tenant.id, db, CLOCK)).metrics.find((r) => r.engine === "openai")!;
  }

  it("anchors the interval to answers, not to total brand mentions", async () => {
    // Two competitors, 60 mentions between them: 86 brand mentions over 84
    // answers. Anchored to mentions this reads 9.53 pp; anchored to the 84
    // independent answers it is 9.64.
    const two = await withCompetitors({ a: 30, b: 30 });
    expect(two.sovWilsonPp).toBeCloseTo(9.643, 2);
  });

  it("does not shrink the band when competitors are added to the roster", async () => {
    await withCompetitors({ a: 30, b: 30 });
    await dropTenant(TENANT);
    // Same 84 answers, same 26 mentions, four more rivals tracked. Anchored to
    // brand mentions this would report 4.54 pp — settings alone would appear to
    // double the precision. Anchored to answers it WIDENS, which is correct:
    // the tenant's share fell, so 26 hits say less about it than before.
    const six = await withCompetitors({ a: 30, b: 30, c: 30, d: 30, e: 30, f: 30 });
    expect(six.sovWilsonPp).toBeCloseTo(7.134, 2);
    expect(six.sovWilsonPp!).toBeGreaterThan(4.6);
  });

  it("is unchanged when the same mentions are split across more competitors", async () => {
    const lumped = await withCompetitors({ a: 60 });
    await dropTenant(TENANT);
    const split = await withCompetitors({ a: 20, b: 20, c: 20 });
    // Identical evidence, differently attributed. The band is a property of the
    // answers and the share, so nothing about it may move.
    expect(split.shareOfVoice).toBeCloseTo(lumped.shareOfVoice!, 10);
    expect(split.sovWilsonPp).toBeCloseTo(lumped.sovWilsonPp!, 10);
  });

  it("never claims more trials than there were brand mentions", async () => {
    // 40 answers, 5 brand mentions in total: the band must be the wide one that
    // 5 observations support, not the narrow one 40 answers would give.
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: 40, tenantMentions: 4, competitorMentions: { a: 1 } });
    const openai = (await engineMetrics(tenant.id, db, CLOCK)).metrics.find((r) => r.engine === "openai")!;
    expect(openai.sovWilsonPp).toBeCloseTo(wilsonPp(4, 5)!, 10);
  });
});

describe("the mention-rate band is a plain binomial over answers", () => {
  const CLOCK = () => new Date("2026-03-30T00:00:00Z");

  it("is the Wilson half-width for tenantMentions out of n", async () => {
    // The band the TILE prints, now that mention rate is the headline. Unlike
    // the SOV band beside it, this one needs no anchoring argument: successes
    // and trials are both counted in answers.
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    await seedAggregate({
      runId: run.id,
      tenantId: tenant.id,
      engine: "openai",
      n: 84,
      tenantMentions: 26,
      competitorMentions: { a: 30, b: 30 },
    });

    const openai = (await engineMetrics(tenant.id, db, CLOCK)).metrics.find((r) => r.engine === "openai")!;
    expect(openai.mentionWilsonPp!).toBeCloseTo(wilsonPp(26, 84)!, 10);
    // And it is NOT the share band: the two describe different numbers, which
    // is the whole reason the tile stopped printing one beside the other.
    expect(openai.mentionWilsonPp).not.toBeCloseTo(openai.sovWilsonPp!, 3);
  });

  it("does not move when a competitor is added to the roster", async () => {
    // The SOV band had to be hand-anchored to answers to achieve this. The
    // mention band gets it for free — no competitor appears in its arithmetic.
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    await seedAggregate({
      runId: run.id,
      tenantId: tenant.id,
      engine: "openai",
      n: 84,
      tenantMentions: 26,
      competitorMentions: { a: 30, b: 30, c: 30, d: 30 },
    });

    const openai = (await engineMetrics(tenant.id, db, CLOCK)).metrics.find((r) => r.engine === "openai")!;
    expect(openai.mentionWilsonPp!).toBeCloseTo(wilsonPp(26, 84)!, 10);
  });

  it("is a real band at a measured zero, where the share band is null", async () => {
    // 0 of 84, nobody else named either. The share has no denominator and no
    // band; the headline still has both a rate and a width, which is what the
    // tile needs in order to be honest about a zero.
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: 84, tenantMentions: 0 });

    const openai = (await engineMetrics(tenant.id, db, CLOCK)).metrics.find((r) => r.engine === "openai")!;
    expect(openai.mentionRate).toBe(0);
    expect(openai.sovWilsonPp).toBeNull();
    expect(openai.mentionWilsonPp!).toBeCloseTo(wilsonPp(0, 84)!, 10);
  });

  it("is null below the display threshold, exactly when mentionRate is", async () => {
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: 29, tenantMentions: 20 });

    const openai = (await engineMetrics(tenant.id, db, CLOCK)).metrics.find((r) => r.engine === "openai")!;
    expect(openai.mentionRate).toBeNull();
    expect(openai.mentionWilsonPp).toBeNull();
  });
});

describe("a null share of voice is discriminated by mentionRate", () => {
  const CLOCK = () => new Date("2026-03-30T00:00:00Z");

  it("reports known-zero (not unknown) when the window is fat and nobody was named", async () => {
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: 84, tenantMentions: 0 });

    const openai = (await engineMetrics(tenant.id, db, CLOCK)).metrics.find((r) => r.engine === "openai")!;
    // The discriminator: a measured zero, so mentionRate is a NUMBER.
    expect(openai.mentionRate).toBe(0);
    expect(openai.shareOfVoice).toBeNull();
    expect(openai.n).toBe(84);
    // No brand mentions at all, so there is no proportion to put a band on.
    expect(openai.sovWilsonPp).toBeNull();
  });

  it("reports unknown when the window is thin, with mentionRate null", async () => {
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: 10, tenantMentions: 0 });

    const openai = (await engineMetrics(tenant.id, db, CLOCK)).metrics.find((r) => r.engine === "openai")!;
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
      brandMentionTotal({ n: 84, nGrounded: 84, tenantMentions: 26, ownCitations: 0, recommendations: 0, competitorMentions: { a: 30, deleted: 30 } })
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

    // Twelve recent openai answers and two older gemini ones. Fetching
    // `limit * 3 = 6` rows newest-first would return openai's six and leave
    // the gemini tab empty.
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
        engine: "gemini",
        sampleIndex: i,
        status: "ok",
        answerText: `gemini ${i}`,
        askedAt: new Date(Date.UTC(2026, 2, 1, 9, i)),
      }))
    );

    const rows = await promptSamples(tenant.id, prompt.id, { limit: 2 });
    expect(rows.filter((r) => r.engine === "openai")).toHaveLength(2);
    expect(rows.filter((r) => r.engine === "gemini")).toHaveLength(2);
    // Newest first across the flattened list.
    expect(rows[0].engine).toBe("openai");
  });
});

/**
 * QA additions. The Wilson numbers below were derived independently of the
 * implementation: each is `(upper − lower) / 2` of the interval obtained by
 * solving the score equation `(p̂ − p)² = z²·p(1 − p)/n` as a quadratic in `p`,
 * with z = 1.959963984540054. `metrics.ts` computes the algebraically
 * equivalent closed form, so agreement to six decimal places is a genuine
 * cross-check rather than a restatement of the code.
 */
describe("wilsonPp against independently derived Wilson intervals", () => {
  it("has no half-width to report without evidence", () => {
    expect(wilsonPp(0, 0)).toBeNull();
    expect(wilsonPp(0, -3)).toBeNull();
    expect(wilsonPp(1, Number.NaN)).toBeNull();
  });

  it("is wide at p = 0 and p = 1, where the normal approximation reports zero width", () => {
    // 0/30: exact Wilson [0, 11.351339] %, half-width 5.675670 pp. The Wald
    // interval is ±0.0 pp here, which is the whole reason this is Wilson.
    expect(wilsonPp(0, 30)!).toBeCloseTo(5.675670, 5);
    expect(wilsonPp(30, 30)!).toBeCloseTo(5.675670, 5);
  });

  it("says almost nothing at n = 1", () => {
    // [0, 79.345069] and [20.654931, 100]: same width, opposite ends.
    expect(wilsonPp(0, 1)!).toBeCloseTo(39.672534, 5);
    expect(wilsonPp(1, 1)!).toBeCloseTo(39.672534, 5);
  });

  it("matches the mid cases to six decimal places", () => {
    expect(wilsonPp(1, 30)!).toBeCloseTo(8.039766, 5);
    expect(wilsonPp(15, 30)!).toBeCloseTo(16.845874, 5);
    // The worked example from the review: 26 tenant mentions over 84 answers.
    expect(wilsonPp(26, 84)!).toBeCloseTo(9.703443, 5);
    // The existing test pins this only to one decimal.
    expect(wilsonPp(50, 100)!).toBeCloseTo(9.616847, 5);
  });

  it("is symmetric in successes and failures", () => {
    expect(wilsonPp(1, 30)!).toBeCloseTo(wilsonPp(29, 30)!, 10);
    expect(wilsonPp(26, 84)!).toBeCloseTo(wilsonPp(58, 84)!, 10);
  });

  it("cannot be un-shifted by clampBand, and does not pretend otherwise", () => {
    const band = wilsonPp(0, 30)!;
    // The exact interval for 0/30 is [0, 11.351339]: the clamp removes the
    // impossible lower half and leaves the upper half where it was.
    expect(clampBand(0, band)).toEqual({ lowPp: 0, highPp: band });
    expect(clampBand(0, band).highPp).toBeLessThan(11.351339);
  });
});

describe("the aggregate display threshold, at the boundary", () => {
  const CLOCK = () => new Date("2026-03-30T00:00:00Z");

  /** One engine-level row of size `n`, read back as its metrics row. */
  async function rowAt(n: number) {
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    await seedAggregate({
      runId: run.id,
      tenantId: tenant.id,
      engine: "openai",
      n,
      tenantMentions: 10,
      competitorMentions: { r: 10 },
      ownCitations: 4,
      recommendations: 2,
    });
    const row = (await engineMetrics(tenant.id, db, CLOCK)).metrics.find((r) => r.engine === "openai")!;
    await dropTenant(TENANT);
    return row;
  }

  it("hides every rate at 29 and shows them at 30 and 31", async () => {
    expect(MIN_N_AGGREGATE).toBe(30);

    const below = await rowAt(MIN_N_AGGREGATE - 1);
    expect(below.n).toBe(29);
    expect(below.mentionRate).toBeNull();
    expect(below.shareOfVoice).toBeNull();
    expect(below.citationRate).toBeNull();
    expect(below.recommendationRate).toBeNull();
    expect(below.sovWilsonPp).toBeNull();
    expect(below.deltaPp).toBeNull();

    // The threshold is `>= MIN_N_AGGREGATE`, so 30 itself is shown.
    const at = await rowAt(MIN_N_AGGREGATE);
    expect(at.n).toBe(30);
    expect(at.mentionRate).toBeCloseTo((10 / 30) * 100, 6);
    expect(at.shareOfVoice).toBeCloseTo(50, 6);
    expect(at.citationRate).toBeCloseTo((4 / 30) * 100, 6);
    expect(at.recommendationRate).toBeCloseTo((2 / 30) * 100, 6);
    expect(at.sovWilsonPp).not.toBeNull();

    const above = await rowAt(MIN_N_AGGREGATE + 1);
    expect(above.n).toBe(31);
    expect(above.mentionRate).toBeCloseTo((10 / 31) * 100, 6);
    expect(above.shareOfVoice).toBeCloseTo(50, 6);
  });
});

describe("the per-prompt threshold belongs to the caller, not to promptMatrix", () => {
  it("returns raw hits and n on both sides of MIN_N_PROMPT", async () => {
    expect(MIN_N_PROMPT).toBe(3);
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    const thin = await seedPromptRow(tenant.id, { text: "two samples" });
    const exact = await seedPromptRow(tenant.id, { text: "three samples" });
    const fat = await seedPromptRow(tenant.id, { text: "four samples" });
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", promptId: thin.id, n: 2, tenantMentions: 1 });
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", promptId: exact.id, n: 3, tenantMentions: 2 });
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", promptId: fat.id, n: 4, tenantMentions: 3 });

    const rows = await promptMatrix(tenant.id);
    const cell = (text: string) =>
      rows.find((r) => r.text === text)!.cells.find((c) => c.engine === "openai")!;

    // Below, at and above the cell threshold — all three come back raw, so the
    // cell component can tell "2 of 3 samples" from "the engine failed".
    expect(cell("two samples")).toEqual({ engine: "openai", hits: 1, n: 2, competitorsNamed: 0 });
    expect(cell("three samples")).toEqual({ engine: "openai", hits: 2, n: 3, competitorsNamed: 0 });
    expect(cell("four samples")).toEqual({ engine: "openai", hits: 3, n: 4, competitorsNamed: 0 });
  });
});

describe("the known-zero row and the unknown row are different shapes", () => {
  const CLOCK = () => new Date("2026-03-30T00:00:00Z");

  it("known zero: every rate is a measured number, and only the share is null", async () => {
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    // 84 answers, nobody named, nothing cited, nothing recommended.
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: 84, tenantMentions: 0 });

    const openai = (await engineMetrics(tenant.id, db, CLOCK)).metrics.find((r) => r.engine === "openai")!;
    expect(openai.n).toBe(84);
    // `mentionRate` is the discriminator, and it is a number: we measured this.
    expect(openai.mentionRate).toBe(0);
    expect(openai.citationRate).toBe(0);
    expect(openai.recommendationRate).toBe(0);
    // No brand mentions at all, so there is no proportion and no band.
    expect(openai.shareOfVoice).toBeNull();
    expect(openai.sovWilsonPp).toBeNull();
    expect(openai.deltaPp).toBeNull();
  });

  it("unknown: every rate is null, including the one that discriminates", async () => {
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    await seedAggregate({
      runId: run.id,
      tenantId: tenant.id,
      engine: "openai",
      n: 29,
      tenantMentions: 20,
      competitorMentions: { r: 5 },
      ownCitations: 10,
      recommendations: 5,
    });

    const openai = (await engineMetrics(tenant.id, db, CLOCK)).metrics.find((r) => r.engine === "openai")!;
    expect(openai.n).toBe(29);
    expect(openai.mentionRate).toBeNull();
    expect(openai.shareOfVoice).toBeNull();
    expect(openai.citationRate).toBeNull();
    expect(openai.recommendationRate).toBeNull();
    expect(openai.sovWilsonPp).toBeNull();
    expect(openai.deltaPp).toBeNull();
  });

  it("reports every rate on a 0..100 scale, not as a proportion", async () => {
    const tenant = await seedTenant(TENANT);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    // Every answer named us, cited us and recommended us; no rival was named.
    await seedAggregate({
      runId: run.id,
      tenantId: tenant.id,
      engine: "openai",
      n: 30,
      tenantMentions: 30,
      ownCitations: 30,
      recommendations: 30,
    });

    const openai = (await engineMetrics(tenant.id, db, CLOCK)).metrics.find((r) => r.engine === "openai")!;
    expect(openai.mentionRate).toBe(100);
    expect(openai.citationRate).toBe(100);
    expect(openai.recommendationRate).toBe(100);
    expect(openai.shareOfVoice).toBe(100);
    // p = 1 over 30 trials: the band is the one-sided Wilson width, not zero.
    expect(openai.sovWilsonPp!).toBeCloseTo(5.675670, 5);
  });
});

describe("deltaPp needs both windows to be readable", () => {
  const CLOCK = () => new Date("2026-03-30T00:00:00Z");

  /**
   * A run 30+ days before the frozen clock and one inside the last 30 days.
   * The current window covers both; the 30-day-ago window covers only the
   * older one, which is exactly the overlap the doc comment warns about.
   */
  async function twoWindows(then: { n: number; tenantMentions: number; competitorMentions?: Record<string, number> },
                            now: { n: number; tenantMentions: number; competitorMentions?: Record<string, number> }) {
    const tenant = await seedTenant(TENANT);
    const older = await seedRun(tenant.id, "2026-01-05T09:00:00Z");
    const newer = await seedRun(tenant.id, "2026-03-05T09:00:00Z");
    await seedAggregate({ runId: older.id, tenantId: tenant.id, engine: "openai", ...then });
    await seedAggregate({ runId: newer.id, tenantId: tenant.id, engine: "openai", ...now });
    const row = (await engineMetrics(tenant.id, db, CLOCK)).metrics.find((r) => r.engine === "openai")!;
    await dropTenant(TENANT);
    return row;
  }

  it("is null when the earlier window is below the threshold, even though the current one is not", async () => {
    const row = await twoWindows(
      { n: 29, tenantMentions: 10, competitorMentions: { r: 90 } },
      { n: 30, tenantMentions: 30, competitorMentions: { r: 70 } }
    );
    // The current window (59 samples) is readable...
    expect(row.n).toBe(59);
    expect(row.shareOfVoice).not.toBeNull();
    // ...but the window as it stood 30 days ago was 29 samples, and a delta
    // against a number nobody was allowed to see is not printable.
    expect(row.deltaPp).toBeNull();
  });

  it("is null when the current window is below the threshold", async () => {
    const row = await twoWindows(
      { n: 20, tenantMentions: 10, competitorMentions: { r: 90 } },
      { n: 5, tenantMentions: 3, competitorMentions: { r: 7 } }
    );
    expect(row.n).toBe(25);
    expect(row.deltaPp).toBeNull();
  });

  it("is null when a window has a share nobody can have", async () => {
    // The earlier window is fat but names no brand at all, so its share is
    // null rather than 0 — there is nothing to subtract from.
    const row = await twoWindows(
      { n: 40, tenantMentions: 0 },
      { n: 40, tenantMentions: 20, competitorMentions: { r: 20 } }
    );
    expect(row.n).toBe(80);
    expect(row.shareOfVoice).toBeCloseTo(50, 6);
    expect(row.deltaPp).toBeNull();
  });

  it("is the pp difference between the two overlapping windows when both clear", async () => {
    const row = await twoWindows(
      { n: 30, tenantMentions: 20, competitorMentions: { r: 80 } },
      { n: 30, tenantMentions: 60, competitorMentions: { r: 40 } }
    );
    // Then: 20 / 100 = 20%. Now: the window includes BOTH runs, so
    // 80 / 200 = 40%. The delta is damped by the overlap by design.
    expect(row.shareOfVoice).toBeCloseTo(40, 6);
    expect(row.deltaPp).toBeCloseTo(20, 6);
  });
});

describe("the window is the last four COMPLETE runs, summed", () => {
  it("sums every run there is when there are fewer than four", async () => {
    const tenant = await seedTenant(TENANT);
    for (const day of ["01", "08", "15"]) {
      const run = await seedRun(tenant.id, `2026-03-${day}T09:00:00Z`);
      await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: 10, tenantMentions: 3 });
    }
    const counts = await windowCounts(tenant.id, { engine: "openai" });
    expect(counts.n).toBe(30);
    expect(counts.tenantMentions).toBe(9);
  });

  it("sums exactly four when there are exactly four", async () => {
    const tenant = await seedTenant(TENANT);
    for (const day of ["01", "08", "15", "22"]) {
      const run = await seedRun(tenant.id, `2026-03-${day}T09:00:00Z`);
      await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: 10, tenantMentions: 3 });
    }
    const counts = await windowCounts(tenant.id, { engine: "openai" });
    expect(counts.n).toBe(WINDOW_RUNS * 10);
    expect(counts.tenantMentions).toBe(WINDOW_RUNS * 3);
  });

  it("drops the fifth-oldest run rather than averaging it in", async () => {
    const tenant = await seedTenant(TENANT);
    const oldest = await seedRun(tenant.id, "2026-02-01T09:00:00Z");
    // Distinctive counts, so a leak shows up as a number rather than a wobble.
    await seedAggregate({ runId: oldest.id, tenantId: tenant.id, engine: "openai", n: 1000, tenantMentions: 1000 });
    for (const day of ["01", "08", "15", "22"]) {
      const run = await seedRun(tenant.id, `2026-03-${day}T09:00:00Z`);
      await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: 10, tenantMentions: 3 });
    }
    const counts = await windowCounts(tenant.id, { engine: "openai" });
    expect(counts.n).toBe(40);
    expect(counts.tenantMentions).toBe(12);
  });

  it("excludes runs that never finished without letting them consume a window slot", async () => {
    const tenant = await seedTenant(TENANT);
    for (const day of ["01", "08", "15", "22"]) {
      const run = await seedRun(tenant.id, `2026-03-${day}T09:00:00Z`);
      await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: 10, tenantMentions: 3 });
    }
    // Two newer runs that never finished. Filtering AFTER the limit would leave
    // two complete runs in the window and report n = 20.
    for (const [day, status] of [["24", "failed"], ["26", "running"]] as const) {
      const run = await seedRun(tenant.id, `2026-03-${day}T09:00:00Z`, status);
      await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: 500, tenantMentions: 500 });
    }
    const counts = await windowCounts(tenant.id, { engine: "openai" });
    expect(counts.n).toBe(40);
    expect(counts.tenantMentions).toBe(12);
  });

  it("counts a cap-paused run, whose aggregates are as final as a complete one's", async () => {
    // Superseded assertion: this used to be lumped in with `failed` and
    // `running` as a run to exclude. `paused_by_cap` is terminal, not in
    // flight — `runSlice` aggregates what it bought before the cap tripped and
    // nothing ever resumes it — so excluding it threw away every answer the
    // tenant paid for, while the cost still counted against their cap.
    const tenant = await seedTenant(TENANT);
    for (const day of ["01", "08", "15", "22"]) {
      const run = await seedRun(tenant.id, `2026-03-${day}T09:00:00Z`);
      await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: 10, tenantMentions: 3 });
    }
    const paused = await seedRun(tenant.id, "2026-03-29T09:00:00Z", "paused_by_cap");
    await seedAggregate({ runId: paused.id, tenantId: tenant.id, engine: "openai", n: 5, tenantMentions: 2 });

    const counts = await windowCounts(tenant.id, { engine: "openai" });
    // The paused run takes the newest slot and the 1st drops out of the window.
    expect(counts.n).toBe(35);
    expect(counts.tenantMentions).toBe(11);
  });
});

describe("a deleted competitor keeps its place in the denominator", () => {
  const CLOCK = () => new Date("2026-03-30T00:00:00Z");

  it("still counts a hard-deleted competitor's mentions in share of voice", async () => {
    const tenant = await seedTenant(TENANT);
    const [rival] = await db.insert(competitors).values({ tenantId: tenant.id, name: "Rival" }).returning();
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z");
    await seedAggregate({
      runId: run.id,
      tenantId: tenant.id,
      engine: "openai",
      n: 40,
      tenantMentions: 10,
      competitorMentions: { [rival.id]: 30 },
    });

    // The roster row goes; the mentions it earned in this window stay, or
    // deleting a competitor would retroactively quadruple the tenant's share.
    await db.delete(competitors).where(eq(competitors.id, rival.id));

    const counts = await windowCounts(tenant.id, { engine: "openai" });
    expect(counts.competitorMentions[rival.id]).toBe(30);
    expect(brandMentionTotal(counts)).toBe(40);

    const openai = (await engineMetrics(tenant.id, db, CLOCK)).metrics.find((r) => r.engine === "openai")!;
    expect(openai.shareOfVoice).toBeCloseTo(25, 6);
  });
});

describe("history is capped at HISTORY_RUNS", () => {
  it("plots the newest twelve runs, oldest first, and drops the thirteenth", async () => {
    const tenant = await seedTenant(TENANT);
    const prompt = await seedPromptRow(tenant.id);
    const runs = [];
    for (let i = 1; i <= HISTORY_RUNS + 1; i++) {
      const run = await seedRun(tenant.id, `2026-01-${String(i).padStart(2, "0")}T09:00:00Z`);
      await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: 30, tenantMentions: 15, competitorMentions: { r: 15 } });
      await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", promptId: prompt.id, n: 3, tenantMentions: 1 });
      runs.push(run);
    }

    const engine = await engineHistory(tenant.id, "openai");
    expect(engine).toHaveLength(HISTORY_RUNS);
    // The oldest run fell off the front; the series still reads oldest-first.
    expect(engine[0].runId).toBe(runs[1].id);
    expect(engine.at(-1)!.runId).toBe(runs.at(-1)!.id);
    expect(engine.map((p) => p.runDate)).toEqual([...engine.map((p) => p.runDate)].sort());

    const history = await promptHistory(tenant.id, prompt.id, "openai");
    expect(history).toHaveLength(HISTORY_RUNS);
    expect(history[0].runId).toBe(runs[1].id);
  });
});

describe("runEngineHealth reporting", () => {
  it("names the most recent error and lists engines in engine order", async () => {
    const tenant = await seedTenant(TENANT);
    const prompt = await seedPromptRow(tenant.id);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z", "complete");

    // Inserted newest-first, so a reader that trusts insertion order rather
    // than `askedAt` reports the older message.
    await db.insert(aiVisibilitySamples).values([
      { runId: run.id, tenantId: tenant.id, promptId: prompt.id, engine: "gemini", sampleIndex: 1, status: "error", error: "later: 503 unavailable", askedAt: new Date("2026-03-01T10:00:00Z") },
      { runId: run.id, tenantId: tenant.id, promptId: prompt.id, engine: "gemini", sampleIndex: 0, status: "error", error: "earlier: 429 rate limited", askedAt: new Date("2026-03-01T09:00:00Z") },
      { runId: run.id, tenantId: tenant.id, promptId: prompt.id, engine: "openai", sampleIndex: 0, status: "ok", answerText: "text", askedAt: new Date("2026-03-01T09:30:00Z") },
    ]);

    const health = await runEngineHealth(tenant.id, run.id);
    // ENGINE_IDS order (openai, gemini, anthropic), not the order
    // the rows came back in, and engines with no attempts are absent.
    expect(health.map((h) => h.engine)).toEqual(["openai", "gemini"]);
    expect(health.find((h) => h.engine === "gemini")!.lastError).toBe("later: 503 unavailable");
  });
});

describe("promptSamples at samplesPerPrompt: 5", () => {
  it("returns a full five for every engine rather than five in total", async () => {
    const tenant = await seedTenant(TENANT);
    const prompt = await seedPromptRow(tenant.id);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z", "complete");

    // Three engines, six answers each. openai's are the newest, so an
    // over-fetch of `limit * 3 = 15` newest rows would return openai's six and
    // starve the other two tabs.
    const engines = ["anthropic", "gemini", "openai"] as const;
    for (const [engineIndex, engine] of engines.entries()) {
      await db.insert(aiVisibilitySamples).values(
        Array.from({ length: 6 }, (_, i) => ({
          runId: run.id,
          tenantId: tenant.id,
          promptId: prompt.id,
          engine,
          sampleIndex: i,
          status: "ok",
          answerText: `${engine} ${i}`,
          askedAt: new Date(Date.UTC(2026, 2, 1, 9 + engineIndex, i)),
        }))
      );
    }

    const rows = await promptSamples(tenant.id, prompt.id, { limit: 5 });
    expect(rows).toHaveLength(15);
    for (const engine of engines) {
      const forEngine = rows.filter((r) => r.engine === engine);
      expect(forEngine).toHaveLength(5);
      // The newest five of that engine's six, not an arbitrary five.
      expect(forEngine.map((r) => r.answerText)).toEqual([
        `${engine} 5`,
        `${engine} 4`,
        `${engine} 3`,
        `${engine} 2`,
        `${engine} 1`,
      ]);
    }
    expect(rows[0].engine).toBe("openai");
  });
});

describe("every read is scoped to the tenant it was asked for", () => {
  const CLOCK = () => new Date("2026-03-30T00:00:00Z");

  it("returns a foreign tenant nothing, never the owner's numbers", async () => {
    const tenant = await seedTenant(TENANT);
    const other = await seedTenant(TENANT);
    const prompt = await seedPromptRow(tenant.id);
    const run = await seedRun(tenant.id, "2026-03-01T09:00:00Z", "complete", { openai: "gpt-5.1" });
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", n: 40, tenantMentions: 20, competitorMentions: { r: 20 } });
    await seedAggregate({ runId: run.id, tenantId: tenant.id, engine: "openai", promptId: prompt.id, n: 3, tenantMentions: 2 });
    await db.insert(aiVisibilitySamples).values({
      runId: run.id, tenantId: tenant.id, promptId: prompt.id, engine: "openai", sampleIndex: 0,
      status: "ok", answerText: "text", askedAt: new Date("2026-03-01T09:05:00Z"),
    });

    // The fixture is real for its owner...
    expect((await windowCounts(tenant.id, {})).n).toBe(40);
    expect((await engineMetrics(tenant.id, db, CLOCK)).metrics.find((r) => r.engine === "openai")!.shareOfVoice).toBeCloseTo(50, 6);
    expect(await promptMatrix(tenant.id)).toHaveLength(1);
    expect(await engineHistory(tenant.id, "openai")).toHaveLength(1);
    expect(await promptHistory(tenant.id, prompt.id, "openai")).toHaveLength(1);
    expect(await runEngineHealth(tenant.id, run.id)).toHaveLength(1);
    expect(await promptSamples(tenant.id, prompt.id, {})).toHaveLength(1);

    // ...and invisible to anybody else, including when they hand over a real
    // promptId or runId lifted from a URL.
    expect(await windowCounts(other.id, {})).toEqual({
      n: 0, nGrounded: 0, tenantMentions: 0, ownCitations: 0, recommendations: 0, competitorMentions: {},
    });
    const foreign = (await engineMetrics(other.id, db, CLOCK)).metrics;
    expect(foreign.map((r) => r.n)).toEqual([0, 0, 0, 0]);
    expect(foreign.every((r) => r.mentionRate === null && r.shareOfVoice === null)).toBe(true);
    expect(await promptMatrix(other.id)).toEqual([]);
    expect(await engineHistory(other.id, "openai")).toEqual([]);
    expect(await promptHistory(other.id, prompt.id, "openai")).toEqual([]);
    expect(await promptHistory(other.id, prompt.id, "all")).toEqual([]);
    expect(await runEngineHealth(other.id, run.id)).toEqual([]);
    expect(await promptSamples(other.id, prompt.id, {})).toEqual([]);
    expect(await promptSamples(other.id, prompt.id, { engine: "openai" })).toEqual([]);
  });
});
