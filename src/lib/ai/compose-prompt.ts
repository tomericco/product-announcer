import type { companyProfiles, ResolvedPersona, systemContentExamples } from "@/db/schema";
import { contentTypeEnum } from "@/db/schema";

type BrandProfileRow = typeof companyProfiles.$inferSelect;
type ExampleRow = typeof systemContentExamples.$inferSelect;
export type ContentType = (typeof contentTypeEnum.enumValues)[number];

const DEFAULT_MAX_PROMPT_CHARS = 24000;
const MAX_GUIDELINES_CHARS = 6000;

function renderExample(example: ExampleRow): string {
  const label = example.category ? `Example (${example.category}):` : "Example:";
  return `${label}\nTitle: ${example.title}\nBody:\n${example.body}`;
}

function renderPersona(persona: ResolvedPersona): string {
  return persona.description ? `${persona.name} (${persona.description}): ${persona.brief}` : `${persona.name}: ${persona.brief}`;
}

/**
 * The team's brand guidelines document, prepared for prompt injection: trimmed,
 * and capped so a very long document can't crowd out the material being
 * summarized. Returns null when nothing is configured, so callers omit the
 * block entirely rather than injecting an empty one.
 */
export function truncateGuidelines(guidelines: string | null): string | null {
  const trimmed = guidelines?.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_GUIDELINES_CHARS
    ? `${trimmed.slice(0, MAX_GUIDELINES_CHARS)}\n…(truncated)`
    : trimmed;
}

const ROLE_LINES: Record<ContentType, string> = {
  product_update: "You write concise, user-facing product update announcements.",
  blog_post: "You write industry blog posts for this company's audience — substantive, specific, and useful to a practitioner.",
  social_post: "You write a single short social post: one idea, no headings, no preamble.",
};

export function buildSystemPrompt(
  brandProfile: BrandProfileRow,
  personas: ResolvedPersona[],
  examples: ExampleRow[],
  contentType: ContentType = "product_update"
): string {
  const lines = [
    ROLE_LINES[contentType],
    // Product updates keep the total prohibition — an announcement about our own
    // release has no business naming anyone else, and that rule predates the
    // brief pipeline entirely.
    //
    // Blog and social posts may name other companies, reversed on 2026-08-06
    // from the stricter rule this file previously applied to every type. The
    // reason for the reversal is the reason the strict rule was doubted when it
    // was chosen: the validation spike's highest-value brief was a response to a
    // named competitor's security advisory, and a piece that covers an industry
    // development while refusing to say who did it reads as evasive to anyone
    // who knows the context.
    //
    // Nothing here licenses invention: the grounding rule below still binds, so
    // a claim about another company must come from the source material rather
    // than from the model's memory.
    contentType === "product_update"
      ? "Write only about this company's own product. Never name, compare to, or reference competitors or other companies."
      : "You may name other companies and respond to what they published or shipped, but only as the source material describes them. Never state a comparison, ranking, or claim about another company that the source material does not support.",
    "Ground every statement strictly in the source material you are given. Only describe changes that appear in that material; never invent or embellish features, capabilities, benefits, use cases, metrics, numbers, dates, version names, quotes, or any other specifics. If a detail is not in the source, leave it out rather than guessing — an omission is always better than a fabrication.",
    "Never fabricate links. Only include a URL if it appears verbatim in the source material; do not construct, complete, shorten, or recall a URL from memory, and do not guess a plausible one. If a link would be helpful but no verified URL is present in the source, write the literal placeholder [add link] in its place so an editor can fill it in — never emit a made-up or guessed URL.",
    brandProfile.industry ? `Industry: ${brandProfile.industry}.` : null,
    personas.length > 0
      ? `Audience personas — tailor the update to appeal to each: ${personas.map(renderPersona).join(" ")}`
      : null,
  ].filter((line): line is string => Boolean(line));

  // The fixed instructions read as one paragraph, but the guidelines document is
  // Markdown — joining it with " " like the lines above would flatten its
  // structure, so it becomes its own block. Delimiters keep the team's prose
  // from reading as further instructions to the model.
  const blocks = [lines.join(" ")];

  // The guidelines document is written for product updates — the onboarding
  // agent derives it from the company's own changelog, so it prescribes
  // changelog conventions: opening with what shipped, emoji section anchors,
  // breaking-change callouts, performance percentages.
  //
  // Applying that wholesale to a blog post produced exactly what you would
  // expect on the first live run: a fabricated "UX impact / May 15, 2025"
  // category-and-date header and a "Team Frontitude" sign-off, neither of which
  // appeared in any source. The metrics guidance is the dangerous one — it
  // invites invented numbers into a piece that has no shipped work to measure.
  //
  // So for other content types the guidelines are introduced as VOICE ONLY.
  // They are still the team's own words about how the company sounds; it is
  // their structural conventions that do not transfer.
  const guidelines = truncateGuidelines(brandProfile.guidelines);
  if (guidelines) {
    const framing =
      contentType === "product_update"
        ? "Follow these brand writing guidelines, written by the team:"
        : [
            "These brand writing guidelines were written by the team for the company's PRODUCT UPDATES, not for this piece.",
            "Take from them only the voice: tone, vocabulary, level of formality, and anything they tell you not to do.",
            "Ignore their structural conventions entirely — do not open with what shipped, do not add emoji section anchors,",
            "do not add a category label, a date line, or a sign-off, and do not cite performance percentages or metrics.",
            "Never invent a detail in order to match a format they describe.",
          ].join(" ");
    blocks.push(`${framing}\n<brand-guidelines>\n${guidelines}\n</brand-guidelines>`);
  }

  if (examples.length > 0) {
    blocks.push(
      [
        "Here are example updates for a similar audience — mirror their structure, depth, and voice; do not reuse their wording or specifics:",
        ...examples.map(renderExample),
      ].join("\n\n")
    );
  }

  return blocks.join("\n\n");
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

const FORMAT_GUIDANCE: Record<ContentType, string> = {
  product_update: SIZE_GUIDANCE,
  blog_post: "Format the body as Markdown with section headings. Aim for the target length if one is given.",
  social_post: "Plain text, no Markdown headings, no bullet lists. A few sentences at most.",
};

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

/**
 * `evidence` carries the NON-shipped-work signals a product-update brief cited
 * when this prompt is reached through the unified drafting path. Only
 * `shipped_work` signals supply `items`; the rest would otherwise be silently
 * dropped on the way into a release composition. It is optional and empty by
 * default, so the claim-based compose path is unaffected.
 *
 * It is fenced as context, not as material to announce: a news article a brief
 * cited is background for how the update is framed, not something this company
 * shipped.
 */
export function composeReleasePrompt(args: {
  items: AtomicUpdateForPrompt[];
  brandProfile: BrandProfileRow;
  personas: ResolvedPersona[];
  examples: ExampleRow[];
  evidence?: BriefEvidenceForPrompt[];
}): { system: string; prompt: string } {
  const evidence = args.evidence ?? [];
  const context =
    evidence.length > 0
      ? `\n\nBackground the brief cited — context for framing only. None of it is work this company shipped, so do not announce any of it as a change; ground anything you take from it strictly in what it says.\n<sources>\n${serializeBriefEvidence(evidence)}\n</sources>`
      : "";

  return {
    system: buildSystemPrompt(args.brandProfile, args.personas, args.examples),
    prompt: `Here are the changes to summarize into one product update. Format the body as Markdown (short paragraphs, and bullet lists where helpful). ${SIZE_GUIDANCE}\n\n${serializeAtomicUpdates(args.items)}${context}`,
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

/**
 * Prompt for a SURGICAL edit of one highlighted excerpt: the full body is
 * context only, and the model must return just the revised excerpt so the
 * client can splice it back in place (see `applyEdit`, selection mode). Contrast
 * `composeWholeEditPrompt`, which returns the whole body.
 */
export function composeScopedEditPrompt(args: {
  fullBody: string;
  excerpt: string;
  instruction: string;
  brandProfile: BrandProfileRow;
  personas: ResolvedPersona[];
  examples: ExampleRow[];
}): { system: string; prompt: string } {
  const base = buildSystemPrompt(args.brandProfile, args.personas, args.examples);
  const system = `${base}\n\nYou are revising ONE excerpt of an existing product update, not writing a fresh one. Return only the revised excerpt as Markdown — no surrounding text, no explanation, no code fences. Match the voice and formatting of the rest of the update, and change only what the instruction asks; keep the facts and meaning otherwise intact.`;

  const fullBody =
    args.fullBody.length > DEFAULT_MAX_PROMPT_CHARS
      ? `${args.fullBody.slice(0, DEFAULT_MAX_PROMPT_CHARS)}\n…(truncated)`
      : args.fullBody;

  const prompt = `Full update, for context only — do not return it:\n${fullBody}\n\nExcerpt to revise:\n${args.excerpt}\n\nInstruction: ${args.instruction}\n\nReturn only the revised excerpt.`;
  return { system, prompt };
}

/**
 * Prompt for a WHOLE-update edit: apply an instruction across the body and
 * return the full revised body, preserving existing wording where the
 * instruction doesn't call for change (same "revise, don't rewrite" stance as
 * `composeMergePrompt`).
 */
export function composeWholeEditPrompt(args: {
  currentBody: string;
  instruction: string;
  brandProfile: BrandProfileRow;
  personas: ResolvedPersona[];
  examples: ExampleRow[];
}): { system: string; prompt: string } {
  const base = buildSystemPrompt(args.brandProfile, args.personas, args.examples);
  const system = `${base}\n\nYou are revising an existing product update per an instruction — not writing a fresh one. Preserve the current wording and structure wherever the instruction doesn't call for a change; edit and extend rather than rewrite from scratch. Return the full revised body as Markdown — no explanation, no code fences.`;

  const currentBody =
    args.currentBody.length > DEFAULT_MAX_PROMPT_CHARS
      ? `${args.currentBody.slice(0, DEFAULT_MAX_PROMPT_CHARS)}\n…(truncated)`
      : args.currentBody;

  const prompt = `Apply this instruction to the product update below and return the full revised body. Format as Markdown (short paragraphs, and bullet lists where helpful).\n\nInstruction: ${args.instruction}\n\nCurrent body:\n${currentBody}`;
  return { system, prompt };
}

/**
 * Prompt for EXTRACTING a highlighted passage out of a larger update into an
 * update of its own. Unlike `composeScopedEditPrompt` (which revises an excerpt
 * in place, returning only the excerpt) the result here is a whole new draft —
 * title and body — that must stand alone with no back-reference to the update
 * it was lifted from.
 */
export function composeExtractPrompt(args: {
  excerpt: string;
  instruction: string;
  brandProfile: BrandProfileRow;
  personas: ResolvedPersona[];
  examples: ExampleRow[];
}): { system: string; prompt: string } {
  const base = buildSystemPrompt(args.brandProfile, args.personas, args.examples);
  const system =
    `${base}\n\nYou are rewriting a passage that was lifted out of a larger product update so that it ` +
    `stands on its own. Return a complete, self-contained update with its own title — it must read as if ` +
    `it had always been a separate announcement, with no reference to the update it came from and no ` +
    `words like "also", "additionally", or "as mentioned above" that only made sense in the original. ` +
    `Stay grounded strictly in the passage: keep every change it describes, and add no feature, benefit, ` +
    `metric, or detail that is not already there.`;

  const excerpt =
    args.excerpt.length > DEFAULT_MAX_PROMPT_CHARS
      ? `${args.excerpt.slice(0, DEFAULT_MAX_PROMPT_CHARS)}\n…(truncated)`
      : args.excerpt;

  const sections = [`Passage to rewrite as its own update:\n${excerpt}`];
  const instruction = args.instruction.trim();
  if (instruction.length > 0) {
    sections.push(`Additional instruction from the editor:\n${instruction}`);
  }

  const prompt =
    `Rewrite the passage below as a standalone product update. Format the body as Markdown ` +
    `(short paragraphs, and bullet lists where helpful).\n\n${sections.join("\n\n")}`;

  return { system, prompt };
}

/**
 * The commission, as the human last left it. `body` is the brief's markdown
 * document — read through `briefBody` (`@/lib/briefs/body`), never re-rendered
 * from the structured fields here — which is what makes editing a brief change
 * the draft it produces. `title`, `contentType` and `targetLength` are not part
 * of that prose: they are instructions to the model about the piece's shape.
 */
export type BriefForPrompt = {
  title: string;
  body: string;
  contentType: ContentType;
  targetLength: number | null;
};

export type BriefEvidenceForPrompt = { title: string; kind: string; excerpt: string | null };

/**
 * Renders the signals a brief cited. The analogue of `serializeAtomicUpdates`,
 * which serializes atomic updates and is the wrong shape for this input.
 * Trailing items past `maxChars` are dropped whole with a note, never cut
 * mid-item.
 */
export function serializeBriefEvidence(
  items: BriefEvidenceForPrompt[],
  maxChars = DEFAULT_MAX_PROMPT_CHARS
): string {
  const lines = items.map(
    (item, i) => `${i + 1}. [${item.kind}] "${item.title}"${item.excerpt ? ` — ${item.excerpt}` : ""}`
  );
  const full = lines.join("\n");
  if (full.length <= maxChars) return full;

  const kept: string[] = [];
  for (const line of lines) {
    if ([...kept, line].join("\n").length > maxChars && kept.length > 0) break;
    kept.push(line);
    if (kept.join("\n").length > maxChars) break;
  }
  const dropped = lines.length - kept.length;
  return dropped > 0 ? `${kept.join("\n")}\n…and ${dropped} more signals not shown.` : kept.join("\n");
}

export function composeBriefPrompt(args: {
  brief: BriefForPrompt;
  evidence: BriefEvidenceForPrompt[];
  brandProfile: BrandProfileRow;
  personas: ResolvedPersona[];
  examples: ExampleRow[];
}): { system: string; prompt: string } {
  const { brief } = args;
  const commission = [
    `Write this piece. Title: "${brief.title}".`,
    brief.body,
    brief.targetLength ? `Target length: about ${brief.targetLength} words.` : null,
    FORMAT_GUIDANCE[brief.contentType],
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");

  // The evidence is source material, NOT part of the commission — the two are
  // fenced apart because the model otherwise treats the body as one more
  // signal. The naming reminder sits here rather than only in the system
  // prompt because this is where the company names actually appear.
  const evidence =
    args.evidence.length > 0
      ? `\n\nSource material — ground every factual claim in it, including anything you say about another company.\n<sources>\n${serializeBriefEvidence(args.evidence)}\n</sources>`
      : "\n\nNo source material was attached. Write only what the commission above supports.";

  return {
    system: buildSystemPrompt(args.brandProfile, args.personas, args.examples, brief.contentType),
    prompt: `${commission}${evidence}`,
  };
}
