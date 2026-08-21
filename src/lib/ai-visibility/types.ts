/**
 * The AI-visibility vocabulary, in one dependency-free module.
 *
 * Imports nothing on purpose: `src/db/schema.ts` imports `SampleExtraction`
 * and `AiVisibilityPayload` from here for its `$type<>` annotations, so
 * anything this file imported would become a schema dependency and could
 * cycle back through `@/db`.
 */

export const ENGINE_IDS = ["openai", "perplexity", "gemini", "anthropic"] as const;
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
 * The one instruction every engine is given, identical across all four.
 *
 * Neutral by design: the run measures the natural distribution of answers, so
 * anything that nudges the model toward listing brands, or toward citing,
 * would measure our own prompt rather than the engine. Temperature is left at
 * each provider's default for the same reason (spec, "Engines & run
 * mechanics").
 *
 * Lives here rather than in `engines/index.ts` because all four clients need
 * it and `engines/index.ts` imports them — putting it there would cycle.
 */
export const NEUTRAL_SYSTEM_PROMPT =
  "You are a helpful assistant. Answer the user's question directly and concisely, " +
  "using web search where it helps. Cite the sources you used.";

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
  /** null below the display threshold — "Collecting baseline", not zero. */
  mentionRate: number | null;
  /** 0..100. */
  shareOfVoice: number | null;
  citationRate: number | null;
  recommendationRate: number | null;
  /** ± percentage points on SOV (Wilson 95%). */
  wilsonPp: number | null;
  /** 30-day delta in pp; null when the earlier window is unknown. */
  deltaPp: number | null;
};
