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
    // No system prompt by default: a buyer types a question and sends nothing
    // else, and the prompt this replaced asked the model to cite its sources —
    // instructing the very behaviour the leaderboard counts.
    expect(body.instructions).toBeUndefined();
    // Search is opt-in here — without the tool the model answers from memory.
    expect(body.tools).toEqual([{ type: "web_search" }]);
    // The endpoint is strict: an unknown field anywhere is a 400, so the body
    // must carry nothing beyond these three keys. `instructions` is absent
    // because no system prompt is sent by default.
    expect(Object.keys(body).sort()).toEqual(["input", "model", "tools"]);
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
      costUsd: PERPLEXITY_COST_PER_CALL_USD,
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
      costUsd: PERPLEXITY_COST_PER_CALL_USD,
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
      costUsd: PERPLEXITY_COST_PER_CALL_USD,
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
      costUsd: PERPLEXITY_COST_PER_CALL_USD,
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
      costUsd: PERPLEXITY_COST_PER_CALL_USD,
    });
  });

  it("exposes itself as an EngineClient", () => {
    expect(perplexityEngine.id).toBe("perplexity");
    expect(perplexityEngine.label).toContain("API");
  });
});

describe("askPerplexity, the remaining error paths and extraction edges", () => {
  it("never calls out on a key that is only whitespace", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "   ");
    const fetchImpl = vi.fn();

    expect(await askPerplexity("x", { fetchImpl: fetchImpl as never })).toEqual({
      kind: "error",
      message: expect.stringContaining("PERPLEXITY_API_KEY"),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("turns a 401 and a 500 into errors carrying the status and the body", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");

    const unauthorized = vi.fn(async () => new Response("invalid api key", { status: 401 }));
    const result = await askPerplexity("x", { fetchImpl: unauthorized as never });
    expect(result).toEqual({ kind: "error", message: expect.stringContaining("401") });
    expect("kind" in result && result.message).toContain("invalid api key");

    const broken = vi.fn(async () => new Response("boom", { status: 500 }));
    expect(await askPerplexity("x", { fetchImpl: broken as never })).toEqual({
      kind: "error",
      message: expect.stringContaining("500"),
    });
  });

  it("turns an unparseable body into an error rather than an exception", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");

    const empty = vi.fn(async () => new Response("", { status: 200 }));
    expect(await askPerplexity("x", { fetchImpl: empty as never })).toEqual({
      kind: "error",
      message: expect.stringMatching(/unparseable/i),
    });

    const html = vi.fn(async () => new Response("<html>502</html>", { status: 200 }));
    expect(await askPerplexity("x", { fetchImpl: html as never })).toEqual({
      kind: "error",
      message: expect.stringMatching(/unparseable/i),
    });
  });

  it("sends the model override and falls back to the requested id when none comes back", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");
    vi.stubEnv("AI_VISIBILITY_PERPLEXITY_MODEL", "perplexity/sonar-pro");
    const fetchImpl = vi.fn(async () =>
      json({
        status: "completed",
        output: [
          { type: "search_results", results: [{ url: "https://a.example/1" }] },
          { type: "message", content: [{ type: "output_text", text: "An answer." }] },
        ],
      })
    );

    const result = await askPerplexity("x", { fetchImpl: fetchImpl as never });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).model).toBe("perplexity/sonar-pro");
    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    expect(result.modelId).toBe("perplexity/sonar-pro");
  });

  it("keeps a metered cost of zero instead of falling back to the estimate", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");
    // A free-tier or cached call really can meter zero. `||` here would silently
    // replace it with the estimate and over-bill the tenant's cap.
    const fetchImpl = vi.fn(async () => json({ ...ANSWER, usage: { cost: { total_cost: 0 } } }));

    const result = await askPerplexity("x", { fetchImpl: fetchImpl as never });

    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    expect(result.costUsd).toBe(0);
  });

  it("merges text, queries and sources across several output items", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");
    const fetchImpl = vi.fn(async () =>
      json({
        status: "completed",
        model: "perplexity/sonar",
        output: [
          {
            type: "search_results",
            queries: ["q1", "q2"],
            results: [{ url: "https://a.example/1" }, { url: "https://b.example/2" }],
          },
          {
            type: "search_results",
            queries: ["q2", "q3"],
            // Already seen: one source cited twice is one source.
            results: [{ url: "https://a.example/1" }, { url: "https://c.example/3" }],
          },
          {
            type: "message",
            content: [
              { type: "output_text", text: "First half. " },
              { type: "reasoning_text", text: "IGNORED" },
              { type: "output_text", text: "Second half." },
            ],
          },
        ],
      })
    );

    const result = await askPerplexity("x", { fetchImpl: fetchImpl as never });

    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    expect(result.text).toBe("First half. Second half.");
    expect(result.searchQueries).toEqual(["q1", "q2", "q3"]);
    expect(result.citations).toEqual([
      { url: "https://a.example/1", position: 1 },
      { url: "https://b.example/2", position: 2 },
      { url: "https://c.example/3", position: 3 },
    ]);
  });

  it("skips a source with no usable URL", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");
    const fetchImpl = vi.fn(async () =>
      json({
        status: "completed",
        model: "perplexity/sonar",
        output: [
          {
            type: "search_results",
            results: [{ id: 1, title: "no url" }, { id: 2, url: "" }, { id: 3, url: "https://a.example/1" }],
          },
          { type: "message", content: [{ type: "output_text", text: "An answer." }] },
        ],
      })
    );

    const result = await askPerplexity("x", { fetchImpl: fetchImpl as never });

    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    expect(result.citations).toEqual([{ url: "https://a.example/1", position: 1 }]);
  });
});

/**
 * Perplexity's request and response shapes here were derived from published
 * documentation — no PERPLEXITY_API_KEY was available to confirm them against a
 * live call. These tests therefore prove ROBUSTNESS, not CORRECTNESS: if the
 * real Agent API differs from what this client assumes, the parser must degrade
 * to `{kind:"error"}` or to a sourceless answer, never throw an exception out of
 * `ask()` and take the whole run slice with it. Passing these says nothing
 * about whether the assumed shape is right.
 */
describe("askPerplexity, when the real response shape is not what we assumed", () => {
  const cases: [string, unknown][] = [
    [
      "the retiring chat-completions shape, if /v1/agent proxied to it",
      {
        id: "x",
        model: "sonar",
        choices: [{ message: { role: "assistant", content: "An answer." } }],
        citations: ["https://a.example/1"],
      },
    ],
    [
      "citations under a top-level key rather than a search_results item",
      {
        status: "completed",
        model: "perplexity/sonar",
        search_results: [{ url: "https://a.example/1" }],
        output: [{ type: "message", content: [{ type: "output_text", text: "An answer." }] }],
      },
    ],
    [
      "the message text under a renamed part type",
      {
        status: "completed",
        model: "perplexity/sonar",
        output: [
          { type: "search_results", results: [{ url: "https://a.example/1" }] },
          { type: "message", content: [{ type: "text", text: "An answer." }] },
        ],
      },
    ],
    [
      "no output key at all",
      { status: "completed", model: "perplexity/sonar", response: { text: "An answer." } },
    ],
    [
      "a status this client has never heard of",
      { status: "queued", model: "perplexity/sonar" },
    ],
  ];

  it.each(cases)("degrades rather than throwing: %s", async (_label, body) => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");
    const fetchImpl = vi.fn(async () => json(body));

    const result = await askPerplexity("x", { fetchImpl: fetchImpl as never });

    // Either a non-answer we can see in the run report, or an answer with no
    // citations — never a thrown exception, and never a silent scored zero.
    if ("kind" in result) {
      expect(["error", "refused"]).toContain(result.kind);
      expect(result.message.length).toBeGreaterThan(0);
    } else {
      expect(result.citations).toEqual([]);
    }
  });
});

describe("askPerplexity, shapes that are not what the docs describe", () => {
  /**
   * Was a QA `it.fails` pin. `output` nested one level deeper — the single most
   * likely way a documentation-derived shape is wrong, and this client's shape
   * has never been checked against a real key — threw a TypeError out of
   * `ask()` instead of returning an EngineError, which would have taken the
   * whole run slice down with it.
   */
  it("does not throw when output items are nested one level deeper", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");
    const fetchImpl = vi.fn(async () =>
      json({
        status: "completed",
        model: "perplexity/sonar",
        output: { items: [{ type: "message", content: [{ type: "output_text", text: "a" }] }] },
      })
    );

    const result = await askPerplexity("x", { fetchImpl: fetchImpl as never });

    expect(result).toEqual({
      kind: "refused",
      message: expect.any(String),
      costUsd: PERPLEXITY_COST_PER_CALL_USD,
    });
  });

  it("does not throw when the body, or any list inside it, is the wrong type", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");

    const bodies = [
      null,
      "a string",
      42,
      { status: "completed", output: "nope" },
      { status: "completed", output: [null, 7] },
      { status: "completed", output: [{ type: "message", content: { text: "a" } }] },
      { status: "completed", output: [{ type: "search_results", results: "nope", queries: "no" }] },
    ];

    for (const body of bodies) {
      const fetchImpl = vi.fn(async () => json(body));
      const result = await askPerplexity("x", { fetchImpl: fetchImpl as never });
      expect("kind" in result).toBe(true);
      if (!("kind" in result)) return;
      expect(["error", "refused"]).toContain(result.kind);
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it("reports an unfinished run as an error, not as the model refusing", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");

    for (const status of ["in_progress", "queued"]) {
      const fetchImpl = vi.fn(async () => json({ status, model: "perplexity/sonar" }));

      // The distinction is the whole point: a refusal is a fact about the
      // model's answer, an unfinished run is a fact about our own plumbing,
      // and filing the second as the first misreports the engine.
      expect(await askPerplexity("x", { fetchImpl: fetchImpl as never })).toEqual({
        kind: "error",
        message: expect.stringContaining(status),
      });
    }
  });
});

describe("askPerplexity, what gets stored as raw", () => {
  it("drops the per-result snippets and leaves everything else alone", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");
    const fetchImpl = vi.fn(async () => json(ANSWER));

    const result = await askPerplexity("x", { fetchImpl: fetchImpl as never });

    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    const stored = JSON.stringify(result.raw);
    expect(stored).not.toContain("A short snippet.");
    expect(stored).not.toContain("snippet");
    // The evidence worth keeping survives: URLs, titles, the answer, the model.
    expect(stored).toContain("https://g2.com/categories/issue-tracking");
    expect(stored).toContain("Issue tracking");
    expect(stored).toContain("Linear and Acme are both strong.");
    expect(stored).toContain("perplexity/sonar");
  });

  it("does not invent keys on a response that had nothing to strip", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");
    const lean = {
      status: "completed",
      model: "perplexity/sonar",
      output: [
        { type: "search_results", queries: ["q"], results: [{ id: 1, url: "https://a.example/1" }] },
        { type: "message", content: [{ type: "output_text", text: "An answer." }] },
      ],
    };
    const fetchImpl = vi.fn(async () => json(lean));

    const result = await askPerplexity("x", { fetchImpl: fetchImpl as never });

    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    // `raw` is the evidence record: a response with nothing to remove must come
    // back through sanitising byte-for-byte, not reshaped.
    expect(result.raw).toEqual(lean);
  });
});
