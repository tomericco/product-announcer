import { ENGINE_IDS, type EngineId } from "@/lib/ai-visibility/types";

/**
 * Engine display names, client-safe.
 *
 * `engineLabel()` in `@/lib/ai-visibility/engines` is the same information,
 * but that module is the four fetch-based API clients — importing a runtime
 * value from it into a `"use client"` file would pull all four into the
 * browser bundle (the mistake `signals-list.tsx` documents at length for
 * `MAX_PROPOSAL_SIGNALS`). This module imports nothing but a type and a
 * const array, so it is safe on either side of the boundary.
 *
 * "API" is load-bearing, not decoration: the spec's trust cues require the
 * proxy to be visible in the engine's own name, because these are API
 * answers and not what a human sees in the consumer app.
 */
export const ENGINE_LABEL: Record<EngineId, string> = {
  openai: "GPT-5.x API + web search",
  perplexity: "Perplexity Sonar API",
  gemini: "Gemini API, grounded",
  anthropic: "Claude API + web search",
};

/** The matrix and the per-prompt chips have room for four characters. */
export const ENGINE_SHORT: Record<EngineId, string> = {
  openai: "GPT",
  perplexity: "Pplx",
  gemini: "Gem",
  anthropic: "Claude",
};

export const ENGINE_ORDER: readonly EngineId[] = ENGINE_IDS;
