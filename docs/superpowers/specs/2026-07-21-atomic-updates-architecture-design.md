# Atomic Updates Architecture

Restructure the core pipeline from two layers to three: raw source events cluster
into *atomic updates* (one meaningful user-facing change), and atomic updates are
composed into *releases* (one shippable announcement).

Today the app maps each commit or PR one-to-one onto a `change_items` row,
enriches it in isolation, and batches whatever is `pending` into an `updates`
row. There is no notion that three commits and a follow-up fix describe a single
thing. This spec introduces that layer, generalizes sources beyond GitHub, and
renames the shippable artifact to *release*.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Source model | Keep `change_events` (evolved `change_items`), typed `commit \| pull_request \| task` | Preserves the audit trail and the migration is an in-place alter. |
| Task providers | Provider-agnostic from day one; Notion first | Linear/Jira are plausible next. Naming it `notion_task` would cost a migration later. |
| Resolver scope | Open atomic updates only | Keeps the candidate set small and cheap. A fix to a shipped feature is genuinely new news, not an amendment. |
| Noise filtering | Three tiers: deterministic → Haiku classifier → Sonnet resolver | Kills most commits before any model call. |
| Atomic update summary | Regenerate on attach, freeze on manual edit | The list is what the user curates from; a stale summary means curating on wrong information. |
| Release composition | Manual selection, or scheduler creates a **draft** | Auto-publishing an uncurated sweep contradicts the point of curation. |
| Atomic update in a draft release | Still open for assignment; belongs to at most one release | Nothing has been communicated yet, so there is nothing to preserve. |
| Stale drafts | Catch-up affordance, merge-regenerate | Never silently rewrite text a human touched. |
| Notion delivery | Public integration (OAuth) + webhooks. No polling. | Minimal. Polling is additive later. |
| Resolver concurrency | Batched per push, serialized per tenant by advisory lock | Batching is both faster and more accurate than a sequential loop. |
| Historical backfill | None | Running the resolver over all history is expensive and produces atomic updates nobody asked for. |

## Pipeline

```
commit / PR / task
  → deterministic filter        no model call
  → Haiku classifier            userFacing? + one-line summary
  → Sonnet resolver             assign to open atomic update | create new
  → atomic_update               summary regenerates on attach, freezes on manual edit
  → release                     manual selection, or scheduler drafts
  → publish                     → atomic updates archive
```

## Data model

### `change_events` (in-place evolution of `change_items`)

New columns:

- `type` — `commit | pull_request | task`
- `provider` — `github | notion` (extensible)
- `externalId` — provider-native id; the idempotency key
- `externalUrl`
- `atomicUpdateId` — nullable FK; null means unassigned
- `userFacing` — retained from today's enrichment
- `filterReason` — nullable; why the deterministic tier dropped it

`updateId` is dropped — the link to a release is now transitive, through
`atomicUpdateId`.

Backfill on migration: `type` derives from which columns are populated
(`prNumber` present → `pull_request`, else `commit`); `provider` is `github` for
every existing row. Existing `pending` rows keep `atomicUpdateId` null and appear
in the change-events list as unassigned.

### `atomic_updates` (new)

- `tenantId`, `releaseId` (nullable FK, at most one)
- `title`, `summary` — LLM-generated, user-editable
- `summaryEditedAt` — non-null freezes regeneration
- `category`
- `status` — `open | released` (`released` is the archive state; there is no
  separate manual archive)
- `createdAt`, `updatedAt`

One atomic update has many `change_events`. Exclusivity of `releaseId` is what
makes "which release is this shipping in" always have one answer.

### `releases` (renamed from `updates`)

Existing columns carry over unchanged (`title`, `body`, `status`,
`reviewStatus`, `reviewIssues`, `editedBy`, …). `sourceItems` jsonb is replaced
by the `atomic_updates.releaseId` FK.

New:

- `bodyEditedAt` — drives merge-regenerate vs regenerate
- `composedAt` — the timestamp the catch-up deltas are measured against

### `notion_connections` (new)

Mirrors `webflow_connections`: encrypted `accessToken` / `refreshToken`,
`workspaceId`, `botId`, `databaseId`, `statusPropertyId`, `doneValues[]`,
`status` (`active | needs_reauth | misconfigured`).

## Ingestion

### Tier 1 — deterministic filter

No model call. Extends the drops `ingest-push.ts` already performs (merge
commits, empty diffs) with: lockfile-only changes, test-only changes, and
`chore:` / `docs:` / `ci:` conventional-commit prefixes. Dropped events are still
stored, with `filterReason` set, and are hidden by default in the UI.

Task-source rules differ — e.g. skip tasks with an empty description — so the
tier is per-source-type, sharing a common interface.

### Tier 2 — Haiku classifier

Roughly today's `enrich-change-item.ts`: per-event, independent, fans out at
concurrency 5. Returns `{userFacing, summary, category, confidence}`. Fails open,
as today.

### Tier 3 — Sonnet resolver

Runs once per arrival batch, not once per event. Input: all surviving
`userFacing` events plus the tenant's open atomic updates (title + summary, not
full evidence). Output:

```ts
{ eventId, action: "assign", atomicUpdateId }
| { eventId, action: "create", title, summary, category }
```

Batching is a correctness improvement, not only a speed one: commits within one
push are the likeliest to belong together, and a sequential loop decides each in
ignorance of the rest. Cap at 25–30 events per call; chunk sequentially beyond
that.

The whole plan applies in one transaction. A failed chunk leaves its events
unassigned — recoverable, not lost.

### Concurrency

A per-tenant Postgres advisory lock is held across resolve-and-apply, so
concurrent pushes and task webhooks cannot both create an atomic update for the
same feature. Tiers 1 and 2 stay parallel and outside the lock. This follows the
lock-across-work pattern already in `src/lib/publishing/dispatch.ts`.

Ingestion remains deferred via Next's `after()`, so none of this blocks a webhook
response. The cost of slowness is UI latency, not a timeout.

## Notion integration

A **public integration** — OAuth 2.0, installable by any workspace, the direct
analogue of the existing GitHub App. On install we receive `access_token`,
`refresh_token`, `workspace_id`, `bot_id`, and owner info; the tenant picks which
databases to grant via Notion's page picker during consent.

Real-time delivery uses connection webhooks, subscribing to
`page.properties_updated`. The payload carries `workspace_id` (routes to the
tenant) and an `updated_properties` array (cheaply ignore edits that don't touch
the configured status property), but **not** the property values — a follow-up
`GET /pages/{id}` fetches those, using the stored token.

Signature verification is HMAC-SHA256 via `X-Notion-Signature`, the same shape as
the GitHub webhook verification already in
`src/lib/integrations/github/github-webhook.ts`.

### Notion API facts this design depends on

Verified against `developers.notion.com` and Notion's help center, 2026-07-21.

- **Webhook subscriptions are created in Notion's developer UI, not via API**, with
  a one-time `verification_token` handshake. This is a one-off setup for our
  integration, not per tenant.
- **Delivery is at-most-once.** Notion retries up to 8 times over ~24h but does
  not guarantee delivery. Unlike GitHub's at-least-once webhooks, a dropped event
  is simply lost.
- **Events may arrive out of order.** Use payload timestamps, not arrival order.
- **The integration only receives events for pages explicitly shared with it.**
  There is no workspace-wide firehose. The OAuth page picker defines the scope.

### Known gap, accepted

**Unresolved:** whether one subscription on a public integration fans in events
from every install (routed by `workspace_id`), or whether each workspace needs
its own subscription. Notion's docs support both readings and third-party guides
favor fan-in. If it turns out to be per-workspace, self-serve onboarding is
blocked and the fallback is on-demand reconciliation. **Confirm with a hands-on
test against a second workspace before building the webhook route.**

**Accepted:** no polling means no backfill on connect — a tenant links Notion and
sees nothing until their next task completes — and dropped webhooks are
unrecoverable. Both are additive to fix later: one function querying tasks
completed since the last recorded event, wired to a "Sync tasks" button, and
optionally promoted to the existing cron tick.

## Composition

### Manual

The user selects atomic updates and drafts. This reuses today's generation path
— `compose-prompt.ts`, brand profile, personas, few-shot examples, and the
`reviewAndReconcile` loop — with `serializeBatch()` fed atomic update titles and
summaries instead of per-item enrichment lines.

### Scheduled

`schedule_configs` and the hourly cron survive largely unchanged. Cadence or
threshold fires, sweeps all open atomic updates into a **draft** release, and
stops. The `autoPublish` flag and its branch are removed — nothing publishes
unattended.

### Catch-up

A draft release goes stale in two ways, both measured against `composedAt`:

- **Evidence delta** — new change events attached to atomic updates already in
  this release
- **Membership delta** — new open atomic updates not in this release

Both surface as one count: *"5 new updates since this draft — catch up."*
Clicking regenerates.

Regeneration **merges**: the composer receives the current body plus the new
atomic updates and integrates them while preserving existing wording and
structure. This is the only behavior that survives the realistic sequence — user
edits the intro, three atomic updates land, user hits catch-up — without either
destroying work or leaving a visible seam. A "start over" escape hatch discards
and regenerates from scratch, but is not the default.

## Lifecycle

An atomic update is `open` from creation until a release containing it publishes,
at which point it becomes `released` and moves to history/archive. Only
publishing closes it — sitting in an unpublished draft does not.

## UI

- **Change events** — new list, all events, filterable by type/provider/assigned.
  Non-user-facing and deterministically-filtered events hidden by default.
  Reassignment to a different atomic update is the manual override on the
  resolver.
- **Atomic updates** — the primary curation surface. Open ones, their evidence,
  inline title/summary editing (which sets `summaryEditedAt`), and selection for
  a release.
- **Releases** — today's drafts/history pages, renamed, plus the catch-up banner.
- **Integrations** — Notion connect card alongside GitHub and Webflow.

## Testing

- Deterministic filter rules — pure, table-driven, per source type.
- Resolver plan application — assign/create/mixed, and the failed-chunk case
  leaving events unassigned.
- Advisory lock — two concurrent pushes for the same tenant produce one atomic
  update, not two.
- Summary regeneration freeze — `summaryEditedAt` suppresses regeneration on
  attach.
- Catch-up delta computation — both evidence and membership deltas, against
  `composedAt`.
- Merge-regenerate — hand-edited body survives.
- Release exclusivity — an atomic update cannot join a second release.
- Migration — `type`/`provider` backfill correctness against real-DB fixtures,
  following the existing schema-test pattern.

## Suggested phasing

This is larger than one implementation plan. It decomposes cleanly along the
pipeline, each phase shippable on its own:

1. **Schema + resolver.** Migrate `change_items` → `change_events`, add
   `atomic_updates`, rename `updates` → `releases`. Build the three-tier filter
   and the batched resolver over the existing GitHub sources. No new UI beyond
   an atomic-updates list. This is the core bet and validates whether clustering
   quality is good enough to build on.
2. **Composition.** Repoint generation at atomic updates, add the catch-up
   affordance and merge-regenerate, remove `autoPublish`.
3. **Change-events UI.** The full list plus manual reassignment.
4. **Notion.** Public integration, OAuth flow, webhook route.

Phase 1 carries essentially all the risk. Phases 2–4 are additive.

## Out of scope

- Polling / reconciliation for Notion (see accepted gap above)
- Task providers other than Notion
- Historical backfill of atomic updates
- Auto-publishing of any kind
