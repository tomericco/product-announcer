/**
 * Defensive readers for provider JSON.
 *
 * `EngineClient.ask` promises `Promise<EngineAnswer | EngineError>` — it must
 * never throw. Every `for (const x of maybeList)` and `maybeList.map(...)` in a
 * client is a place where a response shaped differently than expected raises a
 * TypeError out of `ask()` instead, which is a broken contract and, in a run
 * slice with no try/catch above it, a dead slice.
 *
 * That is not a hypothetical: two of the four engine shapes here were written
 * from documentation rather than from a verified live call, and "the list is
 * nested one level deeper" is the single most ordinary way such a guess is
 * wrong.
 *
 * This module is imported BY the clients. Nothing here may import a client, or
 * `engines/index.ts`, on pain of a cycle.
 */

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
