import { anthropic } from "@ai-sdk/anthropic";

/**
 * Resolves a configured model spec to a concrete Anthropic model, calling the
 * Anthropic API directly via @ai-sdk/anthropic (billed against ANTHROPIC_API_KEY)
 * instead of routing a bare model string through the Vercel AI Gateway.
 *
 * Specs may be gateway-style ("anthropic/claude-sonnet-4-5") or bare
 * ("claude-sonnet-4-5"); a leading "anthropic/" is stripped so the existing
 * GENERATION_MODEL / ENRICHMENT_MODEL / etc. env values keep working unchanged.
 */
export function resolveModel(spec: string) {
  const id = spec.startsWith("anthropic/") ? spec.slice("anthropic/".length) : spec;
  return anthropic(id);
}
