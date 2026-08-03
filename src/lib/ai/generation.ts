import { generateObject } from "ai";
import { z } from "zod";
import type { companyProfiles, ResolvedPersona, systemContentExamples } from "@/db/schema";
import { composeReleasePrompt, composeMergePrompt, composeExtractPrompt, type AtomicUpdateForPrompt } from "./compose-prompt";
import { resolveModel, modelId } from "./model";
import { recordLlmUsage } from "./llm-usage";

type BrandProfileRow = typeof companyProfiles.$inferSelect;
type ExampleRow = typeof systemContentExamples.$inferSelect;

export const UpdateDraftSchema = z.object({
  title: z.string(),
  body: z.string(),
});

export type UpdateDraft = z.infer<typeof UpdateDraftSchema>;

export async function generateReleaseDraft(
  items: AtomicUpdateForPrompt[],
  brandProfile: BrandProfileRow,
  personas: ResolvedPersona[] = [],
  examples: ExampleRow[] = []
): Promise<UpdateDraft> {
  const { system, prompt } = composeReleasePrompt({ items, brandProfile, personas, examples });

  const spec = process.env.GENERATION_MODEL ?? "anthropic/claude-sonnet-4-5";
  const result = await generateObject({
    model: resolveModel(spec),
    schema: UpdateDraftSchema,
    system,
    prompt,
  });

  await recordLlmUsage({
    tenantId: brandProfile.tenantId,
    operation: "generation",
    model: modelId(spec),
    usage: result.usage,
  });

  return result.object;
}

/**
 * Catch-up MERGE regeneration: folds new/changed atomic updates into an
 * existing draft body, preserving its wording (see `composeMergePrompt`).
 * Mirrors `generateReleaseDraft`'s model resolution / usage-recording shape
 * exactly — the only difference is which prompt composer it calls.
 */
export async function mergeReleaseDraft(args: {
  currentBody: string;
  newItems: AtomicUpdateForPrompt[];
  changedItems: AtomicUpdateForPrompt[];
  brandProfile: BrandProfileRow;
  personas?: ResolvedPersona[];
  examples?: ExampleRow[];
}): Promise<UpdateDraft> {
  const { system, prompt } = composeMergePrompt({
    currentBody: args.currentBody,
    newItems: args.newItems,
    changedItems: args.changedItems,
    brandProfile: args.brandProfile,
    personas: args.personas ?? [],
    examples: args.examples ?? [],
  });

  const spec = process.env.GENERATION_MODEL ?? "anthropic/claude-sonnet-4-5";
  const result = await generateObject({
    model: resolveModel(spec),
    schema: UpdateDraftSchema,
    system,
    prompt,
  });

  await recordLlmUsage({
    tenantId: args.brandProfile.tenantId,
    operation: "generation",
    model: modelId(spec),
    usage: result.usage,
  });

  return result.object;
}

/**
 * Rewrites a passage lifted out of an existing draft into a standalone update
 * (see `composeExtractPrompt`). Mirrors `generateReleaseDraft`'s model
 * resolution and usage recording exactly — only the prompt composer differs.
 */
export async function generateExtractedDraft(args: {
  excerpt: string;
  instruction: string;
  brandProfile: BrandProfileRow;
  personas?: ResolvedPersona[];
  examples?: ExampleRow[];
}): Promise<UpdateDraft> {
  const { system, prompt } = composeExtractPrompt({
    excerpt: args.excerpt,
    instruction: args.instruction,
    brandProfile: args.brandProfile,
    personas: args.personas ?? [],
    examples: args.examples ?? [],
  });

  const spec = process.env.GENERATION_MODEL ?? "anthropic/claude-sonnet-4-5";
  const result = await generateObject({
    model: resolveModel(spec),
    schema: UpdateDraftSchema,
    system,
    prompt,
  });

  await recordLlmUsage({
    tenantId: args.brandProfile.tenantId,
    operation: "generation",
    model: modelId(spec),
    usage: result.usage,
  });

  return result.object;
}
