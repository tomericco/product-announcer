import { describe, it, expect, vi, afterEach } from "vitest";
import {
  askOpenAi,
  openaiEngine,
  OPENAI_COST_PER_CALL_USD,
} from "../../../../src/lib/ai-visibility/engines/openai";

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
  model: "gpt-5.1-2026-01-01",
  output: [
    { type: "web_search_call", action: { type: "search", query: "best issue trackers" } },
    { type: "web_search_call", action: { type: "search", query: "issue tracker startups" } },
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: "Linear and Acme are both strong.",
          annotations: [
            { type: "url_citation", url: "https://g2.com/categories/issue-tracking" },
            { type: "file_citation", url: "https://ignored.example/file" },
            { type: "url_citation", url: "https://acme.com/pricing" },
            { type: "url_citation", url: "https://g2.com/categories/issue-tracking" },
          ],
        },
      ],
    },
  ],
};

describe("askOpenAi", () => {
  it("posts to the Responses API with web search at medium context", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const fetchImpl = vi.fn(async () => json(ANSWER));

    await askOpenAi("best issue trackers for startups", { fetchImpl: fetchImpl as never });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body as string);
    expect(body.input).toBe("best issue trackers for startups");
    expect(body.tools).toEqual([{ type: "web_search", search_context_size: "medium" }]);
    expect(typeof body.instructions).toBe("string");
  });

  it("extracts the answer, the model, the citations in order and the queries", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const fetchImpl = vi.fn(async () => json(ANSWER));

    const result = await askOpenAi("best issue trackers", { fetchImpl: fetchImpl as never });

    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    expect(result.text).toBe("Linear and Acme are both strong.");
    expect(result.modelId).toBe("gpt-5.1-2026-01-01");
    expect(result.searchUsed).toBe(true);
    expect(result.searchQueries).toEqual(["best issue trackers", "issue tracker startups"]);
    expect(result.citations).toEqual([
      { url: "https://g2.com/categories/issue-tracking", position: 1 },
      { url: "https://acme.com/pricing", position: 2 },
    ]);
    expect(result.costUsd).toBe(OPENAI_COST_PER_CALL_USD);
    expect(result.raw).toEqual(ANSWER);
  });

  it("reports a missing key without calling out", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const fetchImpl = vi.fn();

    expect(await askOpenAi("x", { fetchImpl: fetchImpl as never })).toEqual({
      kind: "error",
      message: expect.stringContaining("OPENAI_API_KEY"),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("turns 429 and 5xx into an error, not an exception", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");

    const rateLimited = vi.fn(async () => new Response("slow down", { status: 429 }));
    const limited = await askOpenAi("x", { fetchImpl: rateLimited as never });
    expect(limited).toEqual({ kind: "error", message: expect.stringContaining("429") });

    const broken = vi.fn(async () => new Response("boom", { status: 503 }));
    expect(await askOpenAi("x", { fetchImpl: broken as never })).toEqual({
      kind: "error",
      message: expect.stringContaining("503"),
    });

    const thrower = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    expect(await askOpenAi("x", { fetchImpl: thrower as never })).toEqual({
      kind: "error",
      message: expect.stringContaining("socket hang up"),
    });
  });

  it("refuses a refusal, an empty answer, and an answer written without searching", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");

    const refusal = vi.fn(async () =>
      json({
        model: "m",
        output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }],
      })
    );
    expect(await askOpenAi("x", { fetchImpl: refusal as never })).toEqual({
      kind: "refused",
      message: expect.any(String),
    });

    const noSearch = vi.fn(async () =>
      json({
        model: "m",
        output: [{ type: "message", content: [{ type: "output_text", text: "From memory." }] }],
      })
    );
    const result = await askOpenAi("x", { fetchImpl: noSearch as never });
    expect(result).toEqual({ kind: "refused", message: expect.stringMatching(/search/i) });

    const empty = vi.fn(async () => json({ model: "m", output: [{ type: "web_search_call" }] }));
    expect(await askOpenAi("x", { fetchImpl: empty as never })).toEqual({
      kind: "refused",
      message: expect.any(String),
    });
  });

  it("exposes itself as an EngineClient", () => {
    expect(openaiEngine.id).toBe("openai");
    expect(openaiEngine.label).toContain("API");
  });
});
