import { describe, it, expect } from "vitest";
import {
  FEATURE_LABELS,
  FEATURE_ORDER,
  featureForOperation,
  byokEngineLabel,
} from "../../../src/lib/usage/features";

describe("featureForOperation", () => {
  it("maps every known operation to its product feature", () => {
    expect(featureForOperation("generation")).toBe("content_generation");
    expect(featureForOperation("brief_draft")).toBe("content_generation");
    expect(featureForOperation("atomic_summary")).toBe("content_generation");
    expect(featureForOperation("resolution")).toBe("content_generation");
    expect(featureForOperation("review")).toBe("review_revision");
    expect(featureForOperation("revision")).toBe("review_revision");
    expect(featureForOperation("brief_proposal")).toBe("briefs_ideation");
    expect(featureForOperation("ideation")).toBe("briefs_ideation");
    expect(featureForOperation("image_generation")).toBe("images");
    expect(featureForOperation("illustration_plan")).toBe("images");
    expect(featureForOperation("signal_relevance")).toBe("signals");
    expect(featureForOperation("news_selection")).toBe("signals");
    expect(featureForOperation("enrichment")).toBe("signals");
    expect(featureForOperation("linkedin_copy")).toBe("linkedin");
    expect(featureForOperation("brand_analysis")).toBe("onboarding_brand");
    expect(featureForOperation("company_context_analysis")).toBe("onboarding_brand");
    expect(featureForOperation("ai_visibility_prompts")).toBe("ai_visibility");
    expect(featureForOperation("ai_visibility_judge")).toBe("ai_visibility");
  });

  it("routes an unknown operation to 'other', never dropping it", () => {
    expect(featureForOperation("some_future_operation")).toBe("other");
  });

  it("does NOT map ai_visibility_engine — it belongs to the BYOK channel", () => {
    // The queries exclude it before this map is consulted; if it ever arrives
    // here, "other" keeps it visible rather than counted under a feature.
    expect(featureForOperation("ai_visibility_engine")).toBe("other");
  });

  it("labels and orders every feature", () => {
    for (const key of FEATURE_ORDER) expect(FEATURE_LABELS[key]).toBeTruthy();
    expect(FEATURE_ORDER[FEATURE_ORDER.length - 1]).toBe("other");
  });
});

describe("byokEngineLabel", () => {
  it("maps snapshot ids and engine ids to engine names", () => {
    expect(byokEngineLabel("gpt-5.5-2026-04-23")).toBe("GPT");
    expect(byokEngineLabel("openai")).toBe("GPT");
    expect(byokEngineLabel("gemini-2.5-flash")).toBe("Gemini");
    expect(byokEngineLabel("gemini")).toBe("Gemini");
    expect(byokEngineLabel("claude-sonnet-4-5")).toBe("Claude");
    expect(byokEngineLabel("anthropic")).toBe("Claude");
  });

  it("passes an unknown model through unchanged", () => {
    expect(byokEngineLabel("mystery-model-9")).toBe("mystery-model-9");
  });
});
