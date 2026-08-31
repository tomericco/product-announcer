import type { companyProfiles, ResolvedPersona, systemContentExamples } from "@/db/schema";
import { contentTypeEnum } from "@/db/schema";
import {
  DEFAULT_MAX_PROMPT_CHARS,
  fenceGuidelines,
  GROUNDING_RULE,
  NO_INVENTED_LINKS_RULE,
  SIZE_RANK,
  truncateForPrompt,
  type SizeKey,
} from "./prompt-rules";
import { parseTemplate, substituteVariables } from "./template";

type BrandProfileRow = typeof companyProfiles.$inferSelect;
type ExampleRow = typeof systemContentExamples.$inferSelect;
export type ContentType = (typeof contentTypeEnum.enumValues)[number];

function renderExample(example: ExampleRow): string {
  const label = example.category ? `Example (${example.category}):` : "Example:";
  return `${label}\nTitle: ${example.title}\nBody:\n${example.body}`;
}

function renderPersona(persona: ResolvedPersona): string {
  return persona.description ? `${persona.name} (${persona.description}): ${persona.brief}` : `${persona.name}: ${persona.brief}`;
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
    GROUNDING_RULE,
    NO_INVENTED_LINKS_RULE,
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
  const guidelines = fenceGuidelines(brandProfile.guidelines);
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
    blocks.push(`${framing}\n${guidelines}`);
  }

  if (examples.length > 0) {
    blocks.push(
      [
        "Here are example updates for a similar audience — mirror their structure, depth, and voice; do not reuse their wording or specifics:",
        ...examples.map(renderExample),
      ].join("\n\n")
    );
  }

  return blocks.join("\n");
}

export type AtomicUpdateForPrompt = {
  id: string;
  title: string;
  summary: string;
  category: "new" | "improvement" | "fix" | "announcement" | null;
  size: "s" | "m" | "l" | "xl" | null;
  // Non-null means a human set the size. Breaks ties in the composer's sort:
  // a human who picked a size is a stronger signal than a Haiku call on a
  // one-line summary.
  sizeEditedAt: Date | null;
  // The most recent real-world date among this update's evidence. Feeds
  // {month}/{year}, which must describe the work's period, not the
  // composition date.
  latestEvidenceAt: Date | null;
};

/**
 * Most significant first. A sort, not an assignment: which change leads is the
 * model's editorial call, but it should read them in the order that matters.
 * An earlier design assigned items to named template slots deterministically —
 * cut, because a template with fixed sections already prevents the failure that
 * motivated it. See the spec's Part 1.
 */
function bySignificance(a: AtomicUpdateForPrompt, b: AtomicUpdateForPrompt): number {
  const rank = (item: AtomicUpdateForPrompt) => SIZE_RANK[(item.size ?? "m") as SizeKey];
  return (
    rank(b) - rank(a) ||
    Number(Boolean(b.sizeEditedAt)) - Number(Boolean(a.sizeEditedAt))
  );
}

/**
 * The template as the model will see it: variables replaced from these items.
 *
 * Exported, and deriving `latestEvidenceAt` itself, because the reviewer needs
 * the SAME substituted string the composer produced. Two call sites each
 * assembling their own `TemplateFacts` is how the composer and the reviewer end
 * up disagreeing about what `{count}` was.
 */
export function fillTemplate(template: string, items: AtomicUpdateForPrompt[]): string {
  const latestEvidenceAt = items.reduce<Date | null>(
    (max, item) => (item.latestEvidenceAt && (!max || item.latestEvidenceAt > max) ? item.latestEvidenceAt : max),
    null
  );
  return substituteVariables(template, { items, latestEvidenceAt });
}

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
 *
 * `template` is the tenant's product update template, or null when they have
 * none — which is every tenant that has not re-imported since the template was
 * introduced. The NULL BRANCH MUST RENDER BYTE-FOR-BYTE what this function
 * rendered before templates existed: it is the live path, and a refactor that
 * drifts it silently changes every existing tenant's output.
 *
 * `examples` is still accepted but no longer reaches the system prompt on this
 * path (see the `[]` below). A tenant with a real template does not need a
 * stranger's changelog to imitate, and a tenant without one was getting generic
 * exemplars fighting their own guidelines. The parameter stays because blog and
 * social still use it.
 */
export function composeReleasePrompt(args: {
  items: AtomicUpdateForPrompt[];
  brandProfile: BrandProfileRow;
  personas: ResolvedPersona[];
  examples: ExampleRow[];
  evidence?: BriefEvidenceForPrompt[];
  template: string | null;
}): { system: string; prompt: string } {
  const evidence = args.evidence ?? [];
  const context =
    evidence.length > 0
      ? `\n\nBackground the brief cited — context for framing only. None of it is work this company shipped, so do not announce any of it as a change; ground anything you take from it strictly in what it says.\n<sources>\n${serializeBriefEvidence(evidence)}\n</sources>`
      : "";

  const system = buildSystemPrompt(args.brandProfile, args.personas, [], "product_update");

  const untemplated = {
    system,
    prompt: `Here are the changes to summarize into one product update. Format the body as Markdown (short paragraphs, and bullet lists where helpful). ${SIZE_GUIDANCE}\n\n${serializeAtomicUpdates(args.items)}${context}`,
  };

  if (!args.template) return untemplated;

  const sorted = [...args.items].sort(bySignificance);
  const { titlePattern, bodySkeleton } = parseTemplate(fillTemplate(args.template, sorted));

  // An H1-only template (or one that's otherwise blank once the title line is
  // stripped) leaves nothing for "reproduce the template's structure exactly"
  // to act on — the model would be handed `<template>\n\n</template>` right
  // alongside the instruction to add no section the template doesn't have,
  // which is a contradiction, not a constraint. Fall back to the untemplated
  // path instead. Reachable by hand-editing a template down to a bare heading
  // on /company.
  if (!bodySkeleton) return untemplated;

  const instruction = [
    "Write one product update following the template below.",
    "Reproduce the template's structure exactly — its sections, their order, its headings and any sign-off —",
    "placing each change where it belongs. Omit a section you have nothing to put in rather than inventing filler,",
    "and add no section the template does not have.",
    "A bare [image] or [video] marker is a slot only a person can fill — a screenshot or walkthrough of the",
    "product. Reproduce it exactly where the template puts it and write nothing in its place: no caption, no",
    "description of what the picture would show, no apology for its absence. An editor replaces it before",
    "publishing.",
    "Anything in {curly braces} is an INSTRUCTION describing what belongs in that position — write that, and",
    "delete the braces. Never reproduce a brace, or the words inside it, in what you publish: a template",
    "reading '{main feature, plus 1-2 smaller ones} {month}' asks for a title naming the biggest change and",
    "one or two lesser ones, followed by the month. Everything OUTSIDE braces is the company's own wording",
    "and is reproduced verbatim.",
    titlePattern
      ? `The title must follow this pattern: ${titlePattern}`
      : "Write a title in the company's usual style; the template does not prescribe one.",
    "Any number already present in the template is authoritative: never recompute it, and never adjust it to match your own prose.",
  ].join(" ");

  return {
    system,
    prompt: `${instruction}\n\n<template>\n${bodySkeleton}\n</template>\n\nThe changes to place into it, most significant first:\n${serializeAtomicUpdates(sorted)}${context}`,
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
  /**
   * EVERY atomic update the finished release will carry — the ones already
   * written up plus the delta being folded in — not just the delta.
   *
   * The template's variables are computed from this, and only from this. A
   * `{count}` substituted over the delta would put "2 updates this month" into
   * the skeleton of a nine-update release: `parseTemplate` strips the leading
   * H1, so a headline count never reaches the model, but a count inside a body
   * section does. Required rather than optional so a caller has to go and find
   * the full set instead of defaulting to the delta it already has in hand.
   */
  releaseItems: AtomicUpdateForPrompt[];
  brandProfile: BrandProfileRow;
  personas: ResolvedPersona[];
  examples: ExampleRow[];
  template: string | null;
}): { system: string; prompt: string } {
  const base = buildSystemPrompt(args.brandProfile, args.personas, [], "product_update");

  // Parsed once, and gated on below instead of `args.template` directly: an
  // H1-only (or otherwise blank-after-title) template leaves `bodySkeleton`
  // empty, and fencing an empty `<template></template>` while telling the
  // model to fold material into "its existing sections rather than adding
  // sections of your own" is a contradiction, not a constraint — the same
  // failure `composeReleasePrompt` was fixed to fall back from. There is no
  // title pattern to fall back to here the way `composeReleasePrompt` has
  // one (the title is preserved on this path), so an empty skeleton simply
  // means "act as if there is no template."
  const bodySkeleton = args.template ? parseTemplate(fillTemplate(args.template, args.releaseItems)).bodySkeleton : "";

  // The template is framed as the shape the body ALREADY has, not as a target
  // to restructure toward — this call's whole stance is "revise, don't
  // rewrite", and handing the model a skeleton without that framing invites it
  // to reformat prose a human may have edited.
  //
  // Only the body skeleton is carried: the title is preserved on this path, so
  // a title pattern has nothing to act on. The authoritative-numbers clause is
  // the same one `composeReleasePrompt` uses, and for the same reason — the
  // substitution already happened in code, so a model recomputing a number is
  // a model introducing an error.
  const templateNote = bodySkeleton
    ? `\n\nThe current body follows the company's product update template, reproduced below. Fold the new material into its existing sections rather than adding sections of your own; do not restructure text that already fits. Any number already present in the template is authoritative: never recompute it, and never adjust it to match your own prose.\n<template>\n${bodySkeleton}\n</template>`
    : "";

  const system = `${base}\n\nYou are revising an existing draft release note to fold in new material — you are not writing a fresh one. Preserve the current body's existing wording and structure wherever it still applies; integrate the new and changed items by editing and extending that text rather than rewriting it from scratch.${templateNote}`;

  const currentBody = truncateForPrompt(args.currentBody);

  const sections = [`Current body (preserve this wording and structure where it still applies):\n${currentBody}`];
  if (args.newItems.length > 0) {
    sections.push(`New changes to fold in:\n${serializeAtomicUpdates(args.newItems)}`);
  }
  if (args.changedItems.length > 0) {
    sections.push(`Changes whose details were updated since the current body was written:\n${serializeAtomicUpdates(args.changedItems)}`);
  }

  // `SIZE_GUIDANCE` prescribes its own structure ("gather S updates into a
  // single bulleted list"), which directly contradicts a skeleton's literal
  // sections. `composeReleasePrompt` omits it when a template is present for
  // exactly this reason; the two paths must not disagree. Gated on
  // `bodySkeleton` rather than `args.template` for the same reason `templateNote`
  // is: an empty skeleton means this behaves as the untemplated path.
  const sizeGuidance = bodySkeleton ? "" : ` ${SIZE_GUIDANCE}`;
  const prompt = `Update the product release note below to incorporate the new material, preserving as much of the existing wording and structure as still applies. Format the body as Markdown (short paragraphs, and bullet lists where helpful).${sizeGuidance}\n\n${sections.join("\n\n")}`;

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

  const fullBody = truncateForPrompt(args.fullBody);

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

  const currentBody = truncateForPrompt(args.currentBody);

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

  const excerpt = truncateForPrompt(args.excerpt);

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
  // Joined with a BLANK line, not a newline. `brief.body` is multi-line
  // markdown, so a single "\n" glues whatever follows onto its last line: the
  // target-length instruction becomes another sentence of the body's closing
  // section (or, when the body ends in a list, another bullet), and the title
  // line runs straight into the body's first heading. Instructions absorbed
  // into commission prose stop reading as instructions — verified against a
  // rendered prompt, not assumed. Every element here is a self-contained block.
  const commission = [
    `Write this piece. Title: "${brief.title}".`,
    brief.body,
    brief.targetLength ? `Target length: about ${brief.targetLength} words.` : null,
    FORMAT_GUIDANCE[brief.contentType],
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n\n");

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
