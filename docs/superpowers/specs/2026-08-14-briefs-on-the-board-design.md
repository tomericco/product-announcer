# Briefs on the Board — Design

**Date:** 2026-08-14
**Status:** approved, not implemented
**Spec:** C of three. Depends on A (briefs as documents), which is complete. B is
independent.

## Context

> "I see that briefs are not displayed in the board under 'Brief' column. I
> created a brief and it didn't appear there."

That is exactly what happens, and it is not a bug — which is the actual problem.

`BOARD_COLUMNS` is `["brief", "draft", "review", "scheduled", "published"]`, and
every one of them is a `contentPieces.status`. A brief is a row in a **different
table**. Creating a brief inserts into `briefs` and nothing else; a content piece
with `status = "brief"` is created only by `acceptBrief`, which then immediately
starts generation and flips it to `draft`.

So the board's "Brief" column shows a content piece for roughly the length of one
generation, and it means **"awaiting generation"**. The name collides with the
object it does not contain, and the collision is what made the expectation
reasonable.

## Two changes, and the rename is the load-bearing one

1. The column that exists today is renamed **Generating**. It keeps its meaning,
   its status, and its rules — it just stops impersonating a brief.
2. A new **Brief** column, first, lists real briefs.

Doing only (2) would leave two columns both plausibly called "brief". Doing only
(1) fixes the lie but leaves the expectation unmet. Both, or neither.

## The board becomes two object types, deliberately

This is the significant architectural consequence and it should be stated plainly
rather than discovered during implementation. `readBoard` returns
`Record<BoardColumn, BoardCard[]>` where every card is a content piece. After
this, the Brief column holds cards backed by `briefs` rows.

They are kept as **distinct types**, not merged into one loose shape:

```ts
type BoardCard      = { kind: "piece";  … }   // as today
type BoardBriefCard = { kind: "brief";  id, title, contentType, score, status }
```

A discriminated union is what stops `moveContentPiece` from ever receiving a
brief id, and what makes the card renderer's two branches explicit instead of a
pile of optional fields. The alternative — one card type with nullable
everything — would push the distinction into runtime checks scattered across the
UI.

**Which briefs appear:** `status = "new"`. Not `accepted` (it has a content
piece, which is already on the board in a later column — showing both would
double-count the same work) and not `dismissed` or `expired`.

## Dragging a brief into Generating accepts it

The one interaction worth having, and it maps onto machinery that already exists:
`acceptBrief` creates the content piece and starts generation. Dropping a brief
into **Generating** calls exactly that.

Every other drag involving the Brief column is refused:

- **Nothing can be dragged *into* Brief.** A content piece cannot become a brief;
  the relationship is one-way.
- **A brief cannot be dragged past Generating.** Skipping to `draft` would mean a
  content piece with no generated body, which is the state `approveDraft` and
  `publishDraft` already refuse.

`canMove` today is a `ReadonlySet<`${BoardColumn}:${BoardColumn}`>` with six
entries covering `draft ↔ review ↔ scheduled`. It stays exactly as it is and
keeps operating on content pieces only. **Brief acceptance is a separate
transition with a separate function** — overloading `moveContentPiece` to
sometimes mean "accept a brief" would put two different authorisation models in
one function, and its existing guards (refusing moves to `published`, to or from
`brief`) are written for pieces.

`acceptBrief` is already the authority: it re-reads the brief tenant-scoped,
creates the piece, and triggers generation. The board calls it and inherits every
guard. **Do not reimplement acceptance.**

## The unsaved-edits lesson applies here too

Spec A shipped a Critical where Accept discarded a brief's unsaved edits, because
the decision path never consulted the editor's dirty state. **The board cannot
reproduce that** — there is no editor open — but it introduces the mirror hazard:
accepting from the board acts on the **stored** brief, which may be older than
what someone has open in another tab.

That is acceptable and needs no lock; it is the ordinary last-write-wins of a
multi-surface app. It is recorded so nobody later "fixes" it by adding one.

## Cards

A brief card shows title, content type and score, and links to
`/briefs/[briefId]` — the spec A editor. It reuses the board's existing card
chrome rather than inventing a second visual language; only the badges differ,
because a brief has no assignee, no schedule and no review status.

`assignedTo` filtering is a content-piece concept. With the assignee filter set
to anything but "Everyone", **the Brief column shows an explanatory empty state**
rather than vanishing or silently showing everything — a column that ignores an
active filter is worse than one that says why it is empty.

## Testing

- `readBoard` returns `new` briefs in the Brief column and excludes `accepted`,
  `dismissed` and `expired`.
- It is tenant-scoped for briefs as well as pieces — asserted **by id**, not by an
  empty result.
- Accepting from the board creates a content piece and starts generation, via
  `acceptBrief` — asserted by the piece existing and the brief flipping to
  `accepted`, not by mocking `acceptBrief` away.
- A brief cannot be dropped into `draft`, `review`, `scheduled` or `published`.
- Nothing can be dropped into `Brief`.
- `canMove` is unchanged — its existing tests must still pass untouched, which is
  the check that acceptance did not get tangled into `moveContentPiece`.
- With an assignee filter active, the Brief column renders its explanatory empty
  state.
- Per the standing rule, each guard is deleted and its test re-run to confirm it
  fails.

jsdom and `@testing-library/react` are available — **render the board and drive
the drag** rather than testing only the pure rules. Every UI defect on this
branch has lived in wiring that pure-function tests could not see.

**`npm run build` is a mandatory gate.** Sanity-check the `.next/static` grep with
a string confirmed to come from a `"use client"` file.

## Files

- Modify: `src/lib/content/board.ts` — the brief read, the card union
- Create: `src/app/(dashboard)/board/accept-brief-action.ts` (or extend the
  board's existing actions file, if that keeps the `"use server"` export rule)
- Modify: `src/app/(dashboard)/board/board.tsx` — `COLUMN_LABEL`, the new column
- Modify: `src/app/(dashboard)/board/card.tsx` — the brief branch
- No schema change.

## Open items

- Dismissing from the board. Deliberately omitted: dismissal takes a reason, and
  a reason picker on a drag target is the wrong shape. Dismissal stays on
  `/briefs` and in the editor.
- The board now reads two tables on every load. Fine at this size; if it ever
  matters, the Brief column is the natural thing to paginate first.
- `BOARD_COLUMNS` is used as both the display order and the status enum. Adding a
  column that is not a `contentPieces.status` strains that. It holds here because
  Brief is first and never a move target, but a second such column would mean
  separating the two concepts.
