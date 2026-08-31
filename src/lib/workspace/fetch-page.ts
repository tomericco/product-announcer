import TurndownService from "turndown";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type PageError = "invalid-url" | "blocked" | "fetch-failed" | "insufficient-content";
export type PageResult =
  | {
      text: string;
      html: string;
      // Where the fetch actually landed after following redirects. For
      // recording and relative-link resolution only -- the same-origin check
      // in crawlCompanySite must keep anchoring on the requested URL, not
      // this, so a homepage redirecting to a hostile host can't steer the
      // crawl onto that host's links.
      finalUrl: string;
      contentType: string;
      // Whether the extracted text exceeded MAX_TEXT_CHARS and was cut off by
      // the slice below. Must be captured here, not inferred by a caller from
      // `text.length === MAX_TEXT_CHARS` -- a page whose genuine extracted
      // text lands at exactly that length on its own is indistinguishable
      // from a truncated one by length alone, and would have its real final
      // block silently dropped every run. This flag is the only reliable
      // signal, so don't "simplify" it back to a length comparison.
      truncated: boolean;
    }
  | { error: PageError };

export type ResolveHost = (hostname: string) => Promise<string[]>;

const TIMEOUT_MS = 8000;
const MAX_BYTES = 2_000_000;
// Exported so callers that diff text across runs (the competitor agent) can
// detect when a page was cut off at this boundary rather than genuinely
// ending -- a slice can land mid-block, and the block it cuts in half must be
// handled differently from one the competitor actually published in full.
export const MAX_TEXT_CHARS = 12_000;
const MIN_TEXT_CHARS = 200;
const MAX_REDIRECTS = 3;
// Both htmlToText's tag-stripping regex and extractSameOriginLinks's href regex
// degrade to quadratic-ish backtracking on hostile HTML that has many "<a" (or
// "<") runs with no following ">" (measured: 841ms for 32KB of such input) --
// and MAX_BYTES above allows up to 2MB through. Clamping to this many
// characters before either regex ever sees the HTML bounds the worst case
// regardless of how large an attacker's page grows. 200KB of markup still
// yields far more than MAX_TEXT_CHARS of extracted text, so this doesn't
// affect real pages. Don't remove this thinking it's redundant with MAX_BYTES
// -- MAX_BYTES bounds the read, this bounds the regex scan, and the scan is
// the expensive part.
const MAX_SCAN_CHARS = 200_000;

const defaultResolveHost: ResolveHost = async (hostname) => {
  const results = await lookup(hostname, { all: true });
  return results.map((r) => r.address);
};

function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    return false;
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return true; // unrecognized → treat as blocked
}

// Blocks IP literals, encoded IPs (new URL normalizes octal/decimal/hex to
// dotted-decimal before this check), redirect-to-private (re-validated per hop),
// and hostnames that resolve to any private/loopback/link-local/CGNAT/ULA IP.
//
// KNOWN RESIDUAL (accepted for now, revisit): this is a check-then-fetch, and
// Node's fetch resolves DNS again independently — so an attacker controlling
// their domain's DNS could pass this check with a public IP and have fetch
// connect to a private one (DNS rebinding / TOCTOU). Fully closing it needs IP
// pinning (connect to the exact validated IP via a custom undici dispatcher,
// preserving Host + TLS servername). Tracked as a follow-up hardening task.
async function hostIsPublic(hostname: string, resolveHost: ResolveHost): Promise<boolean> {
  if (isIP(hostname)) return !isPrivateIp(hostname);
  let ips: string[];
  try {
    ips = await resolveHost(hostname);
  } catch {
    return false;
  }
  return ips.length > 0 && ips.every((ip) => !isPrivateIp(ip));
}

/**
 * Reads a response body as a stream, stopping as soon as more than `maxBytes`
 * have been read. This is a hard cap independent of any `content-length`
 * header, so a server that lies about (or omits) content-length can't force
 * unbounded buffering. Runs under the caller's abort signal/timeout.
 */
async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  const body = res.body;
  if (!body) return "";

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total <= maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        total += value.byteLength;
        chunks.push(value);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  const size = Math.min(total, maxBytes);
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= size) break;
    const take = Math.min(chunk.byteLength, size - offset);
    combined.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return new TextDecoder().decode(combined);
}

/**
 * The extractor version, stamped into anything that persists a fingerprint of
 * extracted text. Bump it whenever a change here would alter the output for an
 * unchanged page.
 *
 * `competitor-agent` is why this exists. It stores hashes of text blocks and
 * treats any hash it has not seen as a new change worth a signal — so a silent
 * change to this function makes every block of every watched page look new at
 * once, and floods the inbox. The version lets that consumer notice the format
 * moved and re-baseline instead.
 */
export const EXTRACTOR_VERSION = 4;

// Elements that never carry page content. Removed outright rather than
// converted, so their text does not survive as stray lines.
//
// `iframe` is NOT here. An embedded player or walkthrough is a real part of how
// some companies write an update, and dropping it silently made that invisible
// to anything reading the page — see MEDIA_MARKERS.
const DROPPED_ELEMENTS = [
  "script",
  "style",
  "noscript",
  "svg",
  "form",
  "template",
  // Site chrome. These are semantic landmarks, so removing them is a structural
  // rule and not a class-name guess — turndown's `remove` runs against the
  // parsed DOM, which is what makes it reliable.
  //
  // Worth the entry: on a real changelog the whole product menu, resources list
  // and footer arrived ahead of the first update, and on a page long enough to
  // truncate that chrome is spent from the same character budget as the
  // content. A page that does not use landmarks is unaffected, which is why
  // this is additive rather than a switch to main-only extraction.
  "nav",
  "header",
  "footer",
  "aside",
];

/**
 * What an image or embed becomes in extracted text.
 *
 * Not the original markup: a URL is noise, and on a real changelog images were
 * 13% of the output. But not nothing either, which is what they used to become.
 * Deleting them meant the page could show a screenshot after every intro and a
 * walkthrough video in every release, and a template derived from it would say
 * nothing about either — the one part of an update the model can see is missing
 * is the part it was never shown.
 *
 * A marker is the middle: one token of signal, no URL. It deliberately uses the
 * `[add link]` shape, because it means the same thing downstream — a slot only a
 * person can fill. Nothing in the pipeline can render a screenshot or a
 * walkthrough of a customer's own product.
 */
export const MEDIA_MARKER = "[media]";

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  // `---` rather than turndown's default `* * *`: it is what a person writing
  // markdown types, so a divider that reaches a template or a draft reads as a
  // divider rather than as three stray asterisks.
  hr: "---",
});
turndown.remove(DROPPED_ELEMENTS as TurndownService.Filter);

// Embeds first: an <iframe> carries no text, so without a rule turndown emits
// nothing for it and the embed vanishes as surely as if it were removed.
// One marker for both, because the distinction does not survive into anything
// useful: a company that leads with a demo clip one week and a screenshot the
// next is doing the same thing structurally, and a template that insisted on
// which would be wrong half the time.
turndown.addRule("embed", {
  filter: ["iframe", "video", "embed", "object", "audio"],
  replacement: () => `\n\n${MEDIA_MARKER}\n\n`,
});
turndown.addRule("media", {
  filter: "img",
  replacement: () => MEDIA_MARKER,
});

/**
 * HTML to Markdown.
 *
 * This used to be a regex tag-stripper, and what it threw away was heading
 * LEVEL: `</h2>` became a newline, so `<h2>Fixes</h2>` and a styled
 * `<div class="badge">Improvement</div>` both arrived as bare lines,
 * indistinguishable to anything reading the result. Every consumer that wanted
 * to know what was a section and what was a label had to guess, and the
 * template derivation guessed wrong — describing a CMS category chip as though
 * it were part of the update.
 *
 * Markdown keeps that distinction at no cost: measured on a real 20-entry
 * changelog, the output is the same size as the old plain text (25.3k vs 25.4k
 * chars) and carries 20 heading markers where the old one carried none.
 *
 * Images and link targets are dropped — the URL of a link is noise to every
 * consumer here, and images were 13% of the output. Link TEXT is kept, since
 * that is content.
 *
 * `extractBlocks` in `@/lib/signals/agent-page` was already markdown-aware
 * (it splits on `/^#{1,6}\s/`), because it also reads `.md` and `llms.txt`
 * pages. This makes the HTML path behave like the one it already supported
 * rather than being a second, structureless shape.
 */
export function htmlToText(html: string): string {
  let markdown: string;
  try {
    markdown = turndown.turndown(html);
  } catch {
    // Turndown parses; a pathological document can throw. Returning empty is
    // right — every caller already treats empty extraction as a failed read,
    // and the alternative is propagating a parse error out of a network fetch.
    return "";
  }

  return cleanMarkdown(markdown);
}

/**
 * The normalisation every extracted page gets, whether we converted it from
 * HTML or the server handed us markdown directly.
 *
 * Both paths are real: this fetcher sends `accept: text/markdown, text/plain,
 * text/html`, and a growing number of sites content-negotiate an agent-facing
 * markdown version. That response used to bypass every cleanup below simply
 * because it never went through the HTML converter — so an agent-facing page
 * arrived carrying YAML frontmatter, image markup and link URLs that the same
 * page in HTML would have had stripped. Same input, same output, regardless of
 * which representation the server chose.
 */
export function cleanMarkdown(markdown: string): string {
  return markdown
    // Leading YAML frontmatter is metadata, not content — title/description/og
    // tags that say nothing about the page's structure. Anchored to the very
    // start and requiring a `key:` line so a document opening with a `---`
    // horizontal rule is left alone.
    .replace(/^---\r?\n(?:[^\n]*:[^\n]*\r?\n|[^\n]*\r?\n)*?---\r?\n/, "")
    // Turndown decodes &nbsp; to a real U+00A0, and markdown served directly
    // can carry them too. Left alone it is an invisible difference that breaks
    // string comparisons and, worse, changes a block's hash depending on how
    // the page happened to encode a space.
    .replace(/\u00a0/g, " ")
    // Zero-width joiners/spaces. Webflow and similar builders emit them as
    // spacer content, and they survive extraction as lines that look blank but
    // are not — so they reach a prompt as structure and come back out in a
    // template as mystery blank-ish rows.
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    // Markdown served directly still arrives with real image syntax; the HTML
    // path has already been through the rule above.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, MEDIA_MARKER)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function fetchPageText(
  url: string,
  deps: { fetchImpl?: typeof fetch; resolveHost?: ResolveHost } = {}
): Promise<PageResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const resolveHost = deps.resolveHost ?? defaultResolveHost;

  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return { error: "invalid-url" };
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") return { error: "invalid-url" };
    if (!(await hostIsPublic(current.hostname, resolveHost))) return { error: "blocked" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      let res: Response;
      try {
        res = await fetchImpl(current.toString(), {
          redirect: "manual",
          signal: controller.signal,
          // Markdown/plain-text first: `.md` and llms.txt probes are asking
          // specifically for those, and a bare "text/html" accept header on
          // those requests invites a content-negotiating server to hand back
          // the HTML variant instead of 406ing -- which is how a soft-404
          // HTML page gets mistaken for a real agent-facing one downstream.
          headers: { accept: "text/markdown, text/plain, text/html" },
        });
      } catch {
        return { error: "fetch-failed" };
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) return { error: "fetch-failed" };
        try {
          current = new URL(location, current);
        } catch {
          return { error: "invalid-url" };
        }
        continue;
      }

      if (!res.ok) return { error: "fetch-failed" };

      const contentType = res.headers.get("content-type") ?? "";
      if (
        !contentType.includes("text/html") &&
        !contentType.includes("text/plain") &&
        !contentType.includes("text/markdown")
      )
        return { error: "fetch-failed" };
      if (Number(res.headers.get("content-length") ?? "0") > MAX_BYTES) return { error: "fetch-failed" };

      // Hard cap the body read itself (not just this fast-path check above),
      // since content-length can be absent, wrong, or lied about. The abort
      // timer above stays live through this read (cleared in `finally`
      // below), so a slow/stalled body still gets aborted at TIMEOUT_MS.
      // A mid-stream abort or connection reset throws out of readBodyCapped
      // (AbortError / network error), so this must be caught too — otherwise
      // it escapes fetchPageText instead of yielding a clean result.
      try {
        const html = await readBodyCapped(res, MAX_BYTES);
        // Clamp before the HTML reaches either regex-based consumer below --
        // htmlToText's tag stripper and (for callers that then run
        // extractSameOriginLinks on this same PageResult.html) the link
        // extractor. See MAX_SCAN_CHARS above for why.
        const scanned = html.slice(0, MAX_SCAN_CHARS);
        // Only HTML goes through the tag stripper. A markdown or plain-text
        // body is already text, and running htmlToText over it would destroy
        // exactly the line structure the block splitter needs.
        const isHtml = contentType.includes("text/html");
        // Both branches land in the same normalisation — see `cleanMarkdown`.
        const extracted = isHtml ? htmlToText(scanned) : cleanMarkdown(scanned);
        // Capture truncation before slicing -- see the `truncated` field's
        // doc comment on PageResult for why this can't be reconstructed from
        // the sliced text's length afterward.
        const truncated = extracted.length > MAX_TEXT_CHARS;
        const text = extracted.slice(0, MAX_TEXT_CHARS);
        if (text.length < MIN_TEXT_CHARS) return { error: "insufficient-content" };
        return { text, html: scanned, finalUrl: current.toString(), contentType, truncated };
      } catch {
        return { error: "fetch-failed" };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return { error: "fetch-failed" }; // too many redirects
}

/**
 * Same-origin links from a page's HTML, absolute and deduplicated.
 *
 * Deliberately a regex over raw HTML rather than a DOM parse: the crawl only
 * needs candidate hrefs, a wrong or missed link costs one page of context, and
 * pulling in a parser for this is not worth the dependency. Fragments are
 * stripped before deduplication so `/product` and `/product#features` count once.
 */
export function extractSameOriginLinks(html: string, baseUrl: string): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }

  // Defensive clamp: this function is exported, so a future caller (e.g. a
  // spec-3 competitor crawler) may pass raw, unclamped HTML rather than the
  // already-clamped `html` fetchPageText returns. Without this, that caller
  // inherits the same quadratic-backtracking exposure documented at
  // MAX_SCAN_CHARS above. Don't remove this as redundant with the caller's own
  // clamp -- it isn't, for callers that aren't fetchPageText.
  const scanned = html.slice(0, MAX_SCAN_CHARS);

  const seen = new Set<string>();
  for (const match of scanned.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
    let candidate: URL;
    try {
      candidate = new URL(match[1], base);
    } catch {
      continue;
    }
    if (candidate.protocol !== "http:" && candidate.protocol !== "https:") continue;
    if (candidate.origin !== base.origin) continue;
    candidate.hash = "";
    if (candidate.href === base.href) continue;
    seen.add(candidate.href);
  }
  return [...seen];
}
