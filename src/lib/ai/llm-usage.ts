import { db as defaultDb } from "@/db";
import { llmUsage } from "@/db/schema";
import type { DbClient } from "@/lib/publishing/destinations/types";

export type LlmOperation =
  | "generation"
  | "enrichment"
  | "review"
  | "revision"
  | "brand_analysis"
  | "template_derivation"
  | "resolution"
  | "atomic_summary"
  | "linkedin_copy"
  | "company_context_analysis"
  | "signal_relevance"
  | "news_selection"
  | "ideation"
  | "brief_draft"
  | "brief_proposal"
  // AI visibility spec. One call per prompt-set generation or monthly
  // expansion. The engine sweep calls are no longer absent from this table:
  // their tokens land here as `ai_visibility_engine`, while their USD
  // estimates stay on `ai_visibility_runs.costUsd`.
  | "ai_visibility_prompts"
  // AI visibility spec §"Extraction": one batched judge call per chunk of
  // samples per run. Billed per run, not per answer, which is why the chunk
  // size in judge.ts is a cost dial.
  | "ai_visibility_judge"
  // AI-visibility ENGINE sweep calls — the raw-fetch BYOK calls to
  // OpenAI/Gemini/Anthropic. Recorded for the settings usage tab so a tenant
  // can track what the sweeps cost on their own keys; NEVER counted as
  // credits and never subject to a credit limit (see the usage-tab spec).
  // `model` holds the provider's reported snapshot id when known, else the
  // engine id.
  | "ai_visibility_engine"
  // Image spec §9. `illustration_plan` is a normal token row (the text model
  // planning which images a draft needs); `image_generation` rows carry real
  // token usage like any text row (credits are computed from total_tokens),
  // plus `imageCount` for the per-image count.
  | "illustration_plan"
  | "image_generation";

/** The subset of the SDK's usage object we persist. Every field is optional. */
export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

/**
 * Records one LLM call's token usage.
 *
 * Deliberately swallows its own errors: this is accounting, and it must never
 * be able to fail a generation that already succeeded. A missing or partial
 * `usage` is normal (the SDK types the counts as `number | undefined`) and is
 * stored as nulls.
 */
export async function recordLlmUsage(
  entry: {
    tenantId: string;
    operation: LlmOperation;
    model: string;
    usage?: TokenUsage;
    /** Number of images rendered by this call. Only image operations set it. */
    imageCount?: number;
  },
  // Widened from `typeof defaultDb`: image and illustration-plan callers hold a
  // `DbClient` (no `$client`), which is not assignable to `typeof defaultDb`.
  // `db` is assignable to `DbClient`, so every existing caller is unaffected.
  database: DbClient = defaultDb
): Promise<void> {
  try {
    await database.insert(llmUsage).values({
      tenantId: entry.tenantId,
      operation: entry.operation,
      model: entry.model,
      inputTokens: entry.usage?.inputTokens ?? null,
      outputTokens: entry.usage?.outputTokens ?? null,
      totalTokens: entry.usage?.totalTokens ?? null,
      imageCount: entry.imageCount ?? null,
    });
  } catch (error) {
    console.error(`Failed to record ${entry.operation} token usage:`, error);
  }
}
