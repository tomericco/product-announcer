import { describe, it, expect, vi, afterEach } from "vitest";
import {
  askAnthropic,
  anthropicEngine,
  ANTHROPIC_COST_PER_CALL_USD,
} from "../../../../src/lib/ai-visibility/engines/anthropic";

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
  model: "claude-sonnet-4-5-20260101",
  stop_reason: "end_turn",
  content: [
    { type: "server_tool_use", name: "web_search", input: { query: "best issue trackers" } },
    {
      type: "web_search_tool_result",
      content: [{ type: "web_search_result", url: "https://g2.com/categories/issue-tracking" }],
    },
    {
      type: "text",
      text: "Linear and Acme are both strong.",
      citations: [
        { type: "web_search_result_location", url: "https://g2.com/categories/issue-tracking" },
        { type: "web_search_result_location", url: "https://acme.com/pricing" },
        { type: "web_search_result_location", url: "https://g2.com/categories/issue-tracking" },
      ],
    },
  ],
};

describe("askAnthropic", () => {
  it("posts to the Messages API with the web_search tool", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    const fetchImpl = vi.fn(async () => json(ANSWER));

    await askAnthropic("best issue trackers for startups", { fetchImpl: fetchImpl as never });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(init.body as string);
    expect(body.tools[0]).toMatchObject({ type: "web_search_20250305", name: "web_search" });
    expect(body.messages).toEqual([{ role: "user", content: "best issue trackers for startups" }]);
    expect(typeof body.system).toBe("string");
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it("extracts text, citations in order, the queries and the dated model id", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    const fetchImpl = vi.fn(async () => json(ANSWER));

    const result = await askAnthropic("x", { fetchImpl: fetchImpl as never });

    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    expect(result.text).toBe("Linear and Acme are both strong.");
    expect(result.modelId).toBe("claude-sonnet-4-5-20260101");
    expect(result.searchUsed).toBe(true);
    expect(result.searchQueries).toEqual(["best issue trackers"]);
    expect(result.citations).toEqual([
      { url: "https://g2.com/categories/issue-tracking", position: 1 },
      { url: "https://acme.com/pricing", position: 2 },
    ]);
    expect(result.costUsd).toBe(ANTHROPIC_COST_PER_CALL_USD);
  });

  it("reports a missing key, a 529 and a transport failure as errors", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const unused = vi.fn();
    expect(await askAnthropic("x", { fetchImpl: unused as never })).toEqual({
      kind: "error",
      message: expect.stringContaining("ANTHROPIC_API_KEY"),
    });
    expect(unused).not.toHaveBeenCalled();

    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    const overloaded = vi.fn(async () => new Response("overloaded", { status: 529 }));
    expect(await askAnthropic("x", { fetchImpl: overloaded as never })).toEqual({
      kind: "error",
      message: expect.stringContaining("529"),
    });

    const thrower = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    expect(await askAnthropic("x", { fetchImpl: thrower as never })).toEqual({
      kind: "error",
      message: expect.stringContaining("socket hang up"),
    });
  });

  it("refuses a refusal, an empty answer and an answer written without searching", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");

    const refusal = vi.fn(async () =>
      json({
        model: "m",
        stop_reason: "refusal",
        content: [{ type: "text", text: "I can't help." }],
      })
    );
    expect(await askAnthropic("x", { fetchImpl: refusal as never })).toEqual({
      kind: "refused",
      message: expect.any(String),
    });

    const noSearch = vi.fn(async () =>
      json({
        model: "m",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "From memory." }],
      })
    );
    expect(await askAnthropic("x", { fetchImpl: noSearch as never })).toEqual({
      kind: "refused",
      message: expect.stringMatching(/search/i),
    });

    const empty = vi.fn(async () =>
      json({
        model: "m",
        stop_reason: "end_turn",
        content: [{ type: "server_tool_use", name: "web_search", input: { query: "q" } }],
      })
    );
    expect(await askAnthropic("x", { fetchImpl: empty as never })).toEqual({
      kind: "refused",
      message: expect.any(String),
    });
  });

  it("exposes itself as an EngineClient", () => {
    expect(anthropicEngine.id).toBe("anthropic");
    expect(anthropicEngine.label).toContain("API");
  });
});
