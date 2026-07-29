# Vercel + Supabase Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the app to Vercel Hobby at `https://versional.vercel.app`, backed by a Supabase Postgres database provisioned through the Vercel Marketplace.

**Architecture:** The Supabase Marketplace integration injects `POSTGRES_URL` (pooled) and `POSTGRES_URL_NON_POOLING` (direct) into the Vercel project. The app resolves its connection string from either `DATABASE_URL` or `POSTGRES_URL` so local development is untouched while production reads the injected value. Drizzle migrations run from the Vercel build command against the direct connection, so a bad migration fails the build instead of shipping. The hourly cron drops to daily because Hobby permits one invocation per day.

**Tech Stack:** Next.js 16 (App Router), Drizzle ORM + `pg`, NextAuth v4, Vitest, Vercel CLI, Supabase Postgres.

Design spec: [docs/superpowers/specs/2026-07-28-vercel-supabase-deploy-design.md](../specs/2026-07-28-vercel-supabase-deploy-design.md)

## Global Constraints

- Production hostname is expected to be `versional.vercel.app`, but it is only **confirmed** by the deploy in Task 6, Step 2. If Vercel assigns `versional-<hash>.vercel.app` instead, the three URL-bearing variables from Task 5 and every URL in Task 7 change. Task 6, Step 3 reconciles this. **Task 7 must not begin until Task 6, Step 3 passes** — registering a wrong URL across five dashboards is expensive to undo.
- All environment variables are set for the **Production** environment only. Never `--environment preview` or `development`.
- **Never run `vercel env pull` into `.env.local`.** It overwrites the file and would repoint `DATABASE_URL` at production; `vitest.setup.ts` derives the test database from `DATABASE_URL`, so this can aim the test suite at production infrastructure. If you need the pulled values, write them to the scratchpad instead.
- Never echo a secret value to stdout. `vercel env ls` prints names only — that is the verification tool.
- `GITHUB_APP_PRIVATE_KEY` is a single line containing literal `\n` escape sequences. `src/lib/integrations/github/github.ts:16` converts them to real newlines at runtime. Copy the value byte-for-byte; do not expand it to a multi-line PEM.
- Vercel plan is Hobby. Cron is once per day; commercial use is not permitted (accepted).
- Working branch is `deploy/vercel-supabase`.
- `$SCRATCHPAD` below refers to the session scratchpad directory. Export it once at the start of Task 3 and keep the same shell, or substitute the literal path:

```bash
export SCRATCHPAD=/private/tmp/claude-501/-Users-tomergabbai-code-product-announcer/b20b396e-78e3-43b7-9c52-90ed1c568028/scratchpad
```

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/db/connection.ts` | Resolve the runtime Postgres connection string from the environment. Pure, testable, no side effects. | Create |
| `tests/db/connection.test.ts` | Cover precedence and fallback of the resolver. | Create |
| `src/db/index.ts` | Build the `pg` Pool and Drizzle client. | Modify |
| `drizzle.config.ts` | Point migrations at the direct (non-pooled) connection. | Modify |
| `vercel.ts` | Cron schedule and build command. | Modify |

Extracting `resolveConnectionString` into its own file is what makes this testable at all — `src/db/index.ts` constructs the Pool at module scope, so its behavior cannot be asserted without side effects.

---

### Task 1: Connection-string resolution

**Files:**
- Create: `src/db/connection.ts`
- Create: `tests/db/connection.test.ts`
- Modify: `src/db/index.ts`
- Modify: `drizzle.config.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `resolveConnectionString(env?: NodeJS.ProcessEnv): string | undefined` exported from `src/db/connection.ts`. Task 6 relies on this returning the Supabase-injected `POSTGRES_URL` in production.

**Why the return type is `string | undefined` and not `string`:** the current code passes `process.env.DATABASE_URL` straight to `new Pool()`, which accepts `undefined` and fails at connect time rather than import time. Throwing here would move the failure to module evaluation, which Next.js performs during `next build` — that would break builds in any environment where the variable is not yet set. Preserve the existing late-failure behavior.

- [ ] **Step 1: Write the failing test**

Create `tests/db/connection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveConnectionString } from "@/db/connection";

describe("resolveConnectionString", () => {
  it("prefers DATABASE_URL when both are set", () => {
    const result = resolveConnectionString({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://local/dev",
      POSTGRES_URL: "postgresql://supabase/prod",
    });
    expect(result).toBe("postgresql://local/dev");
  });

  it("falls back to POSTGRES_URL when DATABASE_URL is absent", () => {
    const result = resolveConnectionString({
      NODE_ENV: "test",
      POSTGRES_URL: "postgresql://supabase/prod",
    });
    expect(result).toBe("postgresql://supabase/prod");
  });

  it("falls back to POSTGRES_URL when DATABASE_URL is an empty string", () => {
    const result = resolveConnectionString({
      NODE_ENV: "test",
      DATABASE_URL: "",
      POSTGRES_URL: "postgresql://supabase/prod",
    });
    expect(result).toBe("postgresql://supabase/prod");
  });

  it("returns undefined when neither is set", () => {
    expect(resolveConnectionString({ NODE_ENV: "test" })).toBeUndefined();
  });
});
```

Every literal carries `NODE_ENV: "test"` because Next.js's ambient
`global.d.ts` declares `NODE_ENV` as a required property of
`NodeJS.ProcessEnv`; a literal without it fails `npm run typecheck`. Supply the
property rather than casting with `as unknown as NodeJS.ProcessEnv` — the cast
compiles but disables excess-property checking, so a typo like `DATABSE_URL`
would slip through to a confusing runtime assertion failure instead of being
caught by `tsc`. Every other property is optional under the type's index
signature, so no other field is needed.

The empty-string case is not hypothetical: Vercel stores a variable that was added with no value as `""`, and `??` would return that empty string instead of falling through. The implementation must use `||`.

Every test passes an explicit env object. This is required — `vitest.setup.ts` assigns `process.env.DATABASE_URL` before any test runs, so a test relying on the real `process.env` could never observe the fallback branch.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/db/connection.test.ts
```

Expected: FAIL — cannot resolve `@/db/connection`.

- [ ] **Step 3: Write the implementation**

Create `src/db/connection.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/db/connection.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Wire the resolver into the Drizzle client**

Replace the contents of `src/db/index.ts`:

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { resolveConnectionString } from "./connection";

const pool = new Pool({
  connectionString: resolveConnectionString(),
  // Bounded so a fleet of warm Fluid Compute instances can't exhaust
  // Supabase's free-tier pooler connection budget. pg's default of 10 per
  // instance is too generous once several instances are warm.
  max: 5,
});

export const db = drizzle(pool, { schema });
```

- [ ] **Step 6: Point migrations at the direct connection**

In `drizzle.config.ts`, replace the `dbCredentials` block:

```ts
  dbCredentials: {
    // Supabase's pooled connection (POSTGRES_URL) runs in transaction mode and
    // does not hold a session across statements, which migrations need.
    // POSTGRES_URL_NON_POOLING is the direct connection Vercel injects; it is
    // unset locally, so DATABASE_URL still applies during development.
    url: process.env.POSTGRES_URL_NON_POOLING ?? process.env.DATABASE_URL!,
  },
```

Leave `drizzle.config.test.ts` alone — it targets `TEST_DATABASE_URL` and is local-only.

- [ ] **Step 7: Verify nothing regressed**

```bash
npm run typecheck && npm run lint && npm test
```

Expected: typecheck and lint clean; the full vitest suite passes against the local `_test` database, proving the resolver change did not disturb the existing database wiring.

- [ ] **Step 8: Commit**

```bash
git add src/db/connection.ts src/db/index.ts tests/db/connection.test.ts drizzle.config.ts
git commit -m "feat: resolve Postgres connection from DATABASE_URL or POSTGRES_URL"
```

---

### Task 2: Vercel project configuration

**Files:**
- Modify: `vercel.ts`

**Interfaces:**
- Consumes: `npm run db:migrate` (an existing script that runs `drizzle-kit migrate`, now reading `POSTGRES_URL_NON_POOLING` after Task 1).
- Produces: a build command that applies migrations before compiling. Task 6 verifies this in the deployment log.

- [ ] **Step 1: Rewrite `vercel.ts`**

```ts
import { type VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  // Migrations run before the build so a bad migration fails the deployment
  // instead of shipping an app against a stale schema. drizzle.config.ts calls
  // dotenv on .env.local, which doesn't exist in a Vercel build; dotenv treats
  // a missing file as a no-op, so the injected Vercel environment is used.
  buildCommand: "npm run db:migrate && next build",
  // Hobby permits one cron invocation per day at an imprecise time. The
  // scheduler tick, delivery retries, and the unresolved-event sweep therefore
  // all run daily. Restore "0 * * * *" on upgrading to Pro.
  crons: [{ path: "/api/cron/scheduler", schedule: "0 9 * * *" }],
};
```

- [ ] **Step 2: Verify the config still typechecks**

```bash
npm run typecheck
```

Expected: clean. `buildCommand` and `crons` are both valid `VercelConfig` fields.

- [ ] **Step 3: Commit**

```bash
git add vercel.ts
git commit -m "chore: run migrations in build, drop cron to daily for Hobby"
```

---

### Task 3: Create and link the Vercel project

**Files:** none — this task operates on the Vercel platform.

**Interfaces:**
- Produces: a linked project (`.vercel/project.json`, gitignored) and **the confirmed production hostname**, which every URL in Tasks 5 and 7 depends on.

**This task is a hard gate.** Do not begin Task 5 or Task 7 until the hostname is confirmed and reported to the user.

- [ ] **Step 1: Confirm CLI authentication and scope**

```bash
vercel whoami
```

Expected: `tomericco`. If it prints nothing or errors, stop and ask the user to run `vercel login`.

- [ ] **Step 2: Create the project**

```bash
vercel project add versional
```

Expected: confirmation that the project was created. If the name is already taken **within this account**, the command errors — stop and ask the user for an alternative name.

- [ ] **Step 3: Link the working directory**

```bash
vercel link --project versional --yes
```

Expected: `.vercel/project.json` is written. It is already covered by `.gitignore` (`.vercel`), so nothing to commit.

- [ ] **Step 4: Confirm the project name**

```bash
vercel project ls
```

Expected: `versional` appears in the list.

**What this does and does not prove.** It confirms the project name within this account. It does **not** confirm the auto-assigned production hostname: if another Vercel account already owns a project called `versional`, the alias becomes `versional-<hash>.vercel.app` instead. The production alias is only reported authoritatively by the deploy in Task 6, Step 2 — which happens *after* Task 5 writes URL-bearing environment variables. Task 6, Step 3 exists to reconcile that ordering. Do not skip it.

- [ ] **Step 5: Record the presumed hostname and report to the user**

`https://versional.vercel.app` returned HTTP 404 during design, meaning no deployment currently holds it, so it is the expected assignment. Record it for later tasks to read rather than re-derive:

```bash
echo "https://versional.vercel.app" > "$SCRATCHPAD/prod-url.txt"
```

Report to the user: *"Project `versional` created. Expected production hostname is `https://versional.vercel.app`; the deploy in Task 6 confirms it. Hold off on registering redirect URIs until then."* Task 7 is the step that must not run on an unconfirmed hostname.

---

### Task 4: Provision Supabase

**Files:** none — this task operates on the Vercel platform.

**Interfaces:**
- Consumes: the linked project from Task 3.
- Produces: `POSTGRES_URL` and `POSTGRES_URL_NON_POOLING` on the Production environment, consumed by `resolveConnectionString` (Task 1) and `drizzle.config.ts` (Task 1, Step 6).

- [ ] **Step 1: Confirm Supabase is available on the Marketplace**

```bash
vercel integration discover --category storage
```

Expected: Supabase appears in the results. This is a read-only command and needs no confirmation from the user.

- [ ] **Step 2: Install the integration**

```bash
vercel integration add supabase --yes
```

Supabase is a **connectable** integration: the CLI cannot drive the account handshake end to end. If the command hands off to a browser or a "claim" step, **stop and ask the user to complete it**, then continue. Do not retry the bare `add` in a loop, and do not substitute a manually created database — the whole point of this path is the automatic env var injection and unified billing the user chose.

If a browser step is needed, tell the user:

```bash
vercel integration open supabase
```

- [ ] **Step 3: Verify the connection strings landed**

```bash
vercel env ls production
```

Expected: `POSTGRES_URL` and `POSTGRES_URL_NON_POOLING` are listed. Names only — never print values.

If `POSTGRES_URL_NON_POOLING` is missing, stop. Migrations in Task 6 depend on it; do not fall back to the pooled URL for DDL.

- [ ] **Step 4: Report to the user**

State that the Supabase database is provisioned and which variables were injected. No commit — nothing changed in the repo.

---

### Task 5: Push application environment variables

**Files:**
- Create: `$SCRATCHPAD/push-env.mjs` (one-time helper, deliberately **not** committed — it handles secrets)

**Interfaces:**
- Consumes: `.env.local` (source of truth for the 18 copied values), the hostname from Task 3.
- Produces: 21 application variables on Production, verified in Step 3.

**Why a Node script rather than a bash loop:** `.env.local` contains a double-quoted value with literal `\n` escapes (`GITHUB_APP_PRIVATE_KEY`). Shell quote-stripping mangles it in ways that are hard to see, and a corrupted key fails only later, at GitHub App authentication, with an opaque error. Node parses it once, correctly.

- [ ] **Step 1: Write the helper script**

Create `$SCRATCHPAD/push-env.mjs`:

```js
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

// The 18 variables copied verbatim from .env.local. Deliberately an explicit
// allowlist, not "everything in the file" — TEST_DATABASE_URL must never be
// pushed, and the three URL-bearing variables are environment-specific and
// handled separately below.
const COPY = [
  "ANTHROPIC_API_KEY",
  "CREDENTIALS_ENCRYPTION_KEY",
  "CRON_SECRET",
  "GENERATION_MODEL",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_WEBHOOK_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "LINKEDIN_API_VERSION",
  "LINKEDIN_CLIENT_ID",
  "LINKEDIN_CLIENT_SECRET",
  "NEXTAUTH_SECRET",
  "NOTION_CLIENT_ID",
  "NOTION_CLIENT_SECRET",
  "NOTION_WEBHOOK_VERIFICATION_TOKEN",
];

const PROD_URL = process.argv[2];
if (!PROD_URL || !PROD_URL.startsWith("https://")) {
  console.error("Usage: node push-env.mjs https://<host>");
  process.exit(1);
}

// Minimal .env parser: KEY=VALUE, optionally double- or single-quoted.
// Surrounding quotes are stripped; escape sequences inside are left as-is,
// which is exactly what GITHUB_APP_PRIVATE_KEY needs.
function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const env = parseEnv(readFileSync(".env.local", "utf8"));

const specific = {
  NEXTAUTH_URL: PROD_URL,
  NOTION_OAUTH_REDIRECT_URI: `${PROD_URL}/api/notion/callback`,
  LINKEDIN_REDIRECT_URI: `${PROD_URL}/api/linkedin/callback`,
};

const missing = COPY.filter((k) => !env[k]);
if (missing.length) {
  console.error("Missing or empty in .env.local:", missing.join(", "));
  process.exit(1);
}

const all = { ...Object.fromEntries(COPY.map((k) => [k, env[k]])), ...specific };

for (const [key, value] of Object.entries(all)) {
  const res = spawnSync("vercel", ["env", "add", key, "production", "--force"], {
    input: value,
    encoding: "utf8",
  });
  // Print the name and status only. Never the value.
  console.log(`${key}: ${res.status === 0 ? "ok" : "FAILED"}`);
  if (res.status !== 0) console.error(res.stderr);
}
```

- [ ] **Step 2: Run it from the repo root**

```bash
node "$SCRATCHPAD/push-env.mjs" "$(cat "$SCRATCHPAD/prod-url.txt")"
```

Expected: 21 lines, all `ok`. The script exits early if any expected variable is missing from `.env.local` rather than pushing a partial set.

If `--force` is rejected by this CLI version (54.18.6), remove the flag and delete any pre-existing variable first with `vercel env rm <name> production --yes`.

- [ ] **Step 3: Verify the full set**

```bash
vercel env ls production
```

Expected: the 18 copied names, the 3 environment-specific names, and the Supabase-injected names from Task 4. Confirm `TEST_DATABASE_URL` is **absent**.

- [ ] **Step 4: Confirm the private key survived the round trip**

This is the one value where silent corruption is likely and the failure surfaces far from the cause. Pull to the scratchpad — **never** to `.env.local` — and compare lengths without printing either value:

```bash
vercel env pull "$SCRATCHPAD/verify.env" --environment=production --yes
node -e '
  const fs = require("fs");
  const pick = (f) => {
    const line = fs.readFileSync(f, "utf8").split("\n").find(l => l.startsWith("GITHUB_APP_PRIVATE_KEY="));
    return line ? line.slice("GITHUB_APP_PRIVATE_KEY=".length).replace(/^"|"$/g, "").length : -1;
  };
  const local = pick(".env.local");
  const remote = pick(process.env.SCRATCHPAD + "/verify.env");
  console.log("local length:", local, "remote length:", remote, local === remote ? "MATCH" : "MISMATCH");
'
```

Expected: `MATCH`. A mismatch means quote-stripping altered the value — re-push that single variable before continuing.

- [ ] **Step 5: Delete the scratchpad artifacts**

```bash
rm -f "$SCRATCHPAD/verify.env"
```

Both files hold plaintext secrets. `push-env.mjs` may stay for the run's duration but must never be committed; the scratchpad is outside the repo, so `git status` should show nothing new. Confirm that.

---

### Task 6: First production deploy

**Files:** none.

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: a live production deployment with the schema migrated.

- [ ] **Step 1: Confirm the working tree is clean and the build passes locally**

```bash
git status --short && npm run build
```

Expected: no uncommitted changes; build completes. A local build failure here is far cheaper to diagnose than a remote one.

- [ ] **Step 2: Deploy to production**

```bash
vercel deploy --prod
```

This is an outward-facing action that publishes the app. Confirm with the user before running it if they have not already said to proceed.

Read the **Production** URL from the command's output. This is the authoritative hostname.

- [ ] **Step 3: Reconcile the hostname (gate for Task 7)**

Compare the deploy's production URL against what Task 3 recorded:

```bash
cat "$SCRATCHPAD/prod-url.txt"
```

If they match, continue.

If they differ — Vercel assigned a suffixed alias — three environment variables now hold wrong values and must be corrected before anything else:

```bash
echo "https://<actual-host>" > "$SCRATCHPAD/prod-url.txt"
URL="$(cat "$SCRATCHPAD/prod-url.txt")"
printf '%s' "$URL"                              | vercel env add NEXTAUTH_URL production --force
printf '%s' "$URL/api/notion/callback"          | vercel env add NOTION_OAUTH_REDIRECT_URI production --force
printf '%s' "$URL/api/linkedin/callback"        | vercel env add LINKEDIN_REDIRECT_URI production --force
vercel deploy --prod
```

Then re-run this step against the new deployment. Report the corrected hostname to the user before Task 7 — they are about to paste it into five dashboards.

- [ ] **Step 4: Verify migrations applied in the build log**

```bash
vercel inspect --logs <deployment-url>
```

Expected: the log shows `drizzle-kit migrate` output before the Next.js build, applying the 37 pending migrations against a fresh database.

If migrations fail, the build fails and nothing is promoted — that is the designed behavior. Read the error before retrying; a connection error means `POSTGRES_URL_NON_POOLING` is missing or wrong (revisit Task 4, Step 3).

- [ ] **Step 5: Verify the app serves**

```bash
curl -s -o /dev/null -w "%{http_code}\n" "$(cat "$SCRATCHPAD/prod-url.txt")/signin"
```

Expected: `200`.

- [ ] **Step 6: Verify the cron endpoint is protected**

```bash
curl -s -o /dev/null -w "%{http_code}\n" "$(cat "$SCRATCHPAD/prod-url.txt")/api/cron/scheduler"
```

Expected: `401`. This confirms `CRON_SECRET` is set in production — the route compares against it, so a `200` here would mean the variable is empty and the endpoint is open.

- [ ] **Step 7: Report to the user**

The app is deployed but **login will not work yet** — no OAuth provider has the production redirect URI registered. Say this explicitly so a failed sign-in is not mistaken for a broken deploy. Task 7 is the user's to complete.

---

### Task 7: Register production URLs with OAuth providers

**Files:** none — these are third-party dashboards.

**This task cannot be performed by an agent.** It requires logging into five external accounts. The deliverable is a precise instruction list for the user plus verification once they confirm completion.

**Interfaces:**
- Consumes: the confirmed hostname from Task 3.
- Produces: working sign-in and integration flows in production.

- [ ] **Step 1: Give the user the exact list**

Substitute the confirmed hostname for `<URL>` in every row. Existing localhost and ngrok entries must be **kept** — production URLs are added alongside them so local development keeps working.

| Provider | Setting | Value |
| --- | --- | --- |
| Google Cloud Console → Credentials | Authorized redirect URI | `<URL>/api/auth/callback/google` |
| GitHub → OAuth App (login) | Authorization callback URL | `<URL>/api/auth/callback/github` |
| GitHub → GitHub App (ingestion) | Setup URL | `<URL>/api/github/setup` |
| GitHub → GitHub App (ingestion) | Webhook URL | `<URL>/api/webhooks/github` |
| Notion → integration settings | Redirect URI | `<URL>/api/notion/callback` |
| Notion → integration settings | Webhook subscription URL | `<URL>/api/webhooks/notion` |
| LinkedIn → app → Auth | Authorized redirect URL | `<URL>/api/linkedin/callback` |

- [ ] **Step 2: Flag the Notion webhook token caveat**

Creating the production webhook subscription triggers a one-time handshake in which Notion sends a `verification_token`. If that token differs from the development one, `NOTION_WEBHOOK_VERIFICATION_TOKEN` in Vercel must be updated or every production webhook signature check fails:

```bash
printf '%s' '<new-token>' | vercel env add NOTION_WEBHOOK_VERIFICATION_TOKEN production --force
```

A change to this variable requires a redeploy to take effect:

```bash
vercel deploy --prod
```

- [ ] **Step 3: Verify end-to-end once the user confirms**

Ask the user to sign in at `<URL>/signin` with Google. A successful sign-in that reaches onboarding proves four things at once: `NEXTAUTH_URL` is correct, the Google redirect URI is registered, `NEXTAUTH_SECRET` is set, and the app can write to the Supabase database through the pooled connection.

If sign-in fails with a redirect URI mismatch, the registered URL does not match the deployed hostname — re-check Task 6, Step 3.

- [ ] **Step 4: Note what remains unverified**

Report honestly. Signing in exercises Google and the database. The GitHub App, Notion, and LinkedIn flows are only verified when the user actually connects each integration from the app's integrations page. Do not claim they work because their URLs were registered.

- [ ] **Step 5: Merge the branch**

```bash
git checkout main && git merge --no-ff deploy/vercel-supabase && git push origin main
```

Confirm with the user before pushing.

---

## Known limitations shipped deliberately

These are accepted design decisions from the spec, not defects. Do not "fix" them mid-execution.

- **Preview deployments cannot authenticate.** Their hostnames are random and unregistrable as OAuth redirect URIs. Environment variables are Production-only, so previews build and serve but sign-in fails.
- **The scheduler runs once daily**, delaying scheduled releases by up to 24 hours and slowing delivery retries. Reverting `vercel.ts` to `0 * * * *` after a Pro upgrade is the only change needed.
- **`ALLOWED_PERSONAL_EMAILS` is unset**, so only work email domains can sign in. If the first sign-in is blocked by `/work-email-required`, this is why.
