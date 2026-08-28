/**
 * How raw `llm_usage.operation` values roll up into product-facing features
 * for the settings usage tab.
 *
 * `operation` is the storage dimension and is deliberately finer-grained than
 * the product (four call sites all record `generation`). This map is the ONLY
 * place the grouping lives. An operation missing from it lands in "other"
 * rather than disappearing — the map must never silently drop usage.
 *
 * `ai_visibility_engine` is intentionally absent: those are BYOK sweep rows,
 * excluded from the credit channel by the queries before this map is asked.
 *
 * Imports nothing, so client components can use the labels without pulling
 * server code into the bundle.
 */

export type FeatureKey =
  | "content_generation"
  | "review_revision"
  | "briefs_ideation"
  | "images"
  | "signals"
  | "linkedin"
  | "onboarding_brand"
  | "ai_visibility"
  | "other";

export const FEATURE_ORDER: FeatureKey[] = [
  "content_generation",
  "review_revision",
  "briefs_ideation",
  "images",
  "signals",
  "linkedin",
  "onboarding_brand",
  "ai_visibility",
  "other",
];

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  content_generation: "Content generation",
  review_revision: "Review & revision",
  briefs_ideation: "Briefs & ideation",
  images: "Images",
  signals: "Signals",
  linkedin: "LinkedIn",
  onboarding_brand: "Onboarding & brand",
  ai_visibility: "AI visibility",
  other: "Other",
};

const OPERATION_FEATURES: Record<string, FeatureKey> = {
  generation: "content_generation",
  brief_draft: "content_generation",
  atomic_summary: "content_generation",
  resolution: "content_generation",
  review: "review_revision",
  revision: "review_revision",
  brief_proposal: "briefs_ideation",
  ideation: "briefs_ideation",
  image_generation: "images",
  illustration_plan: "images",
  signal_relevance: "signals",
  news_selection: "signals",
  enrichment: "signals",
  linkedin_copy: "linkedin",
  brand_analysis: "onboarding_brand",
  company_context_analysis: "onboarding_brand",
  ai_visibility_prompts: "ai_visibility",
  ai_visibility_judge: "ai_visibility",
};

export function featureForOperation(operation: string): FeatureKey {
  return OPERATION_FEATURES[operation] ?? "other";
}

/**
 * Engine name for a BYOK row's `model` column, which holds the provider's
 * dated snapshot id when the call succeeded (e.g. "gpt-5.5-2026-04-23") and
 * the engine id when it failed (e.g. "openai"). Unknown values pass through
 * unchanged — shown as-is beats shown wrong.
 */
export function byokEngineLabel(model: string): string {
  if (model === "openai" || model.startsWith("gpt-")) return "GPT";
  if (model === "gemini" || model.startsWith("gemini-")) return "Gemini";
  if (model === "anthropic" || model.startsWith("claude-")) return "Claude";
  return model;
}
