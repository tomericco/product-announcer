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
    // No system prompt by default: a buyer types a question and sends nothing
    // else, and the prompt this replaced asked the model to cite its sources —
    // instructing the very behaviour the leaderboard counts.
    expect(body.systemInstruction).toBeUndefined();
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
      // Retryable: a quota error clears, and the sample is asked again.
      retryable: true,
    });

    const thrower = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    expect(await askGemini("x", { fetchImpl: thrower as never })).toEqual({
      kind: "error",
      message: expect.stringContaining("socket hang up"),
      retryable: true,
    });
  });

  it("refuses a blocked or empty answer", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gem-test");

    const blocked = vi.fn(async () =>
      json({ modelVersion: "m", candidates: [{ finishReason: "SAFETY", content: { parts: [] } }] })
    );
    expect(await askGemini("x", { fetchImpl: blocked as never })).toEqual({
      kind: "refused",
      message: expect.any(String),
      costUsd: GEMINI_COST_PER_CALL_USD,
    });
  });

  it("returns an ungrounded answer rather than refusing it", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gem-test");

    // Gemini declines to ground on discovery, alternatives and how-to prompts —
    // 18 of a 30-prompt set. Dropping those made a Gemini signal impossible on
    // exactly the intents this feature exists for.
    const ungrounded = vi.fn(async () =>
      json({ modelVersion: "m", candidates: [{ content: { parts: [{ text: "From memory." }] } }] })
    );
    const result = await askGemini("x", { fetchImpl: ungrounded as never });

    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    expect(result.text).toBe("From memory.");
    expect(result.searchUsed).toBe(false);
    expect(result.citations).toEqual([]);
    expect(result.searchQueries).toEqual([]);
    expect(result.costUsd).toBe(GEMINI_COST_PER_CALL_USD);
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
      costUsd: GEMINI_COST_PER_CALL_USD,
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
      retryable: true,
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

describe("askGemini, shapes that are not what the docs describe", () => {
  /**
   * These were QA `it.fails` pins: an unverified shape guessed wrong threw a
   * TypeError straight out of `ask()`, breaking the `EngineAnswer | EngineError`
   * contract. Now guarded, so they are ordinary assertions — and they matter
   * most here, since no Gemini call has ever been made against a real key.
   */
  it("does not throw when content.parts is an object", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gem-test");
    const fetchImpl = vi.fn(async () =>
      json({ modelVersion: "m", candidates: [{ content: { parts: { text: "An answer." } } }] })
    );

    const result = await askGemini("x", { fetchImpl: fetchImpl as never });

    // No text could be read out of an object-shaped `parts`, so this is a
    // reported non-answer rather than an exception.
    expect(result).toEqual({
      kind: "refused",
      message: expect.any(String),
      costUsd: GEMINI_COST_PER_CALL_USD,
    });
  });

  it("reports a grounding shape it cannot read as an error, not as an ungrounded answer", async () => {
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

    const result = await askGemini("x", { fetchImpl: fetchImpl as never });

    // Still does not throw — but it must not pass as "answered from memory"
    // either. Gemini legitimately declines to search on most discovery
    // prompts, so a shape we misread would hide inside that and silently zero
    // this engine's citation rate. Grounding metadata that yields neither a
    // query nor a chunk means we are reading the wrong keys.
    expect("kind" in result).toBe(true);
    if (!("kind" in result)) return;
    expect(result.kind).toBe("error");
    expect(result.message).toMatch(/could not read/i);
    // The keys are named so the fix does not need a repro.
    expect(result.message).toContain("groundingChunks");
  });

  it("does not throw when candidates or the body itself is the wrong type", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gem-test");

    for (const body of [null, "a string", 42, [], { candidates: "nope" }, { candidates: [null] }]) {
      const fetchImpl = vi.fn(async () => json(body));
      const result = await askGemini("x", { fetchImpl: fetchImpl as never });
      expect("kind" in result).toBe(true);
      if (!("kind" in result)) return;
      expect(["error", "refused"]).toContain(result.kind);
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it("does not throw when webSearchQueries is not a list", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gem-test");
    const fetchImpl = vi.fn(async () =>
      json({
        modelVersion: "m",
        candidates: [
          {
            content: { parts: [{ text: "An answer." }] },
            groundingMetadata: {
              webSearchQueries: "best issue trackers",
              groundingChunks: [{ web: { uri: "https://a.example/1" } }],
            },
          },
        ],
      })
    );

    const result = await askGemini("x", { fetchImpl: fetchImpl as never });

    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    expect(result.searchQueries).toEqual([]);
    expect(result.citations).toEqual([{ url: "https://a.example/1", position: 1 }]);
  });
});

describe("askGemini, what gets stored as raw", () => {
  it("drops the search-suggestions widget markup and the thought blobs", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gem-test");
    const fetchImpl = vi.fn(async () =>
      json({
        modelVersion: "gemini-3.7-flash",
        candidates: [
          {
            content: {
              parts: [{ text: "An answer.", thoughtSignature: "Cs4BAcu-opaque-blob" }],
            },
            groundingMetadata: {
              webSearchQueries: ["best issue trackers"],
              groundingChunks: [{ web: { uri: REDIRECT_A, title: "g2.com" } }],
              searchEntryPoint: {
                renderedContent: "<style>.container{padding:8px}</style><div>chips</div>",
              },
            },
          },
        ],
      })
    );

    const result = await askGemini("x", { fetchImpl: fetchImpl as never });

    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    const stored = JSON.stringify(result.raw);
    expect(stored).not.toContain("Cs4BAcu-opaque-blob");
    expect(stored).not.toContain("renderedContent");
    expect(stored).not.toContain("<style>");
    // What the record is for is still in it.
    expect(stored).toContain("An answer.");
    expect(stored).toContain(REDIRECT_A);
    expect(stored).toContain("best issue trackers");
  });

  it("does not invent keys on a response that had nothing to strip", async () => {
    vi.stubEnv("GEMINI_API_KEY", "gem-test");
    const fetchImpl = vi.fn(async () => json(ANSWER));

    const result = await askGemini("x", { fetchImpl: fetchImpl as never });

    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    expect(result.raw).toEqual(ANSWER);
  });
});
