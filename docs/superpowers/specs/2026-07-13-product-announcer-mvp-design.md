# Product Announcer — MVP Design

**Date:** 2026-07-13
**Status:** Approved for planning

## Overview

An AI-powered, cloud-based service that helps SaaS companies turn their engineering activity (merged GitHub PRs and commits) into product-update announcements, written in the company's own brand voice, on an automated cadence. This MVP scopes to the **core authoring/generation pipeline** on a **lean, headless, multi-tenant foundation** — no public-facing delivery channel (widget, email, changelog page) yet. Output is structured JSON, delivered via a signed outbound webhook, so it can later be wired into CMSs, Webflow, Customer.io, or other publishing/newsletter targets. There is no polling/read API in this MVP — webhook is the only delivery mechanism.

Frontitude is tenant #1, using its own product repos as the first real workload — but the system is built as a genuine multi-tenant SaaS from day one (org, users, billing-ready tenant model), not a single-tenant tool with a tenant_id bolted on.

### Goals

- Automatically capture merged PRs and commits from connected GitHub repos.
- On a per-tenant configurable schedule (cadence and/or backlog threshold), batch pending changes into a single AI-drafted announcement written in the tenant's configured brand voice and grounded in their product context (industry, user personas).
- Let a human review, edit, preview, and approve/reject drafts before anything is considered published.
- Expose published updates as JSON via a signed outbound webhook, for downstream systems to consume.
- Give tenants a history view of every announcement actually sent (published), for auditing what's been communicated to their users over time.
- Give tenants visibility into what's queued for the *next* announcement — the pending changes and when the next run will fire — let them drop individual changes they don't want announced, and let them trigger that run early instead of waiting.

### Non-goals (explicitly out of scope for this MVP)

- No public-facing changelog page or embeddable "What's New" widget.
- No email, Slack, or in-app delivery channels, and no polling/read API — the signed outbound webhook is the only delivery mechanism.
- No ticket-tracker (Linear/Jira) integration — PR/commit content only.
- No functional CMS/newsletter/social publishing integrations (Webflow, Customer.io, Mailchimp, HubSpot, LinkedIn, etc.) — these appear only as disabled "coming soon" catalog entries in the Integrations section; Generic Webhook is the only delivery mechanism tenants can actually configure and use.
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

Onboarding (first-run flow, shown once before the dashboard — skippable at any point)
    → Step 1: install GitHub App (GitHub's own picker controls which repos the App *can*
      access; recorded as Tenant.githubInstallationId — one installation per tenant for MVP)
    → Step 2: from the accessible repos, select which ones to actually watch — multiple at
      once — and, per selected repo, which branch (pre-filled with that repo's real GitHub
      default branch, editable to track something else, e.g. "develop")
    → Step 3: set ScheduleConfig (cadence + threshold), applied to every repo picked in Step 2
    → "Skip" is available at any point → Tenant.onboardingCompletedAt is set immediately with
      zero repos/schedule required; repos + branches can be added later from Settings using
      the same Step 2 flow
    → BrandProfile auto-created with neutral defaults, editable later — never blocks onboarding
    → once the user finishes OR skips → Tenant.onboardingCompletedAt is set → tenant lands on
      the Pending view. This is a one-time gate — it is never re-triggered just because a
      tenant currently has zero repos connected.

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
    → History view: every PUBLISHED Update only — "sent announcements" — filterable by
      date/repo. Drafts, in-review edits, and rejected updates do NOT appear here; this is
      the audit trail of what's actually been told to end users, not a full activity log.
    → Integrations: manage the active Generic Webhook, browse coming-soon integrations
    → Settings: repo connections + branches (same add-repo flow as onboarding Step 2),
      BrandProfile, ScheduleConfig

Publish
    → on publish: if the Generic Webhook integration is active, dispatch a signed JSON
      payload immediately, retried with backoff on failure (see Error Handling)
    → no read/polling API in this MVP — a tenant with no webhook configured simply gets no
      outbound delivery (the published Update still exists and shows in History)

External system (future: CMS, Webflow, Customer.io, etc.)
    → receives JSON via the signed webhook
```

### Components

- **Ingestion** — GitHub App webhook handler. Verifies signature, extracts PR-merge or push/commit data per the repo's configured `sourceTypes` and `watchedBranch`, writes `ChangeItem` rows. Does not trigger generation directly.
- **Onboarding** — first-run flow, skippable at any point: connect GitHub, select repos + branches to watch, set a schedule. Finishing or skipping sets `Tenant.onboardingCompletedAt`, a one-time gate — never re-triggered just because a tenant currently has zero repos connected.
- **Scheduler** — evaluates each tenant/repo's `ScheduleConfig` (cadence and threshold, whichever comes first) and decides whether to fire a batch; also the entry point for a manual "Run now" trigger, which fires unconditionally.
- **Generation worker** — consumes a batch of `ChangeItem`s (scheduled or manually triggered), calls the AI SDK with the tenant's `BrandProfile` and the batch's content, writes one `Update`.
- **Dashboard** — Pending view (next run + pending changes + Run now), drafts queue (with preview + edit), history view (published only), integrations, and settings (repos + branches, brand profile, schedule).
- **Integrations** — see dedicated section below; owns outbound delivery of published updates. This is the *only* delivery mechanism in the MVP — there is no read/polling API.
- **Auth** — NextAuth (Auth.js), org/tenant-scoped sessions.

## Data Model

```
Tenant
  id, name, githubInstallationId (nullable), onboardingCompletedAt (nullable), createdAt
  -- githubInstallationId is set once the tenant installs the GitHub App; one installation
  -- per tenant for this MVP (multiple installations per tenant is future work)
  -- onboardingCompletedAt is set when the user finishes OR explicitly skips onboarding —
  -- a one-time gate, not re-derived from whether any repos currently exist

User
  id, email, name

TenantMember
  tenantId, userId, role (owner/member)

Repo
  id, tenantId, githubRepoFullName, githubInstallationId, watchedBranch,
  sourceTypes (array: ["pr"] | ["commit"] | ["pr","commit"])
  -- watchedBranch is user-selected when the repo is added (pre-filled with that repo's
  -- actual GitHub default branch, but editable) — it is NOT assumed to always be "the"
  -- default branch. Applies to both push-sourced ChangeItems and to filtering merged PRs
  -- to only those merged into this branch.
  -- A tenant can add multiple Repos in one pass through the same add-repo action, each
  -- with its own watchedBranch.

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

- Tenants install a GitHub App; GitHub's own install picker controls which repos the App *can* access — recorded as `Tenant.githubInstallationId` (one installation per tenant for MVP).
- From that accessible set, the tenant explicitly selects which repos to actually watch — multiple at once — and, per selected repo, which branch (`Repo.watchedBranch`, pre-filled with GitHub's real default branch, editable). This same selection action is used both during onboarding and later from Settings.
- Per repo, `sourceTypes` determines which webhook events matter: `pull_request` (merged **into `watchedBranch`**) for `"pr"`, `push` (**to `watchedBranch`**) for `"commit"`.
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
  - LinkedIn (post the announcement to the company's LinkedIn Page)

The coming-soon list exists to communicate product direction and collect intent (e.g. a "notify me" click), not to be configured or wired up yet. Turning one of these into a real integration later means adding its own config schema and a delivery implementation, following the same pattern as Generic Webhook — the Integrations section is designed to hold more than one active entry, not to be replaced.

## Brand Profile

Each tenant configures a `BrandProfile` covering both *how* they write and *who* they're writing for:

- **Voice/style:** tone, reading level, do's/don'ts, example phrases.
- **Product context:** industry (e.g. "B2B project management SaaS") and user personas (e.g. "engineering managers," "IC developers").

Both halves are injected into the same generation prompt alongside the batch's `ChangeItem` content — tone dictates *how* it's said, industry/personas dictate *what matters* and *how much explaining is needed* for that audience. Keeping them in one entity/settings page reflects that they're really one input to the model, not two independent concerns. This combined context is the product's core differentiator versus generic AI-changelog tools, so it's built into the MVP rather than deferred.

## Bare UI (current MVP)

Before investing in a visual identity, the MVP ships with a deliberately plain, standard SaaS shell — the goal is a usable, real workflow to validate first; "look and feel" is a separate pass, tracked below under "Design Direction (future)."

- **Layout:** a persistent left sidebar — workspace name/switcher at top, section nav (Pending, Drafts, History, Integrations, Settings) below it, signed-in user pinned to the bottom. This is the standard modern B2B SaaS pattern (Linear, Vercel, Notion, Retool) and replaces any earlier top-nav sketch.
- **Color:** grayscale only — white surfaces, light-gray backgrounds/borders, black/near-black text. No brand accent color anywhere in this pass, including on primary buttons (solid black fill, white text) and the active nav item (a plain bold/border indicator, not a color). "Reject" and other non-primary actions are plain text, not colored red — semantic status color (e.g. a real destructive-red, success-green) is explicitly deferred to the future design pass, not assumed here.
- **Typography:** a single system font stack (Next.js's default `Geist`/`Geist Mono` from the Foundation scaffold is sufficient) — no additional custom font loading in this pass.
- **Components:** standard Tailwind defaults — small border radius, 1px gray borders, no shadows, no custom motion, no iconography or decorative elements beyond what's structurally necessary.
- **Preview:** the Drafts queue's "Preview" (see Generation Strategy) opens in a modal dialog rather than inline, triggered by a "Preview" button; "Approve & Publish" lives inside that modal alongside "Close."

## Design Direction (future) — "The Wire"

Once the bare UI above is validated, this is the intended direction for Product Announcer's actual visual identity — not the default "AI SaaS" look (Inter, white background, blue-to-purple gradient hero, rounded-xl cards with soft shadows, filled rainbow status pills). **Not implemented in this MVP pass** — kept here as documented intent for a later design iteration, not something any current plan builds against. Independent identity — not tied to Frontitude's own brand, since Product Announcer is a standalone product from day one, even though Frontitude is tenant #1.

**Concept: "The Wire."** The product's whole job is turning raw engineering activity into polished, published prose — so the UI is styled like an editorial desk processing a news wire, not a generic admin panel. Pending changes are a wire feed; the Drafts queue is a copy desk where a manuscript gets marked up; approving a draft is "stamping" it for publication; History is the archive/masthead index. This isn't decorative — it makes the review workflow (raw signal → edited copy → published record) legible at a glance.

**Typography:**
- Display/headings — **Fraunces** (variable serif, expressive, available via Google Fonts). Used for page titles, the drafted update's title in the editor and preview, and the workspace nameplate in the header. Never a generic sans for these.
- UI/body text — **Public Sans**. Clean, humanist, used for labels, buttons, table content, form copy. Deliberately not Inter/Roboto/system-ui.
- Technical metadata — **IBM Plex Mono**. Used for anything that came from git: branch names, commit SHAs, timestamps, cadence/threshold values. Reinforces "this originated in code" wherever it appears next to the polished prose.
- Load all three via `next/font/google` in the root layout and expose them as CSS variables (`--font-display`, `--font-body`, `--font-mono`) so every page can reference them consistently.

**Color (light, paper-toned; dark mode is future work, not required for this MVP):**
```
--color-paper:        #F6F1E7   /* page background — warm cream, not white */
--color-surface:      #FFFDF8   /* cards/panels — slightly lighter than paper */
--color-ink:          #1B1712   /* primary text — warm near-black, not pure #000 */
--color-ink-muted:     #6B6255   /* secondary text, captions, metadata labels */
--color-rule:          #DDD3C0   /* hairline borders/dividers — soft tan, not gray-300 */
--color-accent:        #B23A2E   /* "stamp red" — primary actions, Published state */
--color-accent-quiet:  #6B7C5C   /* sage — pending/scheduled state, secondary emphasis */
```
Two accents only (vermillion + sage) — not a five-color rainbow status system. Status is communicated primarily through *language and position* (a dateline, a stamp, a strikethrough), with color as reinforcement, not the only signal.

**Layout per view:**
- **Global chrome** — a masthead-style header (workspace name in Fraunces, like a newspaper nameplate) instead of a generic top app bar. Nav items read like section tabs with a thin rule beneath the row; the active section gets a small vermillion underline, not a filled pill/button.
- **Pending ("The Wire")** — each `ChangeItem` renders like a wire dispatch: monospace timestamp/branch on the left, the PR/commit title in body type. "Drop" is a quiet, text-only affordance (e.g. a strikethrough-on-hover before confirming), not a loud red delete button. The next-scheduled-run line reads like a dateline: "Next edition: Tue, 9:00 AM."
- **Drafts ("The Copy Desk")** — the editor treats the draft like a manuscript; focus states use a thin vermillion underline instead of a default blue browser ring. The preview card is styled like a printed clipping (paper surface, Fraunces headline, a thin rule, small-caps category label) — this is the same "Preview" feature from the Generation section, just skinned to the concept. "Approve & Publish" is treated as a stamp: solid vermillion fill, sharp corners (2–4px radius, not `rounded-xl`), a brief press micro-interaction on click. "Reject" is a quiet text link, not a competing button.
- **History ("The Archive")** — a dense ledger/table: serif title column, monospace date column, minimal chrome, no card wrappers per row.
- **Integrations ("The Wire Services Directory")** — the active Generic Webhook reads as "plugged in"; coming-soon entries (Webflow, Customer.io, Mailchimp, HubSpot, LinkedIn) render visibly dimmed, like an out-of-service listing, not just a slightly-lower-opacity chip.

**Motion:** restrained and purposeful, not decorative. One well-placed moment beats many small ones: a brief stamp-press (scale down then up, ~150ms) on "Approve & Publish"; new items entering the Pending feed fade/slide in from the top. No hover effects on things that aren't interactive, no gratuitous page-load animation.

**Explicit guardrails (never do):**
- Never use Inter, Roboto, Arial, or system-ui as the primary UI font.
- Never use a purple/blue gradient background or hero section.
- Never default to `rounded-xl` cards with soft drop shadows as the primary surface treatment — this reads as generic AI-tool chrome.
- Never use the browser's default blue focus ring — use the accent color.
- Status is not five filled rainbow pill badges; prefer a small colored dot/rule plus a text label, or no color at all where position/language already communicates state.

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
- **Outbound webhook delivery** — signed (HMAC) payload, retried with backoff (e.g. 3 attempts), tracked in `WebhookDelivery`. There is no read/polling API fallback in this MVP — if delivery ultimately fails after all retries, the `Update` is still `published` and visible in History, but the external system never receives it automatically; the tenant would need to notice (e.g. via a failed-delivery indicator) and address it manually.

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
- **Manual/E2E** — install GitHub App, select a repo + branch during onboarding (and again later via Settings), merge a PR into that branch, verify a draft appears, edit and approve it, confirm it's delivered to a test webhook receiver and appears in History.

## Open Questions / Future Work

- Turning coming-soon catalog entries (Webflow, Customer.io, Mailchimp, HubSpot, LinkedIn) into real, configurable integrations.
- A read/polling API for pulling published updates — deliberately cut from this MVP in favor of webhook-only delivery; likely to return once a second real consumer needs it.
- Delivery channels: public changelog page, embeddable widget, email digest, Slack.
- Ticket-tracker enrichment (Linear/Jira) as an additional generation input.
- Billing/plan enforcement once real external tenants onboard.
- Multi-language generation.
- Multiple GitHub App installations per tenant (e.g. across separate GitHub orgs) — one installation per tenant is the MVP assumption.
