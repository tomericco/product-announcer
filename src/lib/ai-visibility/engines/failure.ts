import { scrubSecrets } from "@/lib/ai-visibility/scrub";
import type { EngineError, EngineId, EngineUsage } from "@/lib/ai-visibility/types";

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
 *    TERMINAL, and a verdict on the CREDENTIAL: `isCredentialFailure` flips the
 *    stored key row over this one, so nothing may reach it on a guess.
 *  - `rate_limited` — throughput. The account is fine and the key is fine; the
 *    calls are arriving too fast. Whether another attempt is worth paying for
 *    is `retryable`'s business, not this code's — see `classifyHttpFailure`.
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
 * The card has landed, so these now name the controls that are actually on
 * screen — Re-check, and pasting a replacement. They did not before, because
 * naming a control that does not exist is worse than naming none.
 *
 * One thing they still do NOT name: concurrency. It is a per-tenant column with
 * a conservative default of 3, and it is deliberately not a field on the
 * settings card — "cadence, day of week, samples per prompt, monthly budget"
 * is the whole list that surface owns, and every extra number is a number a
 * marketer can get wrong. So the `rate_limited` sentence says what a tenant can
 * actually do about a Tier 1 throughput limit, which is wait.
 *
 * These are the sentences a RUN writes onto a sample row. The card's own copy
 * for a stored key lives in `settings/engine-key-copy.ts` — same six states,
 * different room: one describes a call that failed hours ago, the other a
 * credential someone is looking at right now.
 */
export function engineFailureMessage(engine: EngineId, code: EngineFailureCode): string {
  const voice = ENGINE_VOICE[engine];
  switch (code) {
    case "invalid_key":
      return `${voice.product} rejected the API key. Check it was copied whole, and that it is a secret key (starts \`${voice.keyPrefix}\`) ${voice.keyHint} — then paste it again in AI-visibility settings.`;
    case "quota_exceeded":
      return `The key is valid, but the ${voice.provider} account behind it is out of credit or has hit a spend cap. Top it up at ${voice.billingUrl}, then press Re-check in AI-visibility settings — retrying inside this run cannot help.`;
    case "rate_limited":
      return `${voice.provider} is rate-limiting this key — new accounts start on a low-throughput tier, and the limit lifts as the account ages. Nothing to change: the next run tries again.`;
    case "provider_unavailable":
      return `Couldn't reach ${voice.provider} just now. This is usually temporary — the next run tries again.`;
    case "bad_response":
      return `${voice.provider} answered in a shape this app could not read. That is ours to fix — nothing is wrong with the key or the account.`;
    case "refused":
      return `${voice.product} read the prompt and declined to answer it.`;
  }
}

/**
 * The sentence for a sample that was never ASKED, because the workspace has no
 * usable key for its engine.
 *
 * A separate sentence from `engineFailureMessage("invalid_key")` on purpose:
 * that one says the provider rejected a key, and here no provider was
 * contacted. Telling a tenant that ChatGPT rejected a key they never pasted is
 * the same class of lie as Zed's "invalid or has expired" over a keychain
 * failure, and it sends them to fix the wrong thing.
 *
 * The four reasons get four remedies, which is Decision 4's rule applied to
 * this layer — `unreadable` above all must not collapse into "your key is
 * wrong", because the fault is in OUR key material and no key they paste will
 * help until we fix it.
 */
export function engineKeyFailureMessage(
  engine: string,
  reason: "missing" | "disabled" | "unusable" | "unreadable"
): string {
  const voice = ENGINE_VOICE[engine as EngineId];
  const product = voice?.product ?? engine;
  switch (reason) {
    case "missing":
      return `No ${product} key is connected for this workspace, so this answer was not collected. Connect one in AI-visibility settings.`;
    case "disabled":
      return `The ${product} key is saved but switched off, so this answer was not collected.`;
    case "unusable":
      return `The ${product} key needs attention before it can be used again — see its status in AI-visibility settings.`;
    case "unreadable":
      return `This workspace's stored ${product} key could not be read. That is a fault on our side, not with your key — the key itself is fine, and re-pasting it will not help until we fix it.`;
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
    retryAfterMs?: number;
    costUsd?: number;
    usage?: EngineUsage;
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
    // Only meaningful alongside `retryable` — a terminal failure has no next
    // attempt to schedule — so it is dropped rather than stored on one.
    ...(opts.retryable && opts.retryAfterMs !== undefined
      ? { retryAfterMs: opts.retryAfterMs }
      : {}),
    ...(opts.costUsd !== undefined ? { costUsd: opts.costUsd } : {}),
    ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
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

/**
 * Whether a code is worth spending another call on, from the code ALONE.
 *
 * The default, not the verdict. `classifyHttpFailure` can still return
 * `rate_limited` with `retryable: false` — a provider that asks for a longer
 * wait than the whole ladder has answered the retry question itself, and the
 * code stays `rate_limited` because the code describes the LIMIT, not the
 * schedule. Read `HttpFailure.retryable` for the decision; this is only what to
 * assume when nothing said otherwise.
 */
export function isRetryableCode(code: EngineFailureCode): boolean {
  return code === "rate_limited" || code === "provider_unavailable";
}

/**
 * The whole retry ladder for one sample, in milliseconds.
 *
 * `run.ts` owns the ladder itself (`SAMPLE_RETRY_BACKOFF_MS` = 30s then 60s);
 * this is its total, restated here because `failure.ts` cannot import `run.ts`
 * — `run.ts` imports the engines. `tests/lib/ai-visibility/retry.test.ts`
 * asserts the two stay equal, so a change to the ladder fails loudly rather
 * than silently moving this threshold.
 *
 * It is a THRESHOLD, not a budget: a provider that tells us to wait longer than
 * this is telling us the run cannot recover, whatever the status code said.
 */
export const RETRY_WINDOW_MS = 90_000;

/**
 * Bodies that mean "out of money", not "too fast".
 *
 * This is the split design Decision 9 demands, and each entry is a specific
 * published marker rather than a guess at prose:
 *
 *  - **OpenAI** returns 429 with `code: "insufficient_quota"` when the account
 *    has no credit. Same status as a throughput limit, opposite remedy.
 *  - **Anthropic's spend cap** is a 429 carrying NO `retry-after` at all,
 *    identified by `error.details.error_code === "enforced_spend_limit_reached"`.
 *    Its out-of-credit case is a 400 saying "credit balance is too low" — a
 *    status that would otherwise read as `bad_response`, i.e. our bug.
 *  - **Gemini's** per-day quotas name themselves in `quotaId`
 *    (`…RequestsPerDayPerProject…`). A per-day quota cannot clear inside a
 *    90-second ladder by definition.
 *
 * HONEST GAP: Gemini's `$10 per rolling 10 minutes` spend cap returns
 * `429 RESOURCE_EXHAUSTED`, and no published sample of that body was available
 * to match on. It is therefore NOT matched here, and it is read as
 * `rate_limited` — terminal for the run when the retry delay outlasts the
 * ladder, but not a verdict on the key. Two guesses used to stand in for the
 * missing sample and both have been withdrawn:
 *
 *  - `/billing account/i` and `/spend limit/i` were prose, not published
 *    markers. "Billing account" is the ordinary name of a Cloud Billing
 *    account and appears in bodies that have nothing to do with a cap, so any
 *    503 or 403 quoting one flipped a funded key to "No credit".
 *  - "a wait longer than the ladder is a cap" — see `classifyHttpFailure`. A
 *    Tier 1 TPM 429 asking for 120 seconds is the most likely first-run
 *    experience a BYOK tenant has (Decision 9), and it is not a cap.
 *
 * If a real sample of that body turns up, this is the table to add it to — a
 * published marker, matched on a 429, is the only thing that belongs here.
 *
 * Matched against the raw body, which is exactly why the raw body never leaves
 * this module: reading it is safe, keeping it is not.
 */
const QUOTA_MARKERS: Record<EngineId, RegExp[]> = {
  openai: [/insufficient_quota/i, /exceeded your current quota/i, /billing_not_active/i],
  anthropic: [/enforced_spend_limit_reached/i, /credit balance is too low/i],
  gemini: [/"quotaId"\s*:\s*"[^"]*PerDay/i],
};

/**
 * Bodies that name the KEY as the problem behind a status that does not.
 *
 * Only consulted for a status that would otherwise read as `bad_response`.
 * Gemini is the reason this exists: it rejects a bad key with **400
 * INVALID_ARGUMENT**, not 401, so without this a customer's typo would be
 * reported as "that is ours to fix" and never get fixed.
 */
const INVALID_KEY_MARKERS: Record<EngineId, RegExp[]> = {
  openai: [/invalid_api_key/i],
  anthropic: [/authentication_error/i],
  gemini: [/API_KEY_INVALID/i, /API key not valid/i],
};

function matchesAny(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

/**
 * How long the provider asked us to wait, in ms, if it said so at all.
 *
 * Two places to look, because the three engines do not agree:
 *
 *  - the `retry-after` HTTP header — seconds, or an HTTP-date (RFC 9110 allows
 *    both, and OpenAI has been observed sending each);
 *  - Google's `RetryInfo` detail in the body, spelled `"retryDelay": "58s"`.
 *
 * Anthropic's spend-cap 429 sends NEITHER, which is itself the signal — see
 * `QUOTA_MARKERS`.
 *
 * Returns undefined rather than 0 when nothing was said: "no guidance" and
 * "retry immediately" are different instructions, and only one of them should
 * replace our ladder.
 */
export function parseRetryAfterMs(
  headers: Headers | undefined,
  bodyText: string,
  now: number = Date.now()
): number | undefined {
  const header = headers?.get("retry-after");
  if (header) {
    const seconds = Number(header.trim());
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const date = Date.parse(header);
    // A date in the past is a clock skew, not an instruction to wait forever.
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }

  const retryDelay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(bodyText);
  if (retryDelay) return Math.round(Number(retryDelay[1]) * 1000);

  return undefined;
}

export type HttpFailure = {
  code: EngineFailureCode;
  retryable: boolean;
  /** What the provider asked for, when it asked. Absent means "use our ladder". */
  retryAfterMs?: number;
};

/**
 * The full reading of a non-2xx: status, then body, then the clock.
 *
 * ### The two questions, and why they are not one question
 *
 * `code` answers **what went wrong, and whose fault it is**. `retryable`
 * answers **whether another attempt inside this run is worth paying for**. They
 * are independent, and the whole point of returning both is that neither has to
 * lie on the other's behalf.
 *
 * They were conflated once, and it was expensive. A 429 whose `retry-after`
 * outlasted the 90-second ladder was reclassified as `quota_exceeded` so that
 * `runSlice` would stop retrying it — which worked, because `runSlice` reads
 * that code as "terminal for this sample". But `flipEngineKeyOnFailure` reads
 * the SAME code as a verdict on the credential: `quota_exceeded` writes
 * `status: "quota_exceeded"` on the key row, which drops the engine out of
 * `effectiveEngines` for every future run and puts a **"No credit"** badge in
 * front of a customer whose account is fully funded.
 *
 * And a long `retry-after` is not a cap. OpenAI Tier 1 is 30,000 TPM and
 * answers a burst with `try again in 120s`; Decision 9 names that as the most
 * likely first-run experience a BYOK tenant has. So a throughput 429 now comes
 * back as `{ code: "rate_limited", retryable: false }` when the wait outlasts
 * the ladder — terminal for this run, silent about the key, exactly as
 * `isCredentialFailure` already documents that it wants.
 *
 * ### The order
 *
 *  1. A body that names the KEY, on a status that does not know (Gemini rejects
 *     a bad key with 400). Before the cap check, so a body naming both reports
 *     the credential — a rejected key is not fixed by paying.
 *  2. A body that names a CAP, on a status a cap can actually wear: a 429, or
 *     the 400 Anthropic sends when the credit balance is too low. NOT on a 5xx
 *     or a 403, where the status is the more reliable witness and a marker
 *     matched in passing would be a permanent verdict drawn from prose.
 *  3. Whatever the status says, with the provider's wait attached when it can
 *     still be used.
 *
 * The body is read and dropped. Nothing from it reaches the return value.
 */
export function classifyHttpFailure(
  engine: EngineId,
  status: number,
  bodyText: string,
  headers?: Headers,
  now: number = Date.now()
): HttpFailure {
  const base = codeForStatus(status);

  if (base === "bad_response" && matchesAny(INVALID_KEY_MARKERS[engine], bodyText)) {
    return { code: "invalid_key", retryable: false };
  }

  // A named cap beats the status code, on the two statuses a cap arrives with.
  // Anthropic's out-of-credit case is a 400, which `codeForStatus` would
  // otherwise call our bug.
  if (
    (base === "rate_limited" || base === "bad_response") &&
    matchesAny(QUOTA_MARKERS[engine], bodyText)
  ) {
    return { code: "quota_exceeded", retryable: false };
  }

  if (base === "rate_limited") {
    const retryAfterMs = parseRetryAfterMs(headers, bodyText, now);
    // The provider says the wait outlasts every attempt we would make. This run
    // cannot wait it out, so it does not try: a sample that fails now is worth
    // more than the same sample failing 90 seconds later with two more paid
    // calls behind it.
    //
    // Still `rate_limited`, though. This is a SCHEDULING fact — the provider
    // told us when, and the answer is "after this run ends" — and scheduling
    // facts are not verdicts on a credential. Nothing downstream may read it as
    // one; `retryable: false` is the whole of what it means.
    if (retryAfterMs !== undefined && retryAfterMs > RETRY_WINDOW_MS) {
      return { code: "rate_limited", retryable: false };
    }
    return { code: "rate_limited", retryable: true, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }

  return { code: base, retryable: isRetryableCode(base) };
}
