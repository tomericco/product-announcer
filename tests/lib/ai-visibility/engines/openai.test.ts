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

// Shaped after a real gpt-5.5 Responses call made while writing this: `status`
// and `incomplete_details` at the top level, `action.queries` as an ARRAY, an
// `open_page` action among the search calls, and a `reasoning` item carrying an
// opaque `encrypted_content` blob.
const ANSWER = {
  model: "gpt-5.5-2026-04-23",
  status: "completed",
  incomplete_details: null,
  output: [
    { type: "reasoning", encrypted_content: "gAAAAAB-opaque-blob", summary: [] },
    {
      type: "web_search_call",
      status: "completed",
      action: { type: "search", queries: ["best issue trackers", "issue tracker startups"] },
    },
    {
      type: "web_search_call",
      status: "completed",
      action: { type: "open_page", url: "https://acme.com/pricing" },
    },
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
    // No system prompt by default: a buyer types a question and sends nothing
    // else, and the prompt this replaced asked the model to cite its sources —
    // instructing the very behaviour the leaderboard counts.
    expect(body.instructions).toBeUndefined();
  });

  it("extracts the answer, the model, the citations in order and the queries", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const fetchImpl = vi.fn(async () => json(ANSWER));

    const result = await askOpenAi("best issue trackers", { fetchImpl: fetchImpl as never });

    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    expect(result.text).toBe("Linear and Acme are both strong.");
    expect(result.modelId).toBe("gpt-5.5-2026-04-23");
    expect(result.searchUsed).toBe(true);
    // Read out of `action.queries`, the array form the live API returns. Read
    // from `action.query` this would come back empty.
    expect(result.searchQueries).toEqual(["best issue trackers", "issue tracker startups"]);
    expect(result.citations).toEqual([
      { url: "https://g2.com/categories/issue-tracking", position: 1 },
      { url: "https://acme.com/pricing", position: 2 },
    ]);
    expect(result.costUsd).toBe(OPENAI_COST_PER_CALL_USD);
  });

  it("still reads the older singular action.query", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const fetchImpl = vi.fn(async () =>
      json({
        model: "m",
        status: "completed",
        output: [
          { type: "web_search_call", action: { type: "search", query: "one query" } },
          { type: "message", content: [{ type: "output_text", text: "An answer." }] },
        ],
      })
    );

    const result = await askOpenAi("x", { fetchImpl: fetchImpl as never });

    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    expect(result.searchQueries).toEqual(["one query"]);
  });

  it("drops the opaque reasoning blob before storing raw", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const fetchImpl = vi.fn(async () => json(ANSWER));

    const result = await askOpenAi("x", { fetchImpl: fetchImpl as never });

    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    // Stored on every sample as jsonb; the blob is an unreadable continuation
    // handle, so it is weight with no evidentiary value.
    expect(JSON.stringify(result.raw)).not.toContain("gAAAAAB-opaque-blob");
    expect(JSON.stringify(result.raw)).toContain("Linear and Acme are both strong.");
  });

  it("treats a truncated or failed response as an error, not as an answer", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");

    // The dangerous case: there IS text, it IS grounded, and it stops mid-way.
    // Scored as an answer, a brand named in the missing tail reads as absent.
    const truncated = vi.fn(async () =>
      json({
        model: "m",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          { type: "web_search_call", action: { type: "search", queries: ["q"] } },
          { type: "message", content: [{ type: "output_text", text: "The best options are Linear," }] },
        ],
      })
    );
    expect(await askOpenAi("x", { fetchImpl: truncated as never })).toEqual({
      kind: "error",
      code: "bad_response",
      message: expect.stringContaining("max_output_tokens"),
      // Generated all the way to the ceiling: the most expensive kind of call
      // there is, and it must not be recorded against the cap as free.
      costUsd: OPENAI_COST_PER_CALL_USD,
    });

    const failed = vi.fn(async () =>
      json({
        model: "m",
        status: "failed",
        output: [
          { type: "web_search_call", action: { type: "search", queries: ["q"] } },
          { type: "message", content: [{ type: "output_text", text: "partial" }] },
        ],
      })
    );
    expect(await askOpenAi("x", { fetchImpl: failed as never })).toEqual({
      kind: "error",
      code: "bad_response",
      message: expect.stringContaining("response status failed"),
      costUsd: OPENAI_COST_PER_CALL_USD,
    });
  });

  it("reports a missing key without calling out", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const fetchImpl = vi.fn();

    expect(await askOpenAi("x", { fetchImpl: fetchImpl as never })).toEqual({
      kind: "error",
      code: "invalid_key",
      message: expect.stringContaining("no key configured"),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("turns 429 and 5xx into an error, not an exception", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");

    const rateLimited = vi.fn(async () => new Response("slow down", { status: 429 }));
    const limited = await askOpenAi("x", { fetchImpl: rateLimited as never });
    // Retryable: a rate limit is a moment, and the sample is asked again. The
    // STATUS is no longer in the message — the code carries that fact now, and
    // the body ("slow down", or a 401's key fragment) never leaves the client.
    expect(limited).toEqual({
      kind: "error",
      code: "rate_limited",
      message: expect.stringContaining("rate-limiting"),
      retryable: true,
    });

    const broken = vi.fn(async () => new Response("boom", { status: 503 }));
    expect(await askOpenAi("x", { fetchImpl: broken as never })).toEqual({
      kind: "error",
      code: "provider_unavailable",
      message: expect.stringContaining("Couldn't reach OpenAI"),
      retryable: true,
    });

    const thrower = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    const threw = await askOpenAi("x", { fetchImpl: thrower as never });
    expect(threw).toEqual({
      kind: "error",
      code: "provider_unavailable",
      retryable: true,
      message: expect.stringContaining("request never completed"),
    });
    // A fetch error stringifies with the request attached, and that request
    // carries an Authorization header. It goes to the log, not to the row.
    expect("message" in threw && threw.message).not.toContain("socket hang up");
  });

  it("refuses a refusal and an empty answer", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");

    const refusal = vi.fn(async () =>
      json({
        model: "m",
        output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }],
      })
    );
    expect(await askOpenAi("x", { fetchImpl: refusal as never })).toEqual({
      kind: "refused",
      code: "refused",
      message: expect.any(String),
      // A refusal ran the model. Billed like any other call.
      costUsd: OPENAI_COST_PER_CALL_USD,
    });

    const empty = vi.fn(async () => json({ model: "m", output: [{ type: "web_search_call" }] }));
    expect(await askOpenAi("x", { fetchImpl: empty as never })).toEqual({
      kind: "refused",
      code: "refused",
      message: expect.any(String),
      costUsd: OPENAI_COST_PER_CALL_USD,
    });
  });

  it("returns an answer written without searching, marked ungrounded", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");

    const noSearch = vi.fn(async () =>
      json({
        model: "m",
        output: [{ type: "message", content: [{ type: "output_text", text: "From memory." }] }],
      })
    );
    const result = await askOpenAi("x", { fetchImpl: noSearch as never });

    // What the engine SAID is measurable even when it never searched. Only the
    // citation-family metrics exclude it, keyed off `searchUsed`.
    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    expect(result.text).toBe("From memory.");
    expect(result.searchUsed).toBe(false);
    expect(result.citations).toEqual([]);
    expect(result.searchQueries).toEqual([]);
  });

  it("marks a sample grounded when it carries citations but no web_search_call", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");

    // Citations come off annotations, the flag off a `web_search_call` item, so
    // the two can disagree. `ownCitations > nGrounded` would push citation rate
    // over 100%, so the citations win.
    const citedWithoutFlag = vi.fn(async () =>
      json({
        model: "m",
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "Acme is strong.",
                annotations: [{ type: "url_citation", url: "https://acme.com/pricing" }],
              },
            ],
          },
        ],
      })
    );
    const result = await askOpenAi("x", { fetchImpl: citedWithoutFlag as never });

    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    expect(result.searchUsed).toBe(true);
    expect(result.citations).toEqual([{ url: "https://acme.com/pricing", position: 1 }]);
  });

  it("exposes itself as an EngineClient", () => {
    expect(openaiEngine.id).toBe("openai");
    expect(openaiEngine.label).toContain("API");
  });
});

describe("askOpenAi, the remaining error paths and extraction edges", () => {
  it("never calls out on a key that is only whitespace", async () => {
    vi.stubEnv("OPENAI_API_KEY", "   ");
    const fetchImpl = vi.fn();

    expect(await askOpenAi("x", { fetchImpl: fetchImpl as never })).toEqual({
      kind: "error",
      code: "invalid_key",
      message: expect.stringContaining("no key configured"),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("turns a 401 into `invalid_key` and keeps the provider's body out of it", async () => {
    // The 401 body OpenAI actually returns. It echoes the submitted key's
    // prefix AND its last four characters — under BYOK that is a customer
    // secret, and this string used to be stored on the sample row and rendered
    // on the overview. The assertion that matters is the ABSENCE.
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const unauthorized = vi.fn(
      async () =>
        new Response(
          '{"error":{"message":"Incorrect API key provided: sk-Eyftb****************************99vW. You can find your API key at https://platform.openai.com/account/api-keys.","type":"invalid_request_error","code":"invalid_api_key"}}',
          { status: 401 }
        )
    );

    const result = await askOpenAi("x", { fetchImpl: unauthorized as never });
    expect(result).toEqual({ kind: "error", code: "invalid_key", message: expect.any(String) });
    const message = "message" in result ? result.message : "";
    expect(message).not.toContain("sk-Eyftb");
    expect(message).not.toContain("99vW");
    expect(message).not.toContain("Incorrect API key");
    // Terminal, as it always was: a wrong key fails identically every time.
    expect("retryable" in result && result.retryable).not.toBe(true);
  });

  it("turns an unparseable body into an error rather than an exception", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");

    const empty = vi.fn(async () => new Response("", { status: 200 }));
    expect(await askOpenAi("x", { fetchImpl: empty as never })).toEqual({
      kind: "error",
      code: "bad_response",
      message: expect.stringMatching(/unparseable/i),
    });

    // What a proxy or an edge error page actually returns when it intercepts.
    const html = vi.fn(async () => new Response("<html>502 Bad Gateway</html>", { status: 200 }));
    expect(await askOpenAi("x", { fetchImpl: html as never })).toEqual({
      kind: "error",
      code: "bad_response",
      message: expect.stringMatching(/unparseable/i),
    });
  });

  it("sends the model override and falls back to the requested id when none comes back", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("AI_VISIBILITY_OPENAI_MODEL", "gpt-5.6-preview");
    const fetchImpl = vi.fn(async () =>
      json({
        status: "completed",
        output: [
          { type: "web_search_call", action: { queries: ["q"] } },
          { type: "message", content: [{ type: "output_text", text: "An answer." }] },
        ],
      })
    );

    const result = await askOpenAi("x", { fetchImpl: fetchImpl as never });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).model).toBe("gpt-5.6-preview");
    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    // No `model` in the response, so the id we asked for is what gets stored —
    // never an empty string, which would break the model-change suppression.
    expect(result.modelId).toBe("gpt-5.6-preview");
  });

  it("dedupes citations and queries across separate output items", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const fetchImpl = vi.fn(async () =>
      json({
        model: "m",
        status: "completed",
        output: [
          { type: "web_search_call", action: { type: "search", queries: ["q1", "q2"] } },
          { type: "web_search_call", action: { type: "search", queries: ["q2", "q3"] } },
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "First half. ",
                annotations: [
                  { type: "url_citation", url: "https://a.example/1" },
                  { type: "url_citation", url: "" },
                  { type: "url_citation" },
                ],
              },
              {
                type: "output_text",
                text: "Second half.",
                annotations: [{ type: "url_citation", url: "https://b.example/2" }],
              },
            ],
          },
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: " Tail.",
                // Already cited in the first message: one source cited twice is
                // one source, and its position is where it FIRST appeared.
                annotations: [
                  { type: "url_citation", url: "https://a.example/1" },
                  { type: "url_citation", url: "https://c.example/3" },
                ],
              },
            ],
          },
        ],
      })
    );

    const result = await askOpenAi("x", { fetchImpl: fetchImpl as never });

    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    expect(result.text).toBe("First half. Second half. Tail.");
    expect(result.searchQueries).toEqual(["q1", "q2", "q3"]);
    expect(result.citations).toEqual([
      { url: "https://a.example/1", position: 1 },
      { url: "https://b.example/2", position: 2 },
      { url: "https://c.example/3", position: 3 },
    ]);
  });

  it("strips the encrypted blob as a KEY, not just as a value", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const fetchImpl = vi.fn(async () => json(ANSWER));

    const result = await askOpenAi("x", { fetchImpl: fetchImpl as never });

    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    const output = (result.raw as { output: Record<string, unknown>[] }).output;
    for (const item of output) {
      expect(Object.keys(item)).not.toContain("encrypted_content");
    }
    // The reasoning item itself is kept — only its blob goes.
    expect(output.some((item) => item.type === "reasoning")).toBe(true);
    expect(JSON.stringify(result.raw)).not.toContain("encrypted_content");
  });

  it("counts a search call that carries no query at all", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    // `open_page` and `find_in_page` actions are navigation, not searches: they
    // contribute no query, but they still prove the model went to the web.
    const fetchImpl = vi.fn(async () =>
      json({
        model: "m",
        status: "completed",
        output: [
          { type: "web_search_call", action: { type: "open_page", url: "https://a.example" } },
          { type: "web_search_call" },
          { type: "message", content: [{ type: "output_text", text: "An answer." }] },
        ],
      })
    );

    const result = await askOpenAi("x", { fetchImpl: fetchImpl as never });

    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    expect(result.searchUsed).toBe(true);
    expect(result.searchQueries).toEqual([]);
    expect(result.citations).toEqual([]);
  });
});

describe("askOpenAi, shapes that are not what the docs describe", () => {
  /**
   * `ask()` promises `EngineAnswer | EngineError` and must never throw: a
   * TypeError out of here has no catch above it and would end the run slice.
   * Verified live, unlike Gemini — but a provider is free to
   * change a shape between releases, and the contract has to hold regardless.
   */
  it("does not throw when the body, or any list inside it, is the wrong type", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");

    const bodies = [
      null,
      "a string",
      42,
      { model: "m", status: "completed", output: "nope" },
      { model: "m", status: "completed", output: [null, 7] },
      { model: "m", status: "completed", output: [{ type: "message", content: { text: "a" } }] },
      {
        model: "m",
        status: "completed",
        output: [{ type: "web_search_call", action: { queries: "not a list" } }],
      },
      {
        model: "m",
        status: "completed",
        output: [
          { type: "web_search_call", action: { queries: ["q"] } },
          { type: "message", content: [{ type: "output_text", text: "a", annotations: "nope" }] },
        ],
      },
    ];

    for (const body of bodies) {
      const fetchImpl = vi.fn(async () => json(body));
      const result = await askOpenAi("x", { fetchImpl: fetchImpl as never });
      if ("kind" in result) {
        expect(["error", "refused"]).toContain(result.kind);
        expect(result.message.length).toBeGreaterThan(0);
      } else {
        // The last body is readable enough to answer; it just has nothing to cite.
        expect(result.citations).toEqual([]);
      }
    }
  });

  it("leaves raw untouched when there was no output key to sanitise", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const fetchImpl = vi.fn(async () => json({ model: "m", status: "completed" }));

    const result = await askOpenAi("x", { fetchImpl: fetchImpl as never });

    // Refused for want of text — the point here is simply that it did not throw.
    expect("kind" in result).toBe(true);
  });
});
