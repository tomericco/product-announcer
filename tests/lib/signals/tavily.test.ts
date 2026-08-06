import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchNews, TAVILY_MAX_RESULTS } from "../../../src/lib/signals/tavily";

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const SAMPLE = {
  query: "localization tooling",
  results: [
    {
      title: "Acme ships AI translation memory",
      url: "https://news.example.com/acme-tm",
      content: "Acme announced a translation memory built on...",
      score: 0.91,
      published_date: "2026-08-04T09:00:00Z",
    },
  ],
  response_time: 1.2,
  usage: { credits: 1 },
  request_id: "req_1",
};

describe("searchNews", () => {
  const originalKey = process.env.TAVILY_API_KEY;

  beforeEach(() => {
    process.env.TAVILY_API_KEY = "tvly-test-key";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = originalKey;
  });

  it("returns hits with parsed publication dates", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(SAMPLE));

    const result = await searchNews("localization tooling", { fetchImpl });

    expect("hits" in result).toBe(true);
    if (!("hits" in result)) return;
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].title).toBe("Acme ships AI translation memory");
    expect(result.hits[0].url).toBe("https://news.example.com/acme-tm");
    expect(result.hits[0].publishedAt?.toISOString()).toBe("2026-08-04T09:00:00.000Z");
    expect(result.credits).toBe(1);
  });

  it("sends the general topic, a week window, domain exclusions, a bounded result count, and the bearer key", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(SAMPLE));

    await searchNews("localization tooling", { fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.tavily.com/search");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tvly-test-key");
    const body = JSON.parse(init.body as string);
    expect(body.query).toBe("localization tooling");
    expect(body.topic).toBe("general");
    expect(body.search_depth).toBe("basic");
    expect(body.time_range).toBe("month");
    expect(body.exclude_domains).toBeDefined();
    expect(body.max_results).toBe(TAVILY_MAX_RESULTS);
  });

  it("treats a missing or unparseable published_date as unknown, not as now", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({
        ...SAMPLE,
        results: [
          { title: "No date", url: "https://news.example.com/a", content: "x", score: 0.5 },
          {
            title: "Bad date",
            url: "https://news.example.com/b",
            content: "y",
            score: 0.5,
            published_date: "not a date",
          },
        ],
      })
    );

    const result = await searchNews("q", { fetchImpl });

    expect("hits" in result).toBe(true);
    if (!("hits" in result)) return;
    expect(result.hits[0].publishedAt).toBeNull();
    expect(result.hits[1].publishedAt).toBeNull();
  });

  it("drops results missing a title or url rather than writing empty signals", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({
        ...SAMPLE,
        results: [
          { title: "", url: "https://news.example.com/a", content: "x", score: 0.5 },
          { title: "Fine", url: "", content: "y", score: 0.5 },
          { title: "Good", url: "https://news.example.com/c", content: "z", score: 0.5 },
        ],
      })
    );

    const result = await searchNews("q", { fetchImpl });

    expect("hits" in result).toBe(true);
    if (!("hits" in result)) return;
    expect(result.hits.map((h) => h.url)).toEqual(["https://news.example.com/c"]);
  });

  it("drops results whose url is not http(s), since signals.url is rendered into an href", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({
        ...SAMPLE,
        results: [
          { title: "Hostile", url: "javascript:alert(1)", content: "x", score: 0.9 },
          { title: "Also hostile", url: "data:text/html,<script>alert(1)</script>", content: "y", score: 0.9 },
          { title: "Not fetchable", url: "ftp://files.example.com/a", content: "z", score: 0.9 },
          { title: "Fine", url: "http://news.example.com/plain", content: "w", score: 0.5 },
          { title: "Also fine", url: "https://news.example.com/secure", content: "v", score: 0.5 },
        ],
      })
    );

    const result = await searchNews("q", { fetchImpl });

    expect("hits" in result).toBe(true);
    if (!("hits" in result)) return;
    expect(result.hits.map((h) => h.url)).toEqual([
      "http://news.example.com/plain",
      "https://news.example.com/secure",
    ]);
  });

  it("reports a missing api key without calling the network", async () => {
    delete process.env.TAVILY_API_KEY;
    const fetchImpl = vi.fn();

    const result = await searchNews("q", { fetchImpl });

    expect(result).toEqual({ error: "no-api-key" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a non-2xx response as request-failed", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 429 }));

    const result = await searchNews("q", { fetchImpl });

    expect(result).toEqual({ error: "request-failed" });
  });

  it("reports a thrown fetch as request-failed rather than propagating", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("socket hang up"));

    const result = await searchNews("q", { fetchImpl });

    expect(result).toEqual({ error: "request-failed" });
  });

  it("reports a response whose shape does not match as bad-response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ nope: true }));

    const result = await searchNews("q", { fetchImpl });

    expect(result).toEqual({ error: "bad-response" });
  });

  it("reports an unparseable body as bad-response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("not json at all", { status: 200, headers: { "content-type": "application/json" } })
    );

    const result = await searchNews("q", { fetchImpl });

    expect(result).toEqual({ error: "bad-response" });
  });

  it("keeps Tavily's own relevance score for each hit", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(SAMPLE));

    const result = await searchNews("localization tooling", { fetchImpl });

    expect("hits" in result).toBe(true);
    if (!("hits" in result)) return;
    expect(result.hits[0].score).toBe(0.91);
  });

  it("reports an absent score as null rather than dropping the hit or faking a zero", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({
        ...SAMPLE,
        results: [{ title: "No score", url: "https://news.example.com/a", content: "x" }],
      })
    );

    const result = await searchNews("q", { fetchImpl });

    expect("hits" in result).toBe(true);
    if (!("hits" in result)) return;
    expect(result.hits).toHaveLength(1);
    // Null, not 0: the caller's floor keeps nulls and ranks them last. Zero
    // here would put every scoreless hit below TAVILY_SCORE_FLOOR, so an
    // upstream rename of `score` would silently empty the news agent.
    expect(result.hits[0].score).toBeNull();
  });

  it("survives a null published_date instead of failing the whole search", async () => {
    // Observed on live traffic: Tavily returns published_date: null for an
    // article whose date it could not determine. `z.string().optional()` allows
    // absent but NOT null, so one such result used to fail the entire parse —
    // 2 of 5 real searches came back bad-response because of this.
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({
        ...SAMPLE,
        results: [
          { title: "Dated", url: "https://news.example.com/a", content: "x", score: 0.4, published_date: "2026-08-04T09:00:00Z" },
          { title: "Undated", url: "https://news.example.com/b", content: "y", score: 0.3, published_date: null },
        ],
      })
    );

    const result = await searchNews("q", { fetchImpl });

    expect("hits" in result).toBe(true);
    if (!("hits" in result)) return;
    expect(result.hits).toHaveLength(2);
    expect(result.hits[1].publishedAt).toBeNull();
  });

  it("drops a single malformed result rather than losing the whole batch", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({
        ...SAMPLE,
        results: [
          { title: "Good one", url: "https://news.example.com/a", content: "x", score: 0.4 },
          { title: 12345, url: "https://news.example.com/b", content: "y", score: 0.3 },
          { title: "Good two", url: "https://news.example.com/c", content: "z", score: 0.2 },
        ],
      })
    );

    const result = await searchNews("q", { fetchImpl });

    expect("hits" in result).toBe(true);
    if (!("hits" in result)) return;
    expect(result.hits.map((h) => h.title)).toEqual(["Good one", "Good two"]);
  });

  it("tolerates a null content and a null score without dropping the hit", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({
        ...SAMPLE,
        results: [{ title: "Sparse", url: "https://news.example.com/a", content: null, score: null }],
      })
    );

    const result = await searchNews("q", { fetchImpl });

    expect("hits" in result).toBe(true);
    if (!("hits" in result)) return;
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].content).toBe("");
    expect(result.hits[0].score).toBeNull();
  });

  it("counts one credit per successful search, since Tavily reports no usage", async () => {
    // Live responses carry no `usage` object at all — the documented top-level
    // keys are query/follow_up_questions/answer/images/results/response_time/
    // request_id. Credits are therefore derived from Tavily's published
    // pricing for the search_depth we send, not read from the response.
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ results: [{ title: "A", url: "https://news.example.com/a", content: "x", score: 0.5 }] })
    );

    const result = await searchNews("q", { fetchImpl });

    expect("hits" in result).toBe(true);
    if (!("hits" in result)) return;
    expect(result.credits).toBe(1);
  });

  it("searches the general index, where professional writing actually lives", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(SAMPLE));

    await searchNews("design localization", { fetchImpl });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    // A live probe found topic:"news" returns Google News aggregator URLs and
    // near-zero relevance for this domain. See the plan's "Why each change".
    expect(body.topic).toBe("general");
    expect(body.time_range).toBe("month");
  });

  it("excludes job boards and aggregators, which otherwise dominate", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(SAMPLE));

    await searchNews("ux content management", { fetchImpl });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    // Without this the top three results were Google Careers, Target and an
    // edtech UX Writer posting.
    expect(body.exclude_domains).toContain("careers.google.com");
    expect(body.exclude_domains).toContain("indeed.com");
    expect(body.exclude_domains).toContain("news.google.com");
  });

  it("still yields hits when the general index omits published_date", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({
        results: [{ title: "A guide", url: "https://phrase.com/blog/guide", content: "x", score: 0.78 }],
      })
    );

    const result = await searchNews("q", { fetchImpl });

    expect("hits" in result).toBe(true);
    if (!("hits" in result)) return;
    expect(result.hits).toHaveLength(1);
    // Every general-index result is undated. Task 3 reads the date off the page.
    expect(result.hits[0].publishedAt).toBeNull();
  });

});
