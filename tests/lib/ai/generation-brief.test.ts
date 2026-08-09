import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/lib/ai/llm-usage", () => ({ recordLlmUsage: vi.fn(async () => {}) }));

const generateObject = vi.fn(async (..._args: unknown[]) => ({
  object: { title: "Written title", body: "Written body." },
  usage: { inputTokens: 10, outputTokens: 20 },
}));
vi.mock("ai", () => ({ generateObject: (...a: unknown[]) => generateObject(...a) }));

import { generateBriefDraft, MAX_BRIEF_DRAFT_OUTPUT_TOKENS } from "../../../src/lib/ai/generation";
import { recordLlmUsage } from "../../../src/lib/ai/llm-usage";

const PROFILE = { tenantId: "t1", industry: null, guidelines: null, userPersonas: [] } as never;
const BRIEF = {
  title: "T", angle: "A", whyNow: "W", keyPoints: ["One"],
  contentType: "blog_post" as const, targetLength: null,
};

describe("generateBriefDraft", () => {
  it("returns the model's title and body", async () => {
    const draft = await generateBriefDraft({ brief: BRIEF, evidence: [], brandProfile: PROFILE });
    expect(draft).toEqual({ title: "Written title", body: "Written body." });
  });

  it("records usage under the brief_draft operation", async () => {
    await generateBriefDraft({ brief: BRIEF, evidence: [], brandProfile: PROFILE });
    // The DB column is free text, so a wrong value here is invisible at runtime
    // and only ever shows up as mis-attributed cost.
    expect(vi.mocked(recordLlmUsage).mock.calls.at(-1)?.[0]).toMatchObject({
      tenantId: "t1",
      operation: "brief_draft",
    });
  });

  it("sends the brief's content type through to the system prompt", async () => {
    await generateBriefDraft({
      brief: { ...BRIEF, contentType: "social_post" },
      evidence: [],
      brandProfile: PROFILE,
    });
    const call = generateObject.mock.calls.at(-1)?.[0] as { system: string };
    expect(call.system).toContain("short social post");
  });

  it("caps its output so a long draft cannot truncate mid-word", async () => {
    // Without this the SDK default applied and a live 1200-word blog post came
    // back cut off at 631 words. A short body is indistinguishable from a
    // concise one, so nothing downstream detects it.
    await generateBriefDraft({ brief: BRIEF, evidence: [], brandProfile: PROFILE });
    const call = generateObject.mock.calls.at(-1)?.[0] as { maxOutputTokens?: number };
    expect(call.maxOutputTokens).toBe(MAX_BRIEF_DRAFT_OUTPUT_TOKENS);
  });
});
