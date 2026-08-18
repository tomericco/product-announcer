import { fetchPageText, extractSameOriginLinks, type PageError, type PageResult } from "@/lib/workspace/fetch-page";

export type CrawlDeps = { fetchPage?: typeof fetchPageText };

export type CrawlResult = { text: string; pages: string[] } | { error: PageError };

const MAX_SECONDARY_PAGES = 3;
const MAX_COMBINED_CHARS = 24_000;

// Path fragments that tend to carry positioning. Ordered by how reliably they
// do: a product page beats an about page beats pricing. Matching on the path
// keeps selection deterministic and free — a model choosing pages here would
// buy nothing and make the crawl irreproducible.
const PAGE_KEYWORDS = ["product", "about", "platform", "features", "pricing", "solutions", "why"];

function rank(url: string): number {
  const path = new URL(url).pathname.toLowerCase();
  const index = PAGE_KEYWORDS.findIndex((keyword) => path.includes(keyword));
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

/**
 * Reads a company's own site for enough context to draft their profile: the
 * homepage plus up to three keyword-matched same-origin pages.
 *
 * A secondary page that fails to fetch is skipped, not fatal — three pages of
 * context is better than none. Only a homepage failure aborts, because without
 * it there is nothing to analyze and no links to follow.
 */
export async function crawlCompanySite(url: string, deps: CrawlDeps = {}): Promise<CrawlResult> {
  const fetchPage = deps.fetchPage ?? fetchPageText;

  const home = await fetchPage(url);
  if ("error" in home) return { error: home.error };

  const candidates = extractSameOriginLinks(home.html, url)
    .map((href) => ({ href, score: rank(href) }))
    .filter((candidate) => candidate.score !== Number.MAX_SAFE_INTEGER)
    .sort((a, b) => a.score - b.score)
    .slice(0, MAX_SECONDARY_PAGES);

  const pages = [url];
  const parts = [home.text];
  for (const { href } of candidates) {
    const page: PageResult = await fetchPage(href);
    if ("error" in page) continue;
    pages.push(href);
    parts.push(page.text);
  }

  return { text: parts.join("\n\n---\n\n").slice(0, MAX_COMBINED_CHARS), pages };
}
