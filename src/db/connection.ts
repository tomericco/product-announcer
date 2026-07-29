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
  return env.DATABASE_URL || env.POSTGRES_URL;
}
