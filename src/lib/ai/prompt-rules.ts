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

/** Chars of a body/excerpt a prompt will carry before truncation. */
export const DEFAULT_MAX_PROMPT_CHARS = 24000;

/** Chars of the brand guidelines document a prompt will carry. */
const MAX_GUIDELINES_CHARS = 6000;

/**
 * Size bands, most significant FIRST. This order is load-bearing twice: it is
 * the order the composer lists changes in, and it is what `SIZE_RUBRIC`
 * describes to the model. One array, so the two can never disagree.
 *
 * A shared string constant would have satisfied the two prompts and left the
 * composer's sort free to hardcode its own ordering — precisely the divergence
 * this module exists to prevent, just moved somewhere harder to see.
 */
export const SIZE_BANDS = [
  { key: "xl", gloss: "a flagship or headline change — a major new capability or overhaul you would lead an announcement with" },
  { key: "l", gloss: "a significant feature or major improvement worth calling out to many users" },
  { key: "m", gloss: "a standard improvement or small feature noticeable to users of that area" },
  { key: "s", gloss: "a minor fix, tweak, or polish — small individual user impact" },
] as const;

export type SizeKey = (typeof SIZE_BANDS)[number]["key"];

/** Descending significance. The composer sorts its item list on this. */
export const SIZE_RANK: Record<SizeKey, number> = Object.fromEntries(
  SIZE_BANDS.map((band, index) => [band.key, SIZE_BANDS.length - index])
) as Record<SizeKey, number>;

/**
 * Rendered ASCENDING, which is the order the two prompts already used. The
 * array is descending because that is what `SIZE_RANK` needs; reversing here
 * rather than there keeps the emitted string byte-identical to what it
 * replaces. A snapshot test enforces that — this extraction is the one in this
 * change set that must not alter behaviour at all.
 */
export const SIZE_RUBRIC = `Also pick a size by USER-FACING SIGNIFICANCE (not amount of code): ${[...SIZE_BANDS]
  .reverse()
  .map((band) => `'${band.key}' (${band.gloss})`)
  .join(", ")}.`;

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
