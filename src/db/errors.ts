/**
 * Postgres error classification, shared by every module that turns a specific
 * constraint failure into a user-facing message.
 *
 * Imports nothing on purpose: this is the bottom of the dependency graph, so
 * both `src/db`-level code and `src/lib` callers can use it without a cycle.
 */

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = "23505";

/**
 * True when `error` is a Postgres unique-constraint violation.
 *
 * Drizzle wraps the driver error in a `DrizzleQueryError` and puts the original
 * pg error on `.cause`, so this walks the cause chain rather than assuming
 * exactly one level of wrapping.
 *
 * Callers must use this to narrow BEFORE swallowing an error. A bare
 * `catch { return duplicate }` reports a connection loss, a deadlock, a
 * statement timeout and a genuine bug as "you already have one of these",
 * which sends the user to fix wording that was never the problem.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  while (current !== null && typeof current === "object") {
    const code = (current as { code?: unknown }).code;
    if (code === UNIQUE_VIOLATION) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
