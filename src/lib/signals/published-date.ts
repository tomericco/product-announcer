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
 * pattern below bounds its spans to prevent backtracking at each anchor, and the
 * input is clamped before any of them run.
 * This branch has already shipped one ReDoS in attribute-scanning code
 * (`extractSameOriginLinks`, measured at 841ms on 32KB) — do not relax this.
 */
export const MAX_DATE_SCAN_CHARS = 200_000;

/** Below this, a date is a template artefact (`0001-01-01`, Unix-epoch defaults). */
const EARLIEST_PLAUSIBLE_YEAR = 2000;

/**
 * Where a date came from, because the caller must treat them differently.
 *
 * `meta` and `jsonld` are the page *asserting* its own publication date in a
 * machine-readable field: whatever else is on the page, that field means "this
 * article was published at". `time` is a guess — it is the first
 * `<time datetime=…>` anywhere in the document, which is as likely to belong to
 * a "recent posts" widget, a comment timestamp or an event listing as to the
 * article itself.
 *
 * That distinction is load-bearing, not informational. `news-agent.ts` DISCARDS
 * an article whose date falls outside `RECENCY_WINDOW_DAYS`, so a wrong-and-old
 * `time` date would silently delete an article rather than merely misdate it —
 * and it would do so to exactly the target population, since vendor blogs on
 * custom CMSes emitting neither an OG tag nor JSON-LD are precisely the pages
 * that reach the `time` pattern. The asymmetry is the point: a wrong-but-recent
 * date is harmless, a wrong-and-old one is destructive.
 */
export type PublishedDateSource = "meta" | "jsonld" | "time";

export type PublishedDate = { date: Date; source: PublishedDateSource };

/**
 * Ordered most-reliable first; first match wins. `article:published_time` is
 * the only one of these that means "this article was published at", which is
 * why it outranks the rest even when they disagree.
 *
 * Each accepts either quote style and either attribute order — publishers emit
 * both. Spans between anchors are length-bounded with {0,400} to prevent
 * quadratic backtracking when HTML contains repeated anchor literals with no
 * closing bracket.
 */
const PATTERNS: { re: RegExp; source: PublishedDateSource }[] = [
  {
    re: /<meta[^>]{0,400}property=["']article:published_time["'][^>]{0,400}content=["']([^"']{4,64})["']/i,
    source: "meta",
  },
  {
    re: /<meta[^>]{0,400}content=["']([^"']{4,64})["'][^>]{0,400}property=["']article:published_time["']/i,
    source: "meta",
  },
  {
    re: /<meta[^>]{0,400}property=["']og:published_time["'][^>]{0,400}content=["']([^"']{4,64})["']/i,
    source: "meta",
  },
  {
    re: /<meta[^>]{0,400}content=["']([^"']{4,64})["'][^>]{0,400}property=["']og:published_time["']/i,
    source: "meta",
  },
  { re: /"datePublished"\s*:\s*"([^"]{4,64})"/i, source: "jsonld" },
  { re: /<time[^>]{0,400}datetime=["']([^"']{4,64})["']/i, source: "time" },
];

export function extractPublishedDate(html: string): PublishedDate | null {
  const scanned = html.length > MAX_DATE_SCAN_CHARS ? html.slice(0, MAX_DATE_SCAN_CHARS) : html;

  for (const { re, source } of PATTERNS) {
    const match = re.exec(scanned);
    if (!match) continue;

    const parsed = new Date(match[1].trim());
    if (Number.isNaN(parsed.getTime())) continue;

    // A page claiming to be published in the future is a scheduled-publish
    // stamp or a template placeholder, not an article date. A day of slack
    // absorbs timezone skew between us and the publisher.
    if (parsed.getTime() > Date.now() + 24 * 60 * 60 * 1000) continue;
    if (parsed.getUTCFullYear() < EARLIEST_PLAUSIBLE_YEAR) continue;

    return { date: parsed, source };
  }

  return null;
}
