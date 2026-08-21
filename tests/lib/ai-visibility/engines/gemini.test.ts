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
