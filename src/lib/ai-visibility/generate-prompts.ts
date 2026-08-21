/** Past this, an engine answers an essay prompt rather than a buyer question. */
export const MAX_PROMPT_WORDS = 25;

/**
 * The tell for keyword-ese: a search phrase is a bag of nouns, a question has
 * connective tissue. "best issue trackers for startups" has "for"; "issue
 * tracking software pricing" has nothing. Deliberately small — it only has to
 * separate a phrase somebody would type into Google from one they would type
 * into a chatbot.
 */
const FUNCTION_WORDS = new Set([
  "a", "an", "the", "for", "of", "in", "to", "with", "without", "vs", "versus", "or", "and",
  "is", "are", "do", "does", "should", "can", "could", "would", "which", "what", "how", "why",
  "when", "who", "where", "best", "top", "compare", "between", "under", "over", "near", "on",
  "at", "from", "than", "my", "our", "your", "that", "this", "it", "i", "we", "instead",
  "alternative", "alternatives", "like",
]);

export type PromptQualityContext = {
  tenantName: string;
  /**
   * Extra spellings of the tenant's name. Optional because generation only has
   * the workspace name to hand; the run-time re-check can pass the full alias
   * table from `buildAliases`.
   */
  aliases?: string[];
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary containment, so "acmegraph" is not a mention of "Acme".
 *
 * A local matcher rather than `mentionsBrand` from `aliases.ts`: that function
 * additionally strips URLs and the echoed prompt out of an ANSWER, and here
 * the prompt IS the input. Stripping it would leave nothing to check.
 */
function containsWord(text: string, needle: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

/**
 * The spec's bad-prompt checks that can be answered from the wording alone.
 *
 * Returns a sentence for `ai_visibility_prompts.flagReason`, or null. Advisory
 * only: flagged prompts get a badge and a "Pause" suggestion, and nothing is
 * ever paused automatically — a prompt the tenant insists on is theirs to keep.
 *
 * The history-dependent checks — refusal or zero brands on every engine for
 * three runs, an identical brand list to another prompt for three runs — need
 * samples and live with the run pipeline, not here.
 */
export function checkPromptQuality(
  prompt: { text: string; branded: boolean },
  context: PromptQualityContext
): string | null {
  const text = prompt.text.trim();
  const words = text.split(/\s+/).filter(Boolean);

  if (words.length > MAX_PROMPT_WORDS) {
    return `Too long — ${words.length} words. Engines answer short buyer questions best; trim it to one ask.`;
  }

  if ((text.match(/\?/g) ?? []).length > 1) {
    return "Asks two questions. Split it, or a 0 of 3 will not tell you which half failed.";
  }

  const names = [context.tenantName, ...(context.aliases ?? [])]
    .map((name) => name.trim())
    .filter((name) => name.length >= 2);
  const namesUs = names.find((name) => containsWord(text, name)) ?? null;

  if (!prompt.branded && namesUs !== null) {
    return `Names ${namesUs}, so it measures whether engines echo the prompt back, not whether they choose you. Mark it as a brand check, or take the name out.`;
  }

  // A prompt that names us is exempt from the keyword check. "Acme pricing" is
  // two nouns with no connective tissue, and is still exactly the brand-check
  // question the spec asks for — a proper noun is the specificity a search
  // phrase lacks. A branded prompt that does NOT name us gets checked as
  // normal, because then the flag is telling the truth.
  if (!text.includes("?") && namesUs === null) {
    const tokens = words.map((word) => word.toLowerCase().replace(/[^\p{L}\p{N}'-]/gu, ""));
    if (words.length < 3 || !tokens.some((token) => FUNCTION_WORDS.has(token))) {
      return "Reads like a search keyword, not something a buyer would type into a chatbot.";
    }
  }

  return null;
}
