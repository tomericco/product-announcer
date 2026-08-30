import { generateObject } from "ai";
import { z } from "zod";
import type { companyProfiles, ResolvedPersona, systemContentExamples } from "@/db/schema";
import {
  composeReleasePrompt,
  composeMergePrompt,
  composeExtractPrompt,
  composeBriefPrompt,
  type AtomicUpdateForPrompt,
  type BriefForPrompt,
  type BriefEvidenceForPrompt,
} from "./compose-prompt";
import { resolveModel, modelId } from "./model";
import { recordLlmUsage } from "./llm-usage";

type BrandProfileRow = typeof companyProfiles.$inferSelect;
type ExampleRow = typeof systemContentExamples.$inferSelect;

export const UpdateDraftSchema = z.object({
  title: z.string(),
  body: z.string(),
});

export type UpdateDraft = z.infer<typeof UpdateDraftSchema>;

/**
 * `evidence` is the non-shipped-work material a product-update brief cited,
 * passed only by the unified drafting path (`generateDraftForPiece`). Optional
 * and empty by default so the claim-based compose path is unchanged.
 *
 * `template` is the tenant's product update template. Defaults to null, which
 * is the pre-template prompt — a caller that forgets it degrades to today's
 * behaviour rather than to a broken one.
 */
export async function generateReleaseDraft(
  items: AtomicUpdateForPrompt[],
  brandProfile: BrandProfileRow,
  personas: ResolvedPersona[] = [],
  examples: ExampleRow[] = [],
  evidence: BriefEvidenceForPrompt[] = [],
  template: string | null = null
): Promise<UpdateDraft> {
  const { system, prompt } = composeReleasePrompt({ items, brandProfile, personas, examples, evidence, template });

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
  /** Every atomic update the finished release carries; see `composeMergePrompt`. */
  releaseItems: AtomicUpdateForPrompt[];
  brandProfile: BrandProfileRow;
  personas?: ResolvedPersona[];
  examples?: ExampleRow[];
  template?: string | null;
}): Promise<UpdateDraft> {
  const { system, prompt } = composeMergePrompt({
    currentBody: args.currentBody,
    newItems: args.newItems,
    changedItems: args.changedItems,
    releaseItems: args.releaseItems,
    brandProfile: args.brandProfile,
    personas: args.personas ?? [],
    examples: args.examples ?? [],
    template: args.template ?? null,
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

/**
 * Writes a full draft from an accepted content brief (see `composeBriefPrompt`).
 * Mirrors `generateReleaseDraft`'s model resolution and usage recording
 * exactly — only the prompt composer differs.
 */
/**
 * Ceiling on a brief-driven draft's output.
 *
 * NOT optional. Without it the AI SDK's default applied and a live run of a
 * 1200-word blog post came back cut off mid-word at 631 words — a truncation
 * nothing in the pipeline detects, because a short body is indistinguishable
 * from a concise one. The validation spike had already found this shape ("6
 * uncapped briefs overflowed a 4096 default; set maxOutputTokens explicitly
 * regardless"); `ideate` and `proposeBriefFromSignals` both took the lesson and
 * this call, which writes by far the longest output, did not.
 *
 * 4,000 covers roughly 2,900 words at ~1.35 tokens per word — comfortably past
 * any `targetLength` a brief realistically asks for, while still bounding a
 * runaway. A brief asking for more than that will still truncate; if that ever
 * becomes real, derive this from `targetLength` rather than raising it blindly.
 */
export const MAX_BRIEF_DRAFT_OUTPUT_TOKENS = 4_000;

export async function generateBriefDraft(args: {
  brief: BriefForPrompt;
  evidence: BriefEvidenceForPrompt[];
  brandProfile: BrandProfileRow;
  personas?: ResolvedPersona[];
  examples?: ExampleRow[];
}): Promise<UpdateDraft> {
  const { system, prompt } = composeBriefPrompt({
    brief: args.brief,
    evidence: args.evidence,
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
    maxOutputTokens: MAX_BRIEF_DRAFT_OUTPUT_TOKENS,
  });

  await recordLlmUsage({
    tenantId: args.brandProfile.tenantId,
    operation: "brief_draft",
    model: modelId(spec),
    usage: result.usage,
  });

  return result.object;
}
