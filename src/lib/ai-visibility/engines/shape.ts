/**
 * Defensive readers for provider JSON.
 *
 * `EngineClient.ask` promises `Promise<EngineAnswer | EngineError>` — it must
 * never throw. Every `for (const x of maybeList)` and `maybeList.map(...)` in a
 * client is a place where a response shaped differently than expected raises a
 * TypeError out of `ask()` instead, which is a broken contract and, in a run
 * slice with no try/catch above it, a dead slice.
 *
 * That is not a hypothetical: two of the three engine shapes here were written
 * from documentation rather than from a verified live call, and "the list is
 * nested one level deeper" is the single most ordinary way such a guess is
 * wrong.
 *
 * This module is imported BY the clients. Nothing here may import a client, or
 * `engines/index.ts`, on pain of a cycle.
 */

/**
 * How long any one engine request may take before it is aborted.
 *
 * Generous, because every client here asks the provider to run a live web
 * search first and answer afterwards — a slow grounded answer is normal and
 * aborting one costs a real sample. Finite, because `runSlice`'s budget only
 * governs when it stops HANDING OUT work: a request that hangs holds its
 * concurrency slot open indefinitely, and with no ceiling the thing that
 * eventually ends the wave is the platform killing the whole cron invocation.
 */
export const ENGINE_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Whether a non-2xx from a provider is worth asking again.
 *
 * 429 is the whole reason this exists: three providers' rate limits are in play
 * on every wave, and a rate-limited sample used to cost the run a data point
 * outright. 5xx is the provider having a bad minute. Everything else in the 4xx
 * range is about the REQUEST — 401 is a key that is wrong or out of funds, 404
 * is a model id that no longer resolves, 400 is a body we built wrong — and
 * re-sending it buys an identical failure at full price.
 *
 * Shared by all three clients so the classification cannot drift between them.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** The value when it really is an array, otherwise an empty one. */
export function asArray<T>(value: T[] | undefined | null | unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Whether the parsed body is something we can read properties off at all.
 *
 * `JSON.parse("null")` is valid JSON and yields `null`; so does a bare string
 * or number. Reading `.output` off any of those throws or silently yields
 * undefined, so clients check this before touching the body.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
