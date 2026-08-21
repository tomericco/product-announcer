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
