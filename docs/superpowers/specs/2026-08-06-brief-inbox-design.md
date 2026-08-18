# Brief Inbox — Design

**Date:** 2026-08-06
**Status:** approved, not implemented
**Spec:** 5b — the second half of spec 5 ("Brief agent + inbox") in the content-hub pivot design.

## Context

The brief agent runs daily and writes `briefs` rows. Nothing can read them.
There is no route under `src/app` matching `brief` or `inbox`, so the human
gate the whole product model rests on — a person deciding what is worth
publishing — is currently unreachable. Every downstream spec (6, 9) depends on
briefs being acceptable.

The agent side is complete: `runIdeation` proposes and extends briefs,
`expireStaleBriefs` ages them out at `BRIEF_TTL_DAYS` (14), and `sweepIdeation`
runs both on the daily cron. The `briefs` table already carries every column
this spec needs for accept and dismiss — `acceptedBy`, `acceptedAt`,
`contentPieceId`, `dismissReason`, `dismissNote`, `dismissedBy`, `dismissedAt`.

**Dismissal is already wired back into the agent.** `run.ts:163-200` selects
dismissed briefs and passes them to the ideation prompt as `rejected`. The
inbox only has to write the columns; the training loop then closes by itself.

## Non-goals

- **Drafting from a brief.** Accept creates a content piece with a
  deterministic scaffold body and makes no model call. Real drafting is spec
  5c, which will replace the scaffold using the failure model settled here:
  accept is an instant state change that cannot fail; generation runs after and
  is retryable.
- **Editing a brief before accepting.** `briefs.editedAt` exists and stays
  unused.
- **Manual brief creation** — spec 6. **Bulk actions** — no evidence of need.

## Part 1 — Schema

### `briefs.contentPieceId` gains its foreign key

The column exists with a comment recording that the reference was deliberately
withheld because "the accept flow lands in the inbox plan, and adding the
reference before anything writes it would be schema written ahead of its
consumer." This spec is that consumer.

- `references(() => contentPieces.id, { onDelete: "set null" })` — **not**
  cascade. The brief is the durable record that a human accepted something;
  deleting the resulting piece must not erase that decision.

**The partial unique index already exists** and must NOT be re-added:
`briefs_content_piece_unique` at `schema.ts:487-490`, on `contentPieceId`
where not null. Only the foreign key is missing. `briefs_tenant_status_score_idx`
on `(tenantId, status, score)` also already exists and is exactly the index the
inbox's default query wants — no new index is needed for the read path either.

The link is kept on `briefs` only. `contentPieces` does **not** gain a
`briefId`: two directions would drift, and the partial unique index is only
expressible on this side.

### A `brief_runs` table

```
brief_runs
  id              uuid pk
  tenant_id       uuid not null → tenants (on delete cascade)
  ran_at          timestamptz not null default now()
  assessment      text          -- the model's period judgement; null when the call failed
  briefs_created  integer not null default 0
  briefs_extended integer not null default 0
  error           text          -- null on a clean run
```

**Why a table rather than a column on `briefs`.** The assessment is a property
of a *run*, not of a brief. Denormalising it onto each brief would mean a run
that produced zero briefs carries no assessment at all — and that is precisely
the case worth explaining. Without this, "the agent ran and correctly found
nothing worth writing" and "the agent is broken" render identically as an empty
inbox. That exact ambiguity was the bug fixed twice in the news agent this
week; this avoids introducing it a third time.

It mirrors the established source-health pattern (`sources.lastRunAt` /
`lastSuccessAt` / `lastError`), which the settings surface already reads.

No retention is enforced. At one row per tenant per day this grows by ~365 rows
a year, and `ran_at` is stored so a purge can be added later.

## Part 2 — Recording runs

`runIdeation` writes the `brief_runs` row itself, via a module-private
`recordRun` helper called at **every** exit point — mirroring `finish()` in
`news-agent.ts`.

It must be `runIdeation` and not `sweepIdeation`, for a reason visible in the
current code: `run.ts:213-222` catches a failed ideation call, logs it with
`console.error`, and returns `empty`. **The error string never escapes the
function**, so a caller cannot record it. `IdeationRunResult` has no `error`
field and does not need one — the row is written where the error is in scope.

`runIdeation` has exactly **two** exits after its setup — verified by reading
the function, not assumed. There is no early return for an empty signal list:
`ideate` returns `{ assessment: "No signals in the window.", actions: [] }` and
that flows through the normal path.

| Exit | line | assessment | created | extended | error |
|---|---|---|---|---|---|
| Ideation call failed | `run.ts:222` | null | 0 | 0 | the error string |
| Normal completion | `run.ts:281` | the model's | actual | actual | null |

The failure exit's existing comment already makes this spec's argument:

> "a permanently broken ideation … is indistinguishable from a genuinely quiet
> company: the cron reports ok, no brief appears, **and nothing is written
> anywhere**. The whole product promise is that an empty inbox means 'nothing
> was worth saying', so a failure that looks like silence is the worst failure
> this system has."

`brief_runs` is what makes that written somewhere. The `console.error` on that
line stays — the table is a record, not a replacement for logging.

A failure to write the row must not throw and cost the run its briefs — wrap
it, exactly as `rememberRejections`'s call sites do in the news agent.

## Part 3 — The read path

A new `src/lib/briefs/query.ts`, mirroring `src/lib/signals/query.ts`:

- `listBriefs(tenantId, filters, database)` — returns briefs with their cited
  signals joined through `brief_signals` (id, title, url, kind), because the
  evidence is what lets a human judge whether the agent reasoned or
  confabulated.
- `latestBriefRun(tenantId, database)` — the most recent `brief_runs` row, for
  the inbox header.

**Ordering: `score DESC, createdAt DESC`.** The schema comment on `briefs.score`
records that the validation spike measured scores clustering narrowly at
0.66–0.92, so score alone ranks poorly once a backlog exists; recency breaks
the ties that score cannot.

**Default filter: `status = "new"`.** Accepted, dismissed and expired are
reachable through the status filter but are decisions already made.

Every query is tenant-scoped. This is not optional: briefs carry the company's
unpublished strategy.

## Part 4 — The inbox UI

Route `/briefs` under `(dashboard)`, following the signals browser's structure
exactly — an async Server Component reading `searchParams` (a `Promise` in
Next.js 16; see `node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md`),
plus `briefs-list.tsx`, `brief-card.tsx`, `briefs-filters.tsx` and `actions.ts`.

**Header:** the latest run — relative time, assessment, brief count, and the
error if there is one. This is the whole reason `brief_runs` exists.

**Card:** title, content type, suggested channel, score, angle, why-now, key
points, and the cited signals as links.

**Empty state:** distinguishes three cases, using `latestBriefRun` — never run
yet; ran and produced nothing (show the assessment); ran and failed (show the
error). A generic "no briefs" message for all three would waste the table.

**Nav:** a `/briefs` entry alongside Signals.

## Part 5 — Accept

One server action. Ordered so a failure cannot half-apply:

1. `requireSession`, then re-read the brief **scoped to the session's tenant**.
   A brief id from another tenant must 404, not accept. The id is
   user-supplied.
2. Reject unless `status === "new"`. Accepting an already-accepted or dismissed
   brief must be a no-op with a clear message, not a second content piece.
3. In a transaction: insert the `content_piece`, then update the brief with
   `status: "accepted"`, `acceptedBy`, `acceptedAt`, `contentPieceId`.
4. `revalidatePath`, then redirect to the draft editor.

The content piece: `type` from `briefs.contentType`, `title` from the brief,
`status: "draft"`, and a scaffold body:

```
{angle}

Why now: {whyNow}

## {keyPoint 1}
## {keyPoint 2}
...
```

Deterministic, no model call. `contentPieces.body` is NOT NULL, so something
must be written; key points as headings give a writer somewhere to start and
give spec 5c something concrete to replace.

## Part 6 — Dismiss

One server action taking a reason from the existing `briefDismissReasonEnum`
(`off_topic`, `wrong_angle`, `already_covered`, `not_our_voice`, `other`) and
an optional note. Same tenant-scoping and same `status === "new"` guard as
accept.

Writes `status: "dismissed"`, `dismissReason`, `dismissNote`, `dismissedBy`,
`dismissedAt` — the columns `run.ts` already reads back into the next run's
prompt.

## Testing

- `listBriefs` is tenant-scoped, orders by score then recency, defaults to
  `new`, and returns cited signals.
- Accept creates exactly one content piece, links it both ways, and sets the
  audit columns.
- **Accepting another tenant's brief creates nothing** — the security case.
- **Accepting an already-accepted brief is a no-op**, not a second piece.
- Dismiss writes all five columns; a dismissed brief then appears in the next
  `runIdeation` prompt as `rejected` — the loop-closing test, which must assert
  on the prompt input rather than on the columns alone.
- `runIdeation` writes exactly one `brief_runs` row per run, at each of the
  three exit points, with the error string present on the failure path.
- The partial unique index rejects a second brief pointing at one content
  piece, and permits many briefs with null.
- Per the standing rule: for each guard, delete it and confirm the test fails.

## Files

- Modify: `src/db/schema.ts` — `briefRuns`, the `contentPieceId` FK and partial unique index
- Create: `src/db/migrations/<n>_*.sql`
- Modify: `src/lib/briefs/run.ts` — `recordRun` at every exit
- Create: `src/lib/briefs/query.ts` — `listBriefs`, `latestBriefRun`
- Create: `src/app/(dashboard)/briefs/{page,briefs-list,brief-card,briefs-filters,actions}.tsx|ts`
- Modify: the dashboard nav
- Tests alongside each

## What spec 5c inherits

- Replace the scaffold body with real generation, reusing
  `prepareGenerationContext` (brand profile, personas, examples). `selectExamples`
  already accepts a `contentType` but `generation-context.ts:35` hardcodes
  `"product_update"` — that is the line spec 5c must generalise.
- The failure model is already decided: accept never fails; generation runs
  after and is retryable, leaving the scaffold and a visible error if it fails.
- Next.js 16's `after()` is the likely primitive for running generation past
  the response. Verify against `node_modules/next/dist/docs/` before relying on
  it — a fire-and-forget promise is killed on serverless.
