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

export type EngineAnswer = {
  text: string;
  modelId: string;
  citations: EngineCitation[];
  searchUsed: boolean;
  searchQueries: string[];
  raw: unknown;
  costUsd: number;
};

export type EngineError = {
  kind: "error" | "refused";
  message: string;
  /**
   * What the failed call still cost, when the provider gave us enough to say.
   *
   * A failure is not free. A refusal, an answer written without searching, and
   * an answer truncated at the token ceiling all ran the model to completion
   * and are billed in full — the truncated one is the most expensive kind of
   * call there is. Typing these as costless made every such sample record zero
   * spend, so the monthly cap under-counted by however many samples failed.
   *
   * Populated when the provider returned a complete response we could read;
   * left undefined for a transport failure or a non-2xx, where nothing tells
   * us whether any work happened. Undefined means "unknown", not "free" —
   * callers should treat it as an unmeasured cost, not a zero.
   */
  costUsd?: number;
};

export type EngineClient = {
  id: EngineId;
  /** e.g. "GPT-5.x API + web search". Carries "API" on purpose — see the spec's trust cues. */
  label: string;
  ask(prompt: string, deps?: { fetchImpl?: typeof fetch }): Promise<EngineAnswer | EngineError>;
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
   * This is the field that discriminates the whole row: it is null if and only
   * if the window was too thin to show anything. Every other rate here is null
   * in that case too, so `mentionRate === null` is the correct test for "we do
   * not know yet".
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
  citationRate: number | null;
  recommendationRate: number | null;
  /**
   * ± percentage points on SOV (Wilson 95%).
   *
   * The proportion is share of voice; the trial count is ANSWERS, not brand
   * mentions — see `toMetrics` in `metrics.ts`. Asymmetric: `sov ± wilsonPp`
   * can leave [0, 100], so render ranges through `clampBand`.
   */
  wilsonPp: number | null;
  /** 30-day delta in pp; null when the earlier window is unknown. */
  deltaPp: number | null;
};
