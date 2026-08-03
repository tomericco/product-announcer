# Content Hub Pivot — Design

**Date:** 2026-08-03
**Status:** Approved. Decomposed into nine specs (see end).

## Summary

Versional pivots from a product-updates tool into a proactive content hub for
software and AI companies. Agents watch a company's sources and propose what it
should publish; a human turns proposals into shipped content.

The company describes itself once at onboarding. Everything downstream — which
sources matter, what counts as relevant, what angle to take, what voice to write
in — derives from that description. No company-specific logic exists anywhere in
the codebase.

## The shape of the change

The pivot generalizes the existing pipeline one level. It does not replace it.

| Today (product updates) | After the pivot (content hub) |
| --- | --- |
| `change_events` — raw things that happened in code | **Signals** — raw things that happened anywhere |
| tier-1 filter + tier-2 LLM enrichment | same two-tier pattern, scoring relevance against company context |
| `atomic_updates` — deduped units of shipped work | **Briefs** — deduped content proposals, carrying their signals as evidence |
| `releases` — a draft assembled from atomic updates | **Content pieces** — typed: product update / blog post / social post |
| publish to Webflow / LinkedIn / webhook | same, plus per-channel variants |

## Primary user

A content marketer or content lead on a 2–5 person marketing team at a Series
A/B software or AI company. They own the calendar, coordinate with PMM and
engineering for source material, and are accountable for cadence and brand
consistency.

Their two pains: chasing context (what shipped, what competitors did, what the
market is talking about) and keeping voice consistent. The first is what the
signals layer solves; the second is what the company profile solves.

## The loop

```
sources → signals → briefs (proposed) → [human gate] → content piece
                                                       → draft → review → scheduled → published
```

The human is the gate between proposed and published, and never faces a blank
page. This is a copilot, not autopilot: agents never publish, never schedule,
and never create a content piece without a person accepting a brief.

## Layers

### 1. Company context

Captured at onboarding, editable in settings. Bootstrapped rather than
interrogated: the user supplies a website URL, an agent reads the homepage,
product, about, and blog pages, and drafts the entire profile. The human
corrects it. This extends the existing pattern of deriving brand style from an
updates page URL.

Captured:

- **Identity** — one-line description, product names, category
- **Positioning** — differentiators and the messages the company wants to own
- **Audience** — ICPs, modelled by the existing `personas`
- **Competitors** — proposed by the agent from the category, confirmed by the
  human, each carrying the URLs to watch
- **Topics** — the subjects in the company's lane
- **Channels** — where they publish, mapping onto existing destinations
- **Voice** — the existing `brand_profiles.guidelines`, unchanged

Positioning and topics are not settings. They are the ranking function, and the
only thing separating a proactive content hub from an RSS reader with a language
model attached.

### 2. Source agents

Every agent implements the same five-step contract, which is the existing GitHub
pipeline generalized:

**fetch → extract → tier-1 drop → tier-2 relevance → write signal**

Tier 1 is deterministic and free. Tier 2 is a single batched LLM call per run
that scores survivors against the company profile and attaches a rationale.
Items below the relevance floor are never written, only counted for
observability.

Three agents in v1:

- **Shipped work** — already built, event-driven. GitHub and Notion flow through
  `change_events` → `atomic_updates` unchanged. A thin adapter projects each
  atomic update into a signal, 1:1, at creation. Hiding an atomic update removes
  its signal. No relevance pass — dedupe and enrichment already happened
  upstream.
- **Competitor** — one per configured source, polled daily. RSS/Atom where
  discoverable; HTML fetch with readable extraction and a content hash
  otherwise. Watermark per source.
- **News** — topic-driven, polled daily per tenant. Searches against the
  tenant's own topics rather than a fixed feed list, because a curated feed list
  per industry does not generalize to "any company". Optional user-supplied RSS
  layered on.

Sources carry a status the way the existing Notion and Webflow connections do,
surfaced in settings rather than failing silently.

Deferred past v1: customer voice (support, sales, community) and search/SEO
demand.

### 3. The brief agent

Runs daily per tenant. Reads company context, signals in a 30-day window above
the relevance floor, and what has already been proposed and published.

1. **Correlate** — group related signals into clusters. The value is
   disproportionately in the joins: "competitor shipped X" + "we shipped X a
   year ago" is a comparison piece. Single-signal clusters are legitimate, but a
   system that only ever produces them is a formatter, not an ideation engine.
2. **Propose** — each cluster yields a complete brief: title, angle, why-now,
   content type, audience, key points, outline, target length, evidence.
3. **Dedupe** — a cluster matches against briefs with status `new` only. On a
   match the brief absorbs the new signals, `lastEvidenceAt` is bumped, and it
   re-ranks upward. Accepted and dismissed briefs are excluded from matching and
   instead passed to the prompt as "already covered" and "previously rejected"
   context. Without this the inbox repeats itself within a week and dies. The
   existing `resolve-atomic-updates.ts` solves the identical problem.
4. **Rank** — timeliness with decay, evidence strength, positioning fit, channel
   gap.

Briefs expire on their own so the inbox never accumulates debt.

**Dismissal is training data.** Dismiss reasons feed the next run's prompt as
negative examples. Cheap, compounds, and it is what makes the tool feel like a
copilot.

**Evidence is always visible** — reuse the atomic-update evidence popover.

## Decisions

- **Briefs, not ideas.** An earlier design split a thin "idea" from a later
  expanded brief. Merged: the agent proposes a complete brief, the human reviews
  and adjusts it, then approves. Two gates where one will do, and "brief" is the
  language the ICP already uses. `content_pieces.brief` as a column is deleted;
  brief content lives on the `briefs` row, referenced by `content_pieces.briefId`.
- **The threshold trigger is removed entirely** — not relocated into ranking.
  Shipped-work signals get no count-based special case.
- **The cadence scheduler is retired.** Auto-composing drafts is autopilot, which
  contradicts the human-gated model.
- **Signal retention is 90 days**, except signals cited by an accepted brief,
  which are the evidence trail behind published content and are exempt.
- **Manual creation goes through a brief, not around it.** `brief_signals` is
  the only evidence join and `content_pieces.briefId` the only route from a piece
  back to its sources. A second path would make evidence inconsistent depending
  on how a piece was born.

## Surfaces

Three surfaces over two objects.

- **Briefs inbox** — agent proposals, ranked, with evidence and accept/dismiss.
  A collapsible rail pinned to the left of the board so proposals are always
  visible without competing for board space.
- **Pipeline board** — the home screen. Content pieces move through
  `brief → draft → review → scheduled → published`. Status `brief` means
  *approved, draft not yet generated*, so a lead can approve five briefs Monday
  and generate drafts across the week.
- **Calendar** — a read view over the same content pieces, scheduled and
  published only, laid out by date and channel. Its job is coverage. A view, not
  a third object.
- **Signals browser** — everything the agents collected, filterable by kind,
  competitor, topic, date, and relevance. Select signals to create a brief by
  hand, or add a signal manually (a competitor post the agent missed, a webinar,
  a conference talk). A debugging tool first and a feature second: an ingestion
  pipeline you cannot see is undebuggable.

## Data model

Unchanged: `change_events`, `atomic_updates`, `repos`, all four connection
tables, `delivery_attempts`, `llm_usage`, tenants/users/members/invites, and both
seeded catalogs.

### New tables

- **`signals`** — `id, tenantId, sourceId?, kind (shipped_work|competitor_move|market_news|manual),
  externalId, url, title, excerpt, occurredAt, atomicUpdateId?, competitorId?,
  relevanceScore, relevanceRationale, topics[], status (new|used|stale), createdAt`.
  Unique `(tenantId, kind, externalId)`; index `(tenantId, occurredAt)` and
  `(tenantId, kind, occurredAt)`.
  `used` is a reporting and pruning flag, **not** a consumption gate — ideation
  reads every signal in the window regardless of status, because a signal cited
  last week can join a new cluster this week.
- **`sources`** — polled-source config: type, url, discovered feed url, watermark
  (jsonb), status, `lastRunAt`, `lastError`.
- **`competitors`** — name and site per competitor; watched URLs are `sources`
  rows, so one competitor can have both a changelog and a blog.
- **`briefs`** — see below.
- **`brief_signals`** — the evidence join: `briefId, signalId, addedBy?, addedAt`,
  PK on `(briefId, signalId)`. `addedBy` is null when the agent attached it.
- **`channel_variants`** — `contentPieceId, channel, body, editedAt`. Holds
  per-channel *content*; `delivery_attempts` continues to hold per-channel
  *delivery*.

### `briefs`

```ts
export const briefOriginEnum = pgEnum("brief_origin", ["agent", "manual"]);
export const briefStatusEnum = pgEnum("brief_status", ["new", "accepted", "dismissed", "expired"]);
export const contentTypeEnum = pgEnum("content_type", ["product_update", "blog_post", "social_post"]);
export const briefDismissReasonEnum = pgEnum("brief_dismiss_reason", [
  "off_topic", "wrong_angle", "already_covered", "not_our_voice", "other",
]);
```

Columns: `id, tenantId, origin, createdBy?, contentType, title, angle, whyNow,
suggestedChannel (text, not an enum — destinations will grow and Postgres has no
DROP VALUE), audience?, keyPoints[], outline?, targetLength?, score,
scoreRationale?, status, acceptedBy?, acceptedAt?, contentPieceId?,
dismissReason?, dismissNote?, dismissedBy?, dismissedAt?, editedAt?,
lastEvidenceAt, expiresAt, createdAt, updatedAt`.

Indexes: `(tenantId, status, score)` for the inbox, `(tenantId, status, expiresAt)`
for the expiry sweep, and a partial unique index on `contentPieceId where not
null` so two briefs can never claim the same piece.

`editedAt` follows the existing `summaryEditedAt`/`bodyEditedAt`/`sizeEditedAt`
convention: a human edit freezes regeneration.

Invariants enforced in the app, since each spans columns: `dismissReason` is set
only when status is `dismissed`; `contentPieceId` only when `accepted`.

`brief_signals` cascades on signal delete, which is precisely why accepted-brief
signals are exempt from the 90-day purge — the exemption is what keeps the join
honest.

### Generalized tables

- **`releases` → `content_pieces`.** Adds `type`, `briefId?`, `scheduledFor`
  (what the calendar renders), `assignedTo`. Status widens from
  `draft|approved|published|rejected` to
  `brief|draft|review|scheduled|published|archived`. `reviewStatus`,
  `reviewIssues`, `bodyEditedAt`, `composedAt`, `editedBy`, `publishedBy` carry
  over unchanged. The `brief` text column is **not** added — brief content lives
  on `briefs`.
- **`brand_profiles` → `company_profiles`.** Keeps `guidelines`, `industry`,
  `personas`. Gains `websiteUrl`, `oneLiner`, `category`, `positioning`,
  `topics[]`.

### Migration steps

1. Create the six new tables.
2. Rename `releases` → `content_pieces`; add new columns; backfill every existing
   row to `type = 'product_update'`.
3. Map statuses: `draft→draft`, `approved→scheduled`, `published→published`,
   `rejected→archived`.
4. For every row with a non-null `linkedin_body`, insert a `channel_variants` row
   (channel `linkedin`, `editedAt` from `linkedin_body_edited_at`); then drop both
   columns in a **separate migration** after the backfill is verified.
5. Rename FKs: `atomic_updates.release_id` and `delivery_attempts.release_id` →
   `content_piece_id`.
6. Rename and extend `brand_profiles`.
7. Strip `schedule_configs` to ideation cadence — drop `cadence`, `threshold`,
   `thresholdEnabled`, `dayOfWeek`, `dayOfMonth`.

Steps 2–5 are the only ones touching live data. All are reversible except the
column drops in step 4.

## Specs

| # | Spec | Delivers | Depends on | Size |
| --- | --- | --- | --- | --- |
| 1 | Content pieces foundation | The full migration above | — | M |
| 2 | Company context & bootstrap | Profile fields, `competitors` CRUD, crawl-site bootstrap agent, onboarding | 1 | M |
| 3 | Signals layer + competitor agent | `signals`/`sources`, retention job, shipped-work adapter, competitor agent, signals browser | 2 | L |
| 4 | News agent | Topic-driven search, relevance, cross-source dedupe | 3 | M |
| 5 | Brief agent + inbox | `briefs`/`brief_signals`, correlate→propose→dedupe→rank, expiry, inbox UI, accept→content piece | 3 | L |
| 6 | Manual brief creation | Signal selection → brief, manual signals | 3, 5 | S |
| 7 | Pipeline board | Board over content pieces, transitions, assignment | 1 | M |
| 8 | Calendar view | `scheduledFor`, month view by channel | 7 | S |
| 9 | Multi-type drafting & publishing | Draft-from-brief per type, channel variants UI, publish per channel | 1, 5 | L |

Specs 4, 7, and 8 are off the critical path.

The signals browser sits in spec 3 rather than with the manual-creation work it
enables, because an ingestion pipeline you cannot see is undebuggable.

Spec 1 comes first despite being pure refactor: every later spec writes against
`content_pieces`, so doing it now means doing it once, against small data.

## Validation spike (precedes spec 1)

The premise the pivot rests on — *an agent, given a company profile and a pile of
signals, produces briefs a content lead would accept* — is untested by specs 1–3.
A throwaway spike answers it in half a day: hand-written profiles for two or
three real companies, hand-collected real signals, the ideation prompt, briefs
printed to a terminal and read by a human. No schema, no UI, nothing kept.

Outcomes:

- Sharp across all companies → the premise holds, proceed.
- Sharp for one, generic for others → the company profile is not carrying enough
  signal; spec 2 must capture more before spec 5 can work.
- Generic everywhere → the ideation design is wrong, found before a migration was
  written.
