/**
 * Cited-URL identity: what counts as "the same publisher", and how to see
 * through a redirector to reach it.
 *
 * KNOWN LIMITATION, recorded so it is not rediscovered as a bug: this is a
 * hand-maintained SUBSET of the public suffix list, not the list itself. A
 * multi-part suffix that is not in `MULTI_PART_SUFFIXES` below reduces to its
 * last two labels, so `acme.co.example` would come back as `co.example` and
 * every site under `.co.example` would merge into one leaderboard row. The
 * real list is ~9,000 entries and changes weekly; pulling in `tldts` or
 * `psl` would be the fix if that ever bites, and the architecture decision
 * for v1 is "no new runtime dependencies". The entries below cover the
 * suffixes a B2B SaaS citation set actually hits.
 */

const MULTI_PART_SUFFIXES = new Set([
  // ccTLD second levels.
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "net.uk",
  "sch.uk",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "gov.au",
  "co.nz",
  "net.nz",
  "org.nz",
  "co.za",
  "org.za",
  "co.jp",
  "or.jp",
  "ne.jp",
  "ac.jp",
  "go.jp",
  "co.kr",
  "co.in",
  "co.id",
  "co.th",
  "co.ke",
  "co.il",
  "org.il",
  "ac.il",
  "gov.il",
  "com.br",
  "com.mx",
  "com.ar",
  "com.co",
  "com.pe",
  "com.tr",
  "com.cn",
  "com.hk",
  "com.sg",
  "com.tw",
  "com.my",
  "com.ph",
  "com.vn",
  "com.pk",
  "com.sa",
  "com.eg",
  "com.ng",
  "com.ua",
  "com.pl",
  "com.es",
  // Private suffixes. Two projects on github.io are two publishers, and
  // merging every Vercel preview into "vercel.app" would make that one row
  // the loudest domain on the leaderboard.
  "github.io",
  "gitlab.io",
  "pages.dev",
  "vercel.app",
  "netlify.app",
  "herokuapp.com",
  "web.app",
  "firebaseapp.com",
  "workers.dev",
  "notion.site",
  "substack.com",
  "gitbook.io",
  "readthedocs.io",
  // Hosted content. Each customer gets a subdomain, so without these every
  // help centre on Zendesk — or every blog on WordPress — would collapse into
  // a single row that dwarfs the rest of the leaderboard.
  "zendesk.com",
  "atlassian.net",
  "wordpress.com",
  "blogspot.com",
  "webflow.io",
  "myshopify.com",
  "ghost.io",
]);

/**
 * Hosts whose URLs are opaque handles rather than pages.
 *
 * Gemini's grounding metadata never returns the cited page directly: every
 * `groundingChunks[].web.uri` is a `vertexaisearch.cloud.google.com` handle
 * that 302s to the real URL. Classifying those unresolved would report the
 * whole engine as citing Google.
 */
export const REDIRECTOR_HOSTS = new Set(["vertexaisearch.cloud.google.com"]);

/** More than this and something is looping; the caller keeps what it has. */
const MAX_REDIRECT_HOPS = 3;

/** Per-hop ceiling. See the comment at the call site for why this is not optional. */
const REDIRECT_TIMEOUT_MS = 5_000;

export type DomainClass =
  | "own"
  | "competitor"
  | "review"
  | "community"
  | "publisher"
  | "docs"
  | "wiki"
  | "other";

/**
 * eTLD+1 of a URL, lowercased, or null when there is no host to find.
 *
 * Accepts a bare host too — profile fields are hand-edited and are often
 * stored without a scheme.
 */
export function toRegistrableDomain(url: string): string | null {
  const raw = url.trim();
  if (raw.length === 0) return null;

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let host: string;
  try {
    host = new URL(candidate).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
  if (host.length === 0) return null;

  // An IP literal (v4 or the bracketed v6 form) is its own identity — there
  // is no registrable domain to reduce it to.
  if (host.startsWith("[") || /^\d+(?:\.\d+){3}$/.test(host)) return host;

  const labels = host.split(".").filter((label) => label.length > 0);
  if (labels.length === 0) return null;
  if (labels.length <= 2) return labels.join(".");

  const lastTwo = labels.slice(-2).join(".");
  return MULTI_PART_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

export function isRedirector(url: string): boolean {
  try {
    return REDIRECTOR_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Resolves a redirector handle to the page it points at.
 *
 * Returns the input untouched — and makes no request at all — for anything
 * that is not a known redirector, so the common case costs nothing. Never
 * throws: a citation we could not resolve is still worth storing under the
 * redirector's own domain, which is visibly wrong on the leaderboard rather
 * than silently missing.
 *
 * `redirect: "manual"` so the Location header is readable; GET rather than
 * HEAD because redirect endpoints are not obliged to answer HEAD, and the
 * body is never read.
 */
export async function resolveRedirect(
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  if (!isRedirector(url)) return url;

  let current = url;
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    let response: Response;
    try {
      response = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        // A run resolves hundreds of these. Without a timeout each one inherits
        // the runtime's default headers timeout (~300s), so a handful of hung
        // redirectors would stall the whole slice past its budget. A redirect
        // hop that has not answered in five seconds is not going to.
        signal: AbortSignal.timeout(REDIRECT_TIMEOUT_MS),
      });
    } catch {
      return current;
    }

    const location = response.headers.get("location");
    if (!location) {
      // Some runtimes resolve the chain for us and report the final URL on
      // the response itself.
      return response.url && response.url !== current ? response.url : current;
    }

    let next: string;
    try {
      next = new URL(location, current).toString();
    } catch {
      return current;
    }
    if (!isRedirector(next)) return next;
    // A redirector pointing at a redirector: keep going, but bounded.
    if (next === current) return current;
    current = next;
  }
  return current;
}

// The lookup tables. Small on purpose and expected to grow: a domain that is
// not here lands in `other`, which is honest, whereas a wrong guess would put
// a competitor's own blog under "publisher" on the leaderboard.
const REVIEW_DOMAINS = new Set([
  "g2.com",
  "capterra.com",
  "getapp.com",
  "softwareadvice.com",
  "trustradius.com",
  "gartner.com",
  "peerspot.com",
  "trustpilot.com",
  "producthunt.com",
  "sourceforge.net",
  "saasworthy.com",
  "crozdesk.com",
  "featuredcustomers.com",
  "goodfirms.co",
  "slashdot.org",
]);

const COMMUNITY_DOMAINS = new Set([
  "reddit.com",
  "ycombinator.com",
  "lobste.rs",
  "stackoverflow.com",
  "stackexchange.com",
  "superuser.com",
  "serverfault.com",
  "quora.com",
  "github.com",
  "gitlab.com",
  "discourse.org",
  "discord.com",
  "slack.com",
  "x.com",
  "twitter.com",
  "linkedin.com",
  "youtube.com",
  "indiehackers.com",
  "dev.to",
  "hashnode.dev",
  "medium.com",
]);

const DOCS_DOMAINS = new Set([
  "readthedocs.io",
  "readthedocs.org",
  "gitbook.io",
  "gitbook.com",
  "readme.io",
  "npmjs.com",
  "pypi.org",
  "docs.rs",
  "mozilla.org",
  "w3.org",
  "postman.com",
  "swagger.io",
]);

const WIKI_DOMAINS = new Set([
  "wikipedia.org",
  "wikimedia.org",
  "wiktionary.org",
  "wikidata.org",
  "fandom.com",
  "britannica.com",
]);

const PUBLISHER_DOMAINS = new Set([
  "techcrunch.com",
  "theverge.com",
  "wired.com",
  "arstechnica.com",
  "zdnet.com",
  "cnet.com",
  "venturebeat.com",
  "forbes.com",
  "businessinsider.com",
  "theinformation.com",
  "axios.com",
  "reuters.com",
  "bloomberg.com",
  "ft.com",
  "nytimes.com",
  "wsj.com",
  "techradar.com",
  "infoworld.com",
  "computerworld.com",
  "siliconangle.com",
  "sifted.eu",
  "substack.com",
]);

/**
 * Buckets a registrable domain for the cited-domain leaderboard.
 *
 * `own` and `competitor` are checked first: a tracked brand is a tracked brand
 * whatever else its domain also looks like. Both sides are compared as
 * registrable domains, so pass the output of `toRegistrableDomain` in.
 */
export function classifyDomain(
  domain: string,
  context: { ownDomain: string | null; competitorDomains: string[] }
): DomainClass {
  const value = domain.trim().toLowerCase();
  if (value.length === 0) return "other";

  if (context.ownDomain && value === context.ownDomain.trim().toLowerCase()) return "own";
  for (const competitor of context.competitorDomains) {
    if (competitor && value === competitor.trim().toLowerCase()) return "competitor";
  }

  // Two forms get looked up, not one. A host under a multi-part suffix keeps
  // its own label — `toRegistrableDomain` returns `someone.substack.com`, which
  // is right for identity — but the FAMILY it belongs to is named by the
  // suffix, so `substack.com`, `readthedocs.io` and `gitbook.io` would never
  // match a bare-form set and every such citation would land in `other`.
  // Checking the last two labels as well is what makes those entries live.
  const labels = value.split(".");
  const suffix = labels.length > 2 ? labels.slice(-2).join(".") : null;
  const inFamily = (family: Set<string>) =>
    family.has(value) || (suffix !== null && family.has(suffix));

  if (inFamily(REVIEW_DOMAINS)) return "review";
  if (inFamily(COMMUNITY_DOMAINS)) return "community";
  if (inFamily(DOCS_DOMAINS)) return "docs";
  if (inFamily(WIKI_DOMAINS)) return "wiki";
  if (inFamily(PUBLISHER_DOMAINS)) return "publisher";
  return "other";
}
