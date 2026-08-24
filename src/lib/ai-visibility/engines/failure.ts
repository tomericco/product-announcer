import { scrubSecrets } from "@/lib/ai-visibility/scrub";
import type { EngineError, EngineId } from "@/lib/ai-visibility/types";

/**
 * The closed set of things that can go wrong with an engine call, and the only
 * vocabulary allowed to leave a client.
 *
 * ### Why a closed set
 *
 * Before this, a failed call returned the provider's own body:
 * `` `openai ${response.status}: ${body.slice(0, 300)}` ``. That string was
 * written to `ai_visibility_samples.error`, summarised into
 * `sources.lastError`, and interpolated into the overview page. An OpenAI 401
 * body quotes the submitted key's prefix and its last four characters back at
 * you; the organization variant quotes the org id. Today that is our key. Under
 * BYOK it is a customer's secret, rendered to whoever opens the page and stored
 * unencrypted in two tables — the shape of CVE-2025-0330 (CVSS 7.5), and
 * CWE-209 by name.
 *
 * So the client boundary is where provider text stops. A client reads the body,
 * decides which of these six things happened, and returns the CODE plus a
 * sentence WE wrote. The body itself may be logged server-side, scrubbed, and
 * goes nowhere else.
 *
 * The six, and the line between them:
 *
 *  - `invalid_key` — 401/403, or a body that names the key as the problem. The
 *    credential is wrong, revoked, or expired.
 *  - `quota_exceeded` — the account is out of money or has hit a spend cap.
 *    TERMINAL: no wait inside a run's lifetime fixes it.
 *  - `rate_limited` — throughput. Retryable, and the provider may tell us how
 *    long to wait.
 *  - `provider_unavailable` — 5xx, a timeout, a dropped connection. Nothing
 *    reached the model, or nothing came back.
 *  - `bad_response` — a request we built wrong, a model id that no longer
 *    resolves, or a body shaped differently than we read it. OUR bug, not the
 *    tenant's; retrying buys an identical failure.
 *  - `refused` — the model read the prompt and declined. That IS the
 *    measurement, and it was billed in full.
 */
export const ENGINE_FAILURE_CODES = [
  "invalid_key",
  "quota_exceeded",
  "rate_limited",
  "provider_unavailable",
  "bad_response",
  "refused",
] as const;

export type EngineFailureCode = (typeof ENGINE_FAILURE_CODES)[number];

/**
 * How each engine is named to a human, and where its billing lives.
 *
 * `product` is what a marketer typed into a browser ("ChatGPT"); `provider` is
 * whose account and whose invoice it is ("OpenAI"). Decision 4's copy needs
 * both and they are not interchangeable — the person who has a ChatGPT Plus
 * subscription and no OpenAI platform account is the exact person this feature
 * confuses, so the sentence has to distinguish them.
 */
const ENGINE_VOICE: Record<
  EngineId,
  { product: string; provider: string; keyPrefix: string; keyHint: string; billingUrl: string }
> = {
  openai: {
    product: "ChatGPT",
    provider: "OpenAI",
    keyPrefix: "sk-",
    keyHint: "rather than an organization ID",
    billingUrl: "platform.openai.com/settings/billing",
  },
  gemini: {
    product: "Gemini",
    provider: "Google",
    keyPrefix: "AIza",
    keyHint: "rather than an OAuth client secret or a project number",
    billingUrl: "console.cloud.google.com/billing",
  },
  anthropic: {
    product: "Claude",
    provider: "Anthropic",
    keyPrefix: "sk-ant-",
    keyHint: "rather than an admin key or a workspace ID",
    billingUrl: "console.anthropic.com/settings/billing",
  },
};

/**
 * The sentence a human reads, per code — design Decision 4.
 *
 * Shaped after Zed's: name the provider, name the cause, name the next action.
 * Four states, never three: LibreChat ships all four distinctly and Dify
 * conflates two into "check that your API key has not expired and has
 * sufficient quota", which tells a marketer to check two things and fix
 * neither.
 *
 * Two deliberate departures from the design's table, both because the surface
 * it was written for does not exist yet:
 *
 *  - no "try Re-check" — there is no Re-check button until the engine-keys card
 *    ships, and naming a control that is not on screen is worse than naming
 *    none;
 *  - no "paste the key again" — same reason. The action a tenant can take today
 *    is on the provider's side, so that is what these say.
 *
 * Update both when the card lands.
 */
export function engineFailureMessage(engine: EngineId, code: EngineFailureCode): string {
  const voice = ENGINE_VOICE[engine];
  switch (code) {
    case "invalid_key":
      return `${voice.product} rejected the API key. Check it was copied whole, and that it is a secret key (starts \`${voice.keyPrefix}\`) ${voice.keyHint}.`;
    case "quota_exceeded":
      return `The key is valid, but the ${voice.provider} account behind it is out of credit or has hit a spend cap. Top it up at ${voice.billingUrl} — retrying inside this run cannot help.`;
    case "rate_limited":
      return `${voice.provider} is rate-limiting this key — new accounts start on a low-throughput tier. Lower the concurrency in AI-visibility settings, or leave it: the next run tries again.`;
    case "provider_unavailable":
      return `Couldn't reach ${voice.provider} just now. This is usually temporary — the next run tries again.`;
    case "bad_response":
      return `${voice.provider} answered in a shape this app could not read. That is ours to fix — nothing is wrong with the key or the account.`;
    case "refused":
      return `${voice.product} read the prompt and declined to answer it.`;
  }
}

/**
 * Builds the `EngineError` a client returns.
 *
 * The ONLY constructor clients use, so "no provider text leaves here" is one
 * rule enforced in one place rather than nine literals that each have to
 * remember it.
 *
 * `detail` is for OUR words and nothing else — a fixed literal the client
 * chose, like "truncated answer" or "unreadable grounding metadata". It is not
 * a hole to post the body through: it goes through `scrubSecrets` on the way
 * out, along with everything else, so even a mistake here cannot carry a key.
 *
 * `requestId` is a provider correlation id (`x-request-id`, `request-id`). Not
 * a secret, and the one thing support can hand back to a provider, so it is
 * appended to the message rather than dropped — the column that stores this has
 * no room for a second field.
 */
export function engineFailure(
  engine: EngineId,
  code: EngineFailureCode,
  opts: {
    kind?: "error" | "refused";
    detail?: string;
    requestId?: string | null;
    retryable?: boolean;
    costUsd?: number;
  } = {}
): EngineError {
  const parts = [engineFailureMessage(engine, code)];
  if (opts.detail) parts.push(`(${opts.detail})`);
  if (opts.requestId) parts.push(`[${ENGINE_VOICE[engine].provider} request ${opts.requestId}]`);

  return {
    kind: opts.kind ?? (code === "refused" ? "refused" : "error"),
    code,
    message: scrubSecrets(parts.join(" ")),
    // Spread rather than `retryable: false`: terminal is the ABSENCE of the
    // flag everywhere in this feature, and one path saying it a second way is
    // how a reader concludes the two mean different things.
    ...(opts.retryable ? { retryable: true as const } : {}),
    ...(opts.costUsd !== undefined ? { costUsd: opts.costUsd } : {}),
  };
}

/**
 * The one place a provider's raw body is allowed to go: a server log, scrubbed.
 *
 * Called by every client on the non-2xx path. Deliberately takes the BODY TEXT
 * and not the `Response`, because response HEADERS must never be logged —
 * `anthropic-organization-id` lives there, and a helper that took the whole
 * response is a helper somebody will one day dump.
 *
 * The status and the code are the useful part; the body is truncated because a
 * provider 502 can be a megabyte of HTML.
 */
export function logEngineFailure(
  engine: EngineId,
  status: number,
  code: EngineFailureCode,
  bodyText: string
): void {
  console.error(
    `[ai-visibility] ${engine} ${status} -> ${code}: ${scrubSecrets(bodyText.slice(0, 300))}`
  );
}

/**
 * Which of the six a non-2xx HTTP status is.
 *
 * Status alone, no body — the plain reading, shared by all three clients so the
 * classification cannot drift between them. Body-sensitive cases (a spend cap
 * wearing a 429, a Gemini key rejection wearing a 400) are a layer on top of
 * this, not a rewrite of it.
 */
export function codeForStatus(status: number): EngineFailureCode {
  if (status === 401 || status === 403) return "invalid_key";
  if (status === 429) return "rate_limited";
  // 408 is a server-side timeout; 425 and 499 are the same family of "try
  // again". Everything else in the 4xx range is about the REQUEST we sent.
  if (status === 408 || status === 425 || status === 499) return "provider_unavailable";
  if (status >= 500) return "provider_unavailable";
  return "bad_response";
}

/** Whether a code is worth spending another call on. */
export function isRetryableCode(code: EngineFailureCode): boolean {
  return code === "rate_limited" || code === "provider_unavailable";
}
