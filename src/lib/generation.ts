import { generateObject } from "ai";
import { z } from "zod";
import type { changeItems, brandProfiles } from "../db/schema";

type ChangeItemRow = typeof changeItems.$inferSelect;
type BrandProfileRow = typeof brandProfiles.$inferSelect;

export const UpdateDraftSchema = z.object({
  title: z.string(),
  body: z.string(),
  category: z.enum(["new", "improved", "fixed"]),
});

export type UpdateDraft = z.infer<typeof UpdateDraftSchema>;

const DEFAULT_MAX_PROMPT_CHARS = 24000;

function formatChangeItem(
  item: ChangeItemRow,
  index: number,
  includeDiff: boolean,
  reposById: Map<string, string>
): string {
  const repo = reposById.get(item.repoId) ?? "unknown";
  if (item.sourceType === "pr") {
    return `${index + 1}. [${repo} · PR #${item.prNumber}] "${item.prTitle}" — ${item.prDescription ?? ""}`;
  }
  const shortSha = item.commitSha?.slice(0, 7) ?? "unknown";
  const diffPart = includeDiff && item.diff ? ` — ${item.diff}` : "";
  return `${index + 1}. [${repo} · commit ${shortSha}] "${item.commitMessage}"${diffPart}`;
}

export function serializeBatchForPrompt(
  items: ChangeItemRow[],
  reposById: Map<string, string>,
  maxChars = DEFAULT_MAX_PROMPT_CHARS
): string {
  const includeDiffFlags = items.map(() => true);

  const render = () => items.map((item, i) => formatChangeItem(item, i, includeDiffFlags[i], reposById)).join("\n");

  let current = render();
  if (current.length <= maxChars) return current;

  const byDiffSizeDesc = items
    .map((item, index) => ({ index, diffLength: item.diff?.length ?? 0 }))
    .sort((a, b) => b.diffLength - a.diffLength);

  for (const { index, diffLength } of byDiffSizeDesc) {
    if (current.length <= maxChars || diffLength === 0) break;
    includeDiffFlags[index] = false;
    current = render();
  }

  return current;
}

function buildSystemPrompt(brandProfile: BrandProfileRow): string {
  const lines = [
    "You write concise, user-facing product update announcements.",
    brandProfile.industry ? `Industry: ${brandProfile.industry}.` : null,
    brandProfile.userPersonas.length > 0 ? `Audience: ${brandProfile.userPersonas.join(", ")}.` : null,
    brandProfile.tone ? `Tone: ${brandProfile.tone}.` : null,
    brandProfile.readingLevel ? `Reading level: ${brandProfile.readingLevel}.` : null,
    brandProfile.doList.length > 0 ? `Do: ${brandProfile.doList.join("; ")}.` : null,
    brandProfile.dontList.length > 0 ? `Avoid: ${brandProfile.dontList.join("; ")}.` : null,
  ].filter((line): line is string => Boolean(line));

  return lines.join(" ");
}

export async function generateUpdateDraft(
  items: ChangeItemRow[],
  brandProfile: BrandProfileRow,
  reposById: Map<string, string>
): Promise<UpdateDraft> {
  const batchText = serializeBatchForPrompt(items, reposById);

  const result = await generateObject({
    model: process.env.GENERATION_MODEL ?? "anthropic/claude-sonnet-4-5",
    schema: UpdateDraftSchema,
    system: buildSystemPrompt(brandProfile),
    prompt: `Here are the changes to summarize into one product update:\n\n${batchText}`,
  });

  return result.object;
}
