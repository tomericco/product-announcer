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
/**
 * The tenant-scoping cases need a neighbour. Named off the first so both stay
 * unique to this file — `dropTenant` deletes by name against a shared
 * Postgres, and a generic name would take another file's fixture with it.
 */
const OTHER_TENANT = "AI Visibility Schema Test Tenant (Other)";
const USER_EMAIL = "ai-visibility-schema@example.test";

/**
 * `users` is not tenant-scoped, so `dropTenant` does not reach it. Deleted by
 * its own address, which is unique to this file.
 */
afterEach(async () => {
  await dropTenant(TENANT);
  await dropTenant(OTHER_TENANT);
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

  it("scopes the one-prompt-per-wording rule to the tenant", async () => {
    const { tenant } = await seed();
    const other = await seedTenant(OTHER_TENANT);

    // "best crm for startups" is exactly the sort of wording two unrelated
    // workspaces both arrive at. A unique that forgot `tenant_id` would let
    // whoever generated it first block everyone else.
    await seedPrompt(tenant.id, "best crm for startups", "active");
    const theirs = await seedPrompt(other.id, "best crm for startups", "active");

    expect(theirs.tenantId).toBe(other.id);
  });

  it("keeps a superseded prompt's successor when the predecessor is deleted", async () => {
    const { tenant } = await seed();
    const original = await seedPrompt(tenant.id, "best issue trackers for startups");
    const [successor] = await db
      .insert(aiVisibilityPrompts)
      .values({
        tenantId: tenant.id,
        text: "best issue trackers for seed-stage startups",
        intent: "discovery",
        origin: "user",
        supersedesId: original.id,
      })
      .returning();

    await db.delete(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.id, original.id));

    // SET NULL, not cascade: deleting an unrun predecessor must not take the
    // wording that replaced it — and its history — with it.
    const [after] = await db
      .select()
      .from(aiVisibilityPrompts)
      .where(eq(aiVisibilityPrompts.id, successor.id));
    expect(after.supersedesId).toBeNull();
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
    const { tenant, competitor, source } = await seed();
    const prompt = await seedPrompt(tenant.id, "best issue trackers for startups");
    const run = await seedRun(tenant.id, source.id);

    const engineLevel = {
      runId: run.id,
      tenantId: tenant.id,
      engine: "openai",
      promptId: null,
      n: 30,
      tenantMentions: 9,
      // Keyed by competitor id, never by name: names are editable and are not
      // unique across tenants, and `computeAggregates` sums these maps.
      competitorMentions: { [competitor.id]: 21 },
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

  it("leaves `payload` null on a signal of any other kind", async () => {
    const { tenant, source } = await seed();

    const [manual] = await db
      .insert(signals)
      .values({
        tenantId: tenant.id,
        sourceId: source.id,
        kind: "manual",
        externalId: "manual:one",
        title: "Someone typed this in",
        occurredAt: new Date(),
      })
      .returning();

    // The column is nullable and unset for the other four kinds — the sibling
    // case above only proves the ai_visibility row HAS one.
    expect(manual.payload).toBeNull();
  });

  it("refuses a second sample at the same run, prompt, engine and index", async () => {
    const { tenant, source } = await seed();
    const prompt = await seedPrompt(tenant.id, "best issue trackers for startups");
    const run = await seedRun(tenant.id, source.id);
    const identity = {
      runId: run.id,
      tenantId: tenant.id,
      promptId: prompt.id,
      engine: "openai",
      sampleIndex: 0,
    };
    await db.insert(aiVisibilitySamples).values(identity);

    // `planRun` inserts the whole grid and `runSlice` can be re-entered after a
    // timeout, so this index is what stops a resumed run doubling its own call
    // count — and its bill.
    await expect(db.insert(aiVisibilitySamples).values(identity)).rejects.toThrow();
  });

  it("treats a different index, engine or run as a different sample", async () => {
    const { tenant, source } = await seed();
    const prompt = await seedPrompt(tenant.id, "best issue trackers for startups");
    const run = await seedRun(tenant.id, source.id);
    const otherRun = await seedRun(tenant.id, source.id);
    const identity = {
      runId: run.id,
      tenantId: tenant.id,
      promptId: prompt.id,
      engine: "openai",
      sampleIndex: 0,
    };

    // The three samples of one prompt × engine, the same prompt on a second
    // engine, and next week's run all have to coexist.
    await db.insert(aiVisibilitySamples).values(identity);
    await db.insert(aiVisibilitySamples).values({ ...identity, sampleIndex: 1 });
    await db.insert(aiVisibilitySamples).values({ ...identity, engine: "perplexity" });
    await db.insert(aiVisibilitySamples).values({ ...identity, runId: otherRun.id });

    const rows = await db
      .select()
      .from(aiVisibilitySamples)
      .where(eq(aiVisibilitySamples.tenantId, tenant.id));
    expect(rows).toHaveLength(4);
  });

  it("cascades samples and aggregates when the prompt is deleted", async () => {
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
      promptId: prompt.id,
      n: 3,
      tenantMentions: 0,
      ownCitations: 0,
      recommendations: 0,
    });

    await db.delete(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.id, prompt.id));

    // Deleting is only offered for an unrun prompt, but the graph must still
    // be consistent if it happens: no sample may outlive the wording that
    // produced it, and the citation goes with its sample.
    expect(await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.id, sample.id))).toHaveLength(0);
    expect(
      await db.select().from(aiVisibilityCitations).where(eq(aiVisibilityCitations.sampleId, sample.id))
    ).toHaveLength(0);
    expect(
      await db.select().from(aiVisibilityAggregates).where(eq(aiVisibilityAggregates.runId, run.id))
    ).toHaveLength(0);
    // The run itself is the record of what we asked and survives.
    expect(await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, run.id))).toHaveLength(1);
  });

  it("keeps prompts and citations when the competitor they name is deleted", async () => {
    const { tenant, competitor, source } = await seed();
    const [prompt] = await db
      .insert(aiVisibilityPrompts)
      .values({
        tenantId: tenant.id,
        text: "acme vs rival",
        intent: "comparison",
        origin: "generated",
        competitorId: competitor.id,
      })
      .returning();
    const run = await seedRun(tenant.id, source.id);
    const [sample] = await db
      .insert(aiVisibilitySamples)
      .values({ runId: run.id, tenantId: tenant.id, promptId: prompt.id, engine: "openai", sampleIndex: 0 })
      .returning();
    const [citation] = await db
      .insert(aiVisibilityCitations)
      .values({
        sampleId: sample.id,
        tenantId: tenant.id,
        runId: run.id,
        url: "https://rival.com/pricing",
        domain: "rival.com",
        position: 1,
        domainClass: "competitor",
        competitorId: competitor.id,
      })
      .returning();

    await db.delete(competitors).where(eq(competitors.id, competitor.id));

    // SET NULL on both: stopping tracking a competitor must not erase the
    // record of what the engines said while we were.
    const [promptAfter] = await db
      .select()
      .from(aiVisibilityPrompts)
      .where(eq(aiVisibilityPrompts.id, prompt.id));
    expect(promptAfter.competitorId).toBeNull();
    const [citationAfter] = await db
      .select()
      .from(aiVisibilityCitations)
      .where(eq(aiVisibilityCitations.id, citation.id));
    expect(citationAfter.competitorId).toBeNull();
    expect(citationAfter.domain).toBe("rival.com");
  });

  it("takes all six tables with it when the tenant is deleted", async () => {
    const { tenant, source } = await seed();
    await db.insert(aiVisibilitySettings).values({ tenantId: tenant.id });
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

    await dropTenant(TENANT);

    // Deleting a workspace must not leave answers, citations or counts behind:
    // every one of the six is keyed on the tenant for exactly this reason.
    expect(
      await db.select().from(aiVisibilitySettings).where(eq(aiVisibilitySettings.tenantId, tenant.id))
    ).toHaveLength(0);
    expect(
      await db.select().from(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.tenantId, tenant.id))
    ).toHaveLength(0);
    expect(await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.tenantId, tenant.id))).toHaveLength(0);
    expect(
      await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.tenantId, tenant.id))
    ).toHaveLength(0);
    expect(
      await db.select().from(aiVisibilityCitations).where(eq(aiVisibilityCitations.tenantId, tenant.id))
    ).toHaveLength(0);
    expect(
      await db.select().from(aiVisibilityAggregates).where(eq(aiVisibilityAggregates.tenantId, tenant.id))
    ).toHaveLength(0);
  });

  it("keeps one tenant's rows out of the other's when both are deleted in turn", async () => {
    const { tenant, source } = await seed();
    const other = await seedTenant(OTHER_TENANT);
    const [otherSource] = await db
      .insert(sources)
      .values({ tenantId: other.id, type: "ai_visibility", url: null, label: "AI visibility" })
      .returning();
    const prompt = await seedPrompt(tenant.id, "best issue trackers for startups");
    const otherPrompt = await seedPrompt(other.id, "best issue trackers for startups");
    const run = await seedRun(tenant.id, source.id);
    const otherRun = await seedRun(other.id, otherSource.id);
    await db
      .insert(aiVisibilitySamples)
      .values({ runId: run.id, tenantId: tenant.id, promptId: prompt.id, engine: "openai", sampleIndex: 0 });
    await db.insert(aiVisibilitySamples).values({
      runId: otherRun.id,
      tenantId: other.id,
      promptId: otherPrompt.id,
      engine: "openai",
      sampleIndex: 0,
    });

    await dropTenant(TENANT);

    // The cascade follows the tenant edge, not the table: the neighbour's run,
    // prompt and sample are untouched.
    expect(await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.tenantId, other.id))).toHaveLength(1);
    expect(
      await db.select().from(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.tenantId, other.id))
    ).toHaveLength(1);
    expect(
      await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.tenantId, other.id))
    ).toHaveLength(1);
  });
});
