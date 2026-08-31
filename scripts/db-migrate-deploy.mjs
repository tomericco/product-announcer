#!/usr/bin/env node
/**
 * `drizzle-kit migrate`, but only when there is a database to migrate.
 *
 * The build runs migrations before `next build` on purpose: a bad migration
 * should fail the deployment rather than ship an app against a stale schema
 * (see `vercel.ts`). That is right for production and wrong everywhere else —
 * Preview deployments have no Postgres env vars attached, so every preview
 * build died on `url: undefined` and every pull request showed a red check.
 * A check that is always red is a check nobody reads, which costs more than
 * the preview was worth.
 *
 * The condition is the ACTUAL precondition — is there a database — rather than
 * the environment's name. A preview given its own database starts migrating it
 * with no further change here.
 *
 * Production keeps the old behaviour exactly: a missing URL there is a
 * misconfiguration that must stop the deploy, not something to skip past. That
 * is the whole point of migrating at build time, and skipping silently would
 * hand back the failure this ordering exists to prevent.
 */
import { spawnSync } from "node:child_process";

// The same pair `drizzle.config.ts` resolves, in the same order.
const url = process.env.POSTGRES_URL_NON_POOLING ?? process.env.DATABASE_URL;
const isProduction = process.env.VERCEL_ENV === "production";

if (!url) {
  if (isProduction) {
    console.error(
      "[db:migrate:deploy] No POSTGRES_URL_NON_POOLING or DATABASE_URL in a PRODUCTION build.\n" +
        "Refusing to build: migrations run before the build so the app never ships against a stale schema."
    );
    process.exit(1);
  }
  console.log(
    `[db:migrate:deploy] No database URL (VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"}) — skipping migrations.\n` +
      "This is expected for Preview builds, which have no database attached."
  );
  process.exit(0);
}

const result = spawnSync("npx", ["drizzle-kit", "migrate"], { stdio: "inherit" });
process.exit(result.status ?? 1);
