import { describe, it, expect, afterEach } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../../src/db";
import {
  competitors,
  aiVisibilityAggregates,
  aiVisibilityPrompts,
  aiVisibilityRuns,
  aiVisibilitySamples,
} from "../../../src/db/schema";
import { computeAggregates, isEligible } from "../../../src/lib/ai-visibility/aggregate";
import { seedTenant, dropTenant } from "../../helpers/fixtures";
import type { SampleExtraction } from "../../../src/lib/ai-visibility/types";

const TENANT = "AI Visibility Aggregate Test Tenant";

afterEach(async () => {
  await dropTenant(TENANT);
});

describe("isEligible", () => {
  const okSample = { status: "ok", flagged: false };
  const plainPrompt = { branded: false, intent: "discovery" };

  it("accepts an ok, unflagged sample on an unbranded prompt", () => {
    expect(isEligible(okSample, plainPrompt)).toBe(true);
  });

  it("rejects errored, refused and still-pending samples", () => {
    expect(isEligible({ status: "error", flagged: false }, plainPrompt)).toBe(false);
    expect(isEligible({ status: "refused", flagged: false }, plainPrompt)).toBe(false);
    expect(isEligible({ status: "pending", flagged: false }, plainPrompt)).toBe(false);
  });

  it("rejects flagged rows", () => {
    expect(isEligible({ status: "ok", flagged: true }, plainPrompt)).toBe(false);
  });

  it("rejects branded and brand_check prompts", () => {
    expect(isEligible(okSample, { branded: true, intent: "discovery" })).toBe(false);
    expect(isEligible(okSample, { branded: false, intent: "brand_check" })).toBe(false);
  });
});

describe("computeAggregates", () => {
  const extraction = (
    tenantMentioned: boolean,
    competitorIds: string[],
    ownDomainCited: boolean,
    level?: "absent" | "mentioned" | "described" | "recommended"
  ): SampleExtraction => ({
    deterministic: { tenantMentioned, competitorIds, ownDomainCited },
    ...(level
      ? {
          judged: {
            orderedBrands: [],
            level,
            framing: "",
            quote: "q",
            positioningClaims: [],
            hallucinations: [],
            answerType: "list" as const,
          },
        }
      : {}),
  });

  async function seedFixture() {
    const tenant = await seedTenant(TENANT);
    const [rival] = await db.insert(competitors).values({ tenantId: tenant.id, name: "Rival" }).returning();
    const [pa] = await db
      .insert(aiVisibilityPrompts)
      .values({ tenantId: tenant.id, text: "best tracker", intent: "discovery", origin: "generated", status: "active" })
      .returning();
    const [pb] = await db
      .insert(aiVisibilityPrompts)
      .values({ tenantId: tenant.id, text: "what is us", intent: "brand_check", origin: "generated", status: "active", branded: true })
      .returning();
    const [run] = await db
      .insert(aiVisibilityRuns)
      .values({ tenantId: tenant.id, trigger: "manual", engines: ["openai", "perplexity"], samplesPerPrompt: 3, status: "running" })
      .returning();
    return { tenant, rival, pa, pb, run };
  }

  async function addSample(a: {
    runId: string;
    tenantId: string;
    promptId: string;
    engine: string;
    sampleIndex: number;
    status?: string;
    flagged?: boolean;
    extraction: SampleExtraction;
  }) {
    await db.insert(aiVisibilitySamples).values({
      runId: a.runId,
      tenantId: a.tenantId,
      promptId: a.promptId,
      engine: a.engine,
      sampleIndex: a.sampleIndex,
      status: a.status ?? "ok",
      flagged: a.flagged ?? false,
      judged: true,
      answerText: "text",
      extraction: a.extraction,
    });
  }

  const engineRowOf = async (runId: string) =>
    (
      await db
        .select()
        .from(aiVisibilityAggregates)
        .where(and(eq(aiVisibilityAggregates.runId, runId), isNull(aiVisibilityAggregates.promptId)))
    )[0];

  it("counts per engine and per prompt x engine, never rates", async () => {
    const { tenant, rival, pa, run } = await seedFixture();
    await addSample({ runId: run.id, tenantId: tenant.id, promptId: pa.id, engine: "openai", sampleIndex: 0, extraction: extraction(true, [rival.id], true, "recommended") });
    await addSample({ runId: run.id, tenantId: tenant.id, promptId: pa.id, engine: "openai", sampleIndex: 1, extraction: extraction(false, [rival.id], false, "absent") });
    await addSample({ runId: run.id, tenantId: tenant.id, promptId: pa.id, engine: "openai", sampleIndex: 2, extraction: extraction(true, [], false, "mentioned") });

    const out = await computeAggregates(run.id);
    expect(out).toEqual({ engineRows: 1, promptRows: 1 });

    const engineRow = await engineRowOf(run.id);
    expect(engineRow.engine).toBe("openai");
    expect(engineRow.n).toBe(3);
    expect(engineRow.tenantMentions).toBe(2);
    expect(engineRow.competitorMentions).toEqual({ [rival.id]: 2 });
    expect(engineRow.ownCitations).toBe(1);
    expect(engineRow.recommendations).toBe(1);
    expect(engineRow.tenantId).toBe(tenant.id);

    const [promptRow] = await db
      .select()
      .from(aiVisibilityAggregates)
      .where(and(eq(aiVisibilityAggregates.runId, run.id), eq(aiVisibilityAggregates.promptId, pa.id)));
    expect(promptRow.n).toBe(3);
    expect(promptRow.tenantMentions).toBe(2);
    expect(promptRow.engine).toBe("openai");
  });

  it("excludes errored, refused, flagged and branded rows from n", async () => {
    const { tenant, rival, pa, pb, run } = await seedFixture();
    await addSample({ runId: run.id, tenantId: tenant.id, promptId: pa.id, engine: "openai", sampleIndex: 0, extraction: extraction(true, [], false) });
    await addSample({ runId: run.id, tenantId: tenant.id, promptId: pa.id, engine: "openai", sampleIndex: 1, status: "error", extraction: extraction(true, [], false) });
    await addSample({ runId: run.id, tenantId: tenant.id, promptId: pa.id, engine: "openai", sampleIndex: 2, status: "refused", extraction: extraction(true, [], false) });
    await addSample({ runId: run.id, tenantId: tenant.id, promptId: pa.id, engine: "openai", sampleIndex: 3, flagged: true, extraction: extraction(true, [rival.id], false) });
    // A branded prompt is excluded entirely, so it produces no prompt row at all.
    await addSample({ runId: run.id, tenantId: tenant.id, promptId: pb.id, engine: "openai", sampleIndex: 0, extraction: extraction(true, [], true) });

    await computeAggregates(run.id);

    const engineRow = await engineRowOf(run.id);
    expect(engineRow.n).toBe(1);
    expect(engineRow.tenantMentions).toBe(1);
    expect(engineRow.competitorMentions).toEqual({});

    const promptRows = await db
      .select()
      .from(aiVisibilityAggregates)
      .where(and(eq(aiVisibilityAggregates.runId, run.id), eq(aiVisibilityAggregates.promptId, pb.id)));
    expect(promptRows).toHaveLength(0);
  });

  it("keeps engines separate", async () => {
    const { tenant, pa, run } = await seedFixture();
    await addSample({ runId: run.id, tenantId: tenant.id, promptId: pa.id, engine: "openai", sampleIndex: 0, extraction: extraction(true, [], false) });
    await addSample({ runId: run.id, tenantId: tenant.id, promptId: pa.id, engine: "perplexity", sampleIndex: 0, extraction: extraction(false, [], false) });

    const out = await computeAggregates(run.id);
    expect(out).toEqual({ engineRows: 2, promptRows: 2 });

    const rows = await db
      .select()
      .from(aiVisibilityAggregates)
      .where(and(eq(aiVisibilityAggregates.runId, run.id), isNull(aiVisibilityAggregates.promptId)));
    expect(rows.find((r) => r.engine === "openai")?.tenantMentions).toBe(1);
    expect(rows.find((r) => r.engine === "perplexity")?.tenantMentions).toBe(0);
  });

  it("counts one mention per brand per sample even if the extraction repeats an id", async () => {
    const { tenant, rival, pa, run } = await seedFixture();
    await addSample({
      runId: run.id,
      tenantId: tenant.id,
      promptId: pa.id,
      engine: "openai",
      sampleIndex: 0,
      extraction: extraction(true, [rival.id, rival.id], false),
    });

    await computeAggregates(run.id);
    const engineRow = await engineRowOf(run.id);
    expect(engineRow.competitorMentions).toEqual({ [rival.id]: 1 });
  });

  it("is idempotent — recomputing replaces rather than doubling", async () => {
    const { tenant, pa, run } = await seedFixture();
    await addSample({ runId: run.id, tenantId: tenant.id, promptId: pa.id, engine: "openai", sampleIndex: 0, extraction: extraction(true, [], false) });

    await computeAggregates(run.id);
    await computeAggregates(run.id);

    const rows = await db.select().from(aiVisibilityAggregates).where(eq(aiVisibilityAggregates.runId, run.id));
    expect(rows).toHaveLength(2); // one engine row + one prompt row
  });

  it("writes an engine row with n = 0 when every sample on that engine failed", async () => {
    const { tenant, pa, run } = await seedFixture();
    await addSample({ runId: run.id, tenantId: tenant.id, promptId: pa.id, engine: "openai", sampleIndex: 0, status: "error", extraction: extraction(false, [], false) });

    await computeAggregates(run.id);

    const engineRow = await engineRowOf(run.id);
    expect(engineRow.n).toBe(0);
  });
});

describe("computeAggregates on a run that is not there", () => {
  it("writes nothing and reports zero rows rather than throwing", async () => {
    // `finalizeRun` catches and records a throw here as a FAILED run. A run id
    // that has been deleted out from under a cron tick is not a failure worth
    // a red badge.
    const out = await computeAggregates(crypto.randomUUID());
    expect(out).toEqual({ engineRows: 0, promptRows: 0 });
  });
});
