# Product Announcer — MVP Design

**Date:** 2026-07-13
**Status:** Approved for planning

## Overview

An AI-powered, cloud-based service that helps SaaS companies turn their engineering activity (merged GitHub PRs and commits) into product-update announcements, written in the company's own brand voice, on an automated cadence. This MVP scopes to the **core authoring/generation pipeline** on a **lean, headless, multi-tenant foundation** — no public-facing delivery channel (widget, email, changelog page) yet. Output is structured JSON, consumable via polling API or outbound webhook, so it can later be wired into CMSs, Webflow, Customer.io, or other publishing/newsletter targets.

Frontitude is tenant #1, using its own product repos as the first real workload — but the system is built as a genuine multi-tenant SaaS from day one (org, users, billing-ready tenant model), not a single-tenant tool with a tenant_id bolted on.

### Goals

- Automatically capture merged PRs and commits from connected GitHub repos.
- On a per-tenant configurable schedule (cadence and/or backlog threshold), batch pending changes into a single AI-drafted announcement written in the tenant's configured brand voice and grounded in their product context (industry, user personas).
- Let a human review, edit, preview, and approve/reject drafts before anything is considered published.
- Expose approved updates as JSON via API and outbound webhook, for downstream systems to consume.
- Give tenants a history view of every update ever generated, for auditing what's been communicated to their users over time.
- Give tenants visibility into what's queued for the *next* announcement — the pending changes and when the next run will fire — let them drop individual changes they don't want announced, and let them trigger that run early instead of waiting.

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

Scheduler (Vercel Cron, periodic tick e.g. hourly; OR a manual "Run now" click)
    → for each tenant+repo's ScheduleConfig:
        - has now passed nextScheduledAt? → trigger (cadence path)
          → on fire: nextScheduledAt += cadence interval (roll forward one cycle)
        - OR has the pending (non-excluded) ChangeItem count >= threshold? → trigger (threshold path)
          → nextScheduledAt is untouched by a threshold-triggered run
        - OR was a manual run just requested? → trigger, provided pending count > 0
          ("Run now" is disabled in the UI when there's nothing pending — no empty updates, ever)
          → nextScheduledAt handling depends on the user's choice, see below
        - if now has passed nextScheduledAt but pending count == 0 → skip silently, leave
          nextScheduledAt as-is (no empty update; fires as soon as a ChangeItem arrives and
          the next tick runs — it does not wait for a further full cadence interval)
    → on trigger: collect all pending, non-excluded ChangeItems for that repo
    → enqueue ONE generation job for that batch
    → mark those ChangeItems "batched" (linked to the Update once created)
    → set ScheduleConfig.lastRunAt = now, always (record-keeping, distinct from nextScheduledAt)

Manual "Run now" follow-up (after the batch is generated):
    → user is asked: keep the next scheduled update as-is, or skip it?
    → "Keep it the same" → nextScheduledAt unchanged (the originally-planned cadence run still fires then)
    → "Skip it" → nextScheduledAt += cadence interval (the upcoming occurrence is skipped entirely,
       landing one full cycle later than originally planned — not one cycle from "now")

Generation worker
    → fetch the batch's ChangeItems (PR and/or commit sourced, mixed is fine)
    → build a prompt: each item's content + the tenant's BrandProfile
    → AI SDK generate → ONE structured draft (title, body, category, sourceItems[])
    → store as Update (status: draft)

Onboarding (first-run gate, before any dashboard view is shown)
    → Step 1: install GitHub App, select repo(s)
    → Step 2: set ScheduleConfig (cadence + threshold)
    → BrandProfile auto-created with neutral defaults, editable later — not required to finish onboarding
    → once both steps complete → tenant lands on the Pending view

Dashboard (Next.js, NextAuth-gated, tenant-scoped)
    → Pending view (default landing page post-onboarding):
        - next scheduled run time (ScheduleConfig.nextScheduledAt)
        - current pending ChangeItem count vs. threshold
        - list of pending ChangeItems for the repo, each with a "drop" action →
          status: pending → excluded (permanent, no undo); dropped items stay listed, muted
        - "Run now" action → manually triggers the Scheduler logic immediately over the
          remaining pending (non-excluded) items; resulting Update still lands as a draft
          for review, same as any scheduled run. Immediately after, prompts: keep the next
          scheduled update the same, or skip it (see Scheduler above for the mechanics)
    → Drafts queue: pending AI drafts awaiting review
        - user can freely edit title/body/category before publishing (saved to the Update row)
        - "Preview" shows the current title/body/category rendered in a generic changelog-card
          mockup (headline, body, category badge, date) — a QA aid for catching formatting/length
          issues before publish, not a real delivery surface (see Non-goals)
        - user approves → status: draft → published, publishedAt set
    → History view: every Update ever generated (draft/approved/published/rejected),
      filterable by status/date/repo — the audit trail of what's been told to users
    → Integrations: manage the active Generic Webhook, browse coming-soon integrations
    → Settings: repo connections, BrandProfile, ScheduleConfig

Publish
    → on publish: available immediately via GET /api/tenants/:id/updates?status=published
    → if the Generic Webhook integration is active: dispatch signed JSON payload, retry with backoff on failure

External system (future: CMS, Webflow, Customer.io, etc.)
    → receives JSON via webhook, or polls the read API
```

### Components

- **Ingestion** — GitHub App webhook handler. Verifies signature, extracts PR-merge or push/commit data per the repo's configured `sourceTypes`, writes `ChangeItem` rows. Does not trigger generation directly.
- **Onboarding** — first-run gate before any dashboard view: connect GitHub + set a schedule. Blocks access to the rest of the dashboard until both steps are done.
- **Scheduler** — evaluates each tenant/repo's `ScheduleConfig` (cadence and threshold, whichever comes first) and decides whether to fire a batch; also the entry point for a manual "Run now" trigger, which fires unconditionally.
- **Generation worker** — consumes a batch of `ChangeItem`s (scheduled or manually triggered), calls the AI SDK with the tenant's `BrandProfile` and the batch's content, writes one `Update`.
- **Dashboard** — Pending view (next run + pending changes + Run now), drafts queue (with preview + edit), history view, integrations, and settings (repos, brand profile, schedule).
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
  threshold (int, e.g. 5), lastRunAt, nextScheduledAt
  -- cadence "none" means threshold is the only trigger (nextScheduledAt is never set/checked);
  -- threshold 0/null means cadence is the only trigger (fires every tick regardless of count)
  -- nextScheduledAt is the actual anchor the cadence path checks against — it's an explicit,
  -- independently-movable field, NOT derived from lastRunAt + interval on every read. This is
  -- what lets a manual run "skip" the upcoming occurrence (nextScheduledAt += interval) without
  -- collapsing that into "restart the clock from now" (which lastRunAt-derived math would do).
  -- lastRunAt is pure record-keeping (last time any run happened, for the Pending view / History).

BrandProfile
  id, tenantId, tone, readingLevel, doList, dontList, examplePhrases,
  industry, userPersonas (array of strings)
  -- auto-created with neutral defaults when a tenant finishes onboarding; not required to fill in
  -- industry + userPersonas are injected into the same generation prompt as tone/style, so the
  -- AI writes for a defined audience ("engineering managers at a B2B SaaS") rather than nobody

ChangeItem
  id, tenantId, repoId, sourceType ("pr" | "commit"), status (pending/batched/excluded),
  updateId (nullable), excludedAt (nullable), excludedBy (nullable),
  -- pr-sourced fields:
  prNumber, prTitle, prDescription, prUrl, mergedAt,
  -- commit-sourced fields:
  commitSha, commitMessage, diff, commitUrl, committedAt
  -- "excluded" is a permanent, one-way transition from "pending" (no un-drop in this MVP).
  -- Excluded items are never picked up by scheduler/threshold/manual-run batch collection,
  -- but remain visible (muted) in the Pending view and queryable in History for transparency.

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

## Brand Profile

Each tenant configures a `BrandProfile` covering both *how* they write and *who* they're writing for:

- **Voice/style:** tone, reading level, do's/don'ts, example phrases.
- **Product context:** industry (e.g. "B2B project management SaaS") and user personas (e.g. "engineering managers," "IC developers").

Both halves are injected into the same generation prompt alongside the batch's `ChangeItem` content — tone dictates *how* it's said, industry/personas dictate *what matters* and *how much explaining is needed* for that audience. Keeping them in one entity/settings page reflects that they're really one input to the model, not two independent concerns. This combined context is the product's core differentiator versus generic AI-changelog tools, so it's built into the MVP rather than deferred.

## Generation Strategy

How the generation worker turns a batch + `BrandProfile` into an `Update` — the architectural decisions here, not the literal prompt wording (that's tuned iteratively during implementation).

**Structured output, not free-text parsing.** Generate with the AI SDK's schema-constrained mode (`generateObject`) against a Zod schema matching `{ title, body, category }`. This guarantees a parseable result and removes the need for ad-hoc JSON extraction/repair from a text completion. A result that fails schema validation is treated as a generation failure and follows the same retry-then-flag path as any other AI SDK error (see Error Handling).

**Batch serialization.** Each `ChangeItem` in the batch is rendered into the prompt as a numbered entry tagged with its source type, so the model can distinguish a PR from a raw commit:
```
1. [PR #142] "Add dark mode toggle" — <PR description>
2. [commit a1b2c3d] "fix export timeout" — <diff, truncated>
3. [PR #145] "Rebuild search indexing" — <PR description>
```
The model is not asked to echo back which items it used — `Update.sourceItems` is populated directly from the batch's `ChangeItem` ids by the app, not parsed out of the AI's response.

**Truncation / context limits.** Commit diffs are the main risk of blowing the context window:
- Each commit-sourced `ChangeItem`'s diff is capped at a fixed length (e.g. first ~200 lines) before it ever reaches the prompt.
- If the full serialized batch still exceeds a configured token budget, items are included title/message-only (diff dropped) starting with the largest diffs, rather than failing the run or silently chunking into multiple AI calls.
- This is a fixed, logged fallback for the MVP, not a summarization pipeline — worth revisiting once real batches show whether it's actually needed.

**Model/provider.** Generation runs through the AI SDK v6 via the Vercel AI Gateway, using a single model configured at the platform level (not per-tenant) for the MVP — e.g. `"anthropic/claude-sonnet-4-5"`. The Gateway makes this a config change, not a code change, when the default model needs to move.

## Error Handling

- **Webhook ingestion** — verify GitHub signature; reject invalid payloads. Malformed payloads are logged and dropped, not retried (GitHub itself retries webhook delivery on failure).
- **Scheduler run** — if generation fails for a batch, its `ChangeItem`s stay `pending` (not marked `batched`) and roll into the next run rather than being lost.
- **Manual "Run now" vs. cadence tick racing** — a run (manual or scheduled) claims its batch by marking `ChangeItem`s `batched` in the same transaction that creates the `Update`; a concurrent trigger for the same repo simply finds nothing left `pending` and no-ops rather than double-batching.
- **Generation** — AI SDK call failures *and* schema-validation failures (see Generation Strategy) get one retry; if still failing, the batch is flagged (e.g. `failed` status) and surfaces in the dashboard for manual retry.
- **Outbound webhook delivery** — signed (HMAC) payload, retried with backoff (e.g. 3 attempts), tracked in `WebhookDelivery`. The polling API remains the source of truth even if push delivery ultimately fails.

## Tech Stack

- Next.js (App Router) on Vercel — dashboard UI + API routes.
- Postgres (via Vercel Marketplace, e.g. Neon/Supabase) — all entities above.
- AI SDK v6 through Vercel AI Gateway — model-agnostic generation.
- Vercel Cron — scheduler tick.
- NextAuth (Auth.js) — tenant-scoped authentication.
- GitHub App + webhooks — ingestion.

## Testing Strategy

- **Unit** — scheduler trigger logic (cadence vs threshold vs "whichever first," zero-pending skip, nextScheduledAt roll-forward on cadence fire vs. manual skip vs. manual keep), webhook signature verification, prompt-building from a `ChangeItem` batch (respecting excluded items).
- **Integration** — webhook → `ChangeItem` persistence; drop action → excluded items never appear in a batch; scheduler run → batch → `Update` creation, including mixed PR + commit batches; manual run + skip/keep choice → correct `nextScheduledAt`; publish → outbound webhook delivery + retry.
- **Manual/E2E** — install GitHub App on a real test repo, merge a PR, verify a draft appears, edit and approve it, confirm it's queryable via the API and delivered to a test webhook receiver.

## Open Questions / Future Work

- Turning coming-soon catalog entries (Webflow, Customer.io, Mailchimp, HubSpot) into real, configurable integrations.
- Delivery channels: public changelog page, embeddable widget, email digest, Slack.
- Ticket-tracker enrichment (Linear/Jira) as an additional generation input.
- Billing/plan enforcement once real external tenants onboard.
- Multi-language generation.
