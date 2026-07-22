import type { brandProfiles, ResolvedPersona, systemUpdateExamples } from "@/db/schema";

type BrandProfileRow = typeof brandProfiles.$inferSelect;
type ExampleRow = typeof systemUpdateExamples.$inferSelect;

const DEFAULT_MAX_PROMPT_CHARS = 24000;

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
    brandProfile.updatesStyleSummary
      ? `Match the house style of their existing updates: ${brandProfile.updatesStyleSummary}.`
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

export type AtomicUpdateForPrompt = {
  id: string;
  title: string;
  summary: string;
  category: "new" | "improved" | "fixed" | null;
};

function formatAtomicUpdate(item: AtomicUpdateForPrompt, index: number): string {
  const tag = item.category ? ` (${item.category})` : "";
  return `${index + 1}. "${item.title}"${tag} — ${item.summary}`;
}

/**
 * Renders selected atomic updates as numbered title + summary lines. Atomic
 * updates are already distilled and repo-agnostic — no repo tag, no PR/commit
 * branching. Trailing items past `maxChars` are dropped whole with a note.
 */
export function serializeAtomicUpdates(
  items: AtomicUpdateForPrompt[],
  maxChars = DEFAULT_MAX_PROMPT_CHARS
): string {
  const lines = items.map(formatAtomicUpdate);
  const full = lines.join("\n");
  if (full.length <= maxChars) return full;

  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const droppedIfStopHere = lines.length - (i + 1);
    const note = droppedIfStopHere > 0 ? `\n…and ${droppedIfStopHere} more updates not shown.` : "";
    const candidate = [...kept, lines[i]].join("\n") + note;
    if (candidate.length > maxChars && kept.length > 0) break;
    kept.push(lines[i]);
    if (candidate.length > maxChars) break;
  }
  const dropped = lines.length - kept.length;
  return dropped > 0 ? `${kept.join("\n")}\n…and ${dropped} more updates not shown.` : kept.join("\n");
}

export function composeReleasePrompt(args: {
  items: AtomicUpdateForPrompt[];
  brandProfile: BrandProfileRow;
  personas: ResolvedPersona[];
  examples: ExampleRow[];
}): { system: string; prompt: string } {
  return {
    system: buildSystemPrompt(args.brandProfile, args.personas, args.examples),
    prompt: `Here are the changes to summarize into one product update. Format the body as Markdown (short paragraphs, and bullet lists where helpful):\n\n${serializeAtomicUpdates(args.items)}`,
  };
}
