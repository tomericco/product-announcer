import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ENGINE_FAILURE_CODES,
  RETRY_WINDOW_MS,
  classifyHttpFailure,
  codeForStatus,
  engineFailure,
  engineFailureMessage,
  isRetryableCode,
  logEngineFailure,
  parseRetryAfterMs,
  type EngineFailureCode,
} from "../../../../src/lib/ai-visibility/engines/failure";
import { isCredentialFailure } from "../../../../src/lib/ai-visibility/engine-keys";
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

describe("parseRetryAfterMs", () => {
  it("reads `retry-after` as seconds", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after": "20" }), "")).toBe(20_000);
    expect(parseRetryAfterMs(new Headers({ "retry-after": " 1.5 " }), "")).toBe(1_500);
  });

  it("reads `retry-after` as an HTTP-date, relative to the clock we pass in", () => {
    const now = Date.parse("2026-03-02T09:00:00Z");
    const headers = new Headers({ "retry-after": "Mon, 02 Mar 2026 09:00:45 GMT" });
    expect(parseRetryAfterMs(headers, "", now)).toBe(45_000);
  });

  it("treats a date already in the past as zero, not as a wait of minus forever", () => {
    const now = Date.parse("2026-03-02T09:01:00Z");
    const headers = new Headers({ "retry-after": "Mon, 02 Mar 2026 09:00:00 GMT" });
    expect(parseRetryAfterMs(headers, "", now)).toBe(0);
  });

  it("falls back to Google's `RetryInfo.retryDelay` in the body", () => {
    // Gemini does not send a `retry-after` header; the wait is a detail block.
    const body = '{"error":{"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"58s"}]}}';
    expect(parseRetryAfterMs(new Headers(), body)).toBe(58_000);
  });

  it("returns undefined when the provider said nothing — not zero", () => {
    // "No guidance" and "retry immediately" are different instructions, and
    // only one of them may replace our ladder.
    expect(parseRetryAfterMs(new Headers(), "{}")).toBeUndefined();
    expect(parseRetryAfterMs(undefined, "")).toBeUndefined();
  });
});

describe("classifyHttpFailure — the 429 split", () => {
  it("openai: a throughput 429 is retryable and carries the provider's wait", () => {
    const failure = classifyHttpFailure(
      "openai",
      429,
      '{"error":{"message":"Rate limit reached","type":"requests"}}',
      new Headers({ "retry-after": "20" })
    );
    expect(failure).toEqual({ code: "rate_limited", retryable: true, retryAfterMs: 20_000 });
  });

  it("openai: `insufficient_quota` on the SAME status is terminal", () => {
    // The account has no credit. Same 429, opposite remedy — this is the split
    // the whole change exists for.
    const failure = classifyHttpFailure(
      "openai",
      429,
      '{"error":{"message":"You exceeded your current quota","code":"insufficient_quota"}}'
    );
    expect(failure).toEqual({ code: "quota_exceeded", retryable: false });
  });

  it("anthropic: the spend cap is terminal, and it arrives with no `retry-after`", () => {
    // Anthropic's spend-cap 429 sends no wait at all — the error code is the
    // only thing that distinguishes it from throughput.
    const failure = classifyHttpFailure(
      "anthropic",
      429,
      '{"type":"error","error":{"type":"rate_limit_error","message":"limit reached","details":{"error_code":"enforced_spend_limit_reached"}}}',
      new Headers()
    );
    expect(failure).toEqual({ code: "quota_exceeded", retryable: false });
  });

  it("anthropic: an out-of-credit 400 is quota, not `bad_response`", () => {
    // Status alone would call this our bug and tell the customer nothing.
    const failure = classifyHttpFailure(
      "anthropic",
      400,
      '{"error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API"}}'
    );
    expect(failure.code).toBe("quota_exceeded");
  });

  it("gemini: a per-day quota is terminal; an ordinary RESOURCE_EXHAUSTED is not", () => {
    const perDay = classifyHttpFailure(
      "gemini",
      429,
      '{"error":{"status":"RESOURCE_EXHAUSTED","details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel"}]}]}}'
    );
    expect(perDay.code).toBe("quota_exceeded");

    const throughput = classifyHttpFailure(
      "gemini",
      429,
      '{"error":{"status":"RESOURCE_EXHAUSTED","message":"Resource has been exhausted"}}'
    );
    expect(throughput).toEqual({ code: "rate_limited", retryable: true });
  });

  it("a wait longer than the whole ladder is TERMINAL, and still `rate_limited`", () => {
    // The provider is telling us the wait outlasts every attempt we would make,
    // so three attempts buy three failures — `retryable: false`, and this run
    // stops asking.
    //
    // The CODE does not move. It used to become `quota_exceeded`, which is not
    // a scheduling word: `isCredentialFailure` reads that one as a verdict on
    // the key and pauses the engine until a human presses Re-check. A slow rate
    // limit is a rate limit.
    const body = `{"error":{"details":[{"retryDelay":"${(RETRY_WINDOW_MS / 1000) + 10}s"}]}}`;
    expect(classifyHttpFailure("gemini", 429, body)).toEqual({
      code: "rate_limited",
      retryable: false,
    });

    // Exactly at the boundary is still retryable — the last attempt lands.
    const atLimit = `{"error":{"details":[{"retryDelay":"${RETRY_WINDOW_MS / 1000}s"}]}}`;
    expect(classifyHttpFailure("gemini", 429, atLimit).code).toBe("rate_limited");
  });

  it("openai: a Tier 1 TPM 429 is never a credential verdict, however long the wait", () => {
    // The regression. This body is the most likely first-run experience a BYOK
    // tenant has (design Decision 9: OpenAI Tier 1 is 30,000 TPM and one
    // grounded call is ~25,000 tokens), and it used to come back
    // `quota_exceeded` — which writes `status: "quota_exceeded"` on the key row,
    // drops the engine out of `effectiveEngines` for every future run, and puts
    // a "No credit" badge in front of a fully-funded customer.
    const failure = classifyHttpFailure(
      "openai",
      429,
      '{"error":{"code":"rate_limit_exceeded","message":"Rate limit reached for gpt-5 in organization org-x on tokens per min (TPM). Limit 30000, Used 29984. Please try again in 120s."}}',
      new Headers({ "retry-after": "120" })
    );

    expect(failure).toEqual({ code: "rate_limited", retryable: false });
    // Said as the property that matters, not only as the code: the key row is
    // flipped off `isCredentialFailure`, and nothing about throughput may reach
    // it. `engine-keys.ts` holds the other half of this rule.
    expect(isCredentialFailure(failure.code)).toBe(false);
  });

  it("gemini: `billing account` in a 503 body does not become a permanent verdict", () => {
    // "Billing account" is the ordinary name of a Cloud Billing account and it
    // turns up in bodies that have nothing to do with a spend cap. It was a
    // guessed marker — no published sample of Gemini's cap body was ever
    // available — and it beat the status code unconditionally, so a transient
    // 503 mentioning one paused the engine permanently.
    expect(
      classifyHttpFailure(
        "gemini",
        503,
        '{"error":{"code":503,"status":"UNAVAILABLE","message":"The service is temporarily unavailable for this billing account."}}'
      )
    ).toEqual({ code: "provider_unavailable", retryable: true });

    // The published marker still wins on the status a cap actually wears.
    expect(
      classifyHttpFailure(
        "gemini",
        429,
        '{"error":{"details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProject"}]}]}}'
      ).code
    ).toBe("quota_exceeded");
  });

  it("a body naming BOTH the key and a quota reports the key", () => {
    // Two remedies, and only one of them works. Paying an invoice does not fix
    // a revoked key, so the credential reading has to be the one that survives.
    const failure = classifyHttpFailure(
      "gemini",
      400,
      '{"error":{"message":"API key not valid. Check the billing account quotaId PerDay for this project.","details":[{"reason":"API_KEY_INVALID"}]}}'
    );
    expect(failure).toEqual({ code: "invalid_key", retryable: false });
  });

  it("gemini: a bad key wearing a 400 is `invalid_key`, not our bug", () => {
    // Google rejects a bad key with 400 INVALID_ARGUMENT rather than 401, so
    // without the body check a customer's typo reads as "ours to fix".
    const failure = classifyHttpFailure(
      "gemini",
      400,
      '{"error":{"code":400,"message":"API key not valid","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}'
    );
    expect(failure).toEqual({ code: "invalid_key", retryable: false });
  });

  it("leaves every non-429 status reading exactly as the status table says", () => {
    expect(classifyHttpFailure("openai", 401, "{}").code).toBe("invalid_key");
    expect(classifyHttpFailure("openai", 404, "{}")).toEqual({
      code: "bad_response",
      retryable: false,
    });
    expect(classifyHttpFailure("openai", 503, "{}")).toEqual({
      code: "provider_unavailable",
      retryable: true,
    });
  });

  it("never returns anything drawn from the body", () => {
    const failure = classifyHttpFailure(
      "openai",
      401,
      '{"error":{"message":"Incorrect API key provided: sk-Eyftb****99vW"}}'
    );
    expect(JSON.stringify(failure)).not.toContain("sk-Eyftb");
    expect(JSON.stringify(failure)).not.toContain("99vW");
  });
});
