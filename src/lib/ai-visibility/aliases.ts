/**
 * Whether an answer named a brand.
 *
 * This is the arbiter for the metric that matters most — the judge only adds
 * levels and quotes on top — so it is deliberately conservative. Two whole
 * classes of false positive are removed before matching starts, because both
 * would report a tenant as named in answers that never mentioned them:
 *
 * 1. **URLs.** "Sources: https://acme.com/pricing" is a citation, not a
 *    mention, and citation rate already counts it.
 * 2. **The echoed prompt.** Every engine restates the question, and half the
 *    prompt set names a competitor by design.
 */

/**
 * Corporate suffixes, longest first so "Pty Ltd" is not eaten by "Pty".
 * Regex-source strings, so a dotted form escapes its own dots.
 */
const LEGAL_SUFFIXES = [
  "pty ltd",
  "incorporated",
  "corporation",
  "limited",
  "l\\.l\\.c",
  "gmbh",
  "s\\.a",
  "b\\.v",
  "oyj",
  "inc",
  "llc",
  "ltd",
  "corp",
  "plc",
  "llp",
  "pty",
  "bv",
  "nv",
  "ab",
  "oy",
  "as",
  "sa",
  "co",
];

/** TLDs a company actually brands itself with. `.systems` and friends stay part of the name. */
const BRAND_TLDS = new Set([
  "io",
  "com",
  "ai",
  "co",
  "app",
  "dev",
  "so",
  "sh",
  "xyz",
  "net",
  "org",
  "me",
  "tech",
  "cloud",
  "gg",
  "to",
  "hq",
]);

/**
 * Anything that is a link rather than prose. `\S+` is greedy to the next
 * space on purpose: a trailing bracket or comma swallowed with the URL costs
 * nothing, whereas leaving half a hostname behind is a false positive.
 */
const URL_PATTERNS: RegExp[] = [
  /\bhttps?:\/\/\S+/gi,
  /\bwww\.\S+/gi,
  /\]\([^)]*\)/g, // markdown link targets
  /<[^>\s]+>/g, // autolinks and stray tags
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The spellings of one brand an engine might use.
 *
 * The original always comes first, so a caller that wants the canonical name
 * can take `aliases[0]`. Entries under two characters are dropped: a
 * one-letter alias matches somewhere in every answer ever written.
 */
export function buildAliases(name: string): string[] {
  const base = name.replace(/\s+/g, " ").trim();
  if (base.length === 0) return [];

  const out: string[] = [];
  const push = (value: string) => {
    const cleaned = value
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[,'’]+$/, "");
    if (cleaned.length < 2) return;
    if (out.some((existing) => existing.toLowerCase() === cleaned.toLowerCase())) return;
    out.push(cleaned);
  };

  push(base);

  // "Acme, Inc." / "Acme GmbH" / "Acme Pty Ltd" -> "Acme". The separator is
  // required, so "Company" does not lose its "co".
  const legal = new RegExp(`[,\\s]+(?:${LEGAL_SUFFIXES.join("|")})\\.?$`, "i");
  const withoutLegal = base.replace(legal, "").trim();

  // "Acme.io" -> "Acme", including after the legal suffix came off.
  for (const candidate of [base, withoutLegal]) {
    const match = /^(.+?)\.([a-z]{2,10})$/i.exec(candidate);
    if (match && BRAND_TLDS.has(match[2].toLowerCase())) {
      if (candidate !== base) push(candidate);
      push(match[1]);
    }
  }
  if (withoutLegal !== base) push(withoutLegal);

  return out;
}

export function stripUrls(text: string): string {
  let out = text;
  for (const pattern of URL_PATTERNS) out = out.replace(pattern, " ");
  return out;
}

/**
 * Removes the question from the answer.
 *
 * Whitespace-tolerant, because an engine that rewraps the prompt across lines
 * or into a bullet is still echoing it — matching the literal string would
 * miss exactly the cases this exists for.
 */
export function stripPromptEcho(text: string, promptText: string): string {
  const needle = promptText.replace(/\s+/g, " ").trim();
  if (needle.length === 0) return text;
  const pattern = needle.split(" ").map(escapeRegExp).join("\\s+");
  return text.replace(new RegExp(pattern, "gi"), " ");
}

/**
 * Whether `text` names the brand, with the prompt echo and every URL removed
 * first.
 *
 * Boundaries are `\p{L}\p{N}` lookaround rather than `\b`, so a brand whose
 * name contains a dot or a hyphen still anchors correctly — `\b` sits at the
 * wrong side of a dot. A trailing possessive is allowed through.
 */
export function mentionsBrand(text: string, aliases: string[], promptText = ""): boolean {
  if (aliases.length === 0) return false;
  const haystack = stripUrls(stripPromptEcho(text, promptText));

  for (const alias of aliases) {
    const cleaned = alias.trim();
    if (cleaned.length < 2) continue;
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegExp(cleaned)}(?:['’]s)?(?![\\p{L}\\p{N}])`,
      "iu"
    );
    if (pattern.test(haystack)) return true;
  }
  return false;
}
