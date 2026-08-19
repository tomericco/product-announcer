import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../../src/lib/ai/llm-usage", () => ({ recordLlmUsage: vi.fn(async () => {}) }));

import { planIllustrations, MAX_ALT_TEXT_LENGTH } from "../../../src/lib/images/plan";
import { buildImagePrompt } from "../../../src/lib/images/prompt";
import { recordLlmUsage } from "../../../src/lib/ai/llm-usage";

const STYLE = "Flat vector illustration, palette: primary #112233, accents #445566.";
const BODY = [
  "Intro paragraph.",
  "",
  "## Why It Matters",
  "",
  "Para.",
  "",
  "## How It Works",
  "",
  "Para.",
  "",
  "## What Changes For You",
  "",
  "Para.",
  "",
  "## Next Steps",
  "",
  "CTA.",
].join("\n");

const PLAN = {
  cover: { concept: "a lighthouse beam sweeping over stacked documents", altText: "A lighthouse beam sweeping over a stack of documents" },
  body: [
    { anchorHeading: "How It Works", concept: "three gears meshing", altText: "Three gears meshing together" },
    { anchorHeading: "what changes for you", concept: "a door opening onto a path", altText: "A door opening onto a bright path" },
  ],
};

function fakeGenerate(object: unknown) {
  return vi.fn(async (_call: { system: string; prompt: string }) => ({ object, usage: { inputTokens: 10, outputTokens: 5 } }));
}

afterEach(() => vi.mocked(recordLlmUsage).mockClear());

describe("planIllustrations", () => {
  it("builds each prompt in code from the concept and the style block; the model never writes it", async () => {
    const generate = fakeGenerate(PLAN);
    const plan = await planIllustrations(
      { tenantId: "t1", title: "T", body: BODY, wantCover: true, bodyCap: 3, styleBlock: STYLE },
      { generate: generate as never }
    );
    expect(plan.cover?.prompt).toBe(
      buildImagePrompt({ styleBlock: STYLE, concept: PLAN.cover.concept, role: "cover", allowText: false })
    );
    expect(plan.body[0].prompt).toBe(
      buildImagePrompt({ styleBlock: STYLE, concept: "three gears meshing", role: "body", allowText: false })
    );
    // The model's schema has no prompt field to fill in.
    const call = generate.mock.calls[0][0] as { system: string; prompt: string };
    expect(call.system).not.toMatch(/write (the|an) image prompt/i);
  });

  it("passes the title, the H2 list and the body to the model, with the rules in the system prompt", async () => {
    const generate = fakeGenerate(PLAN);
    await planIllustrations(
      { tenantId: "t1", title: "The Title", body: BODY, wantCover: true, bodyCap: 3, styleBlock: STYLE },
      { generate: generate as never }
    );
    const call = generate.mock.calls[0][0] as { system: string; prompt: string; maxOutputTokens: number };
    expect(call.prompt).toContain("The Title");
    expect(call.prompt).toContain("- Why It Matters");
    expect(call.prompt).toContain("- Next Steps");
    expect(call.prompt).toContain("Intro paragraph.");
    expect(call.system).toContain("at most 3");
    expect(call.system).toMatch(/never pad/i);
    expect(call.system).toMatch(/125 characters/);
    expect(call.system).toMatch(/"image of"/);
    expect(call.system).toMatch(/double hero|no second hero/i);
    expect(call.maxOutputTokens).toBeGreaterThan(0);
  });

  it("keeps the anchor heading's canonical text and drops entries not anchored to a real H2", async () => {
    const generate = fakeGenerate({
      cover: null,
      body: [
        ...PLAN.body,
        { anchorHeading: "A Heading That Does Not Exist", concept: "x", altText: "x" },
      ],
    });
    const plan = await planIllustrations(
      { tenantId: "t1", title: "T", body: BODY, wantCover: false, bodyCap: 3, styleBlock: STYLE },
      { generate: generate as never }
    );
    expect(plan.body.map((b) => b.anchorHeading)).toEqual(["How It Works", "What Changes For You"]);
  });

  it("truncates to bodyCap and drops the cover when the type has none", async () => {
    const generate = fakeGenerate(PLAN);
    const plan = await planIllustrations(
      { tenantId: "t1", title: "T", body: BODY, wantCover: false, bodyCap: 1, styleBlock: STYLE },
      { generate: generate as never }
    );
    expect(plan.cover).toBeNull();
    expect(plan.body).toHaveLength(1);
    expect(plan.body[0].anchorHeading).toBe("How It Works");
  });

  it("drops a second entry anchored to the same heading", async () => {
    const generate = fakeGenerate({
      cover: null,
      body: [PLAN.body[0], { ...PLAN.body[0], concept: "different" }],
    });
    const plan = await planIllustrations(
      { tenantId: "t1", title: "T", body: BODY, wantCover: false, bodyCap: 3, styleBlock: STYLE },
      { generate: generate as never }
    );
    expect(plan.body).toHaveLength(1);
  });

  it("enforces the alt-text policy on whatever the model returned", async () => {
    const generate = fakeGenerate({
      cover: { concept: "c", altText: "Image of " + "x".repeat(200) },
      body: [{ anchorHeading: "How It Works", concept: "g", altText: "An illustration of gears" }],
    });
    const plan = await planIllustrations(
      { tenantId: "t1", title: "T", body: BODY, wantCover: true, bodyCap: 3, styleBlock: STYLE },
      { generate: generate as never }
    );
    expect(plan.cover?.altText.length).toBeLessThanOrEqual(MAX_ALT_TEXT_LENGTH);
    expect(plan.cover?.altText.toLowerCase().startsWith("image of")).toBe(false);
    expect(plan.body[0].altText).toBe("Gears");
  });

  it("returns an empty plan without calling the model when nothing is wanted", async () => {
    const generate = fakeGenerate(PLAN);
    const plan = await planIllustrations(
      { tenantId: "t1", title: "T", body: BODY, wantCover: false, bodyCap: 0, styleBlock: STYLE },
      { generate: generate as never }
    );
    expect(plan).toEqual({ cover: null, body: [] });
    expect(generate).not.toHaveBeenCalled();
  });

  it("records illustration_plan usage for the tenant", async () => {
    await planIllustrations(
      { tenantId: "t-usage", title: "T", body: BODY, wantCover: true, bodyCap: 3, styleBlock: STYLE },
      { generate: fakeGenerate(PLAN) as never }
    );
    expect(recordLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "t-usage", operation: "illustration_plan", usage: { inputTokens: 10, outputTokens: 5 } }),
      expect.anything()
    );
  });
});
