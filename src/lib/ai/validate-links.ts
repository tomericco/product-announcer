/**
 * Post-generation link validation for AI-drafted update bodies.
 *
 * The generation prompt already forbids inventing URLs (see `compose-prompt.ts`),
 * but the model can still slip one through. As a backstop we verify that every
 * http(s) link the draft emitted actually resolves; any link that can't be
 * verified is downgraded to the same `[add link]` placeholder the prompt uses,
 * so a dead URL never ships in a published update — an editor fills it in.
 *
 * The checker is injectable so callers (and tests) can substitute the network
 * probe; the default probes with a HEAD request (GET fallback) and a short
 * timeout.
 */

const LINK_CHECK_TIMEOUT_MS = 5000;
const MAX_CONCURRENT_CHECKS = 6;

/**
 * The marker left in place of a link that couldn't be verified (see
 * `validateDraftLinks`). Publishing guards on it via `hasLinkPlaceholder` so a
 * draft with an unresolved link never ships — an editor fills it in first.
 */
export const LINK_PLACEHOLDER = "[add link]";

// The placeholder as it can actually appear in a stored body. The Markdown
// editor round-trips a bare `[add link]` (a shortcut link with no definition)
// by backslash-escaping the brackets — `\[add link]`, `[add link\]`, or
// `\[add link\]` — so match those too. The escaping backslashes are part of the
// match, so a fix that replaces this span cleanly removes them. A real link
// whose text is "add link" (`[add link](url)`) is excluded via the lookahead.
const PLACEHOLDER_PATTERN = String.raw`\\?\[add link\\?\](?!\()`;

/** True when a body still carries an unresolved `[add link]` placeholder. */
export function hasLinkPlaceholder(body: string): boolean {
  return new RegExp(PLACEHOLDER_PATTERN).test(body);
}

/** Resolves true if the URL is believed to exist, false if it should be replaced. */
export type LinkCheck = (url: string) => Promise<boolean>;

// Markdown inline link: `[text](url)`, tolerating an optional `!` image prefix,
// angle-bracketed URLs (`[t](<url>)`), and a trailing `"title"`. Deliberately
// not a full Markdown parser: reference-style links and URLs containing a `)`
// are out of scope, which is fine for the model's output here.
const INLINE_LINK = /(!?)\[([^\]]*)\]\(\s*<?([^>)\s]+)>?(?:\s+"[^"]*")?\s*\)/g;

const isHttp = (url: string): boolean => /^https?:\/\//i.test(url);

/** Unique http(s) URLs from non-image inline links, in first-seen order. */
export function extractHttpLinks(body: string): string[] {
  const urls = new Set<string>();
  for (const match of body.matchAll(INLINE_LINK)) {
    const isImage = match[1] === "!";
    const url = match[3];
    if (!isImage && isHttp(url)) urls.add(url);
  }
  return [...urls];
}

/**
 * Default probe. A URL counts as verified when the host answers — even with an
 * auth/bot gate (401/403/405/429), which real links routinely return to a bare
 * probe. A 404/410/other 4xx/5xx, or a transport failure (DNS, refused,
 * timeout — where a fabricated URL lands), counts as unverified.
 */
async function probe(url: string): Promise<boolean> {
  const request = (method: "HEAD" | "GET") =>
    fetch(url, { method, redirect: "follow", signal: AbortSignal.timeout(LINK_CHECK_TIMEOUT_MS) });
  try {
    let res = await request("HEAD");
    // Some servers don't implement HEAD — retry the same URL with GET.
    if (res.status === 405 || res.status === 501) res = await request("GET");
    if (res.status < 400) return true;
    return res.status === 401 || res.status === 403 || res.status === 429;
  } catch {
    return false;
  }
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Verifies every http(s) link in `body` and rewrites each unverified one to a
 * `[add link]` placeholder, keeping the visible anchor text. Returns the
 * (possibly unchanged) body and the list of URLs that were replaced.
 */
export async function validateDraftLinks(
  body: string,
  check: LinkCheck = probe
): Promise<{ body: string; replaced: string[] }> {
  const urls = extractHttpLinks(body);
  if (urls.length === 0) return { body, replaced: [] };

  const verdicts = await mapLimit(urls, MAX_CONCURRENT_CHECKS, check);
  const dead = new Set(urls.filter((_, i) => !verdicts[i]));
  if (dead.size === 0) return { body, replaced: [] };

  const replaced: string[] = [];
  const rewritten = body.replace(INLINE_LINK, (match, bang: string, text: string, url: string) => {
    if (bang === "!" || !isHttp(url) || !dead.has(url)) return match;
    replaced.push(url);
    const label = text.trim();
    return label ? `${label} ${LINK_PLACEHOLDER}` : LINK_PLACEHOLDER;
  });
  return { body: rewritten, replaced };
}

// ---------------------------------------------------------------------------
// Publish-time link validation
//
// Broader than `validateDraftLinks` (which only auto-fixes dead AI links at
// generation): this classifies EVERY link in a body as valid or not, so the
// publish flow can block on anything that isn't a working link — including
// malformed targets a human typed and leftover placeholders — and list the
// specific offenders for an error modal.
// ---------------------------------------------------------------------------

export type InvalidLinkReason = "placeholder" | "malformed" | "unreachable";

/** A single thing wrong with a link in the body, for the publish-time modal. */
export type LinkProblem = { url: string; reason: InvalidLinkReason };

// Looser than INLINE_LINK: matches an EMPTY target `[text]()` too, so a link
// with no URL is caught rather than skipped. Captures 1=image bang, 3=raw target.
const CLASSIFY_LINK = /(!?)\[([^\]]*)\]\(([^)]*)\)/g;

const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** Extracts the URL from a raw Markdown target, dropping `<>` wrappers and a `"title"`. */
function linkTarget(raw: string): string {
  const t = raw.trim();
  if (t.startsWith("<")) {
    const end = t.indexOf(">");
    return (end >= 0 ? t.slice(1, end) : t.slice(1)).trim();
  }
  const space = t.search(/\s/);
  return (space >= 0 ? t.slice(0, space) : t).trim();
}

/** A link target is valid only if it's a well-formed absolute URL with a safe scheme. */
export function isValidLinkTarget(target: string): boolean {
  if (!target) return false;
  try {
    return SAFE_SCHEMES.has(new URL(target).protocol);
  } catch {
    return false;
  }
}

/** Non-image links whose target is a well-formed http(s) URL — the probe candidates. */
function probeableTargets(body: string): string[] {
  const urls = new Set<string>();
  for (const match of body.matchAll(CLASSIFY_LINK)) {
    if (match[1] === "!") continue;
    const target = linkTarget(match[3]);
    if (isHttp(target) && isValidLinkTarget(target)) urls.add(target);
  }
  return [...urls];
}

/**
 * Synchronous problems only: leftover `[add link]` placeholders and malformed
 * link targets (empty, relative, or non-http(s)/mailto). No network — this is
 * also the cheap server-side backstop when a full probe would be too slow.
 */
export function findMalformedLinks(body: string): LinkProblem[] {
  const problems: LinkProblem[] = [];
  if (hasLinkPlaceholder(body)) problems.push({ url: LINK_PLACEHOLDER, reason: "placeholder" });

  const seen = new Set<string>();
  for (const match of body.matchAll(CLASSIFY_LINK)) {
    if (match[1] === "!") continue;
    const target = linkTarget(match[3]);
    if (isValidLinkTarget(target)) continue;
    const key = target || "(empty)";
    if (!seen.has(key)) {
      seen.add(key);
      problems.push({ url: key, reason: "malformed" });
    }
  }
  return problems;
}

/**
 * Full publish-time check: every placeholder, malformed target, AND well-formed
 * http(s) link that doesn't resolve, as one problem each. An empty result means
 * the body is safe to publish. `check` is injectable for tests.
 */
export async function findInvalidLinks(body: string, check: LinkCheck = probe): Promise<LinkProblem[]> {
  const problems = findMalformedLinks(body);

  const urls = probeableTargets(body);
  if (urls.length > 0) {
    const verdicts = await mapLimit(urls, MAX_CONCURRENT_CHECKS, check);
    urls.forEach((url, i) => {
      if (!verdicts[i]) problems.push({ url, reason: "unreachable" });
    });
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Inline fixing (publish-time modal)
//
// The modal needs to locate each invalid link so a user can supply a URL and
// have it spliced back into the exact body that was checked. These are pure
// string helpers (no network) so the client can run them against the same body
// it holds; reachability comes in as the pre-computed `unreachable` set.
// ---------------------------------------------------------------------------

/**
 * One invalid link occurrence, located in the body for inline editing.
 * `text` is the link's display text (empty for a bare `[add link]` placeholder);
 * `url` is the current target (empty for a placeholder or empty `()` target);
 * `[start, end)` is the exact slice to replace.
 */
export type EditableLink = {
  reason: InvalidLinkReason;
  text: string;
  url: string;
  start: number;
  end: number;
};

/**
 * Locates every invalid link in `body` (per occurrence, not deduped) so each can
 * be fixed inline: malformed/empty targets, unreachable ones (per `unreachable`),
 * and leftover `[add link]` placeholders. Sorted by position.
 */
export function collectInvalidLinks(body: string, unreachable: Iterable<string> = []): EditableLink[] {
  const dead = new Set(unreachable);
  const links: EditableLink[] = [];

  for (const match of body.matchAll(CLASSIFY_LINK)) {
    if (match[1] === "!") continue; // image
    const target = linkTarget(match[3]);
    let reason: InvalidLinkReason | null = null;
    if (!isValidLinkTarget(target)) reason = "malformed";
    else if (isHttp(target) && dead.has(target)) reason = "unreachable";
    if (!reason) continue;
    const start = match.index ?? 0;
    links.push({ reason, text: match[2], url: target, start, end: start + match[0].length });
  }

  for (const match of body.matchAll(new RegExp(PLACEHOLDER_PATTERN, "g"))) {
    const start = match.index ?? 0;
    // match[0] includes any escaping backslashes, so replacing this span removes
    // them — no stray `\` left to escape the fixed link into literal text.
    links.push({ reason: "placeholder", text: "", url: "", start, end: start + match[0].length });
  }

  return links.sort((a, b) => a.start - b.start);
}

/**
 * Splices `[text](url)` replacements into `body` at the given ranges. Applied
 * right-to-left so earlier offsets stay valid. When a fix has no display text
 * (a placeholder), the URL doubles as the link text.
 */
export function applyLinkFixes(
  body: string,
  fixes: { start: number; end: number; text: string; url: string }[]
): string {
  let out = body;
  for (const fix of [...fixes].sort((a, b) => b.start - a.start)) {
    const label = fix.text.trim() || fix.url;
    out = out.slice(0, fix.start) + `[${label}](${fix.url})` + out.slice(fix.end);
  }
  return out;
}
