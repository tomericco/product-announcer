import { describe, it, expect, vi } from "vitest";
import { ideate, MAX_IDEATION_OUTPUT_TOKENS, type IdeationSignal, type OpenBrief } from "../../../src/lib/briefs/ideate";
import type { RelevanceProfile } from "../../../src/lib/signals/relevance";

vi.mock("../../../src/lib/ai/llm-usage", () => ({ recordLlmUsage: vi.fn(async () => {}) }));

const PROFILE: RelevanceProfile = {
  name: "Acme",
  oneLiner: "Localization tooling for product teams.",
  positioning: "Fast where incumbents are configurable.",
  topics: ["localization"],
};

const signal = (id: string): IdeationSignal => ({
  id,
  kind: "market_news",
  occurredAt: new Date("2026-08-04T00:00:00Z"),
  title: `Story ${id}`,
  excerpt: `Body of ${id}.`,
});

function generateReturning(object: unknown) {
  return vi.fn().mockResolvedValue({ object, usage: { inputTokens: 10, outputTokens: 5 } });
}

const PROPOSAL = {
  contentType: "blog_post",
  title: "T",
  angle: "A",
  whyNow: "W",
  audience: null,
  keyPoints: ["One.", "Two.", "Three."],
  targetLength: 800,
  suggestedChannel: "blog",
  evidenceSignalIds: ["s1"],
  score: 0.8,
  scoreRationale: "R",
};

describe("ideate", () => {
  it("returns the assessment and a proposed brief", async () => {
    const generate = generateReturning({
      assessment: "A busy fortnight.",
      actions: [{ type: "propose", brief: PROPOSAL }],
    });

    const result = await ideate(
      { signals: [signal("s1")], openBriefs: [], context: { covered: [], rejected: [] }, profile: PROFILE, tenantId: "t1" },
      { generate }
    );

    expect("actions" in result).toBe(true);
    if (!("actions" in result)) return;
    expect(result.assessment).toBe("A busy fortnight.");
    expect(result.actions).toHaveLength(1);
  });

  it("accepts an empty action list — a quiet period is a correct outcome", async () => {
    const generate = generateReturning({ assessment: "Genuinely routine.", actions: [] });

    const result = await ideate(
      { signals: [signal("s1")], openBriefs: [], context: { covered: [], rejected: [] }, profile: PROFILE, tenantId: "t1" },
      { generate }
    );

    expect(result).toEqual({ assessment: "Genuinely routine.", actions: [] });
  });

  it("drops a proposal citing a signal id that was never sent", async () => {
    const generate = generateReturning({
      assessment: "x",
      actions: [
        { type: "propose", brief: { ...PROPOSAL, evidenceSignalIds: ["s1", "ghost"] } },
        { type: "propose", brief: { ...PROPOSAL, title: "All invented", evidenceSignalIds: ["ghost"] } },
      ],
    });

    const result = await ideate(
      { signals: [signal("s1")], openBriefs: [], context: { covered: [], rejected: [] }, profile: PROFILE, tenantId: "t1" },
      { generate }
    );

    expect("actions" in result).toBe(true);
    if (!("actions" in result)) return;
    // The phantom id is stripped from the surviving brief; a brief whose
    // evidence was ENTIRELY invented is dropped, because a brief with no real
    // evidence is not a brief.
    expect(result.actions).toHaveLength(1);
    const first = result.actions[0];
    expect(first.type === "propose" && first.brief.evidenceSignalIds).toEqual(["s1"]);
  });

  it("drops an extend action naming a brief that is not open", async () => {
    const open: OpenBrief[] = [{ id: "b1", title: "Existing", angle: "A" }];
    const generate = generateReturning({
      assessment: "x",
      actions: [
        { type: "extend", briefId: "b1", evidenceSignalIds: ["s1"] },
        { type: "extend", briefId: "nope", evidenceSignalIds: ["s1"] },
      ],
    });

    const result = await ideate(
      { signals: [signal("s1")], openBriefs: open, context: { covered: [], rejected: [] }, profile: PROFILE, tenantId: "t1" },
      { generate }
    );

    expect("actions" in result).toBe(true);
    if (!("actions" in result)) return;
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].type === "extend" && result.actions[0].briefId).toBe("b1");
  });

  it("returns an error rather than throwing when the model call fails", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("overloaded"));

    const result = await ideate(
      { signals: [signal("s1")], openBriefs: [], context: { covered: [], rejected: [] }, profile: PROFILE, tenantId: "t1" },
      { generate }
    );

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("overloaded");
  });

  it("short-circuits an empty signal list without calling the model", async () => {
    const generate = vi.fn();

    const result = await ideate(
      { signals: [], openBriefs: [], context: { covered: [], rejected: [] }, profile: PROFILE, tenantId: "t1" },
      { generate }
    );

    expect(result).toEqual({ assessment: "No signals in the window.", actions: [] });
    expect(generate).not.toHaveBeenCalled();
  });

  it("carries the spike's four rules and the licence to return nothing", async () => {
    const generate = generateReturning({ assessment: "x", actions: [] });

    await ideate(
      { signals: [signal("s1")], openBriefs: [], context: { covered: [], rejected: [] }, profile: PROFILE, tenantId: "t1" },
      { generate }
    );

    const system = generate.mock.calls[0][0].system as string;
    expect(system).toMatch(/no target number/i);
    expect(system).toMatch(/empty list is a correct/i);
    expect(system).toMatch(/swapped in/i);          // the swap test
    expect(system).toMatch(/cluster/i);             // favour clusters
    expect(system).toMatch(/routine|maintenance|version bump/i); // ignore noise
    expect(system).toMatch(/dated|why-now/i);       // why-now points at something dated
    expect(generate.mock.calls[0][0].maxOutputTokens).toBe(MAX_IDEATION_OUTPUT_TOKENS);
  });

  it("puts covered and rejected context in the prompt", async () => {
    const generate = generateReturning({ assessment: "x", actions: [] });

    await ideate(
      {
        signals: [signal("s1")],
        openBriefs: [],
        context: { covered: ["We already shipped SSO"], rejected: ["Too promotional"] },
        profile: PROFILE,
        tenantId: "t1",
      },
      { generate }
    );

    const prompt = generate.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("We already shipped SSO");
    expect(prompt).toContain("Too promotional");
  });
});
