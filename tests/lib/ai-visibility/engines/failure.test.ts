import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ENGINE_FAILURE_CODES,
  codeForStatus,
  engineFailure,
  engineFailureMessage,
  isRetryableCode,
  logEngineFailure,
  type EngineFailureCode,
} from "../../../../src/lib/ai-visibility/engines/failure";
import { REDACTED } from "../../../../src/lib/ai-visibility/scrub";
import { ENGINE_IDS, type EngineError } from "../../../../src/lib/ai-visibility/types";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the closed set", () => {
  it("is the same six literals `EngineError.code` accepts", () => {
    // `types.ts` imports nothing (schema.ts reads two types out of it), so the
    // union is written out there by hand. These two assignments are what stops
    // the hand-written copy from drifting: adding a code in one place and not
    // the other fails to compile here.
    const fromType: EngineError["code"][] = [...ENGINE_FAILURE_CODES];
    const toType: (typeof ENGINE_FAILURE_CODES)[number][] = [
      "invalid_key",
      "quota_exceeded",
      "rate_limited",
      "provider_unavailable",
      "bad_response",
      "refused",
    ];
    expect(fromType).toEqual(toType);
  });

  it("gives every engine a distinct, non-empty sentence for every code", () => {
    for (const engine of ENGINE_IDS) {
      const seen = new Set<string>();
      for (const code of ENGINE_FAILURE_CODES) {
        const message = engineFailureMessage(engine, code);
        expect(message.length).toBeGreaterThan(20);
        // Design Decision 4: four failure states, never three. A copy table
        // that reuses one sentence for two codes is the Dify failure — "check
        // that your API key has not expired and has sufficient quota" tells a
        // marketer to check two things and fix neither.
        expect(seen.has(message)).toBe(false);
        seen.add(message);
      }
    }
  });

  it("names the provider and the next action, in our voice", () => {
    expect(engineFailureMessage("openai", "invalid_key")).toContain("ChatGPT");
    expect(engineFailureMessage("openai", "quota_exceeded")).toContain("OpenAI");
    expect(engineFailureMessage("openai", "quota_exceeded")).toContain(
      "platform.openai.com/settings/billing"
    );
    expect(engineFailureMessage("gemini", "provider_unavailable")).toContain("Google");
    expect(engineFailureMessage("anthropic", "invalid_key")).toContain("sk-ant-");
  });
});

describe("engineFailure", () => {
  it("scrubs the composed message even when a caller passes a secret as `detail`", () => {
    // `detail` is documented as OUR words only. This asserts the documentation
    // is not the whole defence: the constructor scrubs regardless, so one
    // careless call site cannot reopen the leak.
    const failure = engineFailure("openai", "invalid_key", {
      detail: "Incorrect API key provided: sk-Eyftb****************************99vW",
    });

    expect(failure.message).not.toContain("sk-Eyftb");
    expect(failure.message).not.toContain("99vW");
    expect(failure.message).toContain(REDACTED);
  });

  it("carries a request id, which is a support handle rather than a secret", () => {
    const failure = engineFailure("anthropic", "provider_unavailable", {
      requestId: "req_011CX",
      retryable: true,
    });
    expect(failure.message).toContain("req_011CX");
    expect(failure.message).toContain("Anthropic request");
  });

  it("omits `retryable` entirely when terminal, rather than setting it false", () => {
    // Terminal is the ABSENCE of the flag everywhere in this feature. Two
    // spellings of the same fact is how a reader concludes they differ.
    expect(engineFailure("openai", "invalid_key")).not.toHaveProperty("retryable");
    expect(engineFailure("openai", "rate_limited", { retryable: true }).retryable).toBe(true);
  });

  it("defaults `kind` from the code — only `refused` is a refusal", () => {
    expect(engineFailure("gemini", "refused").kind).toBe("refused");
    expect(engineFailure("gemini", "bad_response").kind).toBe("error");
  });
});

describe("codeForStatus", () => {
  it.each([
    [401, "invalid_key"],
    [403, "invalid_key"],
    [429, "rate_limited"],
    [408, "provider_unavailable"],
    [500, "provider_unavailable"],
    [529, "provider_unavailable"],
    [400, "bad_response"],
    [404, "bad_response"],
    [422, "bad_response"],
  ] as [number, EngineFailureCode][])("maps %i to %s", (status, code) => {
    expect(codeForStatus(status)).toBe(code);
  });

  it("agrees with `isRetryableCode` about what a second call can fix", () => {
    expect(isRetryableCode(codeForStatus(429))).toBe(true);
    expect(isRetryableCode(codeForStatus(503))).toBe(true);
    expect(isRetryableCode(codeForStatus(401))).toBe(false);
    expect(isRetryableCode(codeForStatus(404))).toBe(false);
    expect(isRetryableCode("quota_exceeded")).toBe(false);
    expect(isRetryableCode("refused")).toBe(false);
  });
});

describe("logEngineFailure", () => {
  it("scrubs the body on the way into the log — the log is the durable copy", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    logEngineFailure(
      "openai",
      401,
      "invalid_key",
      '{"error":{"message":"Incorrect API key provided: sk-Eyftb****************************99vW."}}'
    );

    const line = spy.mock.calls[0].join(" ");
    expect(line).not.toContain("sk-Eyftb");
    expect(line).not.toContain("99vW");
    // The useful part survives: which engine, which status, which verdict.
    expect(line).toContain("openai 401 -> invalid_key");
  });

  it("truncates a provider error page instead of logging a megabyte of it", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    logEngineFailure("gemini", 502, "provider_unavailable", "x".repeat(5_000));

    expect(spy.mock.calls[0].join(" ").length).toBeLessThan(500);
  });
});
