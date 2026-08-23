/**
 * The two display floors, in a module a client component can import.
 *
 * They lived in `metrics.ts`, which is the right place for the arithmetic and
 * the wrong place for the constants: that module imports `@/db` and the whole
 * drizzle schema, so a `"use client"` file importing `MIN_N_PROMPT` from it
 * would pull the database layer into the browser bundle. `prompt-matrix.tsx`
 * hand-copied the 3 rather than do that, and the copy was free to drift from
 * the floor the metrics layer actually applies.
 *
 * `metrics.ts` re-exports both, so every existing server-side import is
 * unchanged; import from here on the client.
 */

/** Contract decision 8: an engine aggregate is hidden below this. */
export const MIN_N_AGGREGATE = 30;

/** Contract decision 8: a per-prompt cell is hidden below this. */
export const MIN_N_PROMPT = 3;
