/**
 * The AI-visibility vocabulary, in one dependency-free module.
 *
 * Imports nothing on purpose: `src/db/schema.ts` imports `SampleExtraction`
 * and `AiVisibilityPayload` from here for its `$type<>` annotations, so
 * anything this file imported would become a schema dependency and could
 * cycle back through `@/db`.
 */

export const ENGINE_IDS = ["openai", "gemini", "anthropic"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

export const PROMPT_INTENTS = [
  "discovery",
  "comparison",
  "alternatives",
  "how_to",
  "brand_check",
  "pricing",
] as const;
export type PromptIntent = (typeof PROMPT_INTENTS)[number];

/**
 * The system prompt the engines send — by default, none at all.
 *
 * A buyer typing "best content design tools" into ChatGPT sends no system
 * prompt, so neither do we. The engine's own product prompt is part of what we
 * are trying to observe; ours would be a second instruction the real user never
 * gave, and this feature's whole claim is that it reports what an engine says
 * rather than what we asked it to say.
 *
 * The prompt this replaced ended "Cite the sources you used." — an instruction
 * to perform the exact behaviour the cited-domain leaderboard and the
 * `own_page_cited` signal count. Measuring citations while asking for citations
 * inflates the metric by an unknown amount, and the amount is not stable across
 * engines, so it does not even cancel out in a comparison.
 *
 * Lives here rather than in `engines/index.ts` because all three clients need
 * it and `engines/index.ts` imports them — putting it there would cycle.
 *
 * `AI_VISIBILITY_SYSTEM_PROMPT` overrides it, for A/B runs against the old
 * behaviour. An empty or unset value means no system prompt is sent at all —
 * the engines omit the field rather than sending an empty string, which some
 * providers reject and others treat as a real (empty) instruction.
 */
export function engineSystemPrompt(): string | undefined {
  const override = process.env.AI_VISIBILITY_SYSTEM_PROMPT?.trim();
  return override ? override : undefined;
}

export type EngineCitation = { url: string; position: number };

/**
 * Token counts the provider reported for one call, normalised to camelCase.
 *
 * Structurally identical to `TokenUsage` in `src/lib/ai/llm-usage.ts` but
 * declared here because this module deliberately imports nothing (see the
 * header comment). Recorded into `llm_usage` for the settings usage tab —
 * TRACKING of the tenant's own BYOK spend, never counted as credits.
 */
export type EngineUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type EngineAnswer = {
  text: string;
  modelId: string;
  citations: EngineCitation[];
  searchUsed: boolean;
  searchQueries: string[];
  raw: unknown;
  costUsd: number;
  usage?: EngineUsage;
};

export type EngineError = {
  kind: "error" | "refused";
  /**
   * WHICH of the six things went wrong — the closed set in
   * `engines/failure.ts`.
   *
   * Required, not optional, and that is the whole point: the field exists so
   * that a client cannot return a failure without having decided what kind it
   * was, and so that everything downstream can branch on a value we control
   * instead of on a provider's prose.
   *
   * Typed as a plain string union here rather than imported from
   * `engines/failure.ts` because this module imports nothing — `src/db/schema.ts`
   * reads two types out of it, so any import here becomes a schema dependency.
   * `EngineFailureCode` is declared over the same six literals and the two are
   * asserted identical in `tests/lib/ai-visibility/engines/failure.test.ts`.
   */
  code:
    | "invalid_key"
    | "quota_exceeded"
    | "rate_limited"
    | "provider_unavailable"
    | "bad_response"
    | "refused";
  /**
   * A sentence WE wrote, safe to store and to render.
   *
   * NEVER provider body text. A provider's own error message quotes the
   * submitted credential back at you — an OpenAI 401 carries the key's prefix
   * and its last four characters — and this string is written to
   * `ai_visibility_samples.error`, summarised into `sources.lastError`, and
   * interpolated into the overview page. Build it with `engineFailure()`, which
   * composes it from the code and scrubs the result.
   */
  message: string;
  /**
   * What the failed call still cost, when the provider gave us enough to say.
   *
   * A failure is not free. A refusal and an answer truncated at the token
   * ceiling both ran the model to completion and are billed in full — the
   * truncated one is the most expensive kind of call there is. Typing these as
   * costless made every such sample record zero spend, so the monthly cap
   * under-counted by however many samples failed.
   *
   * Populated when the provider returned a complete response we could read;
   * left undefined for a transport failure or a non-2xx, where nothing tells
   * us whether any work happened. Undefined means "unknown", not "free" —
   * callers should treat it as an unmeasured cost, not a zero.
   */
  costUsd?: number;
  /**
   * Token counts, when the provider's response carried them. Present on the
   * same responses that can carry `costUsd` — a complete response we could
   * read — and absent on transport failures, where nothing was reported.
   */
  usage?: EngineUsage;
  /**
   * Whether asking this engine the same question again could plausibly work.
   *
   * Set by the CLIENT, because the client is the only thing that knows what the
   * provider actually said. `runSlice` retries a `true` and gives up on
   * everything else; retrying a terminal failure spends real money to fail
   * identically, which is worse than the missing sample.
   *
   * It is a SEPARATE fact from `code`, not a function of it. `code` says what
   * went wrong and whose fault it is; this says whether another attempt inside
   * this run is worth paying for. A `rate_limited` failure is terminal when the
   * provider asks for a longer wait than the whole retry ladder — and it is
   * still `rate_limited`, because the account and the key are both fine.
   * Nothing may infer a credential verdict from a `retryable: false`.
   *
   * RETRYABLE — the call never produced an answer and the reason is about the
   * moment rather than the request:
   *   - `rate_limited`: a throughput 429 the run can still wait out
   *   - `provider_unavailable`: any 5xx, a transport failure, a dropped
   *     connection, or the 60s abort timeout
   *
   * TERMINAL (leave undefined) — this run gains nothing by asking again:
   *   - `quota_exceeded`: a spend-cap 429 that NAMED itself, or an account with
   *     no credit. Anthropic's carries no `retry-after` and identifies itself by
   *     error code; OpenAI's says `insufficient_quota`. This code is a verdict
   *     on the credential — it pauses the key — so only a published marker
   *     reaches it
   *   - `rate_limited` with a `retry-after` longer than the ladder: the wait
   *     outlasts every attempt this run would make, and the key is untouched
   *   - `invalid_key`: 401/403, a missing key, or a body naming the key
   *   - `bad_response`: 404 (bad model id), 400 (a request we built wrong)
   *   - `kind: "refused"` — the model read the prompt and declined; that IS the
   *     measurement, and it is billed
   *   - a truncated answer (`incomplete_details`, `MAX_TOKENS`, `max_tokens`,
   *     `pause_turn`) — the most expensive kind of call there is, and it will
   *     truncate again
   *   - unparseable or non-object JSON, and Gemini's grounding canary: both
   *     mean OUR reader is wrong about the shape, which no retry fixes
   */
  retryable?: boolean;
  /**
   * How long the PROVIDER asked us to wait before the next attempt, in ms.
   *
   * Set only alongside `retryable`, and only when the provider actually said —
   * a `retry-after` header, or Google's `RetryInfo.retryDelay`. When it is
   * absent `runSlice` uses its own ladder, which is a guess; when it is present
   * the provider's number wins, because Anthropic warns that a nominal 60 RPM
   * "might be enforced as 1 request per second" and no fixed ladder of ours can
   * know that.
   *
   * Never longer than the whole ladder: a provider asking for more than that
   * has said the run cannot wait it out, so the failure comes back terminal
   * (`retryable` unset) and this field is dropped with the attempt it would
   * have scheduled. The CODE is unchanged by that — a slow rate limit is still
   * a rate limit.
   */
  retryAfterMs?: number;
};

export type EngineClient = {
  id: EngineId;
  /** e.g. "GPT-5.x API + web search". Carries "API" on purpose — see the spec's trust cues. */
  label: string;
  /**
   * `apiKey` is the TENANT's key — BYOK, design "Data": "`askOpenAI`/`askGemini`/
   * `askAnthropic` take the key as an argument instead of reading
   * `process.env`. Env keys remain for local development only."
   *
   * Optional in the TYPE and mandatory in PRACTICE on the run path: `runSlice`
   * resolves a key per engine before it asks anything, and an engine with no
   * usable stored key has its samples failed rather than asked. Leaving it out
   * falls back to the local-dev env var (see `resolveEngineKey`), which is what
   * keeps a client callable from a script; passing an empty string does not
   * fall back, so a caller that resolved a key and got nothing cannot silently
   * spend ours.
   */
  ask(
    prompt: string,
    deps?: { fetchImpl?: typeof fetch; apiKey?: string }
  ): Promise<EngineAnswer | EngineError>;
};

export type BrandHit = { brandId: string; name: string; isTenant: boolean };

export type SampleExtraction = {
  deterministic: { tenantMentioned: boolean; competitorIds: string[]; ownDomainCited: boolean };
  judged?: {
    orderedBrands: string[];
    level: "absent" | "mentioned" | "described" | "recommended";
    framing: string;
    quote: string;
    positioningClaims: { claim: string; state: "present" | "contradicted" }[];
    hallucinations: string[];
    answerType: "list" | "comparison" | "how_to" | "other";
  };
  /** Set when deterministic and judged disagree on "mentioned". Such rows are excluded from rates. */
  agreementFlag?: "d_only" | "j_only";
};

export type AiVisibilitySignalType =
  | "gap_vs_competitor"
  | "lost_mention"
  | "gained_mention"
  | "competitor_gained"
  | "new_cited_domain"
  | "own_page_cited"
  | "recommended_not_cited"
  | "misdescription";

export type AiVisibilityPayload = {
  signalType: AiVisibilitySignalType;
  promptId?: string;
  promptText?: string;
  engine?: EngineId;
  engineLabel?: string;
  modelId?: string;
  runId: string;
  /** ISO instant. */
  runDate: string;
  /** Human-readable sample count, e.g. "0 of 3, two runs". */
  samples: string;
  excerpt?: string;
  citedUrls?: { url: string; domain: string; domainClass: string }[];
  competitorId?: string;
  domain?: string;
};

export type WindowCounts = {
  n: number;
  /**
   * Of `n`, the samples whose engine actually ran a search.
   *
   * The denominator for the citation-family metrics ONLY. An engine that
   * answered from memory said something measurable and cited nothing, so it
   * belongs in `n` and not here.
   */
  nGrounded: number;
  tenantMentions: number;
  ownCitations: number;
  recommendations: number;
  competitorMentions: Record<string, number>;
};

export type EngineMetrics = {
  engine: EngineId | "all";
  n: number;
  /**
   * null below the display threshold — "Collecting baseline", not zero.
   *
   * Null if and only if `n` — the MENTION denominator — was too thin, so this
   * is the right test for "we do not know what the engine said yet", and the
   * right discriminator for `shareOfVoice` and `recommendationRate`, which are
   * null exactly when it is.
   *
   * It is NOT the test for `citationRate`. That rate is measured over
   * `nGrounded`, which has its own floor, so `citationRate === null` alongside
   * a real `mentionRate` is a normal state: the engine answered plenty and
   * searched on too few of them to report where it got its answers.
   */
  mentionRate: number | null;
  /**
   * 0..100.
   *
   * NULL MEANS TWO DIFFERENT THINGS, and they must not be rendered the same
   * way. Discriminate on `mentionRate`:
   *
   * - `mentionRate === null` — the window is below the display threshold.
   *   Nothing is known. This is the "Collecting baseline" state.
   * - `mentionRate === 0` (or any number) with `shareOfVoice === null` — the
   *   window is fat enough to report, and NO tracked brand was named in any
   *   answer. That is a known, measured fact, and on a discovery prompt set it
   *   is usually the most actionable finding on the page: the engines are
   *   answering these questions without naming anybody. Showing "Collecting
   *   baseline" here tells a tenant with 84 collected answers that we have no
   *   data, which is false.
   *
   * Share is null in the second case rather than 0 because 0% share implies a
   * denominator — someone else won the mentions — and here there were none.
   */
  shareOfVoice: number | null;
  /**
   * 0..100 — own-domain citations over the GROUNDED sample count, not `n`.
   *
   * An engine that answered without searching cited nothing at all, which is a
   * different fact from "it cited others and not us"; counting it as a zero
   * would understate this rate by the ungrounded share. So it has its own
   * denominator and its own floor, and is null whenever `nGrounded` is below
   * MIN_N_AGGREGATE — independently of `mentionRate`.
   */
  citationRate: number | null;
  recommendationRate: number | null;
  /**
   * ± percentage points on MENTION RATE (Wilson 95%) — the tile's band.
   *
   * The only band this feature can print without an apology: mention rate is
   * `tenantMentions / n`, one Bernoulli trial per answer, so the proportion and
   * the trial count are counted over the same unit and Wilson applies
   * unmodified. `sovWilsonPp` beside it has to anchor its n by hand.
   *
   * Null exactly when `mentionRate` is. Asymmetric like any Wilson half-width:
   * `mentionRate ± mentionWilsonPp` can leave [0, 100], so render ranges
   * through `clampBand`.
   */
  mentionWilsonPp: number | null;
  /**
   * ± percentage points on SOV (Wilson 95%).
   *
   * The proportion is share of voice; the trial count is ANSWERS, not brand
   * mentions — see `toMetrics` in `metrics.ts`. Asymmetric: `sov ± sovWilsonPp`
   * can leave [0, 100], so render ranges through `clampBand`.
   *
   * Named for its metric since the tile headline stopped being share of voice.
   * A field called `wilsonPp` sitting beside a mention-rate headline is how a
   * band gets printed against the wrong number, which is the whole reason this
   * rename happened rather than a comment being added.
   */
  sovWilsonPp: number | null;
  /**
   * 30-day delta in pp; null when the earlier window is unknown.
   *
   * Computed but not rendered anywhere today — the overview tile dropped it
   * because its two windows overlap (see `deltaPp` in `metrics.ts`) and the
   * sparkline beside it tells the same story unhedged. Kept for a surface that
   * can give it context.
   */
  deltaPp: number | null;
};
