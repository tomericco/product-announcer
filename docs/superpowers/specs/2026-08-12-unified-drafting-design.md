# Unified Drafting — Design

**Date:** 2026-08-12
**Status:** approved, not implemented
**Spec:** 11 in the content-hub pivot decomposition. **Blocks spec 10's Task 6** —
the atomic-updates tab cannot retire until its drafting path has a home.

## Context

There are two ways to turn evidence into a draft, and they share almost nothing:

| | Atomic-update path | Brief path |
|---|---|---|
| Entry | `POST /api/atomic-updates/draft` | `generateDraftForPiece` via `after()` |
| Orchestrator | `runBatchForWorkspace` | `generateDraftForPiece` |
| Generator | `generateReleaseDraft` | `generateBriefDraft` |
| Creates the piece | `claimReleaseFromAtomicUpdates` | already exists, from brief accept |
| Progress | NDJSON stream, live checklist | `generationError` / `generatedAt` only |

The first is the changelog-era flow, reached only from
`atomic-updates/draft-release-dialog.tsx`. Spec 10 retires the tab that renders
it.

The decision: **atomic updates are signals, including for drafting.** They get
drafted like any other signal, through the one entry point — and the
atomic-update-specific composition logic and prompts are *called from* it rather
than living on a parallel path.

## The fork

`generateDraftForPiece` (`src/lib/briefs/draft.ts`) is already the single
orchestrator, already loads each evidence signal's `kind`, and already carries a
`deps.generate` seam. The branch goes there:

**`brief.contentType === "product_update"`** selects the release composition.

Not "the evidence is all shipped work". The content type is what the author
chose, and it already drives the prompt fork in `buildSystemPrompt`. Deriving the
branch from evidence instead would mean a blog post built from shipped work
silently gets changelog treatment — the exact confusion spec 5c's prompt fork was
written to end.

| Brief | Path |
|---|---|
| `product_update` + ≥1 `shipped_work` signal | Release composition |
| `product_update`, no `shipped_work` signal | Generic brief draft |
| `blog_post` / `social_post`, any evidence | Generic brief draft |

A product-update brief with no shipped work has no atomic updates to compose
from, so it falls back rather than erroring. That is a real case: a manually
created product-update brief citing only news.

### Mixed evidence

Only `shipped_work` signals supply atomic updates to the composition. Other
evidence on the same brief still reaches the prompt as context, through the
existing `BriefEvidenceForPrompt` list. Nothing is silently dropped.

### The atomic updates are re-derived, never trusted

The retiring API route re-derived the tenant's open atomic updates server-side
and intersected them with the requested ids, so a stale or foreign id was dropped
rather than honoured. That property survives: the atomic updates come from the
brief's own `brief_signals` → `signals.atomicUpdateId` join, tenant-scoped. No id
reaches this path from a client.

## `claimReleaseFromAtomicUpdates` narrows

Today it creates the content piece *and* links the atomic updates *and* marks
them released — it was the only writer, because the atomic-update path had no
piece until it made one.

The brief path already created the piece at accept time. So the function splits:
the piece-creating half is dropped, and what remains links a given set of atomic
updates to an **existing** `contentPieceId` and flips them to `released`, in one
transaction.

This must stay transactional with the draft write. A piece saved with a body but
with its atomic updates left `open` would offer the same shipped work to the next
compose run, producing a duplicate.

## Progress for every content type

The atomic-update dialog streams NDJSON over its POST response and renders a live
checklist. The brief path runs in `after()`, which has **no open response to
stream into** — so the stream cannot simply be reused.

Progress is persisted instead, and the client polls.

### `contentPieces.generationStep`

One new nullable text column holding the `DraftStepKey` currently in flight, or
null when nothing is generating.

That is enough for the existing checklist: every step before the stored one has
completed, the stored one is running, everything after is pending. It reuses
`DraftStepKey` and `DRAFT_STEPS` (`src/lib/drafting/draft-progress.ts`)
unchanged, so the progress vocabulary and the checklist component both survive
the migration off streaming.

The `detail` event's free text is **not** persisted. It exists for the streamed
dialog's per-event pacing and has no reader once that dialog is gone; storing it
would mean a write per token-ish event for something nothing displays.

### Wiring

`OnDraftProgress` keeps its shape. The unified path passes a callback that writes
`generationStep` rather than one that enqueues into a stream, so
`runBatchForWorkspace`'s internals — including `reviewAndReconcile`'s existing
`onProgress` calls — move across without change.

`generationStep` is cleared in the same write that sets `generatedAt`, and in the
failure write that sets `generationError`. A piece must never be left displaying
a step it is no longer running.

There are **four** exits that need a clear, not two: those two, the missing-brief
refusal (a plain `return` that never reaches the outer `catch`), and the outer
`catch` itself. The interrupted-generation write is **not** one of them — that
write is where `"generating"` is *set*, folded into the existing marker so it
stays one statement. Its whole purpose is to survive a process that dies before
any terminal write runs, which is exactly why the client cannot assume the step
is always eventually cleared.

### The read

A server action returning `{ generationStep, generatedAt, generationError }` for
a piece, tenant-scoped. The board card and the drafts list poll it while a piece
is `brief`-status with a null `generatedAt`, and stop on either terminal state.

Polling rather than a subscription: this is a per-piece checklist on a page the
author is already sitting on, and the project has no realtime transport. The
interval should be a few seconds — fast enough to feel live against steps that
take tens of seconds, slow enough not to matter.

## What retires

- `src/app/api/atomic-updates/draft/route.ts`
- `src/lib/drafting/compose-draft.ts` — `runBatchForWorkspace`'s body moves into
  the release branch of `generateDraftForPiece`
- `src/app/(dashboard)/atomic-updates/draft-release-dialog.tsx`, with the tab
  (spec 10)

What survives: `generateReleaseDraft` and its prompts, the category-biased
example selection in `atomicUpdateCategories`, `reviewAndReconcile`,
`validateDraftLinks`, `DraftStepKey` / `DRAFT_STEPS`, and the checklist UI.

**`src/lib/drafting/read-draft-progress.ts` is NOT deleted.** Two other NDJSON
routes survive this spec — `/api/drafts/edit` (the whole-update agent edit,
`EDIT_STEPS`) and `/api/drafts/extract` — and their dialogs
(`drafts/[releaseId]/agent-edit-dialog.tsx`, `extract-dialog.tsx`) both read
through it. Only `/api/atomic-updates/draft` stops streaming here.

Those two are edit and extract paths, not drafting paths, and stay streamed:
each runs from a dialog the author is actively waiting in, with an open response
to stream into. The persisted-progress design exists specifically because
`after()` has no such response.

## Data

One migration: `contentPieces.generationStep`, nullable text.

Nullable and unconstrained rather than an enum: the step vocabulary lives in
TypeScript (`DraftStepKey`), a piece generated before this column exists reads
null and renders as "no progress information", and adding a step later should not
need a migration.

## Testing

- A `product_update` brief with shipped-work signals takes the release branch —
  asserted by which generator ran, not by the output.
- A `product_update` brief with no shipped-work signals takes the generic branch.
- A `blog_post` brief with shipped-work signals takes the generic branch.
- Non-shipped-work evidence on a product-update brief still reaches the prompt.
- The release branch links its atomic updates to the **existing** piece and marks
  them `released`; it does not create a second piece.
- A signal whose atomic update belongs to another tenant contributes nothing.
- `generationStep` advances through the pipeline and is **null** after success,
  after failure, and after the interrupted-generation write.
- The progress read is tenant-scoped and refuses another tenant's piece.
- Per the standing rule, each guard is deleted and its test re-run to confirm it
  fails.

**No test may reach the real Anthropic API.** The generator is injected through
the existing `deps.generate` seam; any test touching this path mocks both
generators, and `after` must be mocked in a way that still runs the callback —
the trap spec 5c's Task 5 hit.

**`npm run build` is a mandatory gate.**

## Files

- Modify: `src/db/schema.ts` + migration — `contentPieces.generationStep`
- Modify: `src/lib/briefs/draft.ts` — the fork, the progress writes, the clears
- Modify: `src/lib/change-events/release-claim.ts` — narrow the claim
- Create: `src/lib/content/generation-progress.ts` — the tenant-scoped read
- Modify: the board card and drafts list — poll and render the checklist
- Delete: `src/app/api/atomic-updates/draft/route.ts` and
  `src/lib/drafting/compose-draft.ts`
- **Do not delete** `src/lib/drafting/read-draft-progress.ts` or
  `draft-progress.ts` — both still serve `/api/drafts/edit` and
  `/api/drafts/extract`

## Open items

- A realtime transport would replace the poll. Not worth introducing for this.
- The whole-update agent edit still streams. Unifying it too would remove the
  last NDJSON route, but it is an edit path, not a drafting path.
- `generationStep` has no timestamp, so a wedged generation looks identical to a
  slow one. A `generationStartedAt` would let the UI say "this has been running
  for six minutes" — deferred until someone hits it.
