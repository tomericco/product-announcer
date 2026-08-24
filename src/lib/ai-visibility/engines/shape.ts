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
 * `isRetryableStatus` used to live here. It now lives in `engines/failure.ts`
 * as `codeForStatus` + `isRetryableCode`, because "is this worth asking again"
 * stopped being a question a status code can answer on its own: a 429 is
 * retryable when it is throughput and terminal when it is a spend cap, and
 * telling those apart needs the body. Classification and the closed set of
 * failure codes are one concern and belong in one module.
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

/**
 * The env var each engine's key falls back to, for LOCAL DEVELOPMENT ONLY.
 *
 * Under BYOK the key is the tenant's, passed to `ask()` as `deps.apiKey`, and
 * `runSlice` always passes one explicitly — an engine with no usable stored key
 * is never asked at all. These are what remain so a developer can exercise a
 * client from a script or a test without seeding an encrypted row, and so the
 * judge and prompt generation (which still run on OUR Anthropic key, and say so
 * in the UI) keep working.
 *
 * They are NOT a fallback in the product sense. The design's hard gate is that
 * a tenant with no verified key does not sample that engine and is never billed
 * to us; the run path enforces that above this layer, by refusing to plan, and
 * by never handing a client an absent key.
 */
export const ENGINE_KEY_ENV_VAR = {
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
} as const;

/**
 * The key a client will actually send: the caller's, or the local-dev env var.
 *
 * `undefined` and `""` are different inputs with the same outcome and that is
 * deliberate — a caller who resolved a key and got an empty string must not
 * silently fall through to ours. Only an ABSENT `apiKey` consults the
 * environment; an explicitly empty one is a failure.
 */
export function resolveEngineKey(
  engine: keyof typeof ENGINE_KEY_ENV_VAR,
  apiKey: string | undefined
): string | null {
  if (apiKey !== undefined) {
    const trimmed = apiKey.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  const fromEnv = process.env[ENGINE_KEY_ENV_VAR[engine]];
  return fromEnv && fromEnv.trim().length > 0 ? fromEnv.trim() : null;
}
