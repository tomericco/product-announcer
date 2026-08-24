import { ENGINE_CLIENTS } from "@/lib/ai-visibility/engines";
import {
  classifyHttpFailure,
  logEngineFailure,
  type EngineFailureCode,
} from "@/lib/ai-visibility/engines/failure";
import { ENGINE_REQUEST_TIMEOUT_MS } from "@/lib/ai-visibility/engines/shape";
import { ANTHROPIC_API_VERSION } from "@/lib/ai-visibility/engines/anthropic";
import { GEMINI_MODELS_ENDPOINT } from "@/lib/ai-visibility/engines/gemini";
import { scrubError } from "@/lib/ai-visibility/scrub";
import type { EngineId } from "@/lib/ai-visibility/types";
import type { EngineKeyStatus } from "@/lib/ai-visibility/engine-keys";

/**
 * Verify a key before storing it — design Decision 3, and the reason the save
 * button IS the verify button.
 *
 * There is no "save without checking" path anywhere in this feature, because a
 * key that was never exercised is a key that fails during a scheduled sweep at
 * 09:00 UTC with nobody watching. Vercel's wording is the model: "Click Test
 * Key to validate and add your credentials." Langfuse fires a real completion
 * before writing the record; n8n tests on save; Dify validates before making
 * the provider available.
 *
 * ### Two calls, and why one is not enough
 *
 * 1. A **free auth probe** — `GET /v1/models`, `GET /v1beta/models`. Catches a
 *    typo, a paste of the wrong secret, and a revoked key instantly, for
 *    nothing.
 * 2. **One real grounded call**, the same shape a run makes. This is the one
 *    the probe cannot do: a perfectly valid key on an account with no credit
 *    passes every authentication check ever written and then fails every call.
 *    Zapier is the only surveyed product that warns about it, and it is the
 *    single most common way a BYOK setup silently does not work.
 *
 * The second call costs roughly $0.25 (OpenAI), $0.07 (Gemini) or $0.09
 * (Anthropic), once, on the tenant's own key, quoted in the UI before it
 * happens. That is acceptable against a ~$6.20 run, and the alternative is
 * finding out 84 calls into a paid one.
 *
 * ### Never on a timer
 *
 * A recurring paid call the tenant did not ask for is precisely what BYOK
 * exists to stop. Re-verification happens on an explicit Re-check, and
 * implicitly on every run — never on a schedule.
 */

/** The prompt the paid half of verification asks. */
const VERIFY_PROMPT = "In one sentence, what is a product changelog?";

type ProbeEndpoint = { url: string; headers: (key: string) => Record<string, string> };

/**
 * The free auth endpoint per provider. All three are documented list-models
 * calls, all three are billed at nothing, and all three reject a bad key with
 * the same status a real call would.
 *
 * Gemini's is the one worth naming: it rejects a bad key with **400
 * INVALID_ARGUMENT**, not 401, which is why `classifyHttpFailure` consults the
 * body for a key marker rather than trusting the status alone. Without that a
 * customer's typo would be reported as "that is ours to fix".
 */
const PROBES: Record<EngineId, ProbeEndpoint> = {
  openai: {
    url: "https://api.openai.com/v1/models",
    headers: (key) => ({ authorization: `Bearer ${key}` }),
  },
  gemini: {
    // Header rather than `?key=`: the key must never end up in a URL, where it
    // reaches proxy logs, `Referer` headers and error strings.
    url: GEMINI_MODELS_ENDPOINT,
    headers: (key) => ({ "x-goog-api-key": key }),
  },
  anthropic: {
    url: "https://api.anthropic.com/v1/models",
    headers: (key) => ({ "x-api-key": key, "anthropic-version": ANTHROPIC_API_VERSION }),
  },
};

export type ProbeResult = { ok: true } | { ok: false; code: EngineFailureCode };

/**
 * The free half. Reads the body to classify, and keeps none of it.
 *
 * Like every other client boundary in this feature: the provider's own text is
 * read, used to decide which of the six codes applies, logged scrubbed, and
 * dropped. An OpenAI 401 body quotes the submitted key's prefix and its last
 * four characters — under BYOK that is a customer secret, and the whole point
 * of the closed code set is that it cannot travel any further than this.
 */
export async function probeEngineKey(
  engine: EngineId,
  apiKey: string,
  deps: { fetchImpl?: typeof fetch } = {}
): Promise<ProbeResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const probe = PROBES[engine];

  let response: Response;
  try {
    response = await fetchImpl(probe.url, {
      method: "GET",
      signal: AbortSignal.timeout(ENGINE_REQUEST_TIMEOUT_MS),
      headers: probe.headers(apiKey),
    });
  } catch (error) {
    // The error stays out of everything that leaves here: a fetch failure can
    // carry the request it failed on, and that request has the key in a header.
    // Scrubbed server log only — through `scrubError`, because handing the
    // object to `console.error` formats it without the scrubber ever seeing it.
    console.error(`[ai-visibility] ${engine} key probe failed: ${scrubError(error)}`);
    return { ok: false, code: "provider_unavailable" };
  }

  if (response.ok) return { ok: true };

  const body = await response.text().catch(() => "");
  const failure = classifyHttpFailure(engine, response.status, body, response.headers);
  logEngineFailure(engine, response.status, failure.code, body);
  return { ok: false, code: failure.code };
}

export type VerifyResult =
  | { ok: true; costUsd: number }
  | { ok: false; status: Exclude<EngineKeyStatus, "verified" | "unreadable"> };

/**
 * How a failure code becomes a stored status.
 *
 * Four of the six map straight across. The two that do not:
 *
 *  - `bad_response` is OUR bug — a shape we read wrong, a model id that no
 *    longer resolves. It says nothing at all about the key, so storing it as
 *    `invalid_key` would tell a tenant to replace a credential that is fine.
 *    It becomes `provider_unavailable`, which is the honest "we could not
 *    confirm this right now, try again".
 *  - `refused` means the model READ the prompt and declined. That is an
 *    authenticated, billed, successful round trip — the key works — so it never
 *    reaches this function as a failure at all (see `verifyEngineKey`).
 */
function statusForCode(code: EngineFailureCode): Exclude<EngineKeyStatus, "verified" | "unreadable"> {
  switch (code) {
    case "invalid_key":
      return "invalid_key";
    case "quota_exceeded":
      return "quota_exceeded";
    case "rate_limited":
      return "rate_limited";
    default:
      return "provider_unavailable";
  }
}

/**
 * Probe, then one real grounded call. Both must pass.
 *
 * Ordered cheap-first on purpose: a typo should cost nothing to discover, and
 * the great majority of failed pastes are typos. The paid call only ever
 * happens behind a key that has already authenticated.
 *
 * Returns a STATUS, never a message and never a provider body — the copy lives
 * in the card, keyed off the status, so the same four sentences are used by the
 * save path, the Re-check path and the run's own auto-pause.
 */
export async function verifyEngineKey(
  engine: EngineId,
  apiKey: string,
  deps: { fetchImpl?: typeof fetch; clients?: Partial<Record<EngineId, (typeof ENGINE_CLIENTS)[EngineId]>> } = {}
): Promise<VerifyResult> {
  const probe = await probeEngineKey(engine, apiKey, deps);
  if (!probe.ok) return { ok: false, status: statusForCode(probe.code) };

  const client = deps.clients?.[engine] ?? ENGINE_CLIENTS[engine];
  const answer = await client.ask(VERIFY_PROMPT, { apiKey, fetchImpl: deps.fetchImpl });

  if ("kind" in answer) {
    // A refusal is a PASS. The model authenticated, read the prompt, decided
    // not to answer it and billed for the privilege — every part of the path
    // this call exists to test worked. Failing verification on it would refuse
    // a working key over the model's opinion of one throwaway question.
    if (answer.kind === "refused") return { ok: true, costUsd: answer.costUsd ?? 0 };
    return { ok: false, status: statusForCode(answer.code) };
  }

  return { ok: true, costUsd: answer.costUsd };
}
