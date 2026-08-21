import { describe, it, expect, afterEach } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../../src/db";
import {
  users,
  competitors,
  sources,
  signals,
  aiVisibilitySettings,
  aiVisibilityPrompts,
  aiVisibilityRuns,
  aiVisibilitySamples,
  aiVisibilityCitations,
  aiVisibilityAggregates,
} from "../../../src/db/schema";
import type { AiVisibilityPayload, SampleExtraction } from "../../../src/lib/ai-visibility/types";
import { seedTenant, dropTenant } from "../../helpers/fixtures";

const TENANT = "AI Visibility Schema Test Tenant";
const USER_EMAIL = "ai-visibility-schema@example.test";

/**
 * `users` is not tenant-scoped, so `dropTenant` does not reach it. Deleted by
 * its own address, which is unique to this file.
 */
afterEach(async () => {
  await dropTenant(TENANT);
  await db.delete(users).where(eq(users.email, USER_EMAIL));
});

async function seed() {
  const tenant = await seedTenant(TENANT);
  const [user] = await db.insert(users).values({ email: USER_EMAIL, name: "Approver" }).returning();
  const [competitor] = await db
    .insert(competitors)
    .values({ tenantId: tenant.id, name: "Rival" })
    .returning();
  const [source] = await db
    .insert(sources)
    .values({ tenantId: tenant.id, type: "ai_visibility", url: null, label: "AI visibility" })
    .returning();
  return { tenant, user, competitor, source };
}

async function seedPrompt(tenantId: string, text: string, status = "active") {
  const [prompt] = await db
    .insert(aiVisibilityPrompts)
    .values({ tenantId, text, intent: "discovery", origin: "generated", status })
    .returning();
  return prompt;
}

async function seedRun(tenantId: string, sourceId: string) {
  const [run] = await db
    .insert(aiVisibilityRuns)
    .values({
      tenantId,
      sourceId,
      trigger: "manual",
      engines: ["openai", "perplexity"],
      samplesPerPrompt: 3,
      plannedCalls: 6,
    })
    .returning();
  return run;
}

describe("ai_visibility schema", () => {
  it("defaults a settings row to the four engines, weekly, 3 samples, $20", async () => {
    const { tenant } = await seed();

    const [row] = await db.insert(aiVisibilitySettings).values({ tenantId: tenant.id }).returning();

    expect(row.enabled).toBe(false);
    expect(row.cadence).toBe("weekly");
    expect(row.dayOfWeek).toBe(1);
    expect(row.engines).toEqual(["openai", "perplexity", "gemini", "anthropic"]);
    expect(row.samplesPerPrompt).toBe(3);
    expect(row.monthlyCapUsd).toBe(20);
  });

  it("round-trips a prompt with every optional column set", async () => {
    const { tenant, user, competitor } = await seed();
    const original = await seedPrompt(tenant.id, "best issue trackers for startups");

    const [edited] = await db
      .insert(aiVisibilityPrompts)
      .values({
        tenantId: tenant.id,
        text: "best issue trackers for seed-stage startups",
        intent: "comparison",
        persona: "Head of Engineering",
        competitorId: competitor.id,
        branded: true,
        origin: "user",
        status: "active",
        cluster: "best_x_for_persona",
        supersedesId: original.id,
        flagReason: "Asks two questions; split it into two prompts.",
        approvedAt: new Date(),
        approvedBy: user.id,
      })
      .returning();

    expect(edited.supersedesId).toBe(original.id);
    expect(edited.competitorId).toBe(competitor.id);
    expect(edited.branded).toBe(true);
    expect(edited.approvedBy).toBe(user.id);
    expect(edited.pausedAt).toBeNull();
  });

  it("allows one non-rejected prompt per text, and any number of rejected ones", async () => {
    const { tenant } = await seed();
    await seedPrompt(tenant.id, "best issue trackers for startups", "active");

    await expect(seedPrompt(tenant.id, "best issue trackers for startups", "paused")).rejects.toThrow();

    // The partial index excludes `rejected`, so negatives accumulate freely.
    const first = await seedPrompt(tenant.id, "keyword ese pricing", "rejected");
    const second = await seedPrompt(tenant.id, "keyword ese pricing", "rejected");
    expect(first.id).not.toBe(second.id);
  });

  it("round-trips a run, a sample with its extraction, and a citation", async () => {
    const { tenant, competitor, source } = await seed();
    const prompt = await seedPrompt(tenant.id, "best issue trackers for startups");
    const run = await seedRun(tenant.id, source.id);

    const extraction: SampleExtraction = {
      deterministic: { tenantMentioned: true, competitorIds: [competitor.id], ownDomainCited: false },
      judged: {
        orderedBrands: ["Rival", "Acme"],
        level: "described",
        framing: "Named second, described as the cheaper option.",
        quote: "Acme is the cheaper option for small teams.",
        positioningClaims: [{ claim: "fast", state: "present" }],
        hallucinations: [],
        answerType: "list",
      },
      agreementFlag: undefined,
    };

    const [sample] = await db
      .insert(aiVisibilitySamples)
      .values({
        runId: run.id,
        tenantId: tenant.id,
        promptId: prompt.id,
        engine: "openai",
        sampleIndex: 0,
        status: "ok",
        answerText: "Acme is the cheaper option for small teams.",
        modelId: "gpt-5.1-2026-01-01",
        searchUsed: true,
        searchQueries: ["best issue trackers"],
        raw: { output: [] },
        costUsd: 0.012,
        judged: true,
        extraction,
        askedAt: new Date(),
      })
      .returning();

    expect(sample.extraction?.judged?.level).toBe("described");
    expect(sample.searchQueries).toEqual(["best issue trackers"]);
    expect(sample.flagged).toBe(false);

    const [citation] = await db
      .insert(aiVisibilityCitations)
      .values({
        sampleId: sample.id,
        tenantId: tenant.id,
        runId: run.id,
        url: "https://g2.com/categories/issue-tracking",
        domain: "g2.com",
        position: 1,
        domainClass: "review",
        competitorId: competitor.id,
      })
      .returning();

    expect(citation.domainClass).toBe("review");
    expect(citation.position).toBe(1);
  });

  it("keeps one engine-level aggregate per run and engine alongside per-prompt rows", async () => {
    const { tenant, source } = await seed();
    const prompt = await seedPrompt(tenant.id, "best issue trackers for startups");
    const run = await seedRun(tenant.id, source.id);

    const engineLevel = {
      runId: run.id,
      tenantId: tenant.id,
      engine: "openai",
      promptId: null,
      n: 30,
      tenantMentions: 9,
      competitorMentions: { Rival: 21 },
      ownCitations: 3,
      recommendations: 2,
    };
    await db.insert(aiVisibilityAggregates).values(engineLevel);

    // Same run + engine, NULL prompt: caught by the null-prompt partial index.
    await expect(db.insert(aiVisibilityAggregates).values(engineLevel)).rejects.toThrow();

    // Same run + engine but a real prompt: a different row entirely.
    const perPrompt = { ...engineLevel, promptId: prompt.id, n: 3, tenantMentions: 0 };
    await db.insert(aiVisibilityAggregates).values(perPrompt);
    await expect(db.insert(aiVisibilityAggregates).values(perPrompt)).rejects.toThrow();

    const rows = await db
      .select()
      .from(aiVisibilityAggregates)
      .where(eq(aiVisibilityAggregates.runId, run.id));
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.promptId === null)).toHaveLength(1);
  });

  it("cascades samples, citations and aggregates when the run is deleted", async () => {
    const { tenant, source } = await seed();
    const prompt = await seedPrompt(tenant.id, "best issue trackers for startups");
    const run = await seedRun(tenant.id, source.id);
    const [sample] = await db
      .insert(aiVisibilitySamples)
      .values({ runId: run.id, tenantId: tenant.id, promptId: prompt.id, engine: "openai", sampleIndex: 0 })
      .returning();
    await db.insert(aiVisibilityCitations).values({
      sampleId: sample.id,
      tenantId: tenant.id,
      runId: run.id,
      url: "https://g2.com/x",
      domain: "g2.com",
      position: 1,
      domainClass: "review",
    });
    await db.insert(aiVisibilityAggregates).values({
      runId: run.id,
      tenantId: tenant.id,
      engine: "openai",
      promptId: null,
      n: 3,
      tenantMentions: 0,
      ownCitations: 0,
      recommendations: 0,
    });

    await db.delete(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, run.id));

    expect(await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.runId, run.id))).toHaveLength(0);
    expect(
      await db.select().from(aiVisibilityCitations).where(eq(aiVisibilityCitations.runId, run.id))
    ).toHaveLength(0);
    expect(
      await db.select().from(aiVisibilityAggregates).where(eq(aiVisibilityAggregates.runId, run.id))
    ).toHaveLength(0);
    // The prompt is the durable record and survives its runs.
    expect(await db.select().from(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.id, prompt.id))).toHaveLength(1);
  });

  it("nulls the run's source when the source goes away, and cascades on tenant delete", async () => {
    const { tenant, source } = await seed();
    const run = await seedRun(tenant.id, source.id);

    await db.delete(sources).where(eq(sources.id, source.id));
    const [afterSourceDelete] = await db
      .select()
      .from(aiVisibilityRuns)
      .where(eq(aiVisibilityRuns.id, run.id));
    expect(afterSourceDelete.sourceId).toBeNull();

    await dropTenant(TENANT);
    expect(await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, run.id))).toHaveLength(0);
    expect(
      await db.select().from(aiVisibilitySettings).where(eq(aiVisibilitySettings.tenantId, tenant.id))
    ).toHaveLength(0);
  });

  it("stores an ai_visibility signal with its payload", async () => {
    const { tenant, source } = await seed();
    const prompt = await seedPrompt(tenant.id, "best issue trackers for startups");
    const run = await seedRun(tenant.id, source.id);

    const payload: AiVisibilityPayload = {
      signalType: "gap_vs_competitor",
      promptId: prompt.id,
      promptText: prompt.text,
      engine: "openai",
      engineLabel: "GPT-5.x API + web search",
      modelId: "gpt-5.1-2026-01-01",
      runId: run.id,
      runDate: new Date().toISOString(),
      samples: "0 of 3, two runs",
      excerpt: "Rival is the usual recommendation here.",
      citedUrls: [{ url: "https://g2.com/x", domain: "g2.com", domainClass: "review" }],
    };

    const [row] = await db
      .insert(signals)
      .values({
        tenantId: tenant.id,
        sourceId: source.id,
        kind: "ai_visibility",
        externalId: `gap_vs_competitor:${prompt.id}:openai:2026-W34`,
        title: "Absent from 'best issue trackers for startups' on ChatGPT",
        occurredAt: new Date(),
        payload,
      })
      .returning();

    expect(row.kind).toBe("ai_visibility");
    expect(row.payload?.signalType).toBe("gap_vs_competitor");

    // Every other kind leaves it null.
    const [plain] = await db
      .select()
      .from(signals)
      .where(and(eq(signals.id, row.id), isNull(signals.payload)));
    expect(plain).toBeUndefined();
  });
});
