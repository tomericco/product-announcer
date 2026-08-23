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
  },
  {
    name: "gemini",
    keyEnv: "GEMINI_API_KEY",
    ask: askGemini,
    // No candidate at all is Gemini's shape for "nothing was answered".
    refusal: { modelVersion: "gemini-3.7-flash", candidates: [] },
  },
  {
    name: "anthropic",
    keyEnv: "ANTHROPIC_API_KEY",
    ask: askAnthropic,
    refusal: { model: "claude-sonnet-5", stop_reason: "refusal", content: [] },
  },
];

describe.each(ENGINES)("$name — retryable classification", (engine) => {
  it("marks 429 retryable: a rate limit is a moment, not a verdict", async () => {
    vi.stubEnv(engine.keyEnv, "test-key");
    const fetchImpl = vi.fn(async () => body({ error: "rate limited" }, 429));

    const result = isError(await engine.ask("best issue tracker", { fetchImpl: fetchImpl as never }));

    expect(result.kind).toBe("error");
    expect(result.retryable).toBe(true);
  });

  it("marks 500 retryable: the provider is having a bad minute", async () => {
    vi.stubEnv(engine.keyEnv, "test-key");
    const fetchImpl = vi.fn(async () => body({ error: "internal" }, 500));

    expect(isError(await engine.ask("q", { fetchImpl: fetchImpl as never })).retryable).toBe(true);
  });

  it("leaves 401 terminal: a bad or unfunded key fails identically every time", async () => {
    vi.stubEnv(engine.keyEnv, "test-key");
    const fetchImpl = vi.fn(async () => body({ error: "invalid api key" }, 401));

    expect(isError(await engine.ask("q", { fetchImpl: fetchImpl as never })).retryable).not.toBe(true);
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
    expect(result.message).toContain("socket hang up");
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
