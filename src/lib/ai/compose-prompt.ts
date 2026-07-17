import type { changeItems, brandProfiles, ResolvedPersona, systemUpdateExamples } from "@/db/schema";

type ChangeItemRow = typeof changeItems.$inferSelect;
type BrandProfileRow = typeof brandProfiles.$inferSelect;
type ExampleRow = typeof systemUpdateExamples.$inferSelect;

const DEFAULT_MAX_PROMPT_CHARS = 24000;

function formatChangeItem(item: ChangeItemRow, index: number, reposById: Map<string, string>): string {
  const repo = reposById.get(item.repoId) ?? "unknown";
  const n = index + 1;
  if (item.sourceType === "pr") {
    const detail = item.impactSummary ?? item.prDescription ?? "";
    return `${n}. [${repo} · PR #${item.prNumber}] "${item.prTitle}"${detail ? ` — ${detail}` : ""}`;
  }
  const sha = item.commitSha?.slice(0, 7) ?? "unknown";
  const detail = item.impactSummary ?? "";
  return `${n}. [${repo} · commit ${sha}] "${item.commitMessage}"${detail ? ` — ${detail}` : ""}`;
}

/**
 * Renders the batch as numbered, repo-tagged lines using each item's enriched
 * impactSummary (falling back to title/message). Diffs are never included — A's
 * enricher already distilled them into impactSummary. If the rendered batch exceeds
 * `maxChars`, trailing whole items are dropped and a summary note is appended.
 */
export function serializeBatch(
  items: ChangeItemRow[],
  reposById: Map<string, string>,
  maxChars = DEFAULT_MAX_PROMPT_CHARS
): string {
  const lines = items.map((item, i) => formatChangeItem(item, i, reposById));
  const full = lines.join("\n");
  if (full.length <= maxChars) return full;

  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const droppedIfStopHere = lines.length - (i + 1);
    const note = droppedIfStopHere > 0 ? `\n…and ${droppedIfStopHere} more changes not shown.` : "";
    const candidate = [...kept, lines[i]].join("\n") + note;
    // Always keep at least one item (a whole-item safety cap must still make progress),
    // even if that single item alone exceeds maxChars.
    if (candidate.length > maxChars && kept.length > 0) break;
    kept.push(lines[i]);
    if (candidate.length > maxChars) break;
  }

  const dropped = lines.length - kept.length;
  return dropped > 0 ? `${kept.join("\n")}\n…and ${dropped} more changes not shown.` : kept.join("\n");
}

function renderExample(example: ExampleRow): string {
  return `Example (${example.category}):\nTitle: ${example.title}\nBody:\n${example.body}`;
}

function renderPersona(persona: ResolvedPersona): string {
  return persona.description ? `${persona.name} (${persona.description}): ${persona.brief}` : `${persona.name}: ${persona.brief}`;
}

export function buildSystemPrompt(
  brandProfile: BrandProfileRow,
  personas: ResolvedPersona[],
  examples: ExampleRow[]
): string {
  const lines = [
    "You write concise, user-facing product update announcements.",
    brandProfile.industry ? `Industry: ${brandProfile.industry}.` : null,
    personas.length > 0
      ? `Audience personas — tailor the update to appeal to each: ${personas.map(renderPersona).join(" ")}`
      : null,
    brandProfile.tone ? `Tone: ${brandProfile.tone}.` : null,
    brandProfile.readingLevel ? `Reading level: ${brandProfile.readingLevel}.` : null,
    brandProfile.doList.length > 0 ? `Do: ${brandProfile.doList.join("; ")}.` : null,
    brandProfile.dontList.length > 0 ? `Avoid: ${brandProfile.dontList.join("; ")}.` : null,
    brandProfile.examplePhrases.length > 0
      ? `Prefer this vocabulary and phrasing where natural: ${brandProfile.examplePhrases.join("; ")}.`
      : null,
  ].filter((line): line is string => Boolean(line));

  const base = lines.join(" ");
  if (examples.length === 0) return base;

  const block = [
    "Here are example updates for a similar audience — mirror their structure, depth, and voice; do not reuse their wording or specifics:",
    ...examples.map(renderExample),
  ].join("\n\n");

  return `${base}\n\n${block}`;
}

export function composePrompt(args: {
  items: ChangeItemRow[];
  brandProfile: BrandProfileRow;
  reposById: Map<string, string>;
  personas: ResolvedPersona[];
  examples: ExampleRow[];
}): { system: string; prompt: string } {
  const batchText = serializeBatch(args.items, args.reposById);
  return {
    system: buildSystemPrompt(args.brandProfile, args.personas, args.examples),
    prompt: `Here are the changes to summarize into one product update. Format the body as Markdown (short paragraphs, and bullet lists where helpful):\n\n${batchText}`,
  };
}
