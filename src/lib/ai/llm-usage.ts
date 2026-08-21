import { db as defaultDb } from "@/db";
import { llmUsage } from "@/db/schema";
import type { DbClient } from "@/lib/publishing/destinations/types";

export type LlmOperation =
  | "generation"
  | "enrichment"
  | "review"
  | "revision"
  | "brand_analysis"
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
  // expansion — the engine calls themselves are raw fetch and are billed on
  // `ai_visibility_runs.costUsd`, not here.
  | "ai_visibility_prompts"
  // Image spec §9. `illustration_plan` is a normal token row (the text model
  // planning which images a draft needs); `image_generation` bills per image
  // and sets `imageCount` instead of the token columns.
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
