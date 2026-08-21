import { describe, it, expect, vi, afterEach } from "vitest";
import {
  askPerplexity,
  perplexityEngine,
  PERPLEXITY_COST_PER_CALL_USD,
} from "../../../../src/lib/ai-visibility/engines/perplexity";

afterEach(() => {
  vi.unstubAllEnvs();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ANSWER = {
  model: "sonar",
  choices: [{ message: { role: "assistant", content: "Linear and Acme are both strong." } }],
  search_results: [
    { url: "https://g2.com/categories/issue-tracking", title: "Issue tracking" },
    { url: "https://acme.com/pricing", title: "Pricing" },
  ],
  citations: ["https://g2.com/categories/issue-tracking", "https://acme.com/pricing"],
};

describe("askPerplexity", () => {
  it("posts a chat completion to the Sonar endpoint", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");
    const fetchImpl = vi.fn(async () => json(ANSWER));

    await askPerplexity("best issue trackers for startups", { fetchImpl: fetchImpl as never });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.perplexity.ai/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer pplx-test");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("sonar");
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1]).toEqual({
      role: "user",
      content: "best issue trackers for startups",
    });
  });

  it("takes citations from search_results in order", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");
    const fetchImpl = vi.fn(async () => json(ANSWER));

    const result = await askPerplexity("x", { fetchImpl: fetchImpl as never });

    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    expect(result.text).toBe("Linear and Acme are both strong.");
    expect(result.modelId).toBe("sonar");
    expect(result.citations).toEqual([
      { url: "https://g2.com/categories/issue-tracking", position: 1 },
      { url: "https://acme.com/pricing", position: 2 },
    ]);
    expect(result.searchUsed).toBe(true);
    // Sonar does not expose the queries it issued.
    expect(result.searchQueries).toEqual([]);
    expect(result.costUsd).toBe(PERPLEXITY_COST_PER_CALL_USD);
  });

  it("falls back to the flat citations array when search_results is absent", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");
    const fetchImpl = vi.fn(async () =>
      json({
        model: "sonar",
        choices: [{ message: { content: "An answer." } }],
        citations: ["https://acme.com/a", "https://acme.com/a", "https://acme.com/b"],
      })
    );

    const result = await askPerplexity("x", { fetchImpl: fetchImpl as never });

    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    expect(result.citations).toEqual([
      { url: "https://acme.com/a", position: 1 },
      { url: "https://acme.com/b", position: 2 },
    ]);
  });

  it("reports a missing key, a 429 and a transport failure as errors", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "");
    const unused = vi.fn();
    expect(await askPerplexity("x", { fetchImpl: unused as never })).toEqual({
      kind: "error",
      message: expect.stringContaining("PERPLEXITY_API_KEY"),
    });
    expect(unused).not.toHaveBeenCalled();

    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");
    const rateLimited = vi.fn(async () => new Response("slow down", { status: 429 }));
    expect(await askPerplexity("x", { fetchImpl: rateLimited as never })).toEqual({
      kind: "error",
      message: expect.stringContaining("429"),
    });

    const thrower = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    expect(await askPerplexity("x", { fetchImpl: thrower as never })).toEqual({
      kind: "error",
      message: expect.stringContaining("socket hang up"),
    });
  });

  it("refuses an empty answer and an answer with no sources at all", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");

    const empty = vi.fn(async () =>
      json({ model: "sonar", choices: [{ message: { content: "  " } }] })
    );
    expect(await askPerplexity("x", { fetchImpl: empty as never })).toEqual({
      kind: "refused",
      message: expect.any(String),
    });

    const unsourced = vi.fn(async () =>
      json({ model: "sonar", choices: [{ message: { content: "From memory." } }], citations: [] })
    );
    expect(await askPerplexity("x", { fetchImpl: unsourced as never })).toEqual({
      kind: "refused",
      message: expect.stringMatching(/search|source/i),
    });
  });

  it("exposes itself as an EngineClient", () => {
    expect(perplexityEngine.id).toBe("perplexity");
    expect(perplexityEngine.label).toContain("API");
  });
});
