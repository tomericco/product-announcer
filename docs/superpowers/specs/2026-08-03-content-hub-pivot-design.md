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
   content type, audience, key points, target length, evidence.

   **Briefs are capped: 3–5 key points, one sentence each.** A brief is a
   commission, not a first draft. The spike produced 6.5 points averaging 27
   words, which is something a writer skims rather than reads — and it doubles
   the token cost of the highest-volume call in the system.
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
DROP VALUE), audience?, keyPoints[], targetLength?, score,
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

### Migration

**The app is not in real use, so there is no production data to preserve.** This
is a schema replacement, not a data migration — no backfill, no status remapping,
no two-phase column drops, no verification step between them:

1. Create the six new tables.
2. Drop `releases`; create `content_pieces` fresh with the full column set.
3. Drop `linkedin_body` and `linkedin_body_edited_at` outright. `channel_variants`
   starts empty.
4. Point `atomic_updates` and `delivery_attempts` at `content_piece_id` directly.
5. Drop `brand_profiles`; create `company_profiles` fresh.
6. Strip `schedule_configs` to ideation cadence — drop `cadence`, `threshold`,
   `thresholdEnabled`, `dayOfWeek`, `dayOfMonth`.

All of it collapses into one generated migration. Spec 1 drops from M to S.

Optional cleanup while nothing depends on history: the 39 accumulated migrations
in `src/db/migrations` can be squashed into a single baseline. Worth doing here
or never.

### What the clean slate does not solve

`system_personas` and `system_update_examples` are **seeded global catalogs**, not
tenant data. They must exist for generation to work, and six modules read them
(`select-examples.ts`, `compose-prompt.ts`, `generation.ts`, `generation-context.ts`,
`edit.ts`, `catch-up.ts`).

`system_update_examples` is product-update-shaped: each row carries an
`update_category` and a body written as a changelog entry. With three content
types, few-shot selection needs examples per type.

Decision for spec 1: rename to `system_content_examples`, add a `contentType`
column, make `update_category` nullable (it is meaningful only for product
updates), and re-seed. Blog and social exemplars can be seeded thin and grown
later — but the **column** lands in spec 1 rather than forcing a second schema
change midway through spec 9.

## Specs

| # | Spec | Delivers | Depends on | Size |
| --- | --- | --- | --- | --- |
| 1 | Content pieces foundation | The schema replacement above, plus the `system_content_examples` rename | — | S |
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

### Result — run 2026-08-03

**Outcome: sharp across all three companies. The premise holds; proceed.**

Run against Linear, Vercel and Frontitude with hand-written profiles and real
signals scraped from actual changelogs, competitor changelogs and industry press.
6 briefs each, on Opus 5.

| | multi-signal | cross-kind | signals cited | hallucinated IDs |
| --- | --- | --- | --- | --- |
| Linear | 6/6 | 4/6 | 14/17 | 0 |
| Vercel | 5/6 | 3/6 | 13/18 | 0 |
| Frontitude | 5/6 | 3/6 | 11/13 | 0 |

Findings that change the specs:

1. **Quantity is not self-limiting.** "Up to 6" produced exactly 6 every time.
   Left as-is this manufactures content on quiet weeks — the exact failure mode
   the human-gated model exists to avoid. Spec 5 must instruct the agent that
   returning zero or two briefs is a correct outcome, and should be evaluated on
   a deliberately thin signal week before shipping.
2. **Noise rejection works.** Planted low-value signals — Cloudflare V8 version
   bumps, a "platform improvements and fixes" maintenance release, market-size
   forecasts — were left uncited in every run. The ignore-noise rule earns its
   place in the prompt.
3. **Low ship velocity is not a blocker.** Frontitude had only 2 shipped-work
   signals and still produced 6 strong briefs off competitor and market signals.
   The product works for companies that do not ship often, which is most
   marketing-led companies — and it means the competitor agent (spec 3), not the
   shipped-work adapter, is the load-bearing source.
4. **Competitor signals are not only good for comparison content.** The
   highest-value Vercel brief was a response to a *competitor's* security
   advisory about Next.js — Vercel's own framework. Do not narrow the competitor
   agent to "what they shipped versus what we shipped".
5. **Scores cluster narrowly** (0.66–0.92). Absolute scores will rank poorly once
   a backlog accumulates. Spec 5 should rank relatively within a run rather than
   trusting the absolute number.
6. **Briefs came out far too long, and `outline` was dead weight.** Measured:
   6.5 key points per brief averaging 27 words each, plus a separate 41-word
   `outline` field that only restated them in compressed form. Two decisions
   follow. **Cap key points at 3–5, one sentence each** — a brief is a
   commission, not a first draft, and 175 words of instructions is something a
   writer skims. **Drop the `outline` column entirely** — ordered key points
   *are* the outline, and keeping both guarantees they drift apart once a human
   edits one of them. Together this roughly halves the output tokens of the
   highest-volume call in the system. Set `maxOutputTokens` explicitly
   regardless: 6 uncapped briefs overflowed a 4096 default.
7. **Excerpt quality drives brief quality.** The tier-2 relevance pass in spec 3
   must preserve a meaningful excerpt, not just a score — the briefs lean on
   excerpt detail heavily.

Four prompt rules earned their place and should carry into spec 5 close to
verbatim: favour clusters, the swap test ("if it reads the same with a
competitor's name swapped in, do not propose it"), ignore noise, and why-now must
point at something dated.
