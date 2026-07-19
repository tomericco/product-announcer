import { generateObject } from "ai";
import { z } from "zod";
import type { changeItems, brandProfiles, ResolvedPersona, systemUpdateExamples } from "@/db/schema";
import { composePrompt } from "./compose-prompt";
import { resolveModel } from "./model";

type ChangeItemRow = typeof changeItems.$inferSelect;
type BrandProfileRow = typeof brandProfiles.$inferSelect;
type ExampleRow = typeof systemUpdateExamples.$inferSelect;

export const UpdateDraftSchema = z.object({
  title: z.string(),
  body: z.string(),
  category: z.enum(["new", "improved", "fixed"]),
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

  const result = await generateObject({
    model: resolveModel(process.env.GENERATION_MODEL ?? "anthropic/claude-sonnet-4-5"),
    schema: UpdateDraftSchema,
    system,
    prompt,
  });

  return result.object;
}
