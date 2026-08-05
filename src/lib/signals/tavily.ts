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
};

export type TavilyError = "no-api-key" | "request-failed" | "bad-response";

export type TavilyResult = { hits: NewsHit[]; credits: number } | { error: TavilyError };

export type TavilyFetch = typeof fetch;

const ResponseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      content: z.string().default(""),
      published_date: z.string().optional(),
    })
  ),
  usage: z.object({ credits: z.number() }).optional(),
});

function parseDate(raw: string | undefined): Date | null {
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
        time_range: "week",
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

  const parsed = ResponseSchema.safeParse(payload);
  if (!parsed.success) return { error: "bad-response" };

  const hits: NewsHit[] = parsed.data.results
    // A result without a title or URL cannot become a signal: the title is
    // NOT NULL and the URL is the idempotency key.
    .filter((r) => r.title.trim().length > 0 && r.url.trim().length > 0)
    .map((r) => ({
      title: r.title.trim(),
      url: r.url.trim(),
      content: r.content,
      publishedAt: parseDate(r.published_date),
    }));

  return { hits, credits: parsed.data.usage?.credits ?? 0 };
}
