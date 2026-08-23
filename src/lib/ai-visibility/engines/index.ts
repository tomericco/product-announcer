import type { EngineClient, EngineId } from "@/lib/ai-visibility/types";
import { openaiEngine, OPENAI_COST_PER_CALL_USD } from "@/lib/ai-visibility/engines/openai";
import { geminiEngine, GEMINI_COST_PER_CALL_USD } from "@/lib/ai-visibility/engines/gemini";
import {
  anthropicEngine,
  ANTHROPIC_COST_PER_CALL_USD,
} from "@/lib/ai-visibility/engines/anthropic";

/**
 * Every engine a run can ask, keyed by the id stored on
 * `ai_visibility_settings.engines` and `ai_visibility_samples.engine`.
 *
 * A `Record<EngineId, …>` rather than an array, so adding a fourth id to
 * `ENGINE_IDS` fails the typecheck here until a client exists for it — the
 * alternative is a run that silently skips an engine a tenant switched on.
 *
 * This module imports the clients; nothing in a client may import this module
 * back. The one thing all three share, `engineSystemPrompt()`, therefore lives
 * in `types.ts`.
 */
export const ENGINE_CLIENTS: Record<EngineId, EngineClient> = {
  openai: openaiEngine,
  gemini: geminiEngine,
  anthropic: anthropicEngine,
};

/**
 * Flat USD-per-call estimates. Multiply by prompts × samples for the "≈ $X per
 * month at current settings" line and for the pre-run cap check.
 *
 * Estimates, not invoices — the real bill depends on token counts nobody knows
 * before the call. Each one is rounded UP for that reason: a cap that pauses
 * slightly early is a bounded surprise, a cap that pauses late is a bill.
 */
const ENGINE_COSTS: Record<EngineId, number> = {
  openai: OPENAI_COST_PER_CALL_USD,
  gemini: GEMINI_COST_PER_CALL_USD,
  anthropic: ANTHROPIC_COST_PER_CALL_USD,
};

/** The UI name, always carrying "API" — see the spec's trust cues. */
export function engineLabel(id: EngineId): string {
  return ENGINE_CLIENTS[id].label;
}

export function engineCost(id: EngineId): number {
  return ENGINE_COSTS[id];
}

