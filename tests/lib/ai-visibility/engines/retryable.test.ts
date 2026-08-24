import { describe, it, expect, vi, afterEach } from "vitest";
import { askOpenAi } from "../../../../src/lib/ai-visibility/engines/openai";
import { askGemini } from "../../../../src/lib/ai-visibility/engines/gemini";
import { askAnthropic } from "../../../../src/lib/ai-visibility/engines/anthropic";
import type { EngineAnswer, EngineError } from "../../../../src/lib/ai-visibility/types";

/**
 * One table for all three clients, because the classification is what
 * `runSlice` spends money on: a `retryable: true` costs a second and a third
 * call at full price, and a missing one costs the run a data point that a
 * moment's wait would have recovered. Drift between the three engines is the
 * failure this file exists to catch — the individual client tests cover their
 * own parsing.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

function body(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isError(result: EngineAnswer | EngineError): EngineError {
  if (!("kind" in result)) throw new Error("expected an EngineError");
  return result;
}

type Engine = {
  name: string;
  keyEnv: string;
  ask: (prompt: string, deps?: { fetchImpl?: typeof fetch }) => Promise<EngineAnswer | EngineError>;
  /** A complete, readable response in which the model declined to answer. */
  refusal: unknown;
  /**
   * A 429 body that means "out of money", not "too fast" — the published marker
   * for each provider. See `QUOTA_MARKERS` in `engines/failure.ts`.
   */
  spendCapBody: string;
};

const ENGINES: Engine[] = [
  {
    name: "openai",
    keyEnv: "OPENAI_API_KEY",
    ask: askOpenAi,
    refusal: {
      model: "gpt-5.5",
      status: "completed",
      output: [{ type: "message", content: [{ type: "refusal", refusal: "I can't help with that." }] }],
    },
    spendCapBody:
      '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"insufficient_quota"}}',
  },
  {
    name: "gemini",
    keyEnv: "GEMINI_API_KEY",
    ask: askGemini,
    // No candidate at all is Gemini's shape for "nothing was answered".
    refusal: { modelVersion: "gemini-3.7-flash", candidates: [] },
    // A per-day quota, which by definition cannot clear inside a 90s ladder.
    spendCapBody:
      '{"error":{"status":"RESOURCE_EXHAUSTED","details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel"}]}]}}',
  },
  {
    name: "anthropic",
    keyEnv: "ANTHROPIC_API_KEY",
    ask: askAnthropic,
    refusal: { model: "claude-sonnet-5", stop_reason: "refusal", content: [] },
    // Carries NO `retry-after` — the error code is the only signal.
    spendCapBody:
      '{"type":"error","error":{"type":"rate_limit_error","message":"limit reached","details":{"error_code":"enforced_spend_limit_reached"}}}',
  },
];

describe.each(ENGINES)("$name — retryable classification", (engine) => {
  it("marks a THROUGHPUT 429 retryable: a rate limit is a moment, not a verdict", async () => {
    vi.stubEnv(engine.keyEnv, "test-key");
    const fetchImpl = vi.fn(async () => body({ error: "rate limited" }, 429));

    const result = isError(await engine.ask("best issue tracker", { fetchImpl: fetchImpl as never }));

    expect(result.kind).toBe("error");
    expect(result.code).toBe("rate_limited");
    expect(result.retryable).toBe(true);
  });

  it("leaves a SPEND-CAP 429 terminal: the same status, the opposite remedy", async () => {
    // Every engine has one, and it wears the status of a throughput limit. Our
    // ladder is 90 seconds; none of these caps clears in 90 seconds, so a
    // retryable classification here spends three of the customer's calls to
    // fail identically. Drift between the three engines on THIS is the
    // expensive kind.
    vi.stubEnv(engine.keyEnv, "test-key");
    const fetchImpl = vi.fn(async () => new Response(engine.spendCapBody, { status: 429 }));

    const result = isError(await engine.ask("q", { fetchImpl: fetchImpl as never }));

    expect(result.code).toBe("quota_exceeded");
    expect(result.retryable).not.toBe(true);
    // Our sentence, and it names money rather than speed.
    expect(result.message).toMatch(/credit|spend cap/i);
  });

  it("carries the provider's `retry-after` when it sends one", async () => {
    vi.stubEnv(engine.keyEnv, "test-key");
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "slow down" }), {
          status: 429,
          headers: { "retry-after": "12" },
        })
    );

    const result = isError(await engine.ask("q", { fetchImpl: fetchImpl as never }));

    expect(result.code).toBe("rate_limited");
    expect(result.retryAfterMs).toBe(12_000);
  });

  it("marks 500 retryable: the provider is having a bad minute", async () => {
    vi.stubEnv(engine.keyEnv, "test-key");
    const fetchImpl = vi.fn(async () => body({ error: "internal" }, 500));

    expect(isError(await engine.ask("q", { fetchImpl: fetchImpl as never })).retryable).toBe(true);
  });

  it("leaves 401 terminal: a bad or unfunded key fails identically every time", async () => {
    vi.stubEnv(engine.keyEnv, "test-key");
    const fetchImpl = vi.fn(async () => body({ error: "invalid api key" }, 401));

    const result = isError(await engine.ask("q", { fetchImpl: fetchImpl as never }));
    expect(result.retryable).not.toBe(true);
    expect(result.code).toBe("invalid_key");
  });

  it("leaves 404 terminal: a model id that no longer resolves will not start to", async () => {
    vi.stubEnv(engine.keyEnv, "test-key");
    const fetchImpl = vi.fn(async () => body({ error: "no such model" }, 404));

    expect(isError(await engine.ask("q", { fetchImpl: fetchImpl as never })).retryable).not.toBe(true);
  });

  it("marks a transport failure retryable: nothing reached the model", async () => {
    vi.stubEnv(engine.keyEnv, "test-key");
    const fetchImpl = vi.fn(async () => {
      throw new Error("socket hang up");
    });

    const result = isError(await engine.ask("q", { fetchImpl: fetchImpl as never }));
    expect(result.retryable).toBe(true);
    expect(result.code).toBe("provider_unavailable");
    // And the exception's own text stays out of it — see `engines/failure.ts`.
    expect(result.message).not.toContain("socket hang up");
  });

  it("leaves a refusal terminal: the model read the prompt, declined, and billed for it", async () => {
    vi.stubEnv(engine.keyEnv, "test-key");
    const fetchImpl = vi.fn(async () => body(engine.refusal, 200));

    const result = isError(await engine.ask("q", { fetchImpl: fetchImpl as never }));
    expect(result.kind).toBe("refused");
    expect(result.retryable).not.toBe(true);
  });

  it("leaves unparseable JSON terminal: our reader is wrong about the shape", async () => {
    vi.stubEnv(engine.keyEnv, "test-key");
    const fetchImpl = vi.fn(
      async () => new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } })
    );

    const result = isError(await engine.ask("q", { fetchImpl: fetchImpl as never }));
    expect(result.retryable).not.toBe(true);
  });

  it("leaves a missing key terminal", async () => {
    vi.stubEnv(engine.keyEnv, "");
    expect(isError(await engine.ask("q")).retryable).not.toBe(true);
  });
});

describe("engine-specific terminal failures", () => {
  it("openai: a truncated answer is not retried — it generated to the ceiling and will again", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const fetchImpl = vi.fn(async () =>
      body({ model: "gpt-5.5", status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }, 200)
    );

    const result = isError(await askOpenAi("q", { fetchImpl: fetchImpl as never }));
    expect(result.retryable).not.toBe(true);
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("gemini: MAX_TOKENS is not retried", async () => {
    vi.stubEnv("GEMINI_API_KEY", "g-test");
    const fetchImpl = vi.fn(async () =>
      body({ modelVersion: "gemini-3.7-flash", candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [] } }] }, 200)
    );

    expect(isError(await askGemini("q", { fetchImpl: fetchImpl as never })).retryable).not.toBe(true);
  });

  it("gemini: the grounding canary is not retried — the shape is what we read wrong", async () => {
    vi.stubEnv("GEMINI_API_KEY", "g-test");
    const fetchImpl = vi.fn(async () =>
      body(
        {
          modelVersion: "gemini-3.7-flash",
          candidates: [
            {
              finishReason: "STOP",
              content: { parts: [{ text: "Acme is the usual pick." }] },
              // Grounding metadata under keys this client does not read.
              groundingMetadata: { renamedChunks: [{ web: { uri: "https://acme.com" } }] },
            },
          ],
        },
        200
      )
    );

    const result = isError(await askGemini("q", { fetchImpl: fetchImpl as never }));
    expect(result.message).toContain("could not read");
    expect(result.retryable).not.toBe(true);
  });

  it("anthropic: max_tokens is not retried", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "a-test");
    const fetchImpl = vi.fn(async () =>
      body({ model: "claude-sonnet-5", stop_reason: "max_tokens", content: [] }, 200)
    );

    expect(isError(await askAnthropic("q", { fetchImpl: fetchImpl as never })).retryable).not.toBe(true);
  });
});
