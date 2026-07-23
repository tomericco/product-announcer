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
    "Write only about this company's own product. Never name, compare to, or reference competitors or other companies.",
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
  category: "new" | "improvement" | "fix" | "announcement" | null;
  size: "s" | "m" | "l" | "xl" | null;
};

function formatAtomicUpdate(item: AtomicUpdateForPrompt, index: number): string {
  const parts = [item.category, item.size ? item.size.toUpperCase() : null].filter(Boolean);
  const tag = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `${index + 1}. "${item.title}"${tag} — ${item.summary}`;
}

const SIZE_GUIDANCE =
  "Give each update space proportional to its size. XL updates are the headline — lead with them, each in " +
  "its own short paragraph. L updates each get their own short paragraph. M updates get a sentence or two and " +
  "may share a paragraph. S updates are minor: when there are two or more, gather them into a single bulleted " +
  "list (e.g. under \"Also improved\" or \"Smaller fixes\") rather than a paragraph each; a lone S update may be " +
  "a brief one-liner. Treat an update with no stated size as M.";

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
    prompt: `Here are the changes to summarize into one product update. Format the body as Markdown (short paragraphs, and bullet lists where helpful). ${SIZE_GUIDANCE}\n\n${serializeAtomicUpdates(args.items)}`,
  };
}

/**
 * Builds the prompt for a catch-up MERGE regeneration: folding new/changed
 * atomic updates into an existing draft body. Contrast with
 * `composeReleasePrompt`, which writes fresh from a plain list of items — here
 * the current body is the anchor, and the system prompt instructs the model to
 * preserve its existing wording and structure rather than rewrite it.
 */
export function composeMergePrompt(args: {
  currentBody: string;
  newItems: AtomicUpdateForPrompt[];
  changedItems: AtomicUpdateForPrompt[];
  brandProfile: BrandProfileRow;
  personas: ResolvedPersona[];
  examples: ExampleRow[];
}): { system: string; prompt: string } {
  const base = buildSystemPrompt(args.brandProfile, args.personas, args.examples);
  const system = `${base}\n\nYou are revising an existing draft release note to fold in new material — you are not writing a fresh one. Preserve the current body's existing wording and structure wherever it still applies; integrate the new and changed items by editing and extending that text rather than rewriting it from scratch.`;

  const currentBody =
    args.currentBody.length > DEFAULT_MAX_PROMPT_CHARS
      ? `${args.currentBody.slice(0, DEFAULT_MAX_PROMPT_CHARS)}\n…(truncated)`
      : args.currentBody;

  const sections = [`Current body (preserve this wording and structure where it still applies):\n${currentBody}`];
  if (args.newItems.length > 0) {
    sections.push(`New changes to fold in:\n${serializeAtomicUpdates(args.newItems)}`);
  }
  if (args.changedItems.length > 0) {
    sections.push(`Changes whose details were updated since the current body was written:\n${serializeAtomicUpdates(args.changedItems)}`);
  }

  const prompt = `Update the product release note below to incorporate the new material, preserving as much of the existing wording and structure as still applies. Format the body as Markdown (short paragraphs, and bullet lists where helpful). ${SIZE_GUIDANCE}\n\n${sections.join("\n\n")}`;

  return { system, prompt };
}
