import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/lib/ai/llm-usage", () => ({ recordLlmUsage: vi.fn(async () => {}) }));

import { proposeBriefFromSignals, MAX_PROPOSAL_SIGNALS } from "../../../src/lib/briefs/propose";
import { recordLlmUsage } from "../../../src/lib/ai/llm-usage";

const PROFILE = { name: "Frontitude", oneLiner: "UX content platform", positioning: null, topics: ["ux writing"] };
const SIGNALS = [
  { id: "s1", kind: "market_news", title: "API-driven localization", excerpt: "Runtime translation.", occurredAt: new Date("2026-07-17") },
  { id: "s2", kind: "competitor_move", title: "Rival ships glossary", excerpt: null, occurredAt: null },
];
const GOOD = {
  contentType: "blog_post", title: "T", angle: "A", whyNow: "W", audience: null,
  keyPoints: ["One.", "Two.", "Three."], targetLength: 700, suggestedChannel: "blog",
  score: 0.7, scoreRationale: "R",
};

describe("proposeBriefFromSignals", () => {
  it("returns one brief and never carries evidence ids from the model", async () => {
    const generate = vi.fn(async () => ({ object: { ...GOOD, evidenceSignalIds: ["HALLUCINATED"] }, usage: {} }));
    const result = await proposeBriefFromSignals(
      { signals: SIGNALS, profile: PROFILE, tenantId: "t1" },
      { generate: generate as never }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The human chose the signals. The model does not get a vote, so the field
    // is not even in its schema — this asserts it cannot leak through.
    expect(result.brief).not.toHaveProperty("evidenceSignalIds");
    expect(result.brief.title).toBe("T");
  });

  it("does NOT ask the model whether anything is worth publishing", async () => {
    const generate = vi.fn(async (_call: { system: string; prompt: string }) => ({ object: GOOD, usage: {} }));
    await proposeBriefFromSignals(
      { signals: SIGNALS, profile: PROFILE, tenantId: "t1" },
      { generate: generate as never }
    );
    const call = generate.mock.calls[0][0] as { system: string; prompt: string };
    const text = `${call.system}\n${call.prompt}`;

    // The regression that would silently restore ideate's refusal behaviour —
    // and it has refused twice on real data. Nothing else would catch it.
    expect(text).not.toMatch(/if anything/i);
    expect(text).not.toMatch(/skeptical head of marketing/i);
    expect(text).not.toMatch(/\bTHE BAR\b/);
    // And it must say the opposite.
    expect(text).toMatch(/already (chosen|selected|decided)/i);
  });

  it("passes the chosen signals to the model", async () => {
    const generate = vi.fn(async (_call: { system: string; prompt: string }) => ({ object: GOOD, usage: {} }));
    await proposeBriefFromSignals(
      { signals: SIGNALS, profile: PROFILE, tenantId: "t1" },
      { generate: generate as never }
    );
    const { prompt } = generate.mock.calls[0][0] as { prompt: string };
    expect(prompt).toContain("API-driven localization");
    expect(prompt).toContain("Rival ships glossary");
  });

  it("caps how many signals reach the prompt", async () => {
    const many = Array.from({ length: MAX_PROPOSAL_SIGNALS + 5 }, (_, i) => ({
      id: `s${i}`, kind: "manual", title: `Signal ${i}`, excerpt: null, occurredAt: null,
    }));
    const generate = vi.fn(async (_call: { system: string; prompt: string }) => ({ object: GOOD, usage: {} }));
    await proposeBriefFromSignals(
      { signals: many, profile: PROFILE, tenantId: "t1" },
      { generate: generate as never }
    );
    const { prompt } = generate.mock.calls[0][0] as { prompt: string };
    expect(prompt).toContain(`Signal ${MAX_PROPOSAL_SIGNALS - 1}`);
    expect(prompt).not.toContain(`Signal ${MAX_PROPOSAL_SIGNALS}`);
  });

  it("returns an error the form can render rather than throwing", async () => {
    const generate = vi.fn(async () => {
      throw new Error("model timeout");
    });
    const result = await proposeBriefFromSignals(
      { signals: SIGNALS, profile: PROFILE, tenantId: "t1" },
      { generate: generate as never }
    );
    // This path exists for when the agent is NOT helping. It must degrade to a
    // blank form, never block the human from writing the brief themselves.
    expect(result).toEqual({ ok: false, error: expect.stringContaining("model timeout") });
  });

  it("refuses an empty selection without calling the model", async () => {
    const generate = vi.fn();
    const result = await proposeBriefFromSignals(
      { signals: [], profile: PROFILE, tenantId: "t1" },
      { generate: generate as never }
    );
    expect(result.ok).toBe(false);
    expect(generate).not.toHaveBeenCalled();
  });

  it("records usage under its own operation", async () => {
    const generate = vi.fn(async () => ({ object: GOOD, usage: { inputTokens: 1, outputTokens: 2 } }));
    await proposeBriefFromSignals(
      { signals: SIGNALS, profile: PROFILE, tenantId: "t1" },
      { generate: generate as never }
    );
    expect(vi.mocked(recordLlmUsage).mock.calls.at(-1)?.[0]).toMatchObject({
      tenantId: "t1",
      operation: "brief_proposal",
    });
  });
});
