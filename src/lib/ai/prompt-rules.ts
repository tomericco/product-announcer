/**
 * Rules stated in more than one system prompt, in one place.
 *
 * The precedent is `src/lib/briefs/signal-fence.ts`, which already does this
 * for `ideate` and `propose`. Deliberately NOT a prompt framework: no registry,
 * no builder, no per-call configuration. Call sites still compose their own
 * system prompts — they just stop restating shared clauses and drifting apart
 * while doing it.
 *
 * `ideate` and `propose` are deliberately NOT customers of GROUNDING_RULE. They
 * lack a grounding rule too, and adding one is a real behaviour change to two
 * prompts tuned against recorded spike results — a separate decision, not a
 * cleanup. See the spec's Part 0, rule 3.
 */

import { SIZE_BANDS } from "@/lib/atomic-updates/sizes";

/** Chars of a body/excerpt a prompt will carry before truncation. */
export const DEFAULT_MAX_PROMPT_CHARS = 24000;

/** Chars of the brand guidelines document a prompt will carry. */
const MAX_GUIDELINES_CHARS = 6000;

/** The bottom-up decision sentence appended to `SIZE_RUBRIC` below. */
const BOTTOM_UP_SENTENCE =
  "Decide from the bottom up: if no user could notice it, 'xxs'; if a user could notice it but would not care, 'xs'; otherwise 's' or larger by how many users it reaches and how much it changes for them.";

/**
 * Rendered ASCENDING (xxs first, xl last), so the model reads the rubric from
 * "nothing noticeable" up to "flagship" — the same direction as the bottom-up
 * decision sentence appended below. `SIZE_BANDS` (in
 * `src/lib/atomic-updates/sizes.ts`, the source of truth for bands and their
 * order) is descending because that is what `SIZE_RANK` there needs;
 * reversing here rather than there keeps that module's order load-bearing in
 * one direction only.
 */
export const SIZE_RUBRIC = `Also pick a size by USER-FACING SIGNIFICANCE (not amount of code): ${[...SIZE_BANDS]
  .reverse()
  .map((band) => `'${band.key}' (${band.gloss})`)
  .join(", ")}. ${BOTTOM_UP_SENTENCE}`;

export const CATEGORIES = [
  { key: "new", gloss: "a new capability" },
  { key: "improvement", gloss: "better existing behavior" },
  { key: "fix", gloss: "a bug fix" },
  { key: "announcement", gloss: "a user-facing notice rather than a feature/fix: a deprecation, a sunset/removal, a pricing/policy change, or an availability heads-up" },
] as const;

/**
 * Canonicalised on `resolve-atomic-updates`' wording, which both groups and
 * names where `enrich-change-item` only classifies. `enrich-change-item` keeps
 * its own extra caveat ("pick this only when the change is fundamentally an
 * announcement, not a code capability") — that is a real instruction to a
 * weaker model, not noise to tidy away. Share the mechanism, not the policy.
 */
export const CATEGORY_RUBRIC = CATEGORIES.map((c) => `'${c.key}' (${c.gloss})`).join(", ");

/** Canonicalised on `resolve-atomic-updates`' wording, for the same reason. */
export const TITLE_SUMMARY_STYLE =
  "Write title as a short noun phrase and summary as one plain sentence describing the user-visible benefit.";

/** Verbatim from `compose-prompt.ts`, which was the only place it existed. */
export const GROUNDING_RULE =
  "Ground every statement strictly in the source material you are given. Only describe changes that appear in that material; never invent or embellish features, capabilities, benefits, use cases, metrics, numbers, dates, version names, quotes, or any other specifics. If a detail is not in the source, leave it out rather than guessing — an omission is always better than a fabrication.";

/** Verbatim from `compose-prompt.ts`, which was the only place it existed. */
export const NO_INVENTED_LINKS_RULE =
  "Never fabricate links. Only include a URL if it appears verbatim in the source material; do not construct, complete, shorten, or recall a URL from memory, and do not guess a plausible one. If a link would be helpful but no verified URL is present in the source, write the literal placeholder [add link] in its place so an editor can fill it in — never emit a made-up or guessed URL.";

/**
 * Truncates text destined for a prompt. Replaces four inline copies of this
 * expression in `compose-prompt.ts`.
 */
export function truncateForPrompt(text: string, maxChars = DEFAULT_MAX_PROMPT_CHARS): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(truncated)` : text;
}

/**
 * The team's guidelines document, trimmed, capped, and wrapped in the
 * delimiters that keep their prose from reading as instructions to the model.
 * Returns null when nothing is configured, so callers omit the block entirely
 * rather than injecting an empty one.
 *
 * Shares the FENCE, not the framing. `buildSystemPrompt` varies its framing
 * sentence by content type and `brandRubric` has a "no requirements configured"
 * fallback — both stay at their call sites.
 */
export function fenceGuidelines(guidelines: string | null): string | null {
  const trimmed = guidelines?.trim();
  if (!trimmed) return null;
  return `<brand-guidelines>\n${truncateForPrompt(trimmed, MAX_GUIDELINES_CHARS)}\n</brand-guidelines>`;
}
