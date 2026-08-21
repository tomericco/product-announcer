import { describe, it, expect, vi, afterEach } from "vitest";
import {
  askGemini,
  geminiEngine,
  GEMINI_COST_PER_CALL_USD,
} from "../../../../src/lib/ai-visibility/engines/gemini";

afterEach(() => {
  vi.unstubAllEnvs();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const REDIRECT_A = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA";
const REDIRECT_B = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB";

const ANSWER = {
  modelVersion: "gemini-3-pro-002",
  candidates: [
    {
      content: { parts: [{ text: "Linear and " }, { text: "Acme are both strong." }] },
      finishReason: "STOP",
      groundingMetadata: {
        webSearchQueries: ["best issue trackers", "issue tracker startups"],
        groundingChunks: [
          { web: { uri: REDIRECT_A, title: "g2.com" } },
          { web: { uri: REDIRECT_B, title: "acme.com" } },
          { web: { uri: REDIRECT_A, title: "g2.com" } },
          { retrievedContext: { uri: "https://ignored.example" } },
        ],
      },
    },
  ],
};

describe("askGemini", () => {
  it("posts to generateContent with google_search grounding", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gem-test");
    const fetchImpl = vi.fn(async () => json(ANSWER));

    await askGemini("best issue trackers for startups", { fetchImpl: fetchImpl as never });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent"
    );
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("gem-test");
    const body = JSON.parse(init.body as string);
    expect(body.tools).toEqual([{ google_search: {} }]);
    expect(body.contents[0].parts[0].text).toBe("best issue trackers for startups");
    expect(body.systemInstruction.parts[0].text).toEqual(expect.any(String));
  });

  it("joins the parts and keeps the grounding URIs in order, unresolved", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gem-test");
    const fetchImpl = vi.fn(async () => json(ANSWER));

    const result = await askGemini("x", { fetchImpl: fetchImpl as never });

    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    expect(result.text).toBe("Linear and Acme are both strong.");
    expect(result.modelId).toBe("gemini-3-pro-002");
    expect(result.searchUsed).toBe(true);
    expect(result.searchQueries).toEqual(["best issue trackers", "issue tracker startups"]);
    // Stored exactly as Gemini returned them; extraction resolves the 302s.
    expect(result.citations).toEqual([
      { url: REDIRECT_A, position: 1 },
      { url: REDIRECT_B, position: 2 },
    ]);
    expect(result.costUsd).toBe(GEMINI_COST_PER_CALL_USD);
  });

  it("reports a missing key, a 429 and a transport failure as errors", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const unused = vi.fn();
    expect(await askGemini("x", { fetchImpl: unused as never })).toEqual({
      kind: "error",
      message: expect.stringContaining("GEMINI_API_KEY"),
    });
    expect(unused).not.toHaveBeenCalled();

    vi.stubEnv("GEMINI_API_KEY", "gem-test");
    const rateLimited = vi.fn(async () => new Response("quota", { status: 429 }));
    expect(await askGemini("x", { fetchImpl: rateLimited as never })).toEqual({
      kind: "error",
      message: expect.stringContaining("429"),
    });

    const thrower = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    expect(await askGemini("x", { fetchImpl: thrower as never })).toEqual({
      kind: "error",
      message: expect.stringContaining("socket hang up"),
    });
  });

  it("refuses a blocked, empty or ungrounded answer", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gem-test");

    const blocked = vi.fn(async () =>
      json({ modelVersion: "m", candidates: [{ finishReason: "SAFETY", content: { parts: [] } }] })
    );
    expect(await askGemini("x", { fetchImpl: blocked as never })).toEqual({
      kind: "refused",
      message: expect.any(String),
    });

    const ungrounded = vi.fn(async () =>
      json({ modelVersion: "m", candidates: [{ content: { parts: [{ text: "From memory." }] } }] })
    );
    expect(await askGemini("x", { fetchImpl: ungrounded as never })).toEqual({
      kind: "refused",
      message: expect.stringMatching(/search|ground/i),
    });
  });

  it("treats a truncated answer as an error, not as an answer", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gem-test");
    const truncated = vi.fn(async () =>
      json({
        modelVersion: "gemini-3.7-flash",
        candidates: [
          {
            content: { parts: [{ text: "The strongest options are Linear, Jira and" }] },
            finishReason: "MAX_TOKENS",
            groundingMetadata: {
              webSearchQueries: ["best issue trackers"],
              groundingChunks: [{ web: { uri: REDIRECT_A, title: "g2.com" } }],
            },
          },
        ],
      })
    );

    expect(await askGemini("x", { fetchImpl: truncated as never })).toEqual({
      kind: "error",
      message: expect.stringContaining("MAX_TOKENS"),
    });
  });

  it("exposes itself as an EngineClient", () => {
    expect(geminiEngine.id).toBe("gemini");
    expect(geminiEngine.label).toContain("API");
  });
});

describe("askGemini, the remaining error paths and extraction edges", () => {
  it("never calls out on a key that is only whitespace", async () => {
    vi.stubEnv("GEMINI_API_KEY", "   ");
    const fetchImpl = vi.fn();

    expect(await askGemini("x", { fetchImpl: fetchImpl as never })).toEqual({
      kind: "error",
      message: expect.stringContaining("GEMINI_API_KEY"),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the key out of the URL, where it would end up in a log line", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gem-secret");
    const fetchImpl = vi.fn(async () => json(ANSWER));

    await askGemini("x", { fetchImpl: fetchImpl as never });

    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain("gem-secret");
  });

  it("turns a 401, a 403 and a 500 into errors carrying the status and the body", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gem-test");

    const unauthorized = vi.fn(async () => new Response("API key not valid", { status: 401 }));
    const result = await askGemini("x", { fetchImpl: unauthorized as never });
    expect(result).toEqual({ kind: "error", message: expect.stringContaining("401") });
    expect("kind" in result && result.message).toContain("API key not valid");

    const forbidden = vi.fn(async () => new Response("no access", { status: 403 }));
    expect(await askGemini("x", { fetchImpl: forbidden as never })).toEqual({
      kind: "error",
      message: expect.stringContaining("403"),
    });

    // The shape a withdrawn model id produces — the exact failure the review
    // caught, and the one that must read as a coverage gap rather than a zero.
    const notFound = vi.fn(
      async () => new Response('{"error":{"message":"models/x is not found"}}', { status: 404 })
    );
    expect(await askGemini("x", { fetchImpl: notFound as never })).toEqual({
      kind: "error",
      message: expect.stringContaining("404"),
    });

    const broken = vi.fn(async () => new Response("boom", { status: 500 }));
    expect(await askGemini("x", { fetchImpl: broken as never })).toEqual({
      kind: "error",
      message: expect.stringContaining("500"),
    });
  });

  it("turns an unparseable body into an error rather than an exception", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gem-test");

    const empty = vi.fn(async () => new Response("", { status: 200 }));
    expect(await askGemini("x", { fetchImpl: empty as never })).toEqual({
      kind: "error",
      message: expect.stringMatching(/unparseable/i),
    });

    const html = vi.fn(async () => new Response("<html>502</html>", { status: 200 }));
    expect(await askGemini("x", { fetchImpl: html as never })).toEqual({
      kind: "error",
      message: expect.stringMatching(/unparseable/i),
    });
  });

  it("puts the model override in the URL and falls back to it for modelId", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gem-test");
    vi.stubEnv("AI_VISIBILITY_GEMINI_MODEL", "gemini-4-flash");
    const fetchImpl = vi.fn(async () =>
      json({
        candidates: [
          {
            content: { parts: [{ text: "An answer." }] },
            finishReason: "STOP",
            groundingMetadata: { webSearchQueries: ["q"] },
          },
        ],
      })
    );

    const result = await askGemini("x", { fetchImpl: fetchImpl as never });

    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-flash:generateContent"
    );
    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    // No `modelVersion` came back, so the id we asked for is what gets stored.
    expect(result.modelId).toBe("gemini-4-flash");
  });

  it("refuses when there is no candidate to read at all", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gem-test");

    for (const body of [{ modelVersion: "m" }, { modelVersion: "m", candidates: [] }]) {
      const fetchImpl = vi.fn(async () => json(body));
      expect(await askGemini("x", { fetchImpl: fetchImpl as never })).toEqual({
        kind: "refused",
        message: expect.stringMatching(/candidate/i),
      });
    }
  });

  it("counts the answer as grounded on queries alone or on chunks alone", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gem-test");

    // Grounding metadata can report the searches without surfacing chunks…
    const queriesOnly = vi.fn(async () =>
      json({
        modelVersion: "m",
        candidates: [
          {
            content: { parts: [{ text: "An answer." }] },
            finishReason: "STOP",
            groundingMetadata: { webSearchQueries: ["q"] },
          },
        ],
      })
    );
    const a = await askGemini("x", { fetchImpl: queriesOnly as never });
    expect("kind" in a).toBe(false);
    if ("kind" in a) return;
    expect(a.searchUsed).toBe(true);
    expect(a.citations).toEqual([]);

    // …or surface chunks without echoing the queries.
    const chunksOnly = vi.fn(async () =>
      json({
        modelVersion: "m",
        candidates: [
          {
            content: { parts: [{ text: "An answer." }] },
            finishReason: "STOP",
            groundingMetadata: { groundingChunks: [{ web: { uri: REDIRECT_A } }] },
          },
        ],
      })
    );
    const b = await askGemini("x", { fetchImpl: chunksOnly as never });
    expect("kind" in b).toBe(false);
    if ("kind" in b) return;
    expect(b.searchUsed).toBe(true);
    expect(b.searchQueries).toEqual([]);
    expect(b.citations).toEqual([{ url: REDIRECT_A, position: 1 }]);
  });

  it("drops queries and chunks that carry nothing usable", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gem-test");
    const fetchImpl = vi.fn(async () =>
      json({
        modelVersion: "m",
        candidates: [
          {
            content: { parts: [{ text: "An answer." }, {}] },
            finishReason: "STOP",
            groundingMetadata: {
              webSearchQueries: ["", "real query"],
              groundingChunks: [{}, { web: {} }, { web: { uri: "" } }, { web: { uri: REDIRECT_B } }],
            },
          },
        ],
      })
    );

    const result = await askGemini("x", { fetchImpl: fetchImpl as never });

    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    expect(result.text).toBe("An answer.");
    expect(result.searchQueries).toEqual(["real query"]);
    expect(result.citations).toEqual([{ url: REDIRECT_B, position: 1 }]);
  });

  it("still returns a grounded answer that finished on a non-STOP reason other than MAX_TOKENS", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gem-test");
    // Deliberate: only truncation invalidates the measurement. A finishReason
    // we do not recognise, on an answer that has text and grounding, is still
    // an answer — treating it as an error would throw away real samples.
    const fetchImpl = vi.fn(async () =>
      json({
        modelVersion: "m",
        candidates: [
          {
            content: { parts: [{ text: "An answer." }] },
            finishReason: "RECITATION",
            groundingMetadata: { webSearchQueries: ["q"] },
          },
        ],
      })
    );

    const result = await askGemini("x", { fetchImpl: fetchImpl as never });

    expect("kind" in result).toBe(false);
  });
});

/**
 * Gemini's request and response shapes here were derived from published
 * documentation — no GEMINI_API_KEY was available to confirm them against a
 * live call. These tests therefore prove ROBUSTNESS, not CORRECTNESS: if the
 * real grounded `generateContent` response differs from what this client
 * assumes, the parser must degrade to `{kind:"error"}` / `{kind:"refused"}` or
 * to an answer with zero citations, never throw out of `ask()`. Passing these
 * says nothing about whether the assumed shape is right.
 */
describe("askGemini, when the real response shape is not what we assumed", () => {
  const cases: [string, unknown][] = [
    [
      "grounding metadata under the REST snake_case spelling",
      {
        modelVersion: "m",
        candidates: [
          {
            content: { parts: [{ text: "An answer." }] },
            finishReason: "STOP",
            grounding_metadata: {
              grounding_chunks: [{ web: { uri: "https://a.example/1" } }],
              web_search_queries: ["q"],
            },
          },
        ],
      },
    ],
    [
      "citations under groundingSupports rather than groundingChunks",
      {
        modelVersion: "m",
        candidates: [
          {
            content: { parts: [{ text: "An answer." }] },
            finishReason: "STOP",
            groundingMetadata: {
              groundingSupports: [{ web: { uri: "https://a.example/1" } }],
            },
          },
        ],
      },
    ],
    [
      "a chunk whose URL sits under a renamed key",
      {
        modelVersion: "m",
        candidates: [
          {
            content: { parts: [{ text: "An answer." }] },
            groundingMetadata: {
              webSearchQueries: ["q"],
              groundingChunks: [{ web: { url: "https://a.example/1" } }, { source: { uri: "x" } }],
            },
          },
        ],
      },
    ],
    [
      "the answer text one level shallower than expected",
      { modelVersion: "m", candidates: [{ text: "An answer.", finishReason: "STOP" }] },
    ],
    [
      "candidates as a single object rather than a list",
      {
        modelVersion: "m",
        candidates: { content: { parts: [{ text: "An answer." }] } },
      },
    ],
    ["an empty object where a response was expected", {}],
  ];

  it.each(cases)("degrades rather than throwing: %s", async (_label, body) => {
    vi.stubEnv("GEMINI_API_KEY", "gem-test");
    const fetchImpl = vi.fn(async () => json(body));

    const result = await askGemini("x", { fetchImpl: fetchImpl as never });

    if ("kind" in result) {
      expect(["error", "refused"]).toContain(result.kind);
      expect(result.message.length).toBeGreaterThan(0);
    } else {
      expect(result.citations).toEqual([]);
    }
  });
});

/**
 * OPEN DEFECT, pinned rather than hidden — the Gemini twin of the Perplexity
 * one. `it.fails` asserts these still throw.
 *
 * `(candidate.content?.parts ?? []).map(...)` and `for (const chunk of
 * grounding?.groundingChunks ?? [])` both assume a list. A response that puts an
 * object there — a plausible way an unverified shape is wrong — throws a
 * TypeError straight out of `ask()` instead of returning an EngineError,
 * breaking the `EngineClient` contract.
 *
 * The fix is an `Array.isArray` guard at each site in
 * `src/lib/ai-visibility/engines/gemini.ts`. When it lands these start PASSING,
 * which makes `it.fails` report them as failing — delete this block then.
 */
describe("askGemini, known unguarded shapes", () => {
  it.fails("should not throw when content.parts is an object", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gem-test");
    const fetchImpl = vi.fn(async () =>
      json({ modelVersion: "m", candidates: [{ content: { parts: { text: "An answer." } } }] })
    );

    expect("kind" in (await askGemini("x", { fetchImpl: fetchImpl as never }))).toBe(true);
  });

  it.fails("should not throw when groundingChunks is an object", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gem-test");
    const fetchImpl = vi.fn(async () =>
      json({
        modelVersion: "m",
        candidates: [
          {
            content: { parts: [{ text: "An answer." }] },
            groundingMetadata: { groundingChunks: { web: { uri: "https://a.example/1" } } },
          },
        ],
      })
    );

    expect("kind" in (await askGemini("x", { fetchImpl: fetchImpl as never }))).toBe(true);
  });
});
