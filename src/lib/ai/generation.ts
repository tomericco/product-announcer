import { generateObject } from "ai";
import { z } from "zod";
import type { changeEvents, brandProfiles, ResolvedPersona, systemUpdateExamples } from "@/db/schema";
import { composePrompt, composeReleasePrompt, type AtomicUpdateForPrompt } from "./compose-prompt";
import { resolveModel, modelId } from "./model";
import { recordLlmUsage } from "./llm-usage";

type ChangeItemRow = typeof changeEvents.$inferSelect;
type BrandProfileRow = typeof brandProfiles.$inferSelect;
type ExampleRow = typeof systemUpdateExamples.$inferSelect;

export const UpdateDraftSchema = z.object({
  title: z.string(),
  body: z.string(),
});

export type UpdateDraft = z.infer<typeof UpdateDraftSchema>;

export async function generateUpdateDraft(
  items: ChangeItemRow[],
  brandProfile: BrandProfileRow,
  reposById: Map<string, string>,
  personas: ResolvedPersona[] = [],
  examples: ExampleRow[] = []
): Promise<UpdateDraft> {
  const { system, prompt } = composePrompt({ items, brandProfile, reposById, personas, examples });

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
