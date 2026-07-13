# Product Announcer — MVP Design

**Date:** 2026-07-13
**Status:** Approved for planning

## Overview

An AI-powered, cloud-based service that helps SaaS companies turn their engineering activity (merged GitHub PRs and commits) into product-update announcements, written in the company's own brand voice, on an automated cadence. This MVP scopes to the **core authoring/generation pipeline** on a **lean, headless, multi-tenant foundation** — no public-facing delivery channel (widget, email, changelog page) yet. Output is structured JSON, consumable via polling API or outbound webhook, so it can later be wired into CMSs, Webflow, Customer.io, or other publishing/newsletter targets.

Frontitude is tenant #1, using its own product repos as the first real workload — but the system is built as a genuine multi-tenant SaaS from day one (org, users, billing-ready tenant model), not a single-tenant tool with a tenant_id bolted on.

### Goals

- Automatically capture merged PRs and commits from connected GitHub repos.
- On a per-tenant configurable schedule (cadence and/or backlog threshold), batch pending changes into a single AI-drafted announcement written in the tenant's configured brand voice.
- Let a human review, edit, and approve/reject drafts before anything is considered published.
- Expose approved updates as JSON via API and outbound webhook, for downstream systems to consume.
- Give tenants a history view of every update ever generated, for auditing what's been communicated to their users over time.

### Non-goals (explicitly out of scope for this MVP)

- No public-facing changelog page or embeddable "What's New" widget.
- No email, Slack, or in-app delivery channels — output is JSON via webhook/API only.
- No ticket-tracker (Linear/Jira) integration — PR/commit content only.
- No functional CMS/newsletter-specific publishing integrations (Webflow, Customer.io, Mailchimp, HubSpot, etc.) — these appear only as disabled "coming soon" catalog entries in the Integrations section; Generic Webhook is the only delivery mechanism tenants can actually configure and use.
- No real per-tenant billing/plan enforcement — the tenant data model supports it, but there's no paywall or usage metering yet.
- No multi-language generation — single language (English) for MVP.

## Architecture

```
GitHub PR merged / commits pushed
    → GitHub App webhook → Next.js API route
    → verify signature, extract PR or commit data
    → store as ChangeItem (tenant, repo, sourceType: "pr" | "commit", status: pending)

Scheduler (Vercel Cron, periodic tick e.g. hourly)
    → for each tenant+repo's ScheduleConfig:
        - has the cadence deadline passed? → trigger
        - OR has the pending ChangeItem count >= threshold? → trigger
        - if pending count == 0 at a cadence tick → skip silently, no empty update
    → on trigger: collect all pending ChangeItems for that repo since the last run
    → enqueue ONE generation job for that batch
    → mark those ChangeItems "batched" (linked to the Update once created)

Generation worker
    → fetch the batch's ChangeItems (PR and/or commit sourced, mixed is fine)
    → build a prompt: each item's content + the tenant's VoiceProfile
    → AI SDK generate → ONE structured draft (title, body, category, sourceItems[])
    → store as Update (status: draft)

Dashboard (Next.js, NextAuth-gated, tenant-scoped)
    → Drafts queue: pending AI drafts awaiting review/edit/approval
    → History view: every Update ever generated (draft/approved/published/rejected),
      filterable by status/date/repo — the audit trail of what's been told to users
    → Integrations: manage the active Generic Webhook, browse coming-soon integrations
    → Settings: repo connections, VoiceProfile, ScheduleConfig
    → user edits a draft → approves → status: draft → published, publishedAt set

Publish
    → on publish: available immediately via GET /api/tenants/:id/updates?status=published
    → if the Generic Webhook integration is active: dispatch signed JSON payload, retry with backoff on failure

External system (future: CMS, Webflow, Customer.io, etc.)
    → receives JSON via webhook, or polls the read API
```

### Components

- **Ingestion** — GitHub App webhook handler. Verifies signature, extracts PR-merge or push/commit data per the repo's configured `sourceTypes`, writes `ChangeItem` rows. Does not trigger generation directly.
- **Scheduler** — periodic job that evaluates each tenant/repo's `ScheduleConfig` (cadence and threshold, whichever comes first) and decides whether to fire a batch.
- **Generation worker** — consumes a scheduled batch of `ChangeItem`s, calls the AI SDK with the tenant's `VoiceProfile` and the batch's content, writes one `Update`.
- **Dashboard** — drafts queue, history view, integrations, and settings (repos, voice profile, schedule).
- **Integrations** — see dedicated section below; owns outbound delivery of published updates.
- **Publish API** — read endpoint for polling, used regardless of which (if any) integration is active.
- **Auth** — NextAuth (Auth.js), org/tenant-scoped sessions.

## Data Model

```
Tenant
  id, name, createdAt

User
  id, email, name

TenantMember
  tenantId, userId, role (owner/member)

Repo
  id, tenantId, githubRepoFullName, githubInstallationId, defaultBranch,
  sourceTypes (array: ["pr"] | ["commit"] | ["pr","commit"])

ScheduleConfig
  id, tenantId, repoId, cadence (daily/weekly/biweekly/monthly/none),
  threshold (int, e.g. 5), lastRunAt
  -- cadence "none" means threshold is the only trigger (no calendar deadline ever fires);
  -- threshold 0/null means cadence is the only trigger (fires every tick regardless of count)

VoiceProfile
  id, tenantId, tone, readingLevel, doList, dontList, examplePhrases

ChangeItem
  id, tenantId, repoId, sourceType ("pr" | "commit"), status (pending/batched), updateId (nullable),
  -- pr-sourced fields:
  prNumber, prTitle, prDescription, prUrl, mergedAt,
  -- commit-sourced fields:
  commitSha, commitMessage, diff, commitUrl, committedAt

Update
  id, tenantId, repoId, title, body, category (new/improved/fixed),
  status (draft/approved/published/rejected), sourceItems (jsonb array of ChangeItem ids),
  createdAt, publishedAt, editedBy

WebhookConfig
  id, tenantId, url, secret, active

WebhookDelivery
  id, updateId, webhookConfigId, status (pending/success/failed), attempts, lastAttemptAt
```

`WebhookConfig`/`WebhookDelivery` back the one functional integration ("Generic Webhook"). The other catalog entries described in **Integrations** below (Webflow, Customer.io, etc.) are a static, hardcoded list for the coming-soon UI — they have no backing table or config schema in this MVP.

Key relationships: `ScheduleConfig` governs when pending `ChangeItem`s for a tenant+repo get batched into an `Update`. A batch can mix PR-sourced and commit-sourced `ChangeItem`s. `ChangeItem` is single-commit / single-PR by design — grouping multiple small commits into one coherent announcement is the scheduler's/generation worker's job (the same batching mechanism already used for multiple PRs), not something baked into the `ChangeItem` schema itself. `Update` rows are never deleted; status transitions (draft → approved → published, or → rejected) are what populate the history view.

### Example published Update JSON

```json
{
  "id": "upd_123",
  "tenantId": "...",
  "title": "This week's updates",
  "body": "- New: faster search\n- New: dark mode\n- Fixed: export bug",
  "category": "improved",
  "status": "published",
  "sourceItems": ["ci_101", "ci_104", "ci_108"],
  "createdAt": "...",
  "publishedAt": "..."
}
```

## GitHub Integration

- Tenants install a GitHub App scoped to the repos they want connected.
- Per repo, `sourceTypes` determines which webhook events matter: `pull_request` (merged, to default branch) for `"pr"`, `push` (to default branch) for `"commit"`.
- Each PR-merge or each commit in a push becomes its own `ChangeItem` — no content batching at ingestion time.

## Integrations

A dedicated dashboard section that presents delivery of published `Update`s as a catalog, not a single hardcoded webhook field:

- **Active:**
  - **Generic Webhook** — fully functional. Tenant sets a URL; on publish, the payload is signed (HMAC) and POSTed, with retry/backoff on failure (see Error Handling). Backed by `WebhookConfig` / `WebhookDelivery`.
- **Coming soon** (static catalog entries, disabled — no config UI, no backing data, no delivery logic in this MVP):
  - Webflow
  - Customer.io
  - Mailchimp
  - HubSpot

The coming-soon list exists to communicate product direction and collect intent (e.g. a "notify me" click), not to be configured or wired up yet. Turning one of these into a real integration later means adding its own config schema and a delivery implementation, following the same pattern as Generic Webhook — the Integrations section is designed to hold more than one active entry, not to be replaced.

## Voice Profile

Each tenant configures a `VoiceProfile` (tone, reading level, do's/don'ts, example phrases) that's injected into every generation prompt alongside the batch's `ChangeItem` content. This is the product's core differentiator versus generic AI-changelog tools, so it's built into the MVP rather than deferred.

## Error Handling

- **Webhook ingestion** — verify GitHub signature; reject invalid payloads. Malformed payloads are logged and dropped, not retried (GitHub itself retries webhook delivery on failure).
- **Scheduler run** — if generation fails for a batch, its `ChangeItem`s stay `pending` (not marked `batched`) and roll into the next run rather than being lost.
- **Generation** — AI SDK call failures get one retry; if still failing, the batch is flagged (e.g. `failed` status) and surfaces in the dashboard for manual retry.
- **Outbound webhook delivery** — signed (HMAC) payload, retried with backoff (e.g. 3 attempts), tracked in `WebhookDelivery`. The polling API remains the source of truth even if push delivery ultimately fails.

## Tech Stack

- Next.js (App Router) on Vercel — dashboard UI + API routes.
- Postgres (via Vercel Marketplace, e.g. Neon/Supabase) — all entities above.
- AI SDK v6 through Vercel AI Gateway — model-agnostic generation.
- Vercel Cron — scheduler tick.
- NextAuth (Auth.js) — tenant-scoped authentication.
- GitHub App + webhooks — ingestion.

## Testing Strategy

- **Unit** — scheduler trigger logic (cadence vs threshold vs "whichever first," zero-pending skip), webhook signature verification, prompt-building from a `ChangeItem` batch.
- **Integration** — webhook → `ChangeItem` persistence; scheduler run → batch → `Update` creation, including mixed PR + commit batches; publish → outbound webhook delivery + retry.
- **Manual/E2E** — install GitHub App on a real test repo, merge a PR, verify a draft appears, edit and approve it, confirm it's queryable via the API and delivered to a test webhook receiver.

## Open Questions / Future Work

- Turning coming-soon catalog entries (Webflow, Customer.io, Mailchimp, HubSpot) into real, configurable integrations.
- Delivery channels: public changelog page, embeddable widget, email digest, Slack.
- Ticket-tracker enrichment (Linear/Jira) as an additional generation input.
- Billing/plan enforcement once real external tenants onboard.
- Multi-language generation.
