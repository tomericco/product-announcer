# Competitor Question Grid — Design

**Date:** 2026-08-06
**Status:** Approved. Precedes the demand map (not yet specced).

## Summary

A second ideation track, seeded by the evaluation questions buyers search for
rather than by things that happened. The questions are generated
deterministically from the `competitors` table the tenant already maintains;
the competitor signals already being collected become the *evidence* a brief
cites rather than the *reason* it exists.

Ships with zero settings changes, no new page, no OAuth, and no paid API.

## Why

Every seed in the system today is supply-side — it answers "what is there to
say."

| Seed | Answers |
| --- | --- |
| Company context | who we are |
| GitHub / Notion | what we did |
| Competitor moves | what they did |
| News | what happened |

Nothing answers *what is being asked*. That is fine for a product update and
fatal for a blog post meant to rank or be cited: nobody searches "competitor X
shipped Y", timely content decays while search assets compound, and answer
engines retrieve comparison pages and docs rather than dated commentary.

The `competitors` table is the fix hiding in plain sight. It is currently spent
only on producing `sources` rows pointed at changelogs — a weak seed. The same
rows also generate the highest-commercial-intent queries in B2B software, at no
cost.

Deliberately **not** a replacement for the timely track. Timely content earns
its keep on distribution and topical currency. The two tracks share the inbox.

## Scope

**In:** a deterministic question backlog from `competitors` × templates; a
second ideation call that turns unanswered questions into `blog_post` briefs;
dismissal write-back; a widened `PAGE_KEYWORDS`; an inbox empty state.

**Out, and each for a reason:** `topic_clusters`, Search Console, DataForSEO,
AEO probes, `differentiation_assets`, volume/difficulty/CPC, and coverage
measurement all belong to the demand map. Schema written ahead of its consumer
tends to be wrong, and none of them are needed for this to be useful.

## The grid

Four templates, all keyed to a competitor, so the grid is exactly `4N`:

| Template | Rendered | Intent |
| --- | --- | --- |
| `alternatives` | `{competitor} alternatives` | evaluation |
| `vs_us` | `{tenant} vs {competitor}` | evaluation |
| `pricing` | `{competitor} pricing` | commercial |
| `migration` | `migrating from {competitor}` | switching |

Question text is plain string templating, not a model call. These are literally
how the queries are typed, it costs nothing, and it is trivially testable.

**`{X} vs {Y}` is cut**, and worth recording why, because its ceiling is
genuinely higher than `vs_us`: it reaches people evaluating the category who
have not considered this company at all, rather than people already comparing
against it.

Two things make it the wrong template for *this* spec. It grows
combinatorially (`N(N-1)/2` — 28 questions at eight competitors, against
`vs_us`'s 8), and nobody writes 28 comparison posts, so it needs a way to pick
which pairs matter. That means knowing where the company is absent from the
SERP or the generated answer, which is precisely the data this spec does not
have. And it is a different genre: the company has no natural role in the
piece, so it must be written as a neutral category guide — excellent when it
lands, bait-and-switch when it does not, and a harder brief for the agent to
get right than "here is how we differ."

It belongs with the demand map. The cheap version, if it is ever wanted
earlier, is to restrict pairs to the top two or three competitors, which needs
no ranking data.

**`best {category} for {persona}` is cut.** It is the only candidate template
not derived from a competitor, so it fits nowhere in the model below, and it is
category-driven rather than competitor-driven. It belongs with the demand map
too. Note the consequence: `company_profiles.category` still has no consumer
after this spec. It remains a captured, editable, unread column.

## Data model

Two new tables and two new columns. Nothing added to `company_profiles`.

### `demand_questions`

```ts
export const demandQuestionTemplateEnum = pgEnum("demand_question_template", [
  "alternatives", "vs_us", "pricing", "migration",
]);
export const demandQuestionOriginEnum = pgEnum("demand_question_origin", ["competitor_grid"]);
export const demandQuestionStatusEnum = pgEnum("demand_question_status", [
  "open", "covered", "dismissed", "stale",
]);
```

Columns: `id, tenantId, question, template, origin, competitorId?, status,
createdAt, updatedAt`.

There is deliberately **no `coveredByContentPieceId`**. The route from a piece
back to its question already exists — `content_pieces.briefId` → `briefs` →
`brief_questions` — and a second one would be a coverage-reporting column with
no reader in this spec, which is the exact mistake the scope section rejects.

- `competitorId` references `competitors` **ON DELETE SET NULL**, mirroring
  `signals.atomicUpdateId`. A removed competitor must not erase the question a
  published piece was commissioned from.
- `origin` has one value today. It exists because the demand map adds producers,
  and a single-value enum is cheaper to extend than a boolean to migrate.
- Unique `(tenantId, question)` — the reconciler's idempotency, and what makes
  re-running it top up rather than duplicate.
- Index `(tenantId, status)` — every read filters on it.

### `brief_questions`

```
briefId → briefs (cascade), questionId → demand_questions (cascade),
addedBy?, addedAt
PK (briefId, questionId)
index (questionId)
```

`brief_signals` in shape, including the reverse index: Postgres indexes the PK,
which leads with `briefId`, and does **not** index the referencing side of the
`questionId` FK. Without it every question delete scans this table. This is the
same lesson already recorded on `brief_signals_signal_idx`.

This is the one place the pivot doc's invariant bends. It states `brief_signals`
is *the* evidence join; an evergreen brief carries a question as well, and the
evidence popover renders both.

### Changed

- `briefs.track: pgEnum("brief_track", ["timely", "evergreen"])`, default
  `timely`. The inbox filter, and what separates the two ideation calls'
  output.
- `schedule_configs.evergreenLastRunAt` — the weekly gate. This spec does **not**
  claim the existing `lastRunAt` and `nextScheduledAt`, which remain dead; a
  future spec giving the timely run a per-tenant cadence should take those.

## Generation — a reconciler, not a hook

`syncCompetitorGrid(tenantId)` recomputes the expected `4N` question set and
upserts it, `onConflictDoNothing` against the unique index. `sweepCompetitorGrid()`
is the cron fan-out over tenants, matching the existing
`sweepNewsSources` / `runNewsSource` pairing.

Staleing is driven by the SET NULL above, not by a join: after a competitor is
removed its questions are the rows where `competitorId IS NULL`, and the
reconciler flips those to `stale`. **Only `open` ones.** A `covered` or
`dismissed` question is a decision someone made, and rewriting it would erase
history the same way re-expiring a decided brief would.

Reconciling rather than hooking competitor creation follows
`syncShippedWorkSignals` and for the identical stated reason: competitors are
inserted from two sites today (the onboarding bootstrap and the manual add
action), hooking both means a third added later silently stops producing, and
reconciling is idempotent and self-healing.

Pure SQL and string templating — no model call — so running it on every daily
cron costs nothing.

The tenant name comes from `tenants.name` for the `vs_us` template, matching
what `loadProfile` in `briefs/run.ts` already reads.

## Evergreen ideation

`ideateEvergreen()` in `src/lib/briefs/`, its own prompt and its own model call.

**Deliberately not an extension of `ideate()`.** That prompt is the output of
two recorded spikes and is balanced around licensing silence on a quiet week.
Feeding it a second class of input risks the fix that made it usable.

### Input

- open questions, bounded at `MAX_EVERGREEN_QUESTIONS` (40 — ten competitors'
  worth, so it does not bite a realistic tenant, but bounded on principle: this
  is the second model input the codebase would otherwise leave unbounded, and
  `MAX_IDEATION_SIGNALS` records what that costs)
- for each question, `competitor_move` signals for that `competitorId` inside
  `IDEATION_WINDOW_DAYS`, above `IDEATION_MIN_SCORE`, non-stale, bounded at
  `MAX_EVIDENCE_PER_QUESTION` (5, freshest first by `occurredAt`) so one noisy
  competitor cannot crowd the prompt
- the company profile, via the existing `RelevanceProfile`
- the same `covered` / `rejected` context `runIdeation` already assembles

### The bar

The existing system prompt permits a blog post to name other companies "but
only as the source material describes them", and the grounding rule binds. A
comparison brief with no attached evidence therefore produces either an empty
piece or a fabricated one.

That gives a structural gate rather than an exhortation:

> **A brief must attach at least one `competitor_move` signal for its
> question's competitor. No signal, no brief.**

Plus `EVERGREEN_MAX_BRIEFS_PER_RUN = 2`, weekly.

Note the asymmetry with the timely track, which deliberately has *no* quota.
Timely input is bursty, so a quota manufactures content on a quiet week. The
grid is a finite backlog that never empties on its own, so the absence of a
quota manufactures content every week. Opposite inputs, opposite fix.

The swap test carries over verbatim: if the brief reads the same with a
different competitor's name substituted, do not propose it.

### Output

The existing `ProposedBrief` shape, `contentType: "blog_post"`,
`track: "evergreen"`, plus the question ids it answers. Writes nothing on
failure, exactly as `runIdeation` does.

## Dismissal writes back to the question

Brief dismissal is soft in the timely track — dismissed titles ride
`context.rejected` and merely discourage re-proposal. That is sufficient there
because signals age out of the 30-day window, so the evidence disappears on its
own.

**Evergreen questions never age out.** Left soft, a dismissed comparison brief
returns every week for as long as the competitor keeps publishing. So dismissal
writes back, using the distinction `briefDismissReasonEnum` already draws:

| Dismiss reason | Question becomes |
| --- | --- |
| `off_topic` | `dismissed` |
| `not_our_voice` | `dismissed` |
| `already_covered` | `covered` |
| `wrong_angle` | stays `open` — the question was fine, the take was not |
| `other` | stays `open` |

Accepting a brief marks its questions `covered`.

This is why the spec has no question configuration UI: the team's preferences
are inferred from decisions they were already making, rather than collected up
front from a settings screen nobody would revisit.

## `PAGE_KEYWORDS` must widen

`discover-sources.ts` matches `{changelog, release-notes, releases, whats-new,
news, blog, updates}` — all publishing surfaces. Under the evidence bar above, a
`pricing` question could never clear it, because no pricing page is ever
watched.

Add `pricing`, `docs`, `compare`, `alternatives`, `customers`, and raise
`MAX_SOURCES` from 3.

Accept the consequence: pricing and docs pages churn more noisily than
changelogs, so the block differ will emit more low-value diffs. The tier-2
relevance pass absorbs that, and `IDEATION_MIN_SCORE` already filters at 0.3.

This was a cheap improvement before this spec. It is now load-bearing — the
spec does not function without it.

## Surfaces

**Zero settings changes.** No new card, no new page, not a line on
`/company`.

The transparency argument that would normally justify a browser does not apply:
the grid is a pure function of `competitors` × four templates, so nothing
surprising can be in it. The signals browser exists because signals are
non-deterministic; this is not.

Two small additions, both in the briefs inbox:

- **A track filter** — Timely / Evergreen / All.
- **An evergreen empty state**, beside the existing `weekAssessment`. When
  questions are open but no competitor pages are watched, say so:
  *"3 comparison questions are waiting, but no competitor pages are watched
  yet."* This is where the hard evidence bar's silence is repaired — the inbox
  is where someone notices nothing appeared, so it is where the reason belongs.
  The pivot doc already establishes the pattern: a blank inbox reads as broken.

Evergreen briefs render their question alongside their signals in the existing
evidence popover.

## Cron

Ordering in `/api/cron/scheduler`:

```
… existing steps …
sweepCompetitorGrid       (cheap, no model call; must precede ideation)
expireStaleBriefs
sweepIdeation             (timely)
sweepEvergreen            (per tenant, gated on evergreenLastRunAt ≥ 7 days)
```

The weekly gate lives in code rather than a second cron entry: `vercel.ts` pins
a single daily invocation under the Hobby plan's limit, which
`schedule_configs.hour` already documents.

## Error handling

Follows the shapes already in the tree, for the reasons those files record.

- Per-tenant try/catch inside `sweepEvergreen`, plus a separate one around the
  candidate select — a throw there rejects the whole cron handler and undoes the
  steps before it.
- `ideateEvergreen` fails closed and **logs loudly**. This matters more here
  than in the timely track: "no evergreen briefs" is otherwise
  indistinguishable from "no competitor evidence yet", and both are
  indistinguishable from a broken call. The whole product promise is that an
  empty inbox means nothing was worth saying.
- `syncCompetitorGrid` failing for one tenant must not stop the sweep, and must
  not block ideation for tenants whose grid is already current.

## Testing

Existing deps-injection style — `database`, `ideateFn` — with hand-built
fixtures.

Every assertion scoped by `tenantId`. The suite shares one Postgres and two
isolation bugs were fixed in the four commits before this spec; new tables are
where that recurs.

Worth covering specifically: the reconciler is idempotent across runs; a removed
competitor staleing its questions without touching an accepted brief's evidence;
the evidence bar rejecting a question with no signals; each dismiss reason
landing the question in the right status; the per-run cap holding.

## Decisions

- **The grid is a question backlog, not a brief backlog.** Questions are cheap
  and complete; briefs are scarce and bar-gated. Keeping the two separate is
  what lets `migration` questions exist for a company with no importer without
  proposing a brief that invents one.
- **Competitor moves become evidence, not seed.** This is the whole point. The
  changelog watching that was a weak reason to write is a strong source of
  substance.
- **Hard evidence bar, not soft.** A soft bar produces exactly the fabricated
  comparison the grounding rules exist to prevent. The cost is silence, and the
  inbox empty state pays it.
- **No question configuration.** Preferences are inferred from brief dismissal,
  which the team is already doing.
- **`covered` is never shown as a user-facing state.** It means "we published",
  not "we rank" or "we are cited" — a claim nothing can back up until the demand
  map exists. It stays an internal dedupe flag, the same way `signals.status =
  'used'` is documented as a reporting flag rather than a gate.

## The runway

The grid is finite. At `4N` with dismissals removed and 1–2 consumed weekly,
eight competitors is roughly four to six months of material, after which the
evergreen track goes quiet permanently — unlike the timely track, which the
world refills.

That is not an argument against this spec; it is the shape of it. This buys the
highest-intent content available from data already on hand. **The demand map is
what refills the well**, and this spec's tables are deliberately named and
shaped to be its foundation rather than a detour.

## Sizing

**M.** Two tables, one column, one reconciler, one model call, one keyword-list
change, two small inbox additions. No OAuth, no paid API, no new agent, no new
page.
