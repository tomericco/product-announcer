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
    }
  | { error: PageError };

export type ResolveHost = (hostname: string) => Promise<string[]>;

const TIMEOUT_MS = 8000;
const MAX_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 12_000;
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

export function htmlToText(html: string): string {
  // Collapse all source whitespace (including real newlines) to single spaces
  // *before* block boundaries are turned into structural newlines below, so a
  // literal line break inside a single block (e.g. a <p> wrapped mid-tag in
  // the source) isn't mistaken for a paragraph break.
  const withoutScripts = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/\s+/g, " ");

  // Only these closing tags (and <br>) become line breaks -- they are the
  // block-level boundaries later per-item extraction splits on. Everything
  // else (inline tags, opening tags) still strips to a plain space.
  const withBlockBreaks = withoutScripts
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');

  // Collapse inline whitespace within each line, trim each line, and squeeze
  // runs of blank lines (including leading/trailing) down to none.
  const lines: string[] = [];
  let prevBlank = true;
  for (const raw of withBlockBreaks.split("\n")) {
    const line = raw.replace(/[ \t]+/g, " ").trim();
    if (line === "") {
      if (!prevBlank) lines.push("");
      prevBlank = true;
    } else {
      lines.push(line);
      prevBlank = false;
    }
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  return lines.join("\n");
}

/**
 * Fetches a public page and returns its readable text alongside the raw HTML
 * (so callers can discover links without a second request). SSRF-guarded:
 * http(s) only, every hop's host must resolve entirely to public IPs, redirects
 * are followed manually and re-validated. Bounded by timeout, size, and content
 * type; returns `insufficient-content` for JS-only shells with little text.
 */
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
        res = await fetchImpl(current.toString(), { redirect: "manual", signal: controller.signal, headers: { accept: "text/html" } });
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
        const text = (isHtml ? htmlToText(scanned) : scanned).slice(0, MAX_TEXT_CHARS);
        if (text.length < MIN_TEXT_CHARS) return { error: "insufficient-content" };
        return { text, html: scanned, finalUrl: current.toString(), contentType };
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
