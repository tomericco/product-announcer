import { and, desc, eq, inArray } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { signals, sources, companyProfiles, tenants, rejectedArticles, type Source } from "@/db/schema";
import { fetchPageText, type PageResult } from "@/lib/workspace/fetch-page";
import { searchNews, type NewsHit, type TavilyResult } from "@/lib/signals/tavily";
import { extractPublishedDate } from "@/lib/signals/published-date";
import type { RelevanceProfile } from "@/lib/signals/relevance";
import {
  selectNewsSignals,
  type NewsCandidate,
  type NewsSelectionDeps,
  type SelectionResult,
} from "@/lib/signals/news-selection";

type SearchFn = (query: string, deps?: { fetchImpl?: typeof fetch }) => Promise<TavilyResult>;
type FetchPage = (url: string) => Promise<PageResult>;
type SelectFn = (
  candidates: NewsCandidate[],
  profile: RelevanceProfile,
  recentTitles: string[],
  tenantId: string,
  deps?: NewsSelectionDeps
) => Promise<SelectionResult>;

export type NewsAgentDeps = {
  search?: SearchFn;
  fetchPage?: FetchPage;
  select?: SelectFn;
  database?: typeof defaultDb;
};

export type NewsRunResult = {
  written: number;
  /** Candidates that reached the selector but were not selected. */
  dropped: number;
  /** Already held as signals — not fetched, not selected, not billed. */
  skipped: number;
  credits: number;
  /** How many of this run's candidates the selector chose. Capped by MAX_SIGNALS_PER_RUN. */
  selected: number;
  /** Dropped because the article's own page date was outside RECENCY_WINDOW_DAYS. */
  stale: number;
  /**
   * Already judged and turned down — not fetched, not scored, not billed.
   * Distinct from `skipped`, which is "we already wrote this". Both are
   * returned and BOTH ARE CURRENTLY DISCARDED by `sweepNewsSources`; the
   * signature of a pool crowded out by repeats is this number staying high
   * while `written` falls toward zero, and nothing surfaces that yet.
   */
  alreadyRejected: number;
};

/**
 * Tavily's own relevance below which a hit is not worth a fetch, let alone a
 * model call. The cheapest filter in the pipeline: it arrives free with every
 * search result and costs nothing to apply.
 *
 * Calibrated against real traffic, not guessed — and RE-calibrated after the
 * switch to the general index, which scores on a completely different scale.
 *
 * The first calibration measured the NEWS index: 11 hits topping out at 0.42
 * with a median near 0.04. That is what the original 0.2 was wrong against (it
 * admitted 2 of 11) and what 0.05 was then set from. Both numbers describe a
 * configuration this agent no longer runs.
 *
 * A 2026-08-06 probe of the CURRENT configuration — general index, month
 * window, exclusions on, seven real topics — returned 68 unique scored hits:
 *
 *   min 0.074   p25 0.436   median 0.630   p75 0.763   max 0.944
 *
 * Those numbers make this floor look absurdly low, and it stays anyway. The
 * probe was run specifically to justify raising it, and it argued the opposite:
 *
 * 1. Raising it changes nothing on a normal day. Candidates are sorted and cut
 *    to MAX_CANDIDATES_PER_RUN, so the floor alters the fetched set ONLY if it
 *    rises above the score at the slice cut point — 0.758 in that probe. Even
 *    0.5 left 45 candidates, more than twice the cap of 20. Every floor below
 *    the cut point is invisible.
 * 2. The only day it acts is a thin day, when few topics return anything and
 *    the pool falls below the cap. That day has never been measured, and it is
 *    the day scores are most likely to be low across the board — so a floor
 *    tuned on good-day data is at its most dangerous exactly when it finally
 *    does something.
 * 3. Nothing is lost by letting the tail through. It reaches the selector,
 *    which fails closed and rejects listicles. The floor's whole marginal value
 *    is saving a few HTTP fetches; its marginal risk is zeroing a run.
 *
 * The failure mode of a too-high floor is silent and total: articles dropped
 * here are seen by no human and no model, and the source still reports a clean
 * run. That is how the original 0.2 hid for as long as it did — calibrated on
 * the news index, where 0.12 was a good hit. Do not repeat that by calibrating
 * on general-index good days. `tests/lib/signals/news-agent.test.ts` guards
 * this with "keeps hits Tavily scored below the old 0.2 floor"; if that test is
 * in your way, you are making this mistake again.
 *
 * The real bounding is MAX_CANDIDATES_PER_RUN and the selector. Note too that
 * no survivable floor touches high-scoring junk: the same probe returned a
 * Capital One job posting at 0.838 and a social post at 0.902. Those belong to
 * EXCLUDED_DOMAINS and the selector, not here.
 */
export const TAVILY_SCORE_FLOOR = 0.05;

/**
 * Hard ceiling on how many articles reach the fetch and selection stages.
 * `MAX_TOPICS_PER_RUN × TAVILY_MAX_RESULTS` is 50; this bounds the run's real
 * cost — 50 fetches and a 50-item prompt — to something predictable regardless
 * of how many topics a tenant configures. Candidates are sorted by Tavily
 * score first, so truncation drops the weakest, not an arbitrary slice.
 */
export const MAX_CANDIDATES_PER_RUN = 20;

/** How many recent headlines the selector sees when judging novelty. */
export const RECENT_TITLES_FOR_NOVELTY = 40;

/**
 * Caps searches per run. Each is one Tavily credit, so this is the cost dial:
 * at 10, a tenant costs 10 credits/day — roughly 300/month against a
 * 1,000-credit free tier, so about three tenants fit free.
 *
 * Raised from 5 because the slice is `topics.slice(0, MAX_TOPICS_PER_RUN)` —
 * an arbitrary prefix, not a ranked selection. At 5 the four most specific
 * terms in a nine-topic profile were never searched at all, while its two
 * broadest ones dominated the results. Ten covers a normal profile outright,
 * which sidesteps the ordering problem rather than solving it.
 *
 * This does NOT multiply the fetch or model bill: MAX_CANDIDATES_PER_RUN still
 * caps what is fetched and scored at 20 regardless of how many searches fed it.
 * Only Tavily credits scale here. What does change is competition — twice the
 * candidates for the same 20 slots — so the Tavily-score sort does more work
 * and a weak topic can no longer crowd out a strong one by position alone.
 */
export const MAX_TOPICS_PER_RUN = 10;

/**
 * How much of each article body the selector sees.
 *
 * Cost and signal density, not context overflow. `MAX_CANDIDATES_PER_RUN` (20)
 * articles at `fetchPageText`'s `MAX_TEXT_CHARS` (12,000) each is ~240k chars,
 * roughly 60k tokens — comfortably inside Haiku's 200k window, so overflow is
 * not the concern it would be at a larger cap.
 *
 * What the cap buys is a per-run model spend the plan's Tavily credit budget
 * does not otherwise account for, paid daily per tenant, and a better prompt:
 * a news article puts its substance in the opening paragraphs, and the tail is
 * boilerplate, navigation and related-story chrome that dilutes the judgement
 * rather than informing it. 2,000 chars is where the marginal token stops
 * telling the model anything new about whether the story matters.
 *
 * Only the selection input is capped. The stored `excerpt` still slices its
 * 500 chars out of the full fetched body.
 */
export const SCORING_EXCERPT_CHARS = 2_000;

/**
 * How many articles are fetched at once.
 *
 * A bare `Promise.all` over a full run opens up to MAX_CANDIDATES_PER_RUN (20)
 * outbound connections simultaneously, each buffering up to `fetchPageText`'s
 * 2MB cap. Batching keeps peak memory and socket use flat without pulling in
 * a pool dependency.
 */
const FETCH_CONCURRENCY = 8;

/**
 * How recent an article must be to be worth surfacing, when we can tell.
 *
 * Enforced here rather than left to Tavily's `time_range` because the general
 * index returns no dates at all — its window filters on its own crawl notion of
 * recency, which is how a two-year-old evergreen guide can arrive inside a
 * one-week window. This is the only place a real publication date is known.
 *
 * COUPLED TO `TAVILY_TIME_RANGE` ("month") in `tavily.ts`, which is the outer
 * window: it decides what is fetched, this decides what survives. Changing one
 * alone does nothing useful. Narrow `TAVILY_TIME_RANGE` and this constant has
 * nothing new to admit, because Tavily never returned it; narrow this one and
 * every dated article in the range the outer window still asks for is fetched
 * and then thrown away — paid for, and discarded. Change them together.
 *
 * 30 matches the outer window exactly, so a dated article is dropped here only
 * if the page's own date disagrees with Tavily's notion of recency — which is
 * the case this inner window exists for: Tavily filters on its crawl date, and
 * an evergreen guide recrawled yesterday can be two years old.
 *
 * Applies ONLY to articles we could date, and only to a date the page actually
 * asserts — see `PublishedDateSource`. An undated article is kept and ranked
 * below dated ones: dropping them would discard most professional writing,
 * which is the content this agent exists to surface. A `time`-derived date is
 * likewise never grounds for dropping, because it is a guess.
 */
export const RECENCY_WINDOW_DAYS = 30;

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
 * Records articles this tenant will not be offered again.
 *
 * Throws on a database error — both call sites wrap it, because a failed
 * memory write must not cost a run its signals. The worst case is that these
 * articles are re-judged next run, which is the behaviour that existed before
 * this table.
 *
 * `url` must already be normalized. `runNewsSource` stores normalized URLs in
 * `byUrl`, so every caller inside this module satisfies that by construction.
 */
async function rememberRejections(
  database: typeof defaultDb,
  tenantId: string,
  entries: { url: string; title: string; reason: "not_selected" | "stale" }[]
): Promise<void> {
  if (entries.length === 0) return;
  await database
    .insert(rejectedArticles)
    .values(entries.map((e) => ({ tenantId, url: e.url, title: e.title, reason: e.reason })))
    // A repeat rejection is expected, not exceptional: an article stays in the
    // search window for weeks. First write wins.
    .onConflictDoNothing({ target: [rejectedArticles.tenantId, rejectedArticles.url] });
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
  const select = deps.select ?? selectNewsSignals;

  const empty: NewsRunResult = {
    written: 0,
    dropped: 0,
    skipped: 0,
    credits: 0,
    selected: 0,
    stale: 0,
    alreadyRejected: 0,
  };

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
    // The bare topic, deliberately. `searchNews` already scopes the search via
    // `topic: "general"`; appending the word "news" as well biased results
    // toward wire copy and press releases, and now also fights the whole point
    // of the general index, which is the professional and opinion writing that
    // never appears on a wire. On the first live run "developer cli news"
    // returned a crypto-brokerage press release as its top hit.
    const result = await search(topic);
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
      //
      // That exception is DORMANT, not live logic: on the general index
      // `publishedAt` is null on every result, so the second half of the
      // condition never fires, and dates are produced later by the fetch below
      // rather than here. It is kept because it costs nothing and would matter
      // the moment an index supplies dates again — do not read it as
      // describing what a run currently does.
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

  // ── Skip what we already judged ───────────────────────────────────────
  // Deliberately BEFORE the score filter, the truncation and every fetch: a
  // remembered article must free a candidate slot for new material, not merely
  // avoid a duplicate row. Queried against what survived the signals skip, so
  // it never asks about URLs already removed.
  const remainingUrls = [...byUrl.keys()];
  const rejectedRows = await database
    .select({ url: rejectedArticles.url })
    .from(rejectedArticles)
    .where(and(eq(rejectedArticles.tenantId, source.tenantId), inArray(rejectedArticles.url, remainingUrls)));
  for (const row of rejectedRows) byUrl.delete(row.url);
  const alreadyRejected = rejectedRows.length;

  if (byUrl.size === 0) {
    await finish(database, source.id, errors.length > 0 ? errors.join("; ") : null, productive);
    return { ...empty, skipped, alreadyRejected, credits };
  }

  // ── Cheap filtering, before anything expensive ────────────────────────
  // Tavily's own score is free and already in hand. Applying it here removes
  // most of a run's cost before a single HTTP request, and the sort means the
  // cap below drops the weakest candidates rather than an arbitrary slice.
  //
  // A `null` score means Tavily gave us none, which is not the same as zero —
  // it is unranked, not irrelevant. Nulls therefore survive the floor and sort
  // as if 0, so they are truncated first rather than dropped outright. That is
  // what keeps a benign upstream rename of Tavily's `score` field from emptying
  // this agent permanently.
  const beforeFilter = byUrl.size;
  const fresh = [...byUrl.values()]
    .filter((article) => article.score === null || article.score >= TAVILY_SCORE_FLOOR)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, MAX_CANDIDATES_PER_RUN);

  if (fresh.length === 0) {
    // A run that discarded every candidate must not report clean. Without this
    // the source sits `active` with a null error while producing nothing — the
    // exact shape a dead upstream field would take, and invisible to anyone
    // reading the health block.
    errors.push(`All ${beforeFilter} candidates were below the relevance floor.`);
    await finish(database, source.id, errors.join("; "), productive);
    return { ...empty, skipped, alreadyRejected, credits };
  }

  // ── Fetch each article through the guarded fetcher ─────────────────────
  // These URLs came from a search engine and are attacker-influenced: a
  // hostile page can rank for a topic. `fetchPageText` is what makes that safe.
  // Fetched in bounded batches rather than one big `Promise.all` — see
  // FETCH_CONCURRENCY.
  const bodies: string[] = [];
  const dates: (Date | null)[] = [];
  /**
   * Per-article: is this date only a guess?
   *
   * True when it came from `extractPublishedDate`'s `time` source — the first
   * `<time datetime=…>` on the page, which is frequently a sidebar widget or a
   * comment stamp rather than the article's own date. A guessed date is good
   * enough to set `occurredAt` and to rank the article as dated; it is NOT good
   * enough to delete the article, which is what the stale drop below does.
   */
  const guessed: boolean[] = [];
  for (let i = 0; i < fresh.length; i += FETCH_CONCURRENCY) {
    const batch = await Promise.all(
      fresh.slice(i, i + FETCH_CONCURRENCY).map(async (article) => {
        const result = await fetchPage(article.url);
        if ("error" in result) {
          // Tavily's own extract is real page text, not a model's paraphrase, so
          // falling back to it keeps the evidence honest. A paywalled or slow
          // article is still worth surfacing — but we cannot date it.
          return { body: article.content, date: article.publishedAt, guessed: false };
        }
        // The page is the authority on its own date; the index gave us none.
        const extracted = extractPublishedDate(result.html);
        if (extracted) {
          return { body: result.text, date: extracted.date, guessed: extracted.source === "time" };
        }
        return { body: result.text, date: article.publishedAt, guessed: false };
      })
    );
    for (const b of batch) {
      bodies.push(b.body);
      dates.push(b.date);
      guessed.push(b.guessed);
    }
  }

  // ── Recency, enforced only where it is actually known ──────────────────
  // Undated articles are NOT dropped here — see RECENCY_WINDOW_DAYS. Nor are
  // articles whose only date came from a bare `<time>` element, which is a
  // guess: dropping on a guess deletes the article outright, and the pages that
  // reach that pattern are the vendor blogs this agent exists to surface. Only
  // an article the page itself dates, outside the window, is cut.
  const cutoff = new Date(Date.now() - RECENCY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const kept: { article: NewsHit; body: string; date: Date | null }[] = [];
  const staleRejections: { url: string; title: string; reason: "stale" }[] = [];
  let stale = 0;
  for (const [i, article] of fresh.entries()) {
    const date = dates[i];
    if (date !== null && !guessed[i] && date < cutoff) {
      stale++;
      staleRejections.push({ url: article.url, title: article.title, reason: "stale" });
      continue;
    }
    kept.push({ article, body: bodies[i], date });
  }

  if (stale > 0) {
    // No early return when everything was stale: the brief's test requires
    // `select` to be called with an empty list, and `selectNewsSignals`
    // short-circuits on that without a model call, so letting it through costs
    // nothing. What must NOT be lost is the reason — a source that fetches fine
    // but finds only stale articles would otherwise report `lastError: null`,
    // `status: "active"` and produce nothing, every day, indistinguishable from
    // a quiet week.
    //
    // Partial staleness is recorded for the same reason. A run that dropped 19
    // of 20 articles is one article away from the all-stale case and reads as
    // completely clean without this; by the time it reaches 20 of 20 the
    // operator has had no warning at all. `finish` still marks the source
    // `active` — the run did its job — exactly as it does for a partial search
    // failure.
    errors.push(
      kept.length === 0
        ? `All ${fresh.length} fetched articles were older than ${RECENCY_WINDOW_DAYS} days.`
        : `${stale} of ${fresh.length} fetched articles were older than ${RECENCY_WINDOW_DAYS} days.`
    );
  }

  // Recorded here rather than with the selector's rejections below, because
  // staleness is a complete judgement on its own: it does not depend on the
  // selection call, so a later selection failure must not discard it. It is
  // also permanent in a way selection is not — an article only gets older.
  try {
    await rememberRejections(database, source.tenantId, staleRejections);
  } catch (e) {
    errors.push(`could not record stale articles: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Dated articles first, each group by Tavily score. An undated article is not
  // rejected, just outranked — the model reads in order, so this is how "we know
  // when this was written" earns its place without becoming a filter.
  //
  // `kept` is now the single ordered source of truth for everything below:
  // `fresh` and `bodies` are in pre-sort order and must not be indexed by
  // `selection.index` again.
  kept.sort((a, b) => {
    const aDated = a.date !== null ? 1 : 0;
    const bDated = b.date !== null ? 1 : 0;
    if (aDated !== bDated) return bDated - aDated;
    return (b.article.score ?? 0) - (a.article.score ?? 0);
  });

  // ── Recent titles, so novelty can be judged ───────────────────────────
  const recent = await database
    .select({ title: signals.title })
    .from(signals)
    .where(and(eq(signals.tenantId, source.tenantId), eq(signals.kind, "market_news")))
    .orderBy(desc(signals.occurredAt))
    .limit(RECENT_TITLES_FOR_NOVELTY);
  const recentTitles = recent.map((r) => r.title);

  // ── Select ────────────────────────────────────────────────────────────
  // Built from `kept`, not `fresh`/`bodies` — `kept` carries the post-sort
  // order the selector actually sees, and its indices are what the write loop
  // below maps `selection.index` back through.
  const candidates: NewsCandidate[] = kept.map((k) => ({
    title: k.article.title,
    // Capped: one run can carry MAX_CANDIDATES_PER_RUN full article bodies
    // into a single prompt. See SCORING_EXCERPT_CHARS for why overflow here is
    // a correctness problem, not just a cost one.
    text: k.body.slice(0, SCORING_EXCERPT_CHARS),
    url: k.article.url,
  }));
  const outcome = await select(candidates, profile, recentTitles, source.tenantId);

  if ("error" in outcome) {
    // Fail CLOSED. An article nobody judged cannot have passed the bar, and
    // writing the batch anyway is exactly what the cap exists to prevent. The
    // settings health block surfaces `lastError`, so this is visible rather
    // than a silent gap.
    errors.push(`selection failed: ${outcome.error}`);
    await finish(database, source.id, errors.join("; "), false);
    return { ...empty, skipped, alreadyRejected, credits };
  }

  // The set, not the count, is the authority for what gets recorded: if the
  // model ever returned a duplicate index, arithmetic on lengths would
  // disagree with the actual complement. `dropped` is left as-is because it is
  // an existing reported number and this task does not change its contract.
  const selectedIndices = new Set(outcome.selections.map((s) => s.index));
  const notSelected = kept
    .filter((_, i) => !selectedIndices.has(i))
    .map((k) => ({ url: k.article.url, title: k.article.title, reason: "not_selected" as const }));
  const dropped = kept.length - outcome.selections.length;

  // ── Write ─────────────────────────────────────────────────────────────
  const now = new Date();
  let written = 0;

  for (const selection of outcome.selections) {
    // `kept` is the single ordered source of truth — see the sort above. Never
    // fall back to indexing `fresh`/`bodies` here: they are in pre-sort order.
    const chosen = kept[selection.index];

    // Unreachable: `selectNewsSignals` already drops out-of-range indices. It
    // is here because the cost of being wrong is out of proportion to the
    // check — an undefined `chosen` would throw a TypeError straight out of
    // `runNewsSource`, breaking its "does not throw for the failures it
    // expects" contract and skipping `finish` entirely, which leaves the source
    // row stale with no lastRunAt and no error to explain it.
    if (!chosen) continue;
    const article = chosen.article;
    const body = chosen.body;

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
          // selector saw.
          excerpt: body.slice(0, 500),
          // The article's own extracted date when we have one, falling back to
          // Tavily's `publishedAt`, and only then to "seen now". An undated
          // article is recorded as `now`, which biases it *fresh* — `now` is
          // the freshest value there is, so spec 5's decay ranking will float
          // it above correctly-dated ones. Accepted, not fixed here: dropping
          // undated articles would discard most of what this agent exists to
          // surface. See RECENCY_WINDOW_DAYS.
          occurredAt: chosen.date ?? now,
          relevanceScore: selection.score,
          relevanceRationale: selection.rationale,
          topics: selection.topics,
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

  // MUST stay after the `"error" in outcome` branch above, which returns early.
  // An article nobody judged has not been rejected, and recording these on a
  // failed selection would bury up to MAX_CANDIDATES_PER_RUN articles
  // permanently because of one API timeout. Do not hoist this to "keep the
  // write path together".
  try {
    await rememberRejections(database, source.tenantId, notSelected);
  } catch (e) {
    errors.push(`could not record rejected articles: ${e instanceof Error ? e.message : String(e)}`);
  }

  await finish(database, source.id, errors.length > 0 ? errors.join("; ") : null, productive);
  return { written, dropped, skipped, credits, selected: outcome.selections.length, stale, alreadyRejected };
}
