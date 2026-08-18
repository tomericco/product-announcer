# Pipeline Board — Design

**Date:** 2026-08-06
**Status:** approved, not implemented
**Spec:** 7 in the content-hub pivot decomposition. Depends on 1, which is complete.

## Context

Content pieces exist and move `brief → draft → published`, but only three of the
five declared statuses are ever assigned, and two columns — `assignedTo` and
`scheduledFor` — are declared in the schema and read or written by **nothing** in
the codebase. There is no view of work in flight: `/drafts` lists `brief` and
`draft` pieces, `/history` lists published ones, and nothing shows the shape of
the pipeline or who owns what.

This spec adds that view and activates the dead columns.

## Non-goals

- **Replacing `/drafts` or `/briefs`.** The board is a new route alongside them.
  Retiring `/drafts` is a later decision, once the board has proved itself.
- **The briefs rail.** The design doc wants the inbox pinned to the board's left;
  that is a separate change and depends on this one existing first.
- **The calendar** — spec 8, which reads the `scheduledFor` this spec starts
  writing.
- **Publishing from the board, and auto-publishing.** Both explained below.
- Editing content on the board. Cards link to the existing editor.

## The board

A new route `/board` under `(dashboard)`, with five columns in pipeline order:

```
brief → draft → review → scheduled → published
```

`brief` means *approved, draft not yet generated* — the definition `schema.ts`
has carried since spec 1.

Each card shows: title, content type, assignee, `scheduledFor` when set, and the
generation state a `brief`-status piece is in (awaiting generation, or failed
with its reason). Cards link to `/drafts/[id]`.

### Two transitions are deliberately not drags

This is the part most likely to be "simplified" later, so the reasoning is
recorded here.

**`brief → draft` is not a manual move.** A `brief`-status piece's body is the
deterministic scaffold written at accept time. Dragging it into `draft` would
present that scaffold as a finished draft — exactly what spec 5c's status fix
exists to prevent, and what `approveDraft`/`publishDraft` now refuse. The board
offers a **Generate draft** action instead, calling the same path the accept
flow does.

**Nothing can be dragged into `published`.** Publishing dispatches to LinkedIn,
Webflow or a webhook — it is an outward-facing, effectively irreversible act
with delivery records attached. A drag gesture is the wrong affordance for it,
and `publishDraft` already carries guards a drag would bypass. Publishing stays
the explicit action on the draft page; the board's `published` column is
read-only.

**Draggable:** `draft ↔ review ↔ scheduled`, in both directions. These are
planning states a human owns, and moving between them changes nothing outside
the row.

### Scheduling is planning, not automation

Moving a card into `scheduled` opens a picker for **date and time** — not date
alone, because "publish Tuesday" and "publish Tuesday 09:00" are different
commitments and the calendar in spec 8 needs the hour to lay a day out.

`contentPieces.scheduledFor` is already `timestamptz`, so it stores the instant.
The picker collects local wall-clock time and it is converted on the way in;
the value is rendered back in the same local zone, so a piece scheduled for
09:00 reads as 09:00.

**Nothing auto-publishes at that time.** The pivot deliberately deleted the
cadence scheduler because autopilot contradicts the human-gated model, and
auto-publishing a finished piece is a smaller version of the same thing. A
`scheduled` card is an intention; a human still publishes it. That gap is worth
naming in the UI so the column does not read as a promise the system does not
keep.

Leaving `scheduled` clears `scheduledFor`, so the calendar never shows a piece
that is no longer scheduled.

### Assignment

`assignedTo` is activated: a picker on each card, populated from
`listWorkspaceMembers`, plus unassign. The board can filter to one assignee.

Assignment is advisory — it gates nothing. Nobody is prevented from editing or
publishing a piece assigned to someone else, because a content team of this size
does not want that friction and the audit columns already record who acted.

### The published column is capped

Published pieces accumulate without bound and would otherwise dominate the
board. The column shows the most recent 20 with a link to `/history`, which
already exists for the full record.

## Data

No schema change. `assignedTo` and `scheduledFor` already exist; this is the
first code to use them.

A `src/lib/content/board.ts` module owns the read — all pieces for the tenant
grouped by status, with the published cap applied — and the two mutations,
`moveContentPiece` and `assignContentPiece`. Keeping them in `lib` rather than
in the route's actions file makes them testable without mocking Next internals,
the same shape as `src/lib/briefs/draft.ts`.

`moveContentPiece` must reject any transition the board does not offer, server
side. The client not rendering a drop target is not a guarantee; the id and
target status arrive from the browser. Specifically it must refuse: any move to
`published`, any move to or from `brief`, and any status outside the enum.

## Testing

- The read groups by status, is tenant-scoped, and caps the published column.
- `moveContentPiece` allows `draft ↔ review ↔ scheduled`.
- It **refuses a move to `published`**, and refuses moves to or from `brief` —
  the two rules the UI merely declines to offer.
- It refuses a piece belonging to another tenant.
- Entering `scheduled` requires a `scheduledFor`; leaving it clears the value.
- `assignContentPiece` accepts a member of the same workspace and refuses a user
  who is not one.
- Per the standing rule, each guard is deleted and its test re-run to confirm it
  fails.

**`npm run build` is a mandatory gate** — it has caught a `"use server"` export
rule twice that the suite missed. The UI cannot be visually verified; the dev
preview is behind an OAuth wall.

## Files

- Create: `src/lib/content/board.ts` and its tests
- Create: `src/app/(dashboard)/board/{page,board,column,card,actions}.tsx|ts`
- Modify: `src/app/(dashboard)/nav-links.tsx` — a Board entry
- Tests alongside each

## Open items

- Retiring `/drafts` in favour of the board, once the board has been used.
- The briefs rail from the design doc.
- Auto-publishing a `scheduled` piece. Deliberately excluded; if it is ever
  built, it needs the same human-gate argument the cadence scheduler lost.
- `reviewStatus` (the AI review's passed/failed/error) and the new `review`
  pipeline status are different things with confusingly similar names. Nothing
  reads them together today, but a future author will assume they are related.
