/**
 * How many engine calls a run plans — the one definition of a formula that had
 * three hand-rolled copies, two of which quote money at the reader.
 *
 * The rule it encodes is `capExceeded`'s: a `brand_check` prompt is sampled
 * exactly ONCE per engine whatever the samples setting says, and everything
 * else at `samplesPerPrompt`. A flat `prompts × engines × samples` always reads
 * high, and it reads high on the two controls whose entire job is to be trusted
 * about spend before the click.
 *
 * `tests/lib/ai-visibility/estimate-matches-cap-gate.test.ts` pins the settings
 * card's dollar estimate against the gate that actually pauses a run; this is
 * the call count underneath both.
 *
 * Dependency-free on purpose: the settings form is a client component and the
 * two pages are Server Components, and all three call this.
 */

/**
 * Calls ONE engine makes in one run.
 *
 * `brandCheckCount` is clamped into `0..promptCount` — the two page callers
 * derive it from the same list they counted `promptCount` from, so the clamp is
 * a no-op there, but the settings form takes both as props from a page that
 * counted them in separate queries.
 */
export function callsPerEnginePerRun(
  promptCount: number,
  brandCheckCount: number,
  samplesPerPrompt: number
): number {
  const prompts = Math.max(0, promptCount);
  const branded = Math.min(Math.max(brandCheckCount, 0), prompts);
  return (prompts - branded) * Math.max(0, samplesPerPrompt) + branded;
}

/** Calls a whole run plans, across every engine it will ask. */
export function plannedRunCalls(a: {
  promptCount: number;
  brandCheckCount: number;
  engineCount: number;
  samplesPerPrompt: number;
}): number {
  return (
    callsPerEnginePerRun(a.promptCount, a.brandCheckCount, a.samplesPerPrompt) * Math.max(0, a.engineCount)
  );
}

/** The same count, read straight off the active prompt list both pages hold. */
export function plannedCallsForPrompts(
  prompts: readonly { intent: string }[],
  a: { engineCount: number; samplesPerPrompt: number }
): number {
  return plannedRunCalls({
    promptCount: prompts.length,
    brandCheckCount: prompts.filter((prompt) => prompt.intent === "brand_check").length,
    engineCount: a.engineCount,
    samplesPerPrompt: a.samplesPerPrompt,
  });
}
