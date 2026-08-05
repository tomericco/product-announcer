import { and, eq, inArray } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { signals, sources, companyProfiles, tenants, type Source } from "@/db/schema";
import { fetchPageText, type PageResult } from "@/lib/workspace/fetch-page";
import { searchNews, type NewsHit, type TavilyResult } from "@/lib/signals/tavily";
import {
  scoreRelevance,
  type RelevanceProfile,
  type ScorableItem,
  type ScoredItem,
  type RelevanceDeps,
} from "@/lib/signals/relevance";

type SearchFn = (query: string, deps?: { fetchImpl?: typeof fetch }) => Promise<TavilyResult>;
type FetchPage = (url: string) => Promise<PageResult>;
type ScoreFn = (
  items: ScorableItem[],
  profile: RelevanceProfile,
  tenantId: string,
  deps?: RelevanceDeps
) => Promise<ScoredItem[]>;

export type NewsAgentDeps = {
  search?: SearchFn;
  fetchPage?: FetchPage;
  score?: ScoreFn;
  database?: typeof defaultDb;
};

export type NewsRunResult = {
  written: number;
  /** Scored below the floor. */
  dropped: number;
  /** Already held as signals — not fetched, not scored, not billed. */
  skipped: number;
  credits: number;
};

/** Matches the competitor agent. A null score is a failure, not a low score, and bypasses this. */
const RELEVANCE_FLOOR = 0.3;

/**
 * Caps searches per run. Each is one Tavily credit, so this is the cost dial:
 * at 5, a tenant costs 5 credits/day — roughly 150/month against a 1,000-credit
 * free tier. Topics beyond this are not dropped forever, they are simply not
 * searched this run; the profile's topic order decides priority.
 */
export const MAX_TOPICS_PER_RUN = 5;

/** Params that identify a referral, not an article. */
const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_[ce]id$|ref$|source$)/i;

/**
 * One article, one identity.
 *
 * `signals.externalId` is the article URL, so anything that varies per
 * referral would split one story into several signals — and spec 5 would read
 * the duplicates as independent corroboration for a cluster when they are one
 * event. Strips tracking params, the fragment, and a trailing slash; leaves
 * everything else alone, because a query string can be load-bearing (`?id=7`).
 *
 * Returns the input unchanged when it will not parse. A URL we cannot
 * normalize is still a usable idempotency key — it just gets no help.
 */
export function normalizeArticleUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }

  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) parsed.searchParams.delete(key);
  }
  parsed.hash = "";
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }
  return parsed.toString().replace(/\?$/, "");
}

async function loadProfile(tenantId: string, database: typeof defaultDb): Promise<RelevanceProfile> {
  const [tenant] = await database.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
  const [profile] = await database.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenantId));

  return {
    name: tenant?.name ?? "",
    oneLiner: profile?.oneLiner ?? null,
    positioning: profile?.positioning ?? null,
    topics: profile?.topics ?? [],
  };
}

async function finish(
  database: typeof defaultDb,
  sourceId: string,
  error: string | null
): Promise<void> {
  const now = new Date();
  await database
    .update(sources)
    .set({
      lastRunAt: now,
      lastSuccessAt: error === null ? now : undefined,
      lastError: error,
      // `failing` is advisory, never terminal: the next run reconsiders it.
      // Only a human setting `disabled` retires a source.
      status: error === null ? "active" : "failing",
    })
    .where(eq(sources.id, sourceId));
}

/**
 * One tenant's daily news run.
 *
 * Deliberately has no watermark. A news article carries its own durable
 * identity (its URL) and its own date, so there is nothing to remember between
 * runs: `signals_tenant_kind_external_unique` guarantees we never write the
 * same article twice, and the pre-flight query below is purely a cost saving
 * so we do not re-fetch and re-score what we already hold.
 *
 * Does not throw for the failures it expects. A dead search, an unreachable
 * article, a failed write: each is recorded and the run continues.
 */
export async function runNewsSource(source: Source, deps: NewsAgentDeps = {}): Promise<NewsRunResult> {
  const database = deps.database ?? defaultDb;
  const search = deps.search ?? searchNews;
  const fetchPage = deps.fetchPage ?? fetchPageText;
  const score = deps.score ?? scoreRelevance;

  const empty: NewsRunResult = { written: 0, dropped: 0, skipped: 0, credits: 0 };

  const profile = await loadProfile(source.tenantId, database);
  const topics = profile.topics.slice(0, MAX_TOPICS_PER_RUN);

  if (topics.length === 0) {
    // Not a failure of ours, but the operator has to be able to see why this
    // source produces nothing — otherwise it reads as broken.
    await finish(database, source.id, "Company profile has no topics to search on.");
    return empty;
  }

  // ── Search ────────────────────────────────────────────────────────────
  const byUrl = new Map<string, NewsHit>();
  const errors: string[] = [];
  let credits = 0;

  for (const topic of topics) {
    const result = await search(`${topic} news`);
    if ("error" in result) {
      errors.push(`${topic}: ${result.error}`);
      continue;
    }
    credits += result.credits;
    for (const raw of result.hits) {
      const url = normalizeArticleUrl(raw.url);
      // First topic to surface an article wins; later duplicates are dropped
      // before they cost a fetch or a scoring slot.
      if (!byUrl.has(url)) byUrl.set(url, { ...raw, url });
    }
  }

  if (byUrl.size === 0) {
    await finish(database, source.id, errors.length > 0 ? errors.join("; ") : null);
    return { ...empty, credits };
  }

  // ── Skip what we already hold ─────────────────────────────────────────
  const candidateUrls = [...byUrl.keys()];
  const existing = await database
    .select({ externalId: signals.externalId })
    .from(signals)
    .where(
      and(
        eq(signals.tenantId, source.tenantId),
        eq(signals.kind, "market_news"),
        inArray(signals.externalId, candidateUrls)
      )
    );
  for (const row of existing) byUrl.delete(row.externalId);
  const skipped = existing.length;

  if (byUrl.size === 0) {
    await finish(database, source.id, errors.length > 0 ? errors.join("; ") : null);
    return { ...empty, skipped, credits };
  }

  // ── Fetch each article through the guarded fetcher ─────────────────────
  // These URLs came from a search engine and are attacker-influenced: a
  // hostile page can rank for a topic. `fetchPageText` is what makes that safe.
  const fresh = [...byUrl.values()];
  const bodies = await Promise.all(
    fresh.map(async (article) => {
      const result = await fetchPage(article.url);
      // Tavily's own extract is real page text, not a model's paraphrase, so
      // falling back to it keeps the evidence honest. A paywalled or slow
      // article is still news worth surfacing.
      return "error" in result ? article.content : result.text;
    })
  );

  // ── Score ─────────────────────────────────────────────────────────────
  const items: ScorableItem[] = fresh.map((article, i) => ({
    title: article.title,
    text: bodies[i],
    url: article.url,
  }));
  const scores = await score(items, profile, source.tenantId);

  // ── Write ─────────────────────────────────────────────────────────────
  const now = new Date();
  let written = 0;
  let dropped = 0;

  for (const [i, article] of fresh.entries()) {
    const scored = scores[i] ?? { score: null, rationale: "Relevance scoring failed for this item.", topics: [] };

    if (scored.score !== null && scored.score < RELEVANCE_FLOOR) {
      dropped++;
      continue;
    }

    try {
      const inserted = await database
        .insert(signals)
        .values({
          tenantId: source.tenantId,
          sourceId: source.id,
          kind: "market_news",
          externalId: article.url,
          url: article.url,
          title: article.title,
          excerpt: bodies[i].slice(0, 500),
          // The article's own date when it has one. Only an undated article
          // falls back to now — spec 5's ranking decays on this, so dating a
          // month-old story today would outrank genuinely fresh news.
          occurredAt: article.publishedAt ?? now,
          relevanceScore: scored.score,
          relevanceRationale: scored.rationale,
          topics: scored.topics,
        })
        .onConflictDoNothing()
        .returning({ id: signals.id });

      if (inserted.length > 0) written++;
    } catch (error) {
      // A failed write must stay visible: without this the source would sit
      // `active` with a null error while silently losing articles every run.
      errors.push(`write failed for ${article.url}: ${String(error)}`);
    }
  }

  await finish(database, source.id, errors.length > 0 ? errors.join("; ") : null);
  return { written, dropped, skipped, credits };
}
