import { generateObject } from "ai";
import { z } from "zod";
import { resolveModel, modelId } from "./model";
import { recordLlmUsage } from "./llm-usage";

export type EnrichmentResult = {
  userFacing: boolean;
  impactSummary: string | null;
  suggestedCategory: "new" | "improved" | "fixed" | null;
  confidence: number | null;
};

export type EnrichmentInput = {
  tenantId: string;
  sourceType: "pr" | "commit";
  repoName: string;
  commitMessage?: string | null;
  diff?: string | null;
  prTitle?: string | null;
  prDescription?: string | null;
};

export type EnrichChangeItem = (input: EnrichmentInput) => Promise<EnrichmentResult>;

export const EnrichmentSchema = z.object({
  userFacing: z.boolean(),
  impactSummary: z.string().nullable(),
  suggestedCategory: z.enum(["new", "improved", "fixed"]).nullable(),
  confidence: z.number().min(0).max(1),
});

const ENRICHMENT_SYSTEM = [
  "You classify a single code change for a user-facing product-update changelog.",
  "Decide whether the change is user-facing (affects what an end user sees, can do, or experiences).",
  "Refactors, tests, chores, CI, and internal-only changes are NOT user-facing.",
  "If user-facing: write impactSummary as one plain sentence describing the end-user benefit,",
  "and pick suggestedCategory: 'new' (new capability), 'improved' (better existing behavior), or 'fixed' (bug fix).",
  "If not user-facing: set impactSummary and suggestedCategory to null.",
  "Always set confidence between 0 and 1.",
].join(" ");

export function buildEnrichmentPrompt(input: EnrichmentInput): string {
  const source =
    input.sourceType === "pr"
      ? `Pull request in ${input.repoName}:\nTitle: ${input.prTitle ?? ""}\nDescription: ${input.prDescription ?? ""}`
      : `Commit in ${input.repoName}:\nMessage: ${input.commitMessage ?? ""}\nDiff:\n${input.diff ?? "(no diff available)"}`;

  return `Classify the following code change.\n\n${source}`;
}

export const enrichChangeItem: EnrichChangeItem = async (input) => {
  try {
    const spec = process.env.ENRICHMENT_MODEL ?? "anthropic/claude-haiku-4-5";
    const { object, usage } = await generateObject({
      model: resolveModel(spec),
      schema: EnrichmentSchema,
      system: ENRICHMENT_SYSTEM,
      prompt: buildEnrichmentPrompt(input),
    });

    await recordLlmUsage({
      tenantId: input.tenantId,
      operation: "enrichment",
      model: modelId(spec),
      usage,
    });

    return {
      userFacing: object.userFacing,
      impactSummary: object.userFacing ? object.impactSummary?.trim() || null : null,
      suggestedCategory: object.userFacing ? object.suggestedCategory : null,
      confidence: object.confidence,
    };
  } catch {
    // Fail open: never drop a genuinely user-facing change on a classifier error.
    return { userFacing: true, impactSummary: null, suggestedCategory: null, confidence: null };
  }
};
