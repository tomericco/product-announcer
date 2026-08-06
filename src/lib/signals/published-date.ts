/**
 * Reads an article's publication date out of its own HTML.
 *
 * Needed because Tavily's general index — the one that actually carries
 * professional and opinion writing — returns no `published_date` at all, on any
 * result. The news index does supply dates, but a live probe found it returns
 * Google News aggregator URLs and near-zero relevance for this domain, so it is
 * not an option. The page itself is also a better authority than a search index.
 *
 * Pure: no network, no database. The caller has already fetched the HTML through
 * `fetchPageText`, which is what makes the fetch safe.
 */

/**
 * Article HTML arrives from a search result and is attacker-influenced, so every
 * pattern below is bounded and the input is clamped before any of them run.
 * This branch has already shipped one ReDoS in attribute-scanning code
 * (`extractSameOriginLinks`, measured at 841ms on 32KB) — do not relax this.
 */
export const MAX_DATE_SCAN_CHARS = 200_000;

/** Below this, a date is a template artefact (`0001-01-01`, Unix-epoch defaults). */
const EARLIEST_PLAUSIBLE_YEAR = 2000;

/**
 * Ordered most-reliable first; first match wins. `article:published_time` is
 * the only one of these that means "this article was published at", which is
 * why it outranks the rest even when they disagree.
 *
 * Each accepts either quote style and either attribute order — publishers emit
 * both — using negated character classes so there is no backtracking.
 */
const PATTERNS: RegExp[] = [
  /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']{4,64})["']/i,
  /<meta[^>]+content=["']([^"']{4,64})["'][^>]+property=["']article:published_time["']/i,
  /<meta[^>]+property=["']og:published_time["'][^>]+content=["']([^"']{4,64})["']/i,
  /<meta[^>]+content=["']([^"']{4,64})["'][^>]+property=["']og:published_time["']/i,
  /"datePublished"\s*:\s*"([^"]{4,64})"/i,
  /<time[^>]+datetime=["']([^"']{4,64})["']/i,
];

export function extractPublishedDate(html: string): Date | null {
  const scanned = html.length > MAX_DATE_SCAN_CHARS ? html.slice(0, MAX_DATE_SCAN_CHARS) : html;

  for (const pattern of PATTERNS) {
    const match = pattern.exec(scanned);
    if (!match) continue;

    const parsed = new Date(match[1].trim());
    if (Number.isNaN(parsed.getTime())) continue;

    // A page claiming to be published in the future is a scheduled-publish
    // stamp or a template placeholder, not an article date. A day of slack
    // absorbs timezone skew between us and the publisher.
    if (parsed.getTime() > Date.now() + 24 * 60 * 60 * 1000) continue;
    if (parsed.getUTCFullYear() < EARLIEST_PLAUSIBLE_YEAR) continue;

    return parsed;
  }

  return null;
}
