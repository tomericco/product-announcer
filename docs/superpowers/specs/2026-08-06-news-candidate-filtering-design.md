# News Agent Candidate Filtering — Design

**Date:** 2026-08-06
**Status:** approved, not implemented
**Spec:** an addendum to the industry-content agent (spec 4), not a new subsystem.

## Problem

Two independent wastes in `runNewsSource`, both costing candidate slots rather
than money.

**1. Nothing remembers a rejection.** A run fetches 20 articles and writes at
most 5. Written articles leave contention permanently — the pre-flight query
skips anything already in `signals`. Everything else is recorded nowhere, so it
returns tomorrow at the same Tavily score that won it a slot today, and is
re-fetched and re-scored on every run until it ages out of the search window.
Widening `TAVILY_TIME_RANGE` to `month` extended that from ~7 days to ~30.

Two classes are affected:

- **Selector rejections** (~15/run): judged by the model and turned down.
- **Stale drops**: the article's own page dates it outside `RECENCY_WINDOW_DAYS`.
  These cost a full fetch every run, because staleness is only knowable after
  the page is retrieved.

**2. The company's own content competes with the industry's.** The agent
searches `companyProfiles.topics`, which are by construction the subjects the
company publishes about. A 2026-08-06 probe of the real profile confirmed the
top results for these topics are vendor blogs — the company's own among them.
Its own posts consume result slots, fetch slots and scoring slots, and could
become a `market_news` signal, which would put the company's own blog post in
front of the brief agent as an industry development.

## Non-goals

- Surfacing rejection counts in the UI. `runNewsSource` will return them;
  `sweepNewsSources` still discards its results and the settings health block
  still shows only `lastError`. Named here so it is a known gap, not an
  oversight.
- Any change to `TAVILY_SCORE_FLOOR`. Measured on 2026-08-06 and deliberately
  left at 0.05 — see the constant's comment.
- Excluding competitors. Competitor writing is legitimate industry signal, and
  the competitor agent is a separate acquisition path.

---

## Part 1 — Rejected-article memory

### Storage

A new table. Deliberately **not** a status on `signals`: a rejected article is
not a signal, and putting it there would require every reader (`listSignals`,
the signals browser, `runIdeation`) to add an exclusion. A miss in any one of
them leaks junk into a brief. A separate table cannot leak.

```
rejected_articles
  id           uuid pk
  tenant_id    uuid not null → tenants (on delete cascade)
  url          text not null       -- normalized via normalizeArticleUrl
  title        text not null       -- already in hand; without it the table is unreadable
  reason       rejected_article_reason not null   -- 'not_selected' | 'stale'
  rejected_at  timestamptz not null default now()
  unique (tenant_id, url)
```

`url` is written through `normalizeArticleUrl`, making this the **second**
persisted consumer of that function alongside `signals.externalId`. It is
therefore doubly a data contract: changing normalization makes both the skip
query and this one miss, and re-admits every already-handled article.

`reason` is a two-value pgEnum, not a model-authored rationale. It is known at
the call site and costs nothing, and it is what lets an operator later
distinguish "my topics surface old material" from "my topics surface weak
material" — two different fixes. A per-article model rationale was considered
and rejected: it would widen the selection schema and spend output tokens every
run on data nothing reads.

### Retention

**None.** A rejection is permanent. Re-judging an article almost always reaches
the same answer, and at ~15 rejections/tenant/day the table grows by roughly 5k
rows a year, which is nothing. `rejected_at` is stored so a purge can be added
later without a migration.

A TTL matched to the search window was considered and rejected: it would add a
third constant coupled to `TAVILY_TIME_RANGE` and `RECENCY_WINDOW_DAYS`, a
coupling that has already caused two defects.

**Known consequence:** a rejection made against one company profile survives a
profile or topic edit. An article rejected under old topics is not reconsidered
under new ones. Accepted deliberately — clearing on every edit re-opens the
re-fetch flood, and the case is narrow because editing topics mostly changes
*which articles are found*, not how old ones are judged.

### Write points

Two, both in `runNewsSource`.

**Stale drops** — in the recency loop, where `stale++` happens today. Safe to
record permanently because staleness only moves one way, and because the
existing rule already refuses to fire on a `<time>`-sourced date, which is a
guess. Only an article the page itself dates, outside the window, is recorded.

**Selector rejections** — immediately after `const dropped = kept.length -
outcome.selections.length`. The rejected set is `kept` minus the selected
indices.

**CRITICAL:** this insert must sit **after** the `"error" in outcome`
fail-closed branch, which returns early. A selection error means nobody judged
those articles; recording them as rejected would permanently bury up to 20
articles because of one API timeout. The plan must state this, and a test must
cover it — a future refactor that hoists the insert "to keep the write path
together" would be silently destructive.

Both inserts use `onConflictDoNothing` on the unique index, so re-rejecting is a
no-op rather than an error.

### Read point

The existing pre-flight lookup (`news-agent.ts:326`) gains a second query
against `rejected_articles`, scoped by tenant and `inArray(candidateUrls)`.
Placement is the whole point: it runs **before** the score filter, the slice and
the fetch, so a remembered article frees a candidate slot rather than consuming
one.

Counted separately from `skipped` — as `alreadyRejected` — because the two mean
different things: one says "we covered this", the other "we turned this down".
Both go in the return type; neither gets UI.

### What must NOT be recorded

Articles discarded by the `slice(0, MAX_CANDIDATES_PER_RUN)` truncation. Those
lost a ranking contest for one run's budget; nobody read them and no judgment
was made. Tomorrow's pool is different and any of them could rank into the top
20. The line is: **stage 4 discards on rank (provisional, never remembered);
stages 6 and 8 discard on judgment (permanent, remembered).**

---

## Part 2 — Own-content exclusion

### Deriving the host

From `companyProfiles.websiteUrl`. `loadProfile` returns
`{ profile: RelevanceProfile; ownHost: string | null }` rather than widening
`RelevanceProfile`, which is shared with the competitor relevance pass and must
not grow a news-only field.

Normalization: parse the URL, take the hostname, lowercase it, strip a leading
`www.`. A null, empty or unparseable `websiteUrl` yields `null` and disables the
exclusion — it must never throw and never degrade into excluding everything.

Matching is host-or-subdomain: `host === ownHost || host.endsWith("." + ownHost)`.
Stripping `www.` first is load-bearing — without it a profile stored as
`https://www.frontitude.com` would fail to match a bare `frontitude.com` article.

### Applied in two places, for two different reasons

**Server-side**, appended to Tavily's `exclude_domains`. This is the
optimization: it reclaims result slots. If three of ten hits are the company's
own blog, excluding them at the API means ten *other* articles come back instead
of seven.

`searchNews`'s second parameter becomes an options object
`{ excludeDomains?: string[]; fetchImpl?: typeof fetch }`. All 19 existing call
sites in `tavily.test.ts` already pass `{ fetchImpl }` and were verified
unaffected. The per-tenant domain is merged with the module-level
`EXCLUDED_DOMAINS` inside `searchNews`.

The `SearchFn` type in `news-agent.ts:15` widens to match, and the agent's call
becomes `search(topic, { excludeDomains })` instead of `search(topic)`.

**This breaks an existing test that the implementer will not otherwise find.**
`news-agent.test.ts` — "searches the bare topic, without a literal 'news'
suffix" — asserts `expect(search).toHaveBeenCalledWith("developer cli")`, an
exact-arguments match that fails as soon as a second argument is passed. It must
be updated to assert on the first argument only, and it must keep testing what
it was written for: that no literal `" news"` suffix is appended. Do not weaken
it to `expect.anything()` on the query itself.

(The topic-cap test in the same file reads `search.mock.calls.map((c) => c[0])`
and is unaffected.)

**Locally**, after the search and before dedupe. This is the guarantee. Tavily's
`exclude_domains` matching is not a contract we control, and if it matches bare
domains only then `blog.frontitude.com` still arrives. Three lines make it
structurally impossible for a `market_news` signal to be created from the
company's own writing.

### Not stored in `rejected_articles`

Own-content exclusion is a deterministic rule re-derived for free on every run,
not a judgment. Storing it would add rows that the rule already covers, and
would wrongly persist across a `websiteUrl` change.

---

## Testing

Per the standing rule from earlier specs: for every guard below, delete the
guard and confirm the test fails, then confirm it passes for reasons that still
hold in a full parallel run.

**Rejected-article memory**

1. Selector rejections are recorded, with `reason: 'not_selected'`.
2. Stale drops are recorded, with `reason: 'stale'`.
3. A fail-closed selection records **nothing** — the critical negative.
4. A recorded rejection is skipped before the fetch and the score pass: assert
   `fetchPage` was never called with that URL, not merely that no signal exists.
5. Rejections are tenant-scoped — tenant B's rejection does not hide an article
   from tenant A.
6. Re-rejecting the same URL is a no-op, not a constraint violation.
7. Articles dropped by the `MAX_CANDIDATES_PER_RUN` truncation are **not**
   recorded.

**Own-content exclusion**

8. The company's domain reaches `searchNews` in `excludeDomains`.
9. A hit on the company's own host is dropped locally even when the search
   returned it — the belt-and-braces case.
10. A subdomain (`blog.<host>`) is dropped.
11. A null/unparseable `websiteUrl` disables the exclusion and drops nothing.
12. A host that merely *contains* the company name is not dropped
    (`notfrontitude.com`), guarding against a substring match.

**Fixtures:** derive scores and counts from the exported constants, never
literals. Three fixtures were recently found encoding constants silently.

**No orchestrator change.** Both features live inside `runNewsSource`, which the
cron route test already mocks. No new call is added to `sweepNewsSources` or the
cron handler, so neither test needs modifying.

**Migrations:** run both `npm run db:migrate:test` and `npm run db:migrate`. A
dev database left one migration behind previously produced a 42P10 error that
was misdiagnosed as a code defect.

## Files

- Modify: `src/db/schema.ts` — `rejectedArticles` table + `rejectedArticleReasonEnum`
- Create: `src/db/migrations/<n>_*.sql` — generated
- Modify: `src/lib/signals/tavily.ts` — options object, merged exclusions
- Modify: `src/lib/signals/news-agent.ts` — `loadProfile`, own-host filter, two
  inserts, the second pre-flight query, return type
- Modify: `tests/lib/signals/news-agent.test.ts`
- Modify: `tests/lib/signals/tavily.test.ts`

## Open items for whatever follows

- **High-scoring junk the floor cannot touch.** The 2026-08-06 probe returned a
  Capital One job posting at 0.838 and a social post at 0.902 — both in the top
  ten, both fetched and sent to the model every run. `EXCLUDED_DOMAINS` was
  built from the week-windowed *news*-index probe and does not cover whatever
  serves these. Fixing it needs a probe that captures hostnames.
- **Stagnation is unobservable.** The signature of a pool crowded out by repeats
  is `dropped` staying high while `written` falls toward zero. Both numbers are
  returned and both are discarded by the sweep.
