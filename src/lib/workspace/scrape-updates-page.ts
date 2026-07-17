import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type ScrapeResult = { text: string } | { error: "invalid-url" | "blocked" | "fetch-failed" | "insufficient-content" };

export type ResolveHost = (hostname: string) => Promise<string[]>;

const TIMEOUT_MS = 8000;
const MAX_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 12_000;
const MIN_TEXT_CHARS = 200;
const MAX_REDIRECTS = 3;

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
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fetches a public updates page and returns its readable text. SSRF-guarded:
 * http(s) only, every hop's host must resolve entirely to public IPs, redirects
 * are followed manually and re-validated. Bounded by timeout, size, and content
 * type; returns `insufficient-content` for JS-only shells with little text.
 */
export async function fetchUpdatesPageText(
  url: string,
  deps: { fetchImpl?: typeof fetch; resolveHost?: ResolveHost } = {}
): Promise<ScrapeResult> {
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
      if (!contentType.includes("text/html") && !contentType.includes("text/plain")) return { error: "fetch-failed" };
      if (Number(res.headers.get("content-length") ?? "0") > MAX_BYTES) return { error: "fetch-failed" };

      // Hard cap the body read itself (not just this fast-path check above),
      // since content-length can be absent, wrong, or lied about. The abort
      // timer above stays live through this read (cleared in `finally`
      // below), so a slow/stalled body still gets aborted at TIMEOUT_MS.
      const html = await readBodyCapped(res, MAX_BYTES);
      const text = htmlToText(html).slice(0, MAX_TEXT_CHARS);
      if (text.length < MIN_TEXT_CHARS) return { error: "insufficient-content" };
      return { text };
    } finally {
      clearTimeout(timer);
    }
  }

  return { error: "fetch-failed" }; // too many redirects
}
