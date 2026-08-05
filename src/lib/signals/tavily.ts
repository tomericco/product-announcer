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
        // The news topic is what makes `published_date` available. Without it
        // every signal's occurredAt would be first-seen time, and spec 5's
        // decay ranking would read a week-old article as breaking.
        topic: "news",
        // One credit per search. `advanced` costs two and buys deeper page
        // extraction we do not use — we fetch the article ourselves.
        search_depth: "basic",
        // Tied to the cron cadence: the sweep runs daily, so a day's window
        // covers everything published since the last run with no overlap.
        // A wider window would keep re-surfacing articles the previous runs
        // already judged — an article scored below the floor is dropped
        // without a record, so nothing can skip it, and a week's window means
        // re-fetching and re-scoring it on seven consecutive days. Do not
        // widen this without either changing the cron cadence to match or
        // giving rejected articles somewhere to be remembered.
        time_range: "day",
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
