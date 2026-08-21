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

// The Agent API envelope, which replaces Sonar chat-completions (retiring
// 2026-09-27). Built from Perplexity's documented response shape: `output` is a
// list of typed items, citations live on a `search_results` item, and there is
// no top-level `citations` array any more.
const ANSWER = {
  id: "resp_18690c07",
  object: "response",
  status: "completed",
  error: null,
  incomplete_details: null,
  model: "perplexity/sonar",
  output: [
    {
      type: "search_results",
      queries: ["best issue trackers", "issue tracker startups"],
      results: [
        {
          id: 1,
          url: "https://g2.com/categories/issue-tracking",
          title: "Issue tracking",
          snippet: "A short snippet.",
        },
        { id: 2, url: "https://acme.com/pricing", title: "Pricing", snippet: "Another snippet." },
      ],
    },
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        { type: "output_text", text: "Linear and Acme are both strong.", annotations: [] },
      ],
    },
  ],
  usage: { input_tokens: 1200, output_tokens: 300, cost: { total_cost: 0.00355 } },
};

describe("askPerplexity", () => {
  it("posts to the Agent API, not the retiring chat-completions endpoint", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");
    const fetchImpl = vi.fn(async () => json(ANSWER));

    await askPerplexity("best issue trackers for startups", { fetchImpl: fetchImpl as never });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.perplexity.ai/v1/agent");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer pplx-test");
    const body = JSON.parse(init.body as string);
    // Provider-prefixed slug: a bare "sonar" is not a valid Agent API model id.
    expect(body.model).toBe("perplexity/sonar");
    expect(body.input).toBe("best issue trackers for startups");
    expect(typeof body.instructions).toBe("string");
    // Search is opt-in here — without the tool the model answers from memory.
    expect(body.tools).toEqual([{ type: "web_search" }]);
    // The endpoint is strict: an unknown field anywhere is a 400, so the body
    // must carry nothing beyond these four keys.
    expect(Object.keys(body).sort()).toEqual(["input", "instructions", "model", "tools"]);
  });

  it("reads the answer, the citations and the queries out of the output items", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");
    const fetchImpl = vi.fn(async () => json(ANSWER));

    const result = await askPerplexity("x", { fetchImpl: fetchImpl as never });

    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    expect(result.text).toBe("Linear and Acme are both strong.");
    expect(result.modelId).toBe("perplexity/sonar");
    expect(result.citations).toEqual([
      { url: "https://g2.com/categories/issue-tracking", position: 1 },
      { url: "https://acme.com/pricing", position: 2 },
    ]);
    expect(result.searchUsed).toBe(true);
    // The Agent API DOES report the queries it issued; Sonar did not.
    expect(result.searchQueries).toEqual(["best issue trackers", "issue tracker startups"]);
    // Metered cost from the response beats the flat estimate.
    expect(result.costUsd).toBe(0.00355);
  });

  it("falls back to the flat estimate when the response meters no cost", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");
    const fetchImpl = vi.fn(async () => json({ ...ANSWER, usage: undefined }));

    const result = await askPerplexity("x", { fetchImpl: fetchImpl as never });

    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    expect(result.costUsd).toBe(PERPLEXITY_COST_PER_CALL_USD);
  });

  it("dedupes repeated sources and keeps first-appearance order", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");
    const fetchImpl = vi.fn(async () =>
      json({
        status: "completed",
        model: "perplexity/sonar",
        output: [
          {
            type: "search_results",
            queries: [],
            results: [
              { id: 1, url: "https://acme.com/a" },
              { id: 2, url: "https://acme.com/a" },
              { id: 3, url: "https://acme.com/b" },
            ],
          },
          { type: "message", content: [{ type: "output_text", text: "An answer." }] },
        ],
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

  it("catches a failed or truncated run that still returned HTTP 200", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");

    // A failed run is a 200 with a status field — branching on the HTTP code
    // alone would file this as an ordinary empty answer.
    const failed = vi.fn(async () =>
      json({ status: "failed", model: "perplexity/sonar", error: { message: "upstream error" } })
    );
    expect(await askPerplexity("x", { fetchImpl: failed as never })).toEqual({
      kind: "error",
      message: expect.stringContaining("upstream error"),
    });

    const truncated = vi.fn(async () =>
      json({
        status: "incomplete",
        model: "perplexity/sonar",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          {
            type: "search_results",
            queries: ["q"],
            results: [{ id: 1, url: "https://acme.com/a" }],
          },
          { type: "message", content: [{ type: "output_text", text: "The best options are" }] },
        ],
      })
    );
    expect(await askPerplexity("x", { fetchImpl: truncated as never })).toEqual({
      kind: "error",
      message: expect.stringContaining("max_output_tokens"),
    });
  });

  it("refuses an empty answer and an answer with no sources at all", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");

    const empty = vi.fn(async () =>
      json({
        status: "completed",
        model: "perplexity/sonar",
        output: [{ type: "message", content: [{ type: "output_text", text: "  " }] }],
      })
    );
    expect(await askPerplexity("x", { fetchImpl: empty as never })).toEqual({
      kind: "refused",
      message: expect.any(String),
    });

    // Documented as possible even with search forced, and it can arrive either
    // as an empty results array or with no search_results item at all.
    const emptyResults = vi.fn(async () =>
      json({
        status: "completed",
        model: "perplexity/sonar",
        output: [
          { type: "search_results", queries: ["q"], results: [] },
          { type: "message", content: [{ type: "output_text", text: "From memory." }] },
        ],
      })
    );
    expect(await askPerplexity("x", { fetchImpl: emptyResults as never })).toEqual({
      kind: "refused",
      message: expect.stringMatching(/search|source/i),
    });

    const noResultsItem = vi.fn(async () =>
      json({
        status: "completed",
        model: "perplexity/sonar",
        output: [{ type: "message", content: [{ type: "output_text", text: "From memory." }] }],
      })
    );
    expect(await askPerplexity("x", { fetchImpl: noResultsItem as never })).toEqual({
      kind: "refused",
      message: expect.stringMatching(/search|source/i),
    });
  });

  it("exposes itself as an EngineClient", () => {
    expect(perplexityEngine.id).toBe("perplexity");
    expect(perplexityEngine.label).toContain("API");
  });
});
