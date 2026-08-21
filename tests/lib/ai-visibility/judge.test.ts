import { describe, it, expect, vi } from "vitest";
import {
  buildJudgeSystem,
  buildJudgePrompt,
  judgeChunk,
  JUDGE_CHUNK_SIZE,
  type JudgeContext,
  type JudgeGenerate,
  type JudgeItem,
} from "../../../src/lib/ai-visibility/judge";

vi.mock("../../../src/lib/ai/llm-usage", () => ({ recordLlmUsage: vi.fn().mockResolvedValue(undefined) }));
import { recordLlmUsage } from "../../../src/lib/ai/llm-usage";

const CTX: JudgeContext = {
  tenantName: "Acme",
  competitorNames: ["Rival", "Beta"],
  positioningClaims: ["Fast where incumbents are configurable."],
};

const items: JudgeItem[] = [
  { sampleId: "s1", promptText: "best issue tracker", answerText: "Rival is the strongest; Acme is newer." },
  { sampleId: "s2", promptText: "best issue tracker", answerText: "I would recommend Acme for small teams." },
];

function label(index: number, overrides: Record<string, unknown> = {}) {
  return {
    index,
    orderedBrands: ["Rival", "Acme"],
    level: "mentioned",
    framing: "listed after the incumbent",
    quote: "Acme is newer",
    positioningClaims: [],
    hallucinations: [],
    answerType: "list",
    ...overrides,
  };
}

const generateReturning = (results: unknown[]): JudgeGenerate =>
  vi.fn().mockResolvedValue({ object: { results }, usage: { inputTokens: 10, outputTokens: 5 } });

describe("buildJudgeSystem", () => {
  it("names the tenant, the competitors and the positioning claims to check", () => {
    const system = buildJudgeSystem(CTX);
    expect(system).toContain("Acme");
    expect(system).toContain("Rival");
    expect(system).toContain("Fast where incumbents are configurable.");
  });

  it("states that the fenced answers are data, never instructions", () => {
    const system = buildJudgeSystem(CTX);
    expect(system).toMatch(/never instructions|not instructions/i);
    expect(system).toContain("BEGIN ANSWER");
  });

  it("requires a verbatim quote for every label", () => {
    expect(buildJudgeSystem(CTX)).toMatch(/verbatim/i);
  });
});

describe("buildJudgePrompt", () => {
  it("fences each answer and its prompt with an index outside the fence", () => {
    const prompt = buildJudgePrompt(items);
    expect(prompt).toContain("[0]");
    expect(prompt).toContain("--- BEGIN ANSWER 0 ---");
    expect(prompt).toContain("--- END ANSWER 0 ---");
    expect(prompt).toContain("--- BEGIN QUESTION 1 ---");
    expect(prompt).toContain("I would recommend Acme for small teams.");
  });
});

describe("judgeChunk", () => {
  it("maps results back to sample ids by the echoed index", async () => {
    const generate = generateReturning([label(1, { level: "recommended" }), label(0)]);
    const out = await judgeChunk(items, CTX, "tenant-1", { generate });

    if ("error" in out) throw new Error(out.error);
    expect(out.labels.get("s2")?.level).toBe("recommended");
    expect(out.labels.get("s1")?.level).toBe("mentioned");
  });

  it("drops out-of-range and duplicate indices instead of misattributing them", async () => {
    const generate = generateReturning([label(0), label(0, { level: "recommended" }), label(9)]);
    const out = await judgeChunk(items, CTX, "tenant-1", { generate });

    if ("error" in out) throw new Error(out.error);
    expect(out.labels.size).toBe(1);
    // First result for an index wins; the duplicate is dropped, not merged.
    expect(out.labels.get("s1")?.level).toBe("mentioned");
    expect(out.labels.has("s2")).toBe(false);
  });

  it("records usage under the ai_visibility_judge operation", async () => {
    vi.mocked(recordLlmUsage).mockClear();
    await judgeChunk(items, CTX, "tenant-1", { generate: generateReturning([label(0)]) });

    expect(recordLlmUsage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordLlmUsage).mock.calls[0][0]).toMatchObject({
      tenantId: "tenant-1",
      operation: "ai_visibility_judge",
    });
  });

  it("returns an error object rather than throwing when the model call fails", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("overloaded")) as unknown as JudgeGenerate;
    const out = await judgeChunk(items, CTX, "tenant-1", { generate });

    expect("error" in out && out.error).toContain("overloaded");
  });

  it("short-circuits an empty chunk without a model call", async () => {
    const generate = vi.fn() as unknown as JudgeGenerate;
    const out = await judgeChunk([], CTX, "tenant-1", { generate });

    expect("labels" in out && out.labels.size).toBe(0);
    expect(generate).not.toHaveBeenCalled();
  });

  it("chunks at 20, the documented cost dial", () => {
    expect(JUDGE_CHUNK_SIZE).toBe(20);
  });
});

import { afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import {
  competitors,
  aiVisibilityPrompts,
  aiVisibilityRuns,
  aiVisibilitySamples,
} from "../../../src/db/schema";
import { judgeRun, quoteIsVerbatim, agreementFlag } from "../../../src/lib/ai-visibility/judge";
import { seedTenant, dropTenant, seedCompanyProfile } from "../../helpers/fixtures";

const TENANT = "AI Visibility Judge Test Tenant";

afterEach(async () => {
  await dropTenant(TENANT);
});

const frozen = (iso: string) => () => new Date(iso);

describe("quoteIsVerbatim", () => {
  it("accepts a span that appears in the answer, ignoring whitespace reflow", () => {
    expect(quoteIsVerbatim("Acme  is\nnewer", "Rival is strongest; Acme is newer.")).toBe(true);
  });

  it("rejects a paraphrase and an empty quote", () => {
    expect(quoteIsVerbatim("Acme is a newcomer", "Rival is strongest; Acme is newer.")).toBe(false);
    expect(quoteIsVerbatim("   ", "anything")).toBe(false);
  });
});

describe("agreementFlag", () => {
  it("flags d_only when the deterministic pass saw a mention the judge did not", () => {
    expect(agreementFlag(true, "absent")).toBe("d_only");
  });

  it("flags j_only when the judge saw a mention the deterministic pass did not", () => {
    expect(agreementFlag(false, "mentioned")).toBe("j_only");
    expect(agreementFlag(false, "recommended")).toBe("j_only");
  });

  it("returns null when they agree", () => {
    expect(agreementFlag(true, "recommended")).toBeNull();
    expect(agreementFlag(false, "absent")).toBeNull();
  });
});

describe("judgeRun", () => {
  async function seedRun(
    samples: { answerText: string | null; status?: string; tenantMentioned?: boolean }[]
  ) {
    const tenant = await seedTenant(TENANT);
    await seedCompanyProfile(tenant.id, { positioning: "Fast where incumbents are configurable." });
    await db.insert(competitors).values({ tenantId: tenant.id, name: "Rival" });
    const [prompt] = await db
      .insert(aiVisibilityPrompts)
      .values({ tenantId: tenant.id, text: "best issue tracker", intent: "discovery", origin: "generated", status: "active" })
      .returning();
    const [run] = await db
      .insert(aiVisibilityRuns)
      .values({ tenantId: tenant.id, trigger: "manual", engines: ["openai"], samplesPerPrompt: 3, status: "running" })
      .returning();

    const rows = [];
    for (const [i, spec] of samples.entries()) {
      const [row] = await db
        .insert(aiVisibilitySamples)
        .values({
          runId: run.id,
          tenantId: tenant.id,
          promptId: prompt.id,
          engine: "openai",
          sampleIndex: i,
          status: spec.status ?? "ok",
          answerText: spec.answerText,
          extraction: {
            deterministic: {
              tenantMentioned: spec.tenantMentioned ?? true,
              competitorIds: [],
              ownDomainCited: false,
            },
          },
        })
        .returning();
      rows.push(row);
    }
    return { tenant, run, prompt, rows };
  }

  const okLabel = (index: number, quote: string, overrides: Record<string, unknown> = {}) => ({
    index,
    orderedBrands: ["Rival", TENANT],
    level: "mentioned",
    framing: "listed second",
    quote,
    positioningClaims: [],
    hallucinations: [],
    answerType: "list",
    ...overrides,
  });

  it("writes the judged block and marks the sample judged", async () => {
    const { run, rows } = await seedRun([{ answerText: `Rival is strongest; ${TENANT} is newer.` }]);
    const generate = vi.fn().mockResolvedValue({
      object: { results: [okLabel(0, `${TENANT} is newer`, { level: "described" })] },
      usage: {},
    });

    const out = await judgeRun(run.id, { budgetMs: 60_000, now: frozen("2026-03-02T10:00:00Z") }, { generate });

    expect(out).toMatchObject({ judged: 1, flagged: 0, remaining: 0, budgetSpent: false });
    const [updated] = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.id, rows[0].id));
    expect(updated.judged).toBe(true);
    expect(updated.flagged).toBe(false);
    expect(updated.extraction?.judged?.level).toBe("described");
    expect(updated.extraction?.judged?.quote).toBe(`${TENANT} is newer`);
    // The deterministic block survives untouched.
    expect(updated.extraction?.deterministic.tenantMentioned).toBe(true);
  });

  it("flags a label whose quote is not verbatim in the answer", async () => {
    const { run, rows } = await seedRun([{ answerText: `Rival is strongest; ${TENANT} is newer.` }]);
    const generate = vi.fn().mockResolvedValue({
      object: { results: [okLabel(0, "a paraphrase nobody wrote")] },
      usage: {},
    });

    const out = await judgeRun(run.id, { budgetMs: 60_000, now: frozen("2026-03-02T10:00:00Z") }, { generate });

    expect(out.flagged).toBe(1);
    const [updated] = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.id, rows[0].id));
    expect(updated.judged).toBe(true);
    expect(updated.flagged).toBe(true);
    // The label is still stored — the human spot check needs to see what it said.
    expect(updated.extraction?.judged?.quote).toBe("a paraphrase nobody wrote");
  });

  it("flags and records a D/J disagreement on mentioned", async () => {
    const { run, rows } = await seedRun([
      { answerText: `Rival is strongest; ${TENANT} is newer.`, tenantMentioned: true },
    ]);
    const generate = vi.fn().mockResolvedValue({
      object: { results: [okLabel(0, "Rival is strongest", { level: "absent" })] },
      usage: {},
    });

    const out = await judgeRun(run.id, { budgetMs: 60_000, now: frozen("2026-03-02T10:00:00Z") }, { generate });

    expect(out.flagged).toBe(1);
    const [updated] = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.id, rows[0].id));
    expect(updated.flagged).toBe(true);
    expect(updated.extraction?.agreementFlag).toBe("d_only");
  });

  it("marks errored and refused samples judged without a model call", async () => {
    const { run, rows } = await seedRun([
      { answerText: null, status: "error" },
      { answerText: null, status: "refused" },
    ]);
    const generate = vi.fn();

    const out = await judgeRun(run.id, { budgetMs: 60_000, now: frozen("2026-03-02T10:00:00Z") }, { generate });

    expect(generate).not.toHaveBeenCalled();
    expect(out.remaining).toBe(0);
    for (const row of rows) {
      const [updated] = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.id, row.id));
      expect(updated.judged).toBe(true);
      expect(updated.flagged).toBe(false);
      expect(updated.extraction?.judged).toBeUndefined();
    }
  });

  it("leaves a sample unjudged and retryable when the chunk call fails", async () => {
    const { run, rows } = await seedRun([{ answerText: "Rival is strongest." }]);
    const generate = vi.fn().mockRejectedValue(new Error("overloaded"));

    const out = await judgeRun(run.id, { budgetMs: 60_000, now: frozen("2026-03-02T10:00:00Z") }, { generate });

    expect(out.judged).toBe(0);
    expect(out.remaining).toBe(1);
    expect(out.errors.join(" ")).toContain("overloaded");
    const [updated] = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.id, rows[0].id));
    expect(updated.judged).toBe(false);
  });

  it("leaves a sample the model returned no label for unjudged, not flagged", async () => {
    const { run, rows } = await seedRun([
      { answerText: `${TENANT} is newer.` },
      { answerText: `Rival is strongest.` },
    ]);
    const generate = vi.fn().mockResolvedValue({
      object: { results: [okLabel(0, `${TENANT} is newer`)] },
      usage: {},
    });

    const out = await judgeRun(run.id, { budgetMs: 60_000, now: frozen("2026-03-02T10:00:00Z") }, { generate });

    expect(out.judged).toBe(1);
    expect(out.remaining).toBe(1);
    const [second] = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.id, rows[1].id));
    expect(second.judged).toBe(false);
    expect(second.flagged).toBe(false);
  });

  it("completes a wave, then stops when the budget is spent, leaving the rest for the next tick", async () => {
    // 90 samples = 5 chunks of JUDGE_CHUNK_SIZE 20 (the last holds 10) = two
    // waves at JUDGE_CONCURRENCY 4. The clock is read once for `startedAt` and
    // once before each wave, each read advancing 30ms: wave one's check reads
    // 30ms (inside the 50ms budget) and wave two's reads 60ms (past it) — so
    // wave one genuinely completes and wave two is cut. That partial progress
    // is the case `finalizeRun` resumes from; a budget spent before the FIRST
    // wave would leave the resume path untested.
    const { run } = await seedRun(
      Array.from({ length: 90 }, (_, i) => ({ answerText: `Answer ${i} mentions ${TENANT}.` }))
    );
    let t = new Date("2026-03-02T10:00:00Z").getTime();
    const now = () => {
      const current = new Date(t);
      t += 30;
      return current;
    };
    // Labels every index a full chunk can hold; the quote "mentions" is
    // verbatim in every answer, so nothing is flagged and everything labelled
    // counts as judged.
    const generate = vi.fn().mockImplementation(async () => ({
      object: { results: Array.from({ length: 20 }, (_, index) => okLabel(index, "mentions")) },
      usage: {},
    }));

    const out = await judgeRun(run.id, { budgetMs: 50, now }, { generate });

    expect(out.budgetSpent).toBe(true);
    // Wave one = 4 chunks × 20 samples judged; the fifth chunk's 10 remain.
    expect(generate).toHaveBeenCalledTimes(4);
    expect(out.judged).toBe(80);
    expect(out.remaining).toBe(10);
  });
});
