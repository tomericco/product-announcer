import { describe, it, expect, vi } from "vitest";
import {
  selectNewsSignals,
  MAX_SIGNALS_PER_RUN,
  MAX_SELECTION_OUTPUT_TOKENS,
  type NewsCandidate,
} from "../../../src/lib/signals/news-selection";
import type { RelevanceProfile } from "../../../src/lib/signals/relevance";

vi.mock("../../../src/lib/ai/llm-usage", () => ({ recordLlmUsage: vi.fn(async () => {}) }));

const PROFILE: RelevanceProfile = {
  name: "Acme",
  oneLiner: "Localization tooling for product teams.",
  positioning: "Fast where incumbents are configurable.",
  topics: ["localization", "translation"],
};

const candidate = (n: number): NewsCandidate => ({
  title: `Article ${n}`,
  text: `Body of article ${n}.`,
  url: `https://news.example.com/${n}`,
});

function generateReturning(selections: unknown) {
  return vi.fn().mockResolvedValue({ object: { selections }, usage: { inputTokens: 10, outputTokens: 5 } });
}

describe("selectNewsSignals", () => {
  it("returns the model's selections matched back by echoed index", async () => {
    const candidates = [candidate(0), candidate(1), candidate(2)];
    const generate = generateReturning([
      { index: 2, score: 0.9, rationale: "new angle", topics: ["localization"] },
      { index: 0, score: 0.7, rationale: "solid", topics: [] },
    ]);

    const result = await selectNewsSignals(candidates, PROFILE, [], "t1", { generate });

    expect("selections" in result).toBe(true);
    if (!("selections" in result)) return;
    expect(result.selections.map((s) => s.index)).toEqual([2, 0]);
    expect(result.selections[0].rationale).toBe("new angle");
  });

  it("enforces the cap in code even when the model returns more", async () => {
    const candidates = Array.from({ length: 10 }, (_, i) => candidate(i));
    const generate = generateReturning(
      Array.from({ length: 10 }, (_, i) => ({ index: i, score: 0.9, rationale: "r", topics: [] }))
    );

    const result = await selectNewsSignals(candidates, PROFILE, [], "t1", { generate });

    expect("selections" in result).toBe(true);
    if (!("selections" in result)) return;
    expect(result.selections).toHaveLength(MAX_SIGNALS_PER_RUN);
  });

  it("drops an index the model invented and keeps the first of a duplicate", async () => {
    const candidates = [candidate(0), candidate(1)];
    const generate = generateReturning([
      { index: 1, score: 0.8, rationale: "first", topics: [] },
      { index: 1, score: 0.4, rationale: "duplicate", topics: [] },
      { index: 7, score: 0.9, rationale: "phantom", topics: [] },
      { index: -1, score: 0.9, rationale: "negative", topics: [] },
    ]);

    const result = await selectNewsSignals(candidates, PROFILE, [], "t1", { generate });

    expect("selections" in result).toBe(true);
    if (!("selections" in result)) return;
    expect(result.selections).toHaveLength(1);
    expect(result.selections[0].index).toBe(1);
    expect(result.selections[0].rationale).toBe("first");
  });

  it("accepts an empty selection — a dull day is a correct outcome", async () => {
    const generate = generateReturning([]);

    const result = await selectNewsSignals([candidate(0)], PROFILE, [], "t1", { generate });

    expect(result).toEqual({ selections: [] });
  });

  it("returns an error rather than throwing when the model call fails", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("rate limited"));

    const result = await selectNewsSignals([candidate(0)], PROFILE, [], "t1", { generate });

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("rate limited");
  });

  it("short-circuits an empty candidate list without calling the model", async () => {
    const generate = vi.fn();

    const result = await selectNewsSignals([], PROFILE, [], "t1", { generate });

    expect(result).toEqual({ selections: [] });
    expect(generate).not.toHaveBeenCalled();
  });

  it("puts the already-held titles in the prompt so novelty can be judged", async () => {
    const generate = generateReturning([]);

    await selectNewsSignals([candidate(0)], PROFILE, ["Acme ships SSO", "Rival raises Series B"], "t1", {
      generate,
    });

    const prompt = generate.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("Acme ships SSO");
    expect(prompt).toContain("Rival raises Series B");
  });

  it("tells the model it may return nothing and what never qualifies", async () => {
    const generate = generateReturning([]);

    await selectNewsSignals([candidate(0)], PROFILE, [], "t1", { generate });

    const system = generate.mock.calls[0][0].system as string;
    // The quiet-week spike showed an agent asked to fill a quota fills it.
    expect(system).toMatch(/empty|nothing|none/i);
    expect(system).toMatch(/routine|incremental|minor/i);
  });

  it("tells the model to pick at most one copy of a syndicated story", async () => {
    const generate = generateReturning([]);

    await selectNewsSignals([candidate(0)], PROFILE, [], "t1", { generate });

    const system = generate.mock.calls[0][0].system as string;
    // Three outlets carrying one wire report have three hosts, so three
    // externalIds — nothing upstream of the model can collapse them, and
    // uncaught they eat three of the five slots for one event.
    expect(system).toMatch(/same story/i);
    expect(system).toMatch(/at most ONE/i);
  });

  it("fences every untrusted span and says so in the system prompt", async () => {
    const generate = generateReturning([]);

    await selectNewsSignals([candidate(0), candidate(1)], PROFILE, ["A held headline"], "t1", {
      generate,
    });

    const prompt = generate.mock.calls[0][0].prompt as string;
    const system = generate.mock.calls[0][0].system as string;

    // Bodies and titles both: a selected title persists to `signals.title` and
    // is replayed into the covered list on every later run, so an unfenced
    // title is a standing injection, not a one-shot one.
    expect(prompt).toContain("--- BEGIN ITEM BODY 0 ---");
    expect(prompt).toContain("--- END ITEM BODY 0 ---");
    expect(prompt).toContain("--- BEGIN ITEM TITLE 1 ---");
    expect(prompt).toContain("--- END ITEM TITLE 1 ---");
    expect(prompt).toContain("--- BEGIN COVERED TITLES ---");
    expect(prompt).toContain("--- END COVERED TITLES ---");

    // The fence is inert without the instruction that says what it means.
    expect(system).toMatch(/untrusted data/i);
    expect(system).toMatch(/never instructions to follow/i);
  });

  it("keeps the [index] prefix outside the fencing, so the matching contract is unaffected", async () => {
    const generate = generateReturning([{ index: 1, score: 0.8, rationale: "r", topics: [] }]);

    const result = await selectNewsSignals([candidate(0), candidate(1)], PROFILE, [], "t1", { generate });

    const prompt = generate.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("[1]\n--- BEGIN ITEM TITLE 1 ---");
    expect("selections" in result).toBe(true);
    if (!("selections" in result)) return;
    expect(result.selections[0].index).toBe(1);
  });

  it("caps the model's own output rather than trusting the default", async () => {
    const generate = generateReturning([]);

    await selectNewsSignals([candidate(0)], PROFILE, [], "t1", { generate });

    // Under fail-closed, a truncated object costs the whole day's news.
    expect(generate.mock.calls[0][0].maxOutputTokens).toBe(MAX_SELECTION_OUTPUT_TOKENS);
  });

  it("clamps an out-of-range score and rounds a float index instead of failing the run", async () => {
    const candidates = [candidate(0), candidate(1), candidate(2)];
    const generate = generateReturning([
      { index: 2.0, score: 1.02, rationale: "over", topics: [] },
      { index: 1, score: -0.3, rationale: "under", topics: [] },
    ]);

    const result = await selectNewsSignals(candidates, PROFILE, [], "t1", { generate });

    // A cosmetic slip must not take the day's news down with it — the
    // fail-closed blast radius is reserved for genuine failures.
    expect("selections" in result).toBe(true);
    if (!("selections" in result)) return;
    expect(result.selections.map((s) => [s.index, s.score])).toEqual([
      [2, 1],
      [1, 0],
    ]);
  });
});
