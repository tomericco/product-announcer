import { z } from "zod";

/**
 * The Tavily Search API, narrowed to the one call the news agent makes.
 *
 * Deliberately dependency-free: this is a single POST to a fixed, known host,
 * so it needs neither an SDK nor `fetchPageText`'s SSRF guards (the host is
 * ours to trust, unlike the article URLs it returns — those are
 * attacker-influenced and MUST go through `fetchPageText`).
 *
 * Every failure is returned, never thrown. A news run that loses one query to
 * a rate limit should still write the other queries' articles.
 */

const TAVILY_URL = "https://api.tavily.com/search";

/** Bounded so one topic cannot dominate a run's fetch budget. Tavily's cap is 20. */
export const TAVILY_MAX_RESULTS = 10;

export type NewsHit = {
  title: string;
  url: string;
  /** Tavily's own extract from the page. Used as the excerpt fallback when we cannot fetch the article ourselves. */
  content: string;
  /** Null when absent or unparseable. Never defaulted to "now" — see `occurredAt` in news-agent.ts. */
  publishedAt: Date | null;
  /**
   * Tavily's own 0–1 relevance for the query that found this hit. Free — it
   * arrives with every result — and it is the only filter available before we
   * spend a fetch or a model call on an article.
   *
   * `null` means Tavily gave us no score, which is deliberately NOT the same as
   * a score of 0: a scoreless result is unranked, not irrelevant. Callers must
   * keep nulls past their relevance floor and rank them last, so that if Tavily
   * ever drops or renames the field the news agent degrades to "unranked" and
   * keeps working, rather than silently filtering every hit away.
   */
  score: number | null;
};

export type TavilyError = "no-api-key" | "request-failed" | "bad-response";

export type TavilyResult = { hits: NewsHit[]; credits: number } | { error: TavilyError };

export type TavilyFetch = typeof fetch;

/**
 * The envelope only. Individual results are parsed one at a time below, on
 * purpose: validating the whole array at once means a single malformed result
 * fails the entire search.
 *
 * That is not hypothetical. The first live run lost 2 of 5 searches to
 * `bad-response` because some results carry `published_date: null` and the
 * field was typed `.optional()`, which permits *absent* but not *null*. Nine
 * good articles were discarded to reject one undated one.
 */
const EnvelopeSchema = z.object({ results: z.array(z.unknown()) });

/**
 * One result. Every field Tavily may omit or null is `.nullish()`, because the
 * response shape is not a contract we control and the failure mode for
 * guessing wrong is silent and total.
 */
const ResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  content: z.string().nullish(),
  published_date: z.string().nullish(),
  score: z.number().nullish(),
});

/**
 * Tavily does not report usage. The live response's top-level keys are
 * `query`, `follow_up_questions`, `answer`, `images`, `results`,
 * `response_time` and `request_id` — there is no `usage` object, so the
 * previous `usage.credits ?? 0` reported zero on every successful search and
 * all credit accounting was fiction.
 *
 * Derived from Tavily's published pricing for the `search_depth` we send:
 * `basic` is one credit. Changing `search_depth` means changing this.
 */
const CREDITS_PER_SEARCH = 1;

/**
 * The general index, not the news index.
 *
 * A live probe on 2026-08-06 found `topic: "news"` unusable for this product's
 * niche: on "design localization" it returned relevance scores of 0.11 down to
 * 0.01 (LiDAR perception, the World Gold Council, payment failures) and every
 * result's URL was `www.google.com` — Google News aggregator redirects, not
 * article links. Those collapse under `normalizeArticleUrl` into one host and
 * defeat `externalId` uniqueness.
 *
 * The same query on the general index returned Phrase, Webflow, Lilt and
 * SimpleLocalize writing substantively about multilingual UX. That is the
 * material this product exists to surface.
 *
 * The cost of the switch: the general index returns no `published_date` on any
 * result, so dates come from the article's own HTML instead — see
 * `published-date.ts`.
 */
export const TAVILY_TOPIC = "general";

/**
 * Deliberately much wider than the daily cron: professional articles keep their
 * value far longer than news events, so a guide published three weeks ago can
 * still be the most useful thing in a company's field this week.
 *
 * COUPLED TO `RECENCY_WINDOW_DAYS` (30) in `news-agent.ts`. This is the outer
 * window — what Tavily is asked for — and that one is the inner window, applied
 * to the real publication date read off each article's own page. This one
 * cannot be changed alone: narrow this to "week" while the inner window stays
 * at 30 and nothing new is admitted, because Tavily never returns it; widen
 * this while the inner window stays at 7 and every dated article in the new
 * 8–30-day range is searched for, fetched, and then discarded. Change both or
 * neither.
 *
 * Set to "month" because that is the window the probe actually validated: with
 * job domains excluded it returned Phrase, Webflow, Lilt and SimpleLocalize
 * writing substantively on the target topics. The week-windowed probe returned
 * job postings instead, and week-plus-exclusions was never observed live — so
 * "month" is the evidenced setting and "week" was the guess.
 *
 * The cost of the wider window is repetition, not spend: a rejected article is
 * recorded nowhere, so it is re-searched and re-fetched on every run it stays
 * inside the window — up to 30 days instead of 7. Tavily credits are unaffected
 * (they scale with MAX_TOPICS_PER_RUN, not with the window) and fetches stay
 * capped by MAX_CANDIDATES_PER_RUN, so the real harm is that repeats occupy
 * candidate slots new articles could have used. Watch the ratio of `skipped` to
 * `written` on the first few live runs; if repeats crowd out new material, the
 * fix is a rejected-article memory, not a narrower window.
 */
export const TAVILY_TIME_RANGE = "month";

/**
 * Job boards and search aggregators, excluded for different reasons and on
 * different evidence.
 *
 * The job boards are the measured half: the un-excluded week-windowed probe on
 * the general index returned Google Careers, Target and an edtech UX Writer
 * posting in its top three. Job postings match the topic vocabulary exactly
 * while carrying no editorial content at all.
 *
 * The aggregators are precautionary. `news.google.com` and `google.com` are
 * here because the `topic: "news"` probe returned Google News redirect URLs
 * instead of article links, which would collapse under `normalizeArticleUrl`
 * into one host and defeat `externalId` uniqueness. That was a symptom of a
 * configuration this file no longer uses — the general-index probes did not
 * return aggregator URLs — so this half is belt-and-braces against a
 * regression, not a response to anything currently observed.
 */
export const EXCLUDED_DOMAINS = [
  "careers.google.com",
  "corporate.target.com",
  "indeed.com",
  "glassdoor.com",
  "ziprecruiter.com",
  "lever.co",
  "greenhouse.io",
  "workday.com",
  "news.google.com",
  "google.com",
];

function parseDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function searchNews(
  query: string,
  deps: { fetchImpl?: TavilyFetch } = {}
): Promise<TavilyResult> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return { error: "no-api-key" };

  const fetchImpl = deps.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(TAVILY_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query,
        topic: TAVILY_TOPIC,
        // One credit per search. `advanced` costs two and buys deeper page
        // extraction we do not use — we fetch the article ourselves.
        search_depth: "basic",
        time_range: TAVILY_TIME_RANGE,
        exclude_domains: EXCLUDED_DOMAINS,
        max_results: TAVILY_MAX_RESULTS,
      }),
    });
  } catch {
    return { error: "request-failed" };
  }

  if (!response.ok) return { error: "request-failed" };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { error: "bad-response" };
  }

  const envelope = EnvelopeSchema.safeParse(payload);
  // Only a missing or non-array `results` is a bad response now. Anything
  // wrong with an individual result costs that result, not the search.
  if (!envelope.success) return { error: "bad-response" };

  const hits: NewsHit[] = [];
  for (const raw of envelope.data.results) {
    const parsed = ResultSchema.safeParse(raw);
    if (!parsed.success) continue;
    const r = parsed.data;

    // A result without a title or URL cannot become a signal: the title is
    // NOT NULL and the URL is the idempotency key. The scheme check is a
    // safety filter, not a tidy-up: `signals.url` is rendered straight into an
    // `<a href>`, so a `javascript:` or `data:` URL arriving from a search
    // result would be a stored XSS vector. It is also what `fetchPageText`
    // expects — anything else could not be fetched anyway.
    const title = r.title.trim();
    const url = r.url.trim();
    if (title.length === 0 || url.length === 0 || !/^https?:/i.test(url)) continue;

    hits.push({
      title,
      url,
      content: r.content ?? "",
      publishedAt: parseDate(r.published_date),
      score: r.score ?? null,
    });
  }

  return { hits, credits: CREDITS_PER_SEARCH };
}
