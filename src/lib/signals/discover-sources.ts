import { and, eq, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { sources, type Source } from "@/db/schema";
import { fetchPageText, extractSameOriginLinks, type PageResult } from "@/lib/workspace/fetch-page";
import { probeAgentPage } from "@/lib/signals/agent-page";

type FetchPage = (url: string) => Promise<PageResult>;

export type DiscoverSourcesDeps = { fetchPage?: FetchPage };

const MAX_SOURCES = 3;

// Path fragments that identify a page worth watching, ordered by how reliably
// each one signals it. Matched against the URL's LAST path segment only --
// not a substring test over the whole path -- so an individual post filed
// under a matching section (e.g. /blog/why-we-left-jira) isn't mistaken for
// the section's own index page. crawl-company-site.ts's `rank()` uses
// substring matching for the same idea; that's fine there (a one-shot
// bootstrap, where a wrong page just costs one page of context) but wrong
// here, where a false match means permanently watching a page that will
// never change again.
const PAGE_KEYWORDS = ["changelog", "release-notes", "releases", "whats-new", "news", "blog", "updates"];

function lastSegment(url: string): string | null {
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1].toLowerCase() : null;
}

/** Index into PAGE_KEYWORDS (lower is a better match), or -1 for no match. */
function rank(url: string): number {
  const segment = lastSegment(url);
  return segment === null ? -1 : PAGE_KEYWORDS.indexOf(segment);
}

function labelFor(keyword: string): string {
  return keyword
    .split("-")
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Finds the pages worth watching on a competitor's site -- changelog, blog,
 * release notes, at most three -- and resolves each one's agent-facing
 * variant (a `.md` page, or the site's llms.txt) so the daily agent can
 * prefer it at fetch time instead of re-probing every run.
 *
 * Idempotent: re-running tops up rather than duplicating, via the same
 * onConflictDoNothing-then-reselect shape `addCompetitor` uses against
 * `competitors_tenant_name_unique`. A candidate page that fails to fetch is
 * skipped, matching `crawlCompanySite`'s "one broken link isn't fatal"
 * precedent -- and skipped candidates are not replaced from further down the
 * ranking, so a competitor can end up with fewer than three sources.
 *
 * Every fetch -- the homepage, each candidate page, and every probe
 * `probeAgentPage` makes -- goes through the injected `fetchPage`. A
 * competitor's website is attacker-influenced input by definition, and
 * `fetchPageText` (the default) is what SSRF-guards it.
 */
export async function discoverCompetitorSources(
  tenantId: string,
  competitorId: string,
  websiteUrl: string,
  deps: DiscoverSourcesDeps = {},
  database: typeof defaultDb = defaultDb
): Promise<Source[]> {
  const fetchPage = deps.fetchPage ?? fetchPageText;

  const home = await fetchPage(websiteUrl);
  if ("error" in home) return [];

  const candidates = extractSameOriginLinks(home.html, websiteUrl)
    .map((href) => ({ href, rank: rank(href) }))
    .filter((candidate) => candidate.rank !== -1)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_SOURCES);

  const created: Source[] = [];
  for (const { href, rank: matchedRank } of candidates) {
    const page = await fetchPage(href);
    if ("error" in page) continue;

    const agentUrl = await probeAgentPage(href, { fetchPage });
    const label = labelFor(PAGE_KEYWORDS[matchedRank]);

    const [inserted] = await database
      .insert(sources)
      .values({ tenantId, competitorId, type: "competitor_web", url: href, agentUrl, label })
      .onConflictDoNothing({
        target: [sources.tenantId, sources.url],
        // Mirrors the partial index's predicate (sources_tenant_url_unique is
        // only defined where url IS NOT NULL) -- Postgres won't infer a
        // partial index as the ON CONFLICT arbiter unless the predicate is
        // restated here.
        where: sql`${sources.url} IS NOT NULL`,
      })
      .returning();

    const source =
      inserted ??
      (
        await database
          .select()
          .from(sources)
          .where(and(eq(sources.tenantId, tenantId), eq(sources.url, href)))
          .limit(1)
      )[0];

    if (source) created.push(source);
  }

  return created;
}
