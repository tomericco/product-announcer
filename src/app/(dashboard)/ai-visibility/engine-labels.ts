import { ENGINE_IDS, type EngineId } from "@/lib/ai-visibility/types";

/**
 * Engine display names, client-safe.
 *
 * `engineLabel()` in `@/lib/ai-visibility/engines` is the same information,
 * but that module is the three fetch-based API clients — importing a runtime
 * value from it into a `"use client"` file would pull all three into the
 * browser bundle (the mistake `signals-list.tsx` documents at length for
 * `MAX_PROPOSAL_SIGNALS`). This module imports nothing but a type and a
 * const array, so it is safe on either side of the boundary.
 */

/**
 * The PRODUCT each engine stands for — deliberately not the model it runs.
 *
 * The question this feature answers is "is ChatGPT naming us", not "is GPT-5.5
 * naming us". The product is what a buyer opens; which model sits behind it on
 * a given week is a decision OpenAI, Google and Anthropic make without telling
 * anyone, and we change our own defaults as models retire.
 *
 * So the label stays put while the model moves. A column headed with a model
 * name would churn on every default bump and would imply the series restarts
 * at each swap — when the whole point of the sparkline's model-change tick is
 * that the series CONTINUES across one, annotated rather than broken. A metric
 * meant to be read week over week for a year cannot be titled with something
 * that changes every few months.
 *
 * The model that actually answered is not lost: it is stored per sample, shown
 * on each answer in the prompt detail tabs, and marks the sparkline when it
 * changes. That is the right place for it — beside one answer, not atop a
 * twelve-week trend.
 */
export const ENGINE_NAME: Record<EngineId, string> = {
  openai: "ChatGPT",
  gemini: "Gemini",
  anthropic: "Claude",
};

/**
 * The product name plus the methodology, for tooltips and accessible names.
 *
 * Derived from `ENGINE_NAME` so the two can never disagree. "API" is
 * load-bearing, not decoration: the spec's trust cues require the proxy to be
 * visible, because these are API answers and not what a person sees in the
 * consumer app — which is the single biggest caveat on every number here.
 */
export const ENGINE_LABEL: Record<EngineId, string> = {
  openai: `${ENGINE_NAME.openai} API + web search`,
  gemini: `${ENGINE_NAME.gemini} API, grounded`,
  anthropic: `${ENGINE_NAME.anthropic} API + web search`,
};

export const ENGINE_ORDER: readonly EngineId[] = ENGINE_IDS;
