# Notion Task Source

Add Notion as a third ingestion source alongside GitHub commits and pull
requests, so that completing a task in Notion feeds the same pipeline that
commits and PRs feed.

## Prerequisite

**This spec depends on
[2026-07-21-atomic-updates-architecture-design.md](./2026-07-21-atomic-updates-architecture-design.md)
being implemented first** — specifically its phase 1, which introduces the
`change_events` table and the three-tier ingestion pipeline. Read that spec's
"Data model" and "Ingestion" sections before starting; this one assumes them.

The short version of what that architecture provides:

- `change_events` — one row per raw source signal, typed
  `commit | pull_request | task`, with `provider`, `externalId` (the idempotency
  key), and `externalUrl`.
- A three-tier ingestion pipeline: a deterministic filter (no model call), a
  Haiku classifier (`userFacing?`), then a batched Sonnet resolver that assigns
  each event to an existing open *atomic update* or creates a new one.
- A per-tenant Postgres advisory lock held across resolve-and-apply.

This spec's job is to produce `change_events` rows of type `task`. Everything
downstream of that is already built.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Naming | `task`, not `notion_task`; `provider` column | Linear/Jira are plausible next. Baking in the vendor costs a migration later. |
| Auth | Notion **public integration** (OAuth 2.0) | Self-serve install by any workspace. Direct analogue of the existing GitHub App. |
| Delivery | Connection webhooks on `page.properties_updated` | Real-time, documented payload contract, no per-tenant setup burden. |
| Polling | **None**, deliberately | Minimalism. Additive later — see "Accepted gaps". |
| Completion detection | Tenant configures database + status property + done values | Notion has no universal "done"; every workspace models it differently. |

### Alternatives rejected

**Notion database automations ("Send webhook" action).** The tenant builds an
automation in their own workspace pointing at a per-tenant URL with a bearer
header. Rejected because it requires a paid Notion plan, the payload shape is
undocumented (Notion's own docs suggest discovering it via webhook.site), setup
is manual per tenant, and — worst — a failed delivery *pauses the automation*,
which only the tenant can re-enable and which they will not notice.

**Polling only.** Simpler to build (no inbound route, no signature verification)
and self-healing, but gives up real-time.

## Notion API facts this design depends on

Verified against `developers.notion.com` and Notion's help center, 2026-07-21.

- **Public integrations use OAuth 2.0.** On install the app receives
  `access_token`, `refresh_token`, `workspace_id`, `bot_id`, and owner info. The
  tenant selects which pages/databases to grant via a page picker during consent.
- **`page.properties_updated` is the relevant event.** Its payload carries
  `workspace_id`, `entity` (the page), and an `updated_properties` array of
  property *ids* — but **not** the property values. A follow-up
  `GET /pages/{id}` is required to read them.
- **Webhook subscriptions are created in Notion's developer UI**
  (`app.notion.com/developers/connections`), not via API, with a one-time
  `verification_token` handshake. This is a one-off setup for our integration.
- **Signing is HMAC-SHA256 via `X-Notion-Signature`**, computed over the raw body
  with the verification token. The Notion JS SDK ≥5.23.0 exposes
  `verifyWebhookSignature()`.
- **Delivery is at-most-once.** Notion retries up to 8 times over ~24h but does
  not guarantee delivery. This differs from GitHub's at-least-once webhooks: a
  dropped event is simply lost.
- **Events may arrive out of order.** Use payload timestamps, not arrival order.
- **The integration only receives events for pages explicitly shared with it.**
  There is no workspace-wide firehose; the OAuth page picker defines the scope.

### Blocker to resolve before building the webhook route

**Unresolved:** whether a single subscription on a public integration fans in
events from *every* workspace that installed it (routed by `workspace_id`), or
whether each workspace requires its own subscription.

Notion's documentation supports both readings — it describes `workspace_id` as
present so you can "route events appropriately," which implies fan-in, but also
states elsewhere that subscriptions are workspace-specific. Third-party developer
guides favor fan-in.

This matters enormously. Fan-in means one manual setup, and self-serve onboarding
works. Per-workspace means **every new tenant requires manual clicking in
Notion's developer UI**, which makes this design unviable as written; the
fallback would be on-demand reconciliation (see "Accepted gaps") with no webhooks
at all.

**Confirm with a hands-on test against a second workspace before writing the
webhook route.** It is cheap to test and expensive to discover mid-build.

## Data model

### `notion_connections` (new)

One per tenant. Mirrors the shape of `webflow_connections`, including AES-256-GCM
encryption of credentials via `src/lib/credentials/encryption.ts`.

- `tenantId` — unique
- `accessTokenCiphertext` / `Iv` / `AuthTag`
- `refreshTokenCiphertext` / `Iv` / `AuthTag`
- `workspaceId` — the routing key for inbound webhooks; indexed
- `botId`
- `databaseId` — the tenant's tasks database
- `statusPropertyId` — which property signals completion
- `doneValues` — text array; which values of that property mean done
- `status` — `active | needs_reauth | misconfigured`

`status` follows the Webflow precedent: flip to `needs_reauth` on a 401 from the
Notion API, and gate ingestion on `active` with a fully-populated config.

## Connect flow

Three steps, matching the existing Webflow setup wizard in
`src/app/(dashboard)/integrations/`:

1. **Authorize** — OAuth redirect to Notion, tenant grants access and picks
   databases. Callback exchanges the code, stores the encrypted tokens plus
   `workspaceId`.
2. **Select database** — list databases the integration can now see; tenant picks
   their tasks database.
3. **Map completion** — read that database's schema, present its status/select
   properties, tenant picks the property and which values mean done.

The connection is `misconfigured` until step 3 completes, and ingestion ignores
non-`active` connections. This mirrors how incomplete Webflow connections are
gated today.

Token refresh: unlike Webflow (which has no refresh token), Notion issues one.
Refresh on 401 and retry once before flipping to `needs_reauth`.

## Webhook route

`src/app/api/webhooks/notion/route.ts`, a sibling of the existing GitHub webhook
route.

1. Verify `X-Notion-Signature` over the raw body. Reject on mismatch.
2. Handle the one-time `verification_token` handshake payload.
3. Ignore any event type other than `page.properties_updated`.
4. Route to a tenant by `workspace_id`. Unknown workspace → 200 and drop.
5. **Cheap rejection:** if `updated_properties` does not contain the connection's
   `statusPropertyId`, stop here. Most edits to a task are not status changes,
   and this avoids an API call for them.
6. `GET /pages/{id}` to read current property values.
7. If the status value is not in `doneValues`, stop.
8. Upsert a `change_events` row: `type: "task"`, `provider: "notion"`,
   `externalId` = the Notion page id, plus title, description, and `externalUrl`.
9. Hand off to the shared ingestion pipeline.

Steps 6–9 run in Next's `after()`, so the webhook response is not blocked. Return
200 quickly in all cases — Notion's retries do not help us, and a non-200 wastes
their backoff budget on something a retry will not fix.

**Idempotency:** the unique constraint on `(tenantId, provider, externalId)`
absorbs duplicates. A task re-opened and re-completed produces the same
`externalId`; treat the second arrival as an update to the existing
`change_events` row rather than a new one, and do not re-run the resolver if the
event is already assigned to an atomic update.

## Ingestion tiers

The three-tier pipeline is shared, but tier 1 is per-source-type. Task rules:

- Skip tasks with an empty title.
- Skip tasks with no description — there is nothing for the classifier to judge,
  and a bare title is usually an internal chore.

Tiers 2 and 3 are unchanged: the Haiku classifier judges `userFacing` from the
task title and description, and the batched Sonnet resolver assigns or creates.

Note that a task webhook usually delivers a single event, unlike a push which
delivers many. The resolver still runs under the per-tenant advisory lock, so a
task arriving concurrently with a push cannot race it into creating a duplicate
atomic update.

## Accepted gaps

**No backfill on connect.** A tenant links Notion and their change-events list
stays empty until the next task is completed. Historical completed tasks are
never ingested.

**Dropped webhooks are unrecoverable.** At-most-once delivery means an occasional
completed task silently never becomes an atomic update, and nothing surfaces the
gap.

Both are deliberate, and both close with the same addition: one function that
queries the tenant's database for tasks completed since the most recent recorded
`change_event`, wired to a "Sync tasks" button and optionally to the existing
hourly cron in `src/app/api/cron/scheduler/route.ts`. Build it if drops prove
common in practice or if empty-on-connect turns out to hurt onboarding.

## Testing

- Signature verification — valid, invalid, and the handshake payload.
- Event filtering — wrong event type, unknown `workspace_id`, `updated_properties`
  not containing the status property (asserting no API call is made), status
  value not in `doneValues`.
- Idempotency — the same page id completed twice produces one `change_events`
  row and does not re-run the resolver on an already-assigned event.
- Tier 1 task rules — empty title, missing description.
- Connection gating — `needs_reauth` and `misconfigured` connections are skipped.
- Token refresh — 401 triggers one refresh-and-retry, then `needs_reauth`.
- Encryption round-trip for both tokens, following the existing
  `webflow_connections` test pattern.

## Out of scope

- Task providers other than Notion (the schema accommodates them; no adapter)
- Polling / reconciliation (see "Accepted gaps")
- Ingesting Notion page *content* — properties only
- Reacting to task re-opening (a completed task that reverts stays ingested)
