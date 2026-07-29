/**
 * Resolves the Postgres connection string.
 *
 * `DATABASE_URL` wins so local development and the test suite (which rewrites
 * it in vitest.setup.ts) are unaffected. `POSTGRES_URL` is what the Supabase
 * Marketplace integration injects on Vercel — reading it directly means
 * rotated credentials take effect without redeploying a copied value.
 *
 * Uses `||` rather than `??`: Vercel stores a valueless variable as an empty
 * string, which must fall through rather than be treated as a real URL.
 *
 * Returns `undefined` rather than throwing when neither is set, so failure
 * happens at connect time instead of at module evaluation — Next.js evaluates
 * this module during `next build`.
 */
export function resolveConnectionString(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  return normalizeConnectionString(env.DATABASE_URL || env.POSTGRES_URL);
}

/**
 * Rewrites `sslmode=require` to `sslmode=no-verify` in a Postgres connection
 * string.
 *
 * The Supabase Marketplace integration injects connection strings ending in
 * `?sslmode=require`. Supabase's pooler presents a certificate chain rooted
 * in a self-signed Supabase CA that isn't in Node's trust store, and the `pg`
 * driver deliberately treats connection-string `sslmode=require` as
 * `verify-full` (a hardening deviation from libpq semantics), so verification
 * fails with `SELF_SIGNED_CERT_IN_CHAIN`. Rewriting to `sslmode=no-verify`
 * keeps the connection encrypted while skipping chain verification, which is
 * the mode Supabase's own pooler expects.
 *
 * Operates on the string directly rather than round-tripping through `new
 * URL()`, which can re-encode the password and other components unreliably.
 * The replacement is delimiter-aware (anchored on `?`/`&` before and `&`/end
 * of string after) so it matches only the exact `sslmode=require` parameter
 * — not a value like `sslmode=required` — and preserves every other query
 * parameter untouched.
 *
 * Any other `sslmode` value (including no `sslmode` at all, as with local
 * development URLs) is left completely untouched.
 */
export function normalizeConnectionString(
  url: string | undefined
): string | undefined {
  if (url === undefined) return undefined;
  return url.replace(/([?&])sslmode=require(?=&|$)/, "$1sslmode=no-verify");
}
