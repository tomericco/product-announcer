# Deploying to Vercel with Supabase Postgres

**Date:** 2026-07-28
**Status:** Approved design

## Goal

Run the app in production on Vercel, backed by a Supabase Postgres database
provisioned through the Vercel Marketplace, reachable at
`https://versional.vercel.app`.

## Decisions

| Decision | Choice | Consequence |
| --- | --- | --- |
| Vercel plan | Hobby | Cron runs once per day, not hourly. |
| Production URL | `versional.vercel.app` | No custom domain; redirect URIs are tied to this hostname. |
| Database | Supabase via Vercel Marketplace | Auto-provisioned, env vars injected, unified billing. |
| Credentials | Reuse the dev OAuth apps | Add production redirect URIs to the existing apps; copy secrets up. |
| Scheduler trigger | Vercel cron, daily | Scheduled releases may go out up to 24h late. |

`versional.vercel.app` returned HTTP 404 during design, meaning no deployment
holds it. Project creation is the definitive check — if the name is taken
globally, Vercel assigns `versional-<hash>.vercel.app` and every redirect URI
below changes accordingly. Confirm the real hostname before touching any
provider dashboard.

## Database

`vercel integration add supabase` provisions the Supabase project and injects
connection strings into the Vercel project:

- `POSTGRES_URL` — Supavisor pooled connection, transaction mode. Runtime use.
- `POSTGRES_URL_NON_POOLING` — direct session connection. Migrations.

The app reads these rather than a hand-copied `DATABASE_URL`, so rotated
credentials keep working without a redeploy of stale values.

### Code changes

**`src/db/index.ts`** — resolve the connection string from either variable and
cap the pool:

```ts
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? process.env.POSTGRES_URL,
  max: 5,
});
```

`DATABASE_URL` keeps first precedence so local development and the test suite
are unaffected. `max: 5` bounds how many Postgres connections a single Fluid
Compute instance can hold; the default of 10 across several warm instances can
exhaust Supabase's free-tier pooler budget.

**`drizzle.config.ts`** — prefer the direct connection for DDL:

```ts
url: process.env.POSTGRES_URL_NON_POOLING ?? process.env.DATABASE_URL!,
```

The transaction pooler does not hold a session across statements, which some
DDL requires. Locally `POSTGRES_URL_NON_POOLING` is unset, so `DATABASE_URL`
still applies.

### Transaction pooler safety

The codebase contains no `.prepare()` call sites, so no query depends on
session-scoped prepared statements. Transaction-mode pooling is safe.

### Migrations

37 migrations exist and none have been applied to the production database. The
Vercel build command becomes:

```
npm run db:migrate && next build
```

A failing migration fails the build rather than shipping an app against a stale
schema. `drizzle.config.ts` calls `dotenv` on `.env.local`, which is absent
during a Vercel build; dotenv treats a missing file as a no-op and the injected
Vercel environment is used.

The tradeoff is that two concurrent builds could run migrations simultaneously.
For a single-developer project this risk is accepted in exchange for never
shipping an unmigrated schema.

## Build-time safety

`npm run build` passes locally against the current code. Every route compiles as
dynamic (`ƒ`), so nothing prerenders against the database at build time. The
module-scope `new Pool()` in `src/db/index.ts` does not open a connection
eagerly, so no lazy-initialization refactor is required.

## Scheduler

`vercel.ts` currently declares an hourly cron. Hobby permits one invocation per
day at an imprecise time, so the schedule changes to:

```ts
crons: [{ path: "/api/cron/scheduler", schedule: "0 9 * * *" }],
```

`/api/cron/scheduler` drives three jobs: `runSchedulerTick`,
`retryFailedDeliveries`, and `sweepUnresolvedEvents`. All three now run once
daily. Scheduled releases will publish up to 24 hours after their intended time,
and failed deliveries retry once a day. This is a known, accepted degradation of
Hobby; upgrading to Pro restores `0 * * * *` with no other change.

The route authenticates via `Authorization: Bearer $CRON_SECRET`. Vercel sends
this header automatically when `CRON_SECRET` is set on the project.

## Environment variables

All variables are set for the **Production** environment only.

### Copied verbatim from `.env.local` (18)

`ANTHROPIC_API_KEY`, `CREDENTIALS_ENCRYPTION_KEY`, `CRON_SECRET`,
`GENERATION_MODEL`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`,
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `LINKEDIN_API_VERSION`,
`LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `NEXTAUTH_SECRET`,
`NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET`,
`NOTION_WEBHOOK_VERIFICATION_TOKEN`.

`GITHUB_APP_PRIVATE_KEY` is stored on a single line with literal `\n` escapes;
`src/lib/integrations/github/github.ts:16` converts them back to newlines. The
value copies across unchanged — it must not be expanded to a real multi-line
value.

### Environment-specific (3)

| Variable | Production value |
| --- | --- |
| `NEXTAUTH_URL` | `https://versional.vercel.app` |
| `NOTION_OAUTH_REDIRECT_URI` | `https://versional.vercel.app/api/notion/callback` |
| `LINKEDIN_REDIRECT_URI` | `https://versional.vercel.app/api/linkedin/callback` |

### Supplied by the Supabase integration

`POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`, and the `SUPABASE_*` /
`NEXT_PUBLIC_SUPABASE_*` variables. The app uses only the two Postgres URLs; the
rest are injected by the integration and left unused.

### Not deployed

`TEST_DATABASE_URL` is local-only. `ALLOWED_PERSONAL_EMAILS`,
`REVIEW_MAX_ROUNDS`, and `INVITE_LINK_TTL_DAYS` are unset and fall back to their
in-code defaults; `ALLOWED_PERSONAL_EMAILS` defaults to empty, so only work
email domains can sign in.

## Provider dashboard configuration

These steps require logging into five third-party dashboards and must be
performed by the user. Each URL assumes the hostname is confirmed as
`versional.vercel.app`.

| Provider | Setting | Value |
| --- | --- | --- |
| Google Cloud Console | Authorized redirect URI | `https://versional.vercel.app/api/auth/callback/google` |
| GitHub OAuth App (login) | Authorization callback URL | `https://versional.vercel.app/api/auth/callback/github` |
| GitHub App (ingestion) | Setup URL | `https://versional.vercel.app/api/github/setup` |
| GitHub App (ingestion) | Webhook URL | `https://versional.vercel.app/api/webhooks/github` |
| Notion integration | Redirect URI | `https://versional.vercel.app/api/notion/callback` |
| Notion integration | Webhook subscription | `https://versional.vercel.app/api/webhooks/notion` |
| LinkedIn app | Authorized redirect URL | `https://versional.vercel.app/api/linkedin/callback` |

Existing localhost and ngrok entries stay in place so local development keeps
working. Production URLs are added alongside them, not substituted.

The Notion webhook subscription performs a one-time handshake that returns a
fresh `verification_token`. If Notion issues a new token for the production
subscription, `NOTION_WEBHOOK_VERIFICATION_TOKEN` in Vercel must be updated to
match; the development token will not verify production signatures.

## Preview deployments

Preview deployments receive randomly generated hostnames that cannot be
pre-registered as OAuth redirect URIs. Previews will build and serve, but login
will fail. Environment variables are therefore scoped to Production only.
Resolving this requires a custom domain or a stable preview alias, both out of
scope here.

## Plan limitations accepted

- **Cron frequency.** Once daily instead of hourly, as described above.
- **Commercial use.** Vercel's Hobby plan does not permit commercial use. This
  has no technical effect on the deployment and was flagged and accepted.

## Out of scope

- Custom domain and the associated redirect URI migration.
- Working OAuth on preview deployments.
- Migrating any existing local development data to production. The production
  database starts empty; the first sign-in creates a new workspace via the
  existing onboarding flow.
- Backups, monitoring, and alerting beyond Vercel and Supabase defaults.

## Verification

1. `npm run build` passes locally before deploying.
2. `vercel env ls` shows all 21 application variables (18 copied + 3
   environment-specific) plus the Supabase-injected ones on Production.
3. The deployment build log shows migrations applying successfully.
4. `https://versional.vercel.app` loads the sign-in page.
5. Google sign-in completes and reaches onboarding — this exercises
   `NEXTAUTH_URL`, the OAuth redirect registration, and a real database write in
   one path.
6. `curl` against `/api/cron/scheduler` without an `Authorization` header
   returns 401, confirming `CRON_SECRET` is set.
