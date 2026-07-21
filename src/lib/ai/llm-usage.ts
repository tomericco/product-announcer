import { db as defaultDb } from "@/db";
import { llmUsage } from "@/db/schema";

export type LlmOperation =
  | "generation"
  | "enrichment"
  | "review"
  | "revision"
  | "brand_analysis"
  | "resolution"
  | "atomic_summary";

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
  },
  database: typeof defaultDb = defaultDb
): Promise<void> {
  try {
    await database.insert(llmUsage).values({
      tenantId: entry.tenantId,
      operation: entry.operation,
      model: entry.model,
      inputTokens: entry.usage?.inputTokens ?? null,
      outputTokens: entry.usage?.outputTokens ?? null,
      totalTokens: entry.usage?.totalTokens ?? null,
    });
  } catch (error) {
    console.error(`Failed to record ${entry.operation} token usage:`, error);
  }
}
