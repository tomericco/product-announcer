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

  it("sends the news topic, a bounded result count, and the bearer key", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(SAMPLE));

    await searchNews("localization tooling", { fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.tavily.com/search");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tvly-test-key");
    const body = JSON.parse(init.body as string);
    expect(body.query).toBe("localization tooling");
    // The news topic is what makes published_date available at all; a plain
    // search would leave every signal's occurredAt guessed.
    expect(body.topic).toBe("news");
    expect(body.search_depth).toBe("basic");
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
});
