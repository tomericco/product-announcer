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

/**
 * How much of each article body the scorer sees.
 *
 * This is a safety bound, not just a prompt-size tidy-up. A run can carry
 * MAX_TOPICS_PER_RUN × TAVILY_MAX_RESULTS = 50 articles, and `fetchPageText`
 * returns up to MAX_TEXT_CHARS (12,000) each, so the unbounded prompt was
 * ~600k chars — past Haiku's context window. `scoreRelevance` *fails open*:
 * on overflow (or a rate limit) it returns all-null scores, and a null score
 * bypasses RELEVANCE_FLOOR by design, so the whole batch of 50
 * attacker-influenced articles would be written unscored. Capping the text
 * each item contributes keeps the batch comfortably inside the window, so the
 * floor keeps doing its job. Also bounds the per-run model spend, which the
 * plan's Tavily credit budget does not otherwise account for.
 *
 * Only the scoring input is capped. The stored `excerpt` still slices its 500
 * chars out of the full fetched body.
 */
export const SCORING_EXCERPT_CHARS = 2_000;

/**
 * How many articles are fetched at once.
 *
 * A bare `Promise.all` over a full run opens up to 50 outbound connections
 * simultaneously, each buffering up to `fetchPageText`'s 2MB cap. Batching
 * keeps peak memory and socket use flat without pulling in a pool dependency.
 */
const FETCH_CONCURRENCY = 8;

/** Params that identify a referral, not an article. */
const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_[ce]id$|ref$|source$)/i;

/**
 * One article, one identity.
 *
 * `signals.externalId` is the article URL, so anything that varies per
 * referral would split one story into several signals — and spec 5 would read
 * the duplicates as independent corroboration for a cluster when they are one
 * event. Strips tracking params, the fragment, and a trailing slash;
 * lowercases the host, drops a leading `www.`, and upgrades `http:` to
 * `https:` so one article does not arrive under three identities. Leaves the
 * query string otherwise alone, because it can be load-bearing (`?id=7`), and
 * leaves the path's case alone, because paths are case-sensitive.
 *
 * THIS IS A PERSISTED DATA CONTRACT, not an internal helper. Its output *is*
 * `signals.externalId` for every market_news row ever written. Changing it
 * later re-keys articles we already hold: the pre-flight skip query stops
 * matching them, `onConflictDoNothing` stops firing, and every still-live
 * article is re-fetched, re-scored and written a second time under its new
 * identity. Any future change needs a backfill of existing externalIds, not
 * just an edit here.
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
  // `URL` already lowercases the host; this is the `www.` and scheme half.
  if (parsed.protocol === "http:") parsed.protocol = "https:";
  parsed.hostname = parsed.hostname.replace(/^www\./, "");
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

/**
 * Records the outcome of a run on the source row.
 *
 * `productive` — not "were there any errors" — decides the badge, matching
 * `runCompetitorSource`'s ruling so the shared `SourceStatusBadge` means the
 * same thing on both cards. A run where four of five searches succeeded did
 * its job; it stays `active` with `lastSuccessAt` set, and the partial failure
 * is surfaced in `lastError` for an operator to read. Only a run that
 * accomplished nothing at all — no topics to search, or every search failed —
 * is `failing`.
 */
async function finish(
  database: typeof defaultDb,
  sourceId: string,
  error: string | null,
  productive: boolean
): Promise<void> {
  const now = new Date();
  await database
    .update(sources)
    .set({
      lastRunAt: now,
      lastSuccessAt: productive ? now : undefined,
      lastError: error,
      // `failing` is advisory, never terminal: the next run reconsiders it.
      // Only a human setting `disabled` retires a source.
      status: productive ? "active" : "failing",
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
    // source produces nothing — otherwise it reads as broken. A run with
    // nothing to search accomplished nothing, so it is genuinely `failing`.
    await finish(database, source.id, "Company profile has no topics to search on.", false);
    return empty;
  }

  // ── Search ────────────────────────────────────────────────────────────
  const byUrl = new Map<string, NewsHit>();
  const errors: string[] = [];
  let credits = 0;
  let searched = 0;

  for (const topic of topics) {
    const result = await search(`${topic} news`);
    if ("error" in result) {
      errors.push(`${topic}: ${result.error}`);
      continue;
    }
    searched++;
    credits += result.credits;
    for (const raw of result.hits) {
      const url = normalizeArticleUrl(raw.url);
      // First topic to surface an article wins — later duplicates are dropped
      // before they cost a fetch or a scoring slot — with one exception: a
      // hit that carries a publication date beats one that does not, whatever
      // the order. Otherwise an undated copy arriving first would throw away a
      // real date and leave `occurredAt` defaulted to run time.
      const held = byUrl.get(url);
      if (!held || (held.publishedAt === null && raw.publishedAt !== null)) {
        byUrl.set(url, { ...raw, url });
      }
    }
  }

  // Every search failed: the run reached nothing and is genuinely failing.
  const productive = searched > 0;

  if (byUrl.size === 0) {
    await finish(database, source.id, errors.length > 0 ? errors.join("; ") : null, productive);
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
    await finish(database, source.id, errors.length > 0 ? errors.join("; ") : null, productive);
    return { ...empty, skipped, credits };
  }

  // ── Fetch each article through the guarded fetcher ─────────────────────
  // These URLs came from a search engine and are attacker-influenced: a
  // hostile page can rank for a topic. `fetchPageText` is what makes that safe.
  // Fetched in bounded batches rather than one big `Promise.all` — see
  // FETCH_CONCURRENCY.
  const fresh = [...byUrl.values()];
  const bodies: string[] = [];
  for (let i = 0; i < fresh.length; i += FETCH_CONCURRENCY) {
    const batch = await Promise.all(
      fresh.slice(i, i + FETCH_CONCURRENCY).map(async (article) => {
        const result = await fetchPage(article.url);
        // Tavily's own extract is real page text, not a model's paraphrase, so
        // falling back to it keeps the evidence honest. A paywalled or slow
        // article is still news worth surfacing.
        return "error" in result ? article.content : result.text;
      })
    );
    bodies.push(...batch);
  }

  // ── Score ─────────────────────────────────────────────────────────────
  const items: ScorableItem[] = fresh.map((article, i) => ({
    title: article.title,
    // Capped: one run can carry 50 full article bodies into a single prompt.
    // See SCORING_EXCERPT_CHARS for why overflow here is a correctness
    // problem, not just a cost one.
    text: bodies[i].slice(0, SCORING_EXCERPT_CHARS),
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
          // Sliced from the full fetched body, not from the capped copy the
          // scorer saw.
          excerpt: bodies[i].slice(0, 500),
          // The article's own date when it has one; an undated article is
          // recorded as "seen now". That biases undated articles *fresh* —
          // `now` is the freshest value there is, so spec 5's decay ranking
          // will float them above correctly-dated ones. What bounds the damage
          // is the search window: `time_range: "day"` in tavily.ts means an
          // undated hit is at most a day old anyway. Widening that window
          // widens this skew with it.
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

  await finish(database, source.id, errors.length > 0 ? errors.join("; ") : null, productive);
  return { written, dropped, skipped, credits };
}
