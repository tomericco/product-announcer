import { describe, it, expect, beforeEach, vi } from "vitest";
import { probeEngineKey, verifyEngineKey } from "../../../../src/lib/ai-visibility/engines/verify";
import type { EngineClient } from "../../../../src/lib/ai-visibility/types";

/**
 * Verification is two calls, and the SECOND one is the point.
 *
 * The free probe catches typos and revoked keys. It cannot catch the failure
 * that actually strands people: a perfectly valid key on an account with no
 * credit passes every authentication check ever written and then fails every
 * call. Zapier is the only surveyed product that warns about it, and our own
 * "how to get a key" copy calls that step out for the same reason.
 *
 * So every test here is really about the ORDER and the CONJUNCTION: cheap
 * first, and both must pass.
 */

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/** An engine client that answers, and records that it was asked. */
function answering(calls: { prompt: string; apiKey?: string }[]): EngineClient {
  return {
    id: "openai",
    label: "openai (answering)",
    ask: async (prompt, deps) => {
      calls.push({ prompt, apiKey: deps?.apiKey });
      return {
        text: "A changelog is a dated list of product changes.",
        modelId: "gpt-5.5",
        citations: [],
        searchUsed: false,
        searchQueries: [],
        raw: {},
        costUsd: 0.25,
      };
    },
  };
}

describe("probeEngineKey — the free half", () => {
  it("passes on a 200 and sends the key in a header, never a URL", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: new Headers(init.headers) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    expect(await probeEngineKey("gemini", "AIza-secret", { fetchImpl })).toEqual({ ok: true });
    // A key in a query string reaches proxy logs, Referer headers and error
    // strings — none of which we control.
    expect(seen[0].url).not.toContain("AIza-secret");
    expect(seen[0].headers.get("x-goog-api-key")).toBe("AIza-secret");
  });

  it("reads Gemini's 400 INVALID_ARGUMENT as a bad KEY, not as our bug", async () => {
    // Gemini rejects a bad key with 400, not 401. Without the body check a
    // customer's typo would be reported as "that is ours to fix" and never get
    // fixed.
    const fetchImpl = (async () =>
      new Response('{"error":{"status":"INVALID_ARGUMENT","message":"API key not valid"}}', {
        status: 400,
      })) as unknown as typeof fetch;

    expect(await probeEngineKey("gemini", "AIza-typo", { fetchImpl })).toEqual({
      ok: false,
      code: "invalid_key",
    });
  });

  it("never returns the provider's body, which quotes the key back at you", async () => {
    const body =
      '{"error":{"message":"Incorrect API key provided: sk-Eyftb****************************99vW.","code":"invalid_api_key"}}';
    const fetchImpl = (async () => new Response(body, { status: 401 })) as unknown as typeof fetch;

    const result = await probeEngineKey("openai", "sk-whatever", { fetchImpl });

    expect(result).toEqual({ ok: false, code: "invalid_key" });
    // The shape of CVE-2025-0330: an OpenAI 401 echoes the key's prefix and its
    // last four characters. Under BYOK that is a customer secret.
    expect(JSON.stringify(result)).not.toContain("sk-Eyftb");
    expect(JSON.stringify(result)).not.toContain("99vW");
  });

  it("a transport failure is `provider_unavailable`, not a bad key", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    expect(await probeEngineKey("openai", "sk-x", { fetchImpl })).toEqual({
      ok: false,
      code: "provider_unavailable",
    });
  });
});

describe("verifyEngineKey — both halves, in order", () => {
  it("does not spend the paid call when the free probe already failed", async () => {
    const calls: { prompt: string }[] = [];
    const fetchImpl = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;

    const result = await verifyEngineKey("openai", "sk-typo", {
      fetchImpl,
      clients: { openai: answering(calls) },
    });

    expect(result).toEqual({ ok: false, status: "invalid_key" });
    // The great majority of bad pastes are typos, and a typo should cost
    // nothing to discover.
    expect(calls).toEqual([]);
  });

  it("makes one REAL grounded call on the tenant's own key after the probe passes", async () => {
    const calls: { prompt: string; apiKey?: string }[] = [];
    const fetchImpl = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

    const result = await verifyEngineKey("openai", "sk-theirs", {
      fetchImpl,
      clients: { openai: answering(calls) },
    });

    expect(result).toEqual({ ok: true, costUsd: 0.25 });
    expect(calls).toHaveLength(1);
    // Their key, not ours. The whole call exists to prove THIS credential can
    // buy an answer.
    expect(calls[0].apiKey).toBe("sk-theirs");
  });

  it("fails a key that authenticates and then cannot pay — the failure a probe cannot see", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const broke: EngineClient = {
      id: "openai",
      label: "openai (no credit)",
      ask: async () => ({
        kind: "error" as const,
        code: "quota_exceeded" as const,
        message: "The key is valid, but the account is out of credit.",
      }),
    };

    expect(
      await verifyEngineKey("openai", "sk-valid-but-broke", { fetchImpl, clients: { openai: broke } })
    ).toEqual({ ok: false, status: "quota_exceeded" });
  });

  it("treats a REFUSAL as a pass — the model authenticated, read the prompt and billed for it", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const refusing: EngineClient = {
      id: "openai",
      label: "openai (refusing)",
      ask: async () => ({
        kind: "refused" as const,
        code: "refused" as const,
        message: "ChatGPT read the prompt and declined to answer it.",
        costUsd: 0.25,
      }),
    };

    // Every part of the path this call exists to test worked. Failing over the
    // model's opinion of one throwaway question would refuse a working key.
    expect(
      await verifyEngineKey("openai", "sk-fine", { fetchImpl, clients: { openai: refusing } })
    ).toEqual({ ok: true, costUsd: 0.25 });
  });

  it("does not blame the key for OUR bug", async () => {
    // `bad_response` is a shape we read wrong or a model id that no longer
    // resolves. It says nothing about the credential, so storing it as
    // `invalid_key` would send someone to replace a key that is fine.
    const fetchImpl = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const ourBug: EngineClient = {
      id: "openai",
      label: "openai (bad shape)",
      ask: async () => ({
        kind: "error" as const,
        code: "bad_response" as const,
        message: "OpenAI answered in a shape this app could not read.",
      }),
    };

    expect(
      await verifyEngineKey("openai", "sk-fine", { fetchImpl, clients: { openai: ourBug } })
    ).toEqual({ ok: false, status: "provider_unavailable" });
  });
});
