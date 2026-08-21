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

// Shaped after a real claude-sonnet-5 call made while writing this: search
// results carry `encrypted_content` and `page_age`, citations carry
// `cited_text` and `encrypted_index`.
const ANSWER = {
  model: "claude-sonnet-5",
  stop_reason: "end_turn",
  content: [
    { type: "server_tool_use", name: "web_search", input: { query: "best issue trackers" } },
    {
      type: "web_search_tool_result",
      content: [
        {
          type: "web_search_result",
          url: "https://g2.com/categories/issue-tracking",
          title: "Issue tracking",
          page_age: "2026-05-01",
          encrypted_content: "EqoBCioIA-opaque-blob",
        },
      ],
    },
    {
      type: "text",
      text: "Linear and Acme are both strong.",
      citations: [
        {
          type: "web_search_result_location",
          url: "https://g2.com/categories/issue-tracking",
          cited_text: "a long verbatim quote from the source page",
          encrypted_index: "eyJ-opaque-index",
        },
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
    // Thinking shares the answer's token budget, and a live check showed it
    // eating enough of it to truncate the answer itself.
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("extracts text, citations in order, the queries and the dated model id", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    const fetchImpl = vi.fn(async () => json(ANSWER));

    const result = await askAnthropic("x", { fetchImpl: fetchImpl as never });

    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    expect(result.text).toBe("Linear and Acme are both strong.");
    expect(result.modelId).toBe("claude-sonnet-5");
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

  it("treats a truncated or paused answer as an error, not as an answer", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");

    // Grounded, plausible, and cut off mid-sentence — the shape that would
    // silently score a brand named in the missing tail as absent.
    const truncated = vi.fn(async () =>
      json({
        model: "claude-sonnet-5",
        stop_reason: "max_tokens",
        content: [
          { type: "server_tool_use", name: "web_search", input: { query: "q" } },
          { type: "text", text: "The strongest options are Linear, Jira and" },
        ],
      })
    );
    expect(await askAnthropic("x", { fetchImpl: truncated as never })).toEqual({
      kind: "error",
      message: expect.stringContaining("max_tokens"),
    });

    const paused = vi.fn(async () =>
      json({
        model: "claude-sonnet-5",
        stop_reason: "pause_turn",
        content: [
          { type: "server_tool_use", name: "web_search", input: { query: "q" } },
          { type: "text", text: "Still working on it" },
        ],
      })
    );
    expect(await askAnthropic("x", { fetchImpl: paused as never })).toEqual({
      kind: "error",
      message: expect.stringContaining("pause_turn"),
    });
  });

  it("drops the opaque blobs before storing raw", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    const fetchImpl = vi.fn(async () => json(ANSWER));

    const result = await askAnthropic("x", { fetchImpl: fetchImpl as never });

    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    const stored = JSON.stringify(result.raw);
    expect(stored).not.toContain("EqoBCioIA-opaque-blob");
    expect(stored).not.toContain("eyJ-opaque-index");
    expect(stored).not.toContain("a long verbatim quote");
    expect(stored).not.toContain("page_age");
    // What is worth keeping is still there: the answer and every cited URL.
    expect(stored).toContain("Linear and Acme are both strong.");
    expect(stored).toContain("https://g2.com/categories/issue-tracking");
    expect(stored).toContain("Issue tracking");
  });

  it("exposes itself as an EngineClient", () => {
    expect(anthropicEngine.id).toBe("anthropic");
    expect(anthropicEngine.label).toContain("API");
  });
});

describe("askAnthropic, the remaining error paths and extraction edges", () => {
  it("never calls out on a key that is only whitespace", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "   ");
    const fetchImpl = vi.fn();

    expect(await askAnthropic("x", { fetchImpl: fetchImpl as never })).toEqual({
      kind: "error",
      message: expect.stringContaining("ANTHROPIC_API_KEY"),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("turns a 401, a 429 and a 500 into errors carrying the status and the body", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");

    const unauthorized = vi.fn(
      async () => new Response('{"error":{"message":"invalid x-api-key"}}', { status: 401 })
    );
    const result = await askAnthropic("x", { fetchImpl: unauthorized as never });
    expect(result).toEqual({ kind: "error", message: expect.stringContaining("401") });
    expect("kind" in result && result.message).toContain("invalid x-api-key");

    const rateLimited = vi.fn(async () => new Response("rate_limit_error", { status: 429 }));
    expect(await askAnthropic("x", { fetchImpl: rateLimited as never })).toEqual({
      kind: "error",
      message: expect.stringContaining("429"),
    });

    const broken = vi.fn(async () => new Response("boom", { status: 500 }));
    expect(await askAnthropic("x", { fetchImpl: broken as never })).toEqual({
      kind: "error",
      message: expect.stringContaining("500"),
    });
  });

  it("turns an unparseable body into an error rather than an exception", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");

    const empty = vi.fn(async () => new Response("", { status: 200 }));
    expect(await askAnthropic("x", { fetchImpl: empty as never })).toEqual({
      kind: "error",
      message: expect.stringMatching(/unparseable/i),
    });

    const html = vi.fn(async () => new Response("<html>502</html>", { status: 200 }));
    expect(await askAnthropic("x", { fetchImpl: html as never })).toEqual({
      kind: "error",
      message: expect.stringMatching(/unparseable/i),
    });
  });

  it("sends a bare model override and falls back to the requested id", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("AI_VISIBILITY_ANTHROPIC_MODEL", "claude-sonnet-5-20260401");
    const fetchImpl = vi.fn(async () =>
      json({
        stop_reason: "end_turn",
        content: [
          { type: "server_tool_use", name: "web_search", input: { query: "q" } },
          { type: "text", text: "An answer." },
        ],
      })
    );

    const result = await askAnthropic("x", { fetchImpl: fetchImpl as never });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    // Raw HTTP to api.anthropic.com — an "anthropic/" gateway prefix would be
    // sent verbatim and rejected.
    expect(body.model).toBe("claude-sonnet-5-20260401");
    expect(body.model).not.toContain("/");
    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    expect(result.modelId).toBe("claude-sonnet-5-20260401");
  });

  it("caps the searches so a buyer question is not a research session", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    const fetchImpl = vi.fn(async () => json(ANSWER));

    await askAnthropic("x", { fetchImpl: fetchImpl as never });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const tool = JSON.parse(init.body as string).tools[0];
    expect(tool.max_uses).toBeGreaterThan(0);
    expect(tool.max_uses).toBeLessThanOrEqual(10);
  });

  it("dedupes citations and queries across separate blocks, keeping first-cited order", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    const fetchImpl = vi.fn(async () =>
      json({
        model: "claude-sonnet-5",
        stop_reason: "end_turn",
        content: [
          { type: "server_tool_use", name: "web_search", input: { query: "q1" } },
          { type: "server_tool_use", name: "web_search", input: { query: "q1" } },
          { type: "server_tool_use", name: "web_search", input: { query: "q2" } },
          // A different server tool is not a web search.
          { type: "server_tool_use", name: "code_execution", input: { query: "IGNORED" } },
          {
            type: "text",
            text: "First half. ",
            citations: [
              { url: "https://a.example/1" },
              { url: "" },
              {},
              { url: "https://b.example/2" },
            ],
          },
          {
            type: "text",
            text: "Second half.",
            citations: [{ url: "https://a.example/1" }, { url: "https://c.example/3" }],
          },
        ],
      })
    );

    const result = await askAnthropic("x", { fetchImpl: fetchImpl as never });

    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    expect(result.text).toBe("First half. Second half.");
    expect(result.searchQueries).toEqual(["q1", "q2"]);
    expect(result.citations).toEqual([
      { url: "https://a.example/1", position: 1 },
      { url: "https://b.example/2", position: 2 },
      { url: "https://c.example/3", position: 3 },
    ]);
  });

  it("does not count a non-search server tool as having searched", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    const fetchImpl = vi.fn(async () =>
      json({
        model: "m",
        stop_reason: "end_turn",
        content: [
          { type: "server_tool_use", name: "code_execution", input: { query: "q" } },
          { type: "text", text: "From memory." },
        ],
      })
    );

    expect(await askAnthropic("x", { fetchImpl: fetchImpl as never })).toEqual({
      kind: "refused",
      message: expect.stringMatching(/search/i),
    });
  });

  it("strips the blobs as KEYS, and leaves a block that never had them alone", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    const fetchImpl = vi.fn(async () => json(ANSWER));

    const result = await askAnthropic("x", { fetchImpl: fetchImpl as never });

    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    const blocks = (result.raw as { content: Record<string, unknown>[] }).content;

    const searchResult = blocks.find((block) => block.type === "web_search_tool_result");
    const hits = searchResult?.content as Record<string, unknown>[];
    expect(hits).toHaveLength(1);
    expect(Object.keys(hits[0])).not.toContain("encrypted_content");
    expect(Object.keys(hits[0])).not.toContain("page_age");
    // Identity survives: without the URL the citation is unusable evidence.
    expect(hits[0].url).toBe("https://g2.com/categories/issue-tracking");

    const textBlock = blocks.find((block) => block.type === "text");
    for (const citation of textBlock?.citations as Record<string, unknown>[]) {
      expect(Object.keys(citation)).not.toContain("cited_text");
      expect(Object.keys(citation)).not.toContain("encrypted_index");
      expect(citation.url).toEqual(expect.any(String));
    }

    // The tool-use block has neither `content` nor `citations`; sanitising must
    // not invent either key on it.
    const toolUse = blocks.find((block) => block.type === "server_tool_use");
    expect(Object.keys(toolUse ?? {})).not.toContain("citations");
    expect(toolUse?.input).toEqual({ query: "best issue trackers" });
  });
});
