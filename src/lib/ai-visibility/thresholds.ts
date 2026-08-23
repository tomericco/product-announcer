/**
 * The display floors, in a module a client component can import.
 *
 * They lived in `metrics.ts`, which is the right place for the arithmetic and
 * the wrong place for the constants: that module imports `@/db` and the whole
 * drizzle schema, so a `"use client"` file importing `MIN_N_PROMPT` from it
 * would pull the database layer into the browser bundle. `prompt-matrix.tsx`
 * hand-copied the 3 rather than do that, and the copy was free to drift from
 * the floor the metrics layer actually applies.
 *
 * `metrics.ts` re-exports them, so every existing server-side import is
 * unchanged; import from here on the client.
 */

/** Contract decision 8: an engine aggregate is hidden below this. */
export const MIN_N_AGGREGATE = 30;

/** Contract decision 8: a per-prompt cell is hidden below this. */
export const MIN_N_PROMPT = 3;

/**
 * The trend chart's floor — deliberately LOWER than `MIN_N_AGGREGATE`.
 *
 * This is a knowing departure from contract decision 8, so read this before
 * "fixing" it back to 30.
 *
 * The 30 floor exists to stop a thin run being rendered as a misleading
 * NUMBER — "8%" printed in 30px type reads as a fact about the world, and at
 * n=10 it is not one. A sparkline point is not that. It is read as SHAPE, in a
 * series, and it sits directly beneath tiles whose headline numbers still carry
 * the strict floor. The reader who wants the number gets it, floored at 30;
 * the line only says which way things are moving.
 *
 * The cost is real and is accepted, not overlooked: at n=15 a mention-rate
 * point carries roughly ±25pp of Wilson noise, so the per-engine lines WILL
 * look jumpy and a run-to-run wiggle on one of them means nothing on its own.
 * That is the trade for having the lines at all — at 30-per-run they never
 * draw, and "no line" teaches the reader strictly less than "a noisy line".
 *
 * 15 is not a round number picked for feel. It is exactly one run at the
 * current shape: `MAX_ACTIVE_PROMPTS = 5` (prompts.ts) x `samplesPerPrompt` 3.
 * The two are therefore COUPLED — if the prompt cap moves again, this constant
 * is what decides whether the per-engine lines draw at all, and it must move
 * with it. A cap of 3 at 3 samples yields 9 per run and every per-engine point
 * silently goes null again.
 *
 * Applies to the pooled "All engines" series too — see `engineHistory`.
 */
export const MIN_N_HISTORY = 15;
