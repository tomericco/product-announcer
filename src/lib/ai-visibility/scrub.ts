/**
 * Redaction of provider credentials from any string we are about to keep.
 *
 * Imports nothing, on purpose: this is called from engine clients, from
 * `run.ts` on the way into the database, from the judge, and from two Server
 * Components on the way into the DOM. Anything it imported would become a
 * dependency of all four.
 *
 * ### Why a scrubber exists at all
 *
 * Provider error bodies quote the credential back at you. An OpenAI 401 says:
 *
 *   Incorrect API key provided: sk-Eyftb****************************99vW.
 *
 * — the key's prefix AND its last four characters, which is most of what an
 * attacker needs to confirm a stolen key belongs to this account. The
 * organization variant echoes the tenant identifier ("No such organization:
 * org-XXXXXXXX"). LiteLLM shipped exactly this shape and it became
 * CVE-2025-0330 (CVSS 7.5); CWE-209 names the class.
 *
 * The primary defence is upstream of this file: `engines/failure.ts` maps a
 * provider failure to a closed set of codes and OUR OWN sentence, so no
 * provider body text is ever put in `EngineError.message` in the first place.
 * This module is the second line, and it is not redundant:
 *
 *  - rows written BEFORE that change still hold raw bodies, and the overview
 *    and /company both render them;
 *  - `String(error)` on a thrown SDK error (the judge, `runSlice`'s per-row
 *    catch) is provider text we never chose the shape of;
 *  - a future client, or a future logger, will get this wrong once.
 *
 * Scrub before LOGGING as much as before rendering. The UI is the symptom; the
 * log is the durable copy, and it outlives the row.
 */

/** What replaces a matched secret. Deliberately unmistakable in a log. */
export const REDACTED = "[redacted]";

/**
 * The credential shapes the three engines can echo back at us.
 *
 * Note the `*` in every character class. OpenAI does not echo the key whole —
 * it masks the middle with asterisks and leaves the last four characters
 * exposed. A pattern that stopped at the first asterisk would redact
 * `sk-Eyftb`, leave `99vW` sitting in the string, and look like it worked.
 *
 * Ordered longest-prefix-first only for readability; each alternative is
 * anchored on its own literal prefix, so `sk-ant-…` cannot be half-eaten by the
 * `sk-` rule — `[A-Za-z0-9_*-]` covers the `ant-` too, and the whole token goes.
 *
 * `Bearer …` is here because an Authorization header can reach a log through a
 * request dump or a thrown `fetch` error, and its value is the key verbatim
 * with no recognisable prefix once a provider changes its key format.
 */
const SECRET_PATTERNS: RegExp[] = [
  // OpenAI (`sk-`, `sk-proj-`) and Anthropic (`sk-ant-`, `sk-ant-admin-`).
  /\bsk-[A-Za-z0-9_*-]{2,}/g,
  // Google AI Studio / Gemini.
  /\bAIza[A-Za-z0-9_*-]{2,}/g,
  // OpenAI organization and project identifiers — the tenant, not the secret,
  // but still a customer identifier we have no business storing or showing.
  /\borg-[A-Za-z0-9_*-]{3,}/g,
  /\bproj_[A-Za-z0-9_*-]{3,}/g,
  // Whatever an Authorization header carried.
  /\bBearer\s+[A-Za-z0-9._*-]{6,}/gi,
];

/**
 * The same string with every recognised credential replaced by `[redacted]`.
 *
 * Total: it never throws, and a non-string is coerced rather than rejected,
 * because every caller is on an error path where throwing would replace a
 * recoverable failure with an unrecoverable one.
 */
export function scrubSecrets(value: string): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS) {
    // A fresh `lastIndex` per call: these are module-level /g regexes and
    // `String#replace` resets it, but `test`/`exec` would not — keep the reset
    // explicit so a later reader adding a `test()` cannot introduce the
    // every-other-call bug.
    pattern.lastIndex = 0;
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * `scrubSecrets` for a value that may be null/undefined, preserving the gap.
 *
 * `sources.lastError` and `ai_visibility_samples.error` are both nullable and
 * "no error" must stay distinguishable from "an error we redacted to nothing".
 */
export function scrubSecretsOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" ? scrubSecrets(value) : null;
}
