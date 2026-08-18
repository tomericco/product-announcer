# Calendar — Design

**Date:** 2026-08-06
**Status:** approved, not implemented
**Spec:** 8 in the content-hub pivot decomposition. Depends on 7, which is complete.

## Context

Spec 7 made `contentPieces.scheduledFor` writable for the first time — a human
moving a card into the board's `scheduled` column picks a date and time. Nothing
reads it. This spec is the reader: a month view answering "what are we shipping,
and when", which the design doc calls the calendar's job — coverage.

## Non-goals

- **Editing.** The design doc is explicit: *"A view, not a third object."*
  Scheduling happens on the board, which already owns the picker and the
  server-side transition rules. One place a schedule can change means the two
  surfaces cannot disagree.
- Week or day views. Month only.
- Anything about `brief`, `draft`, `review` or `archived` pieces — they have no
  date to place.

## The second axis is content type, not channel

The design doc says the calendar lays pieces out "by date and channel". **A
content piece has no channel**, and this is worth stating plainly because the
wording invites the wrong build:

- `channelVariants.channel` exists only where a variant was written, and only
  the LinkedIn path ever writes one.
- `deliveryAttempts.destination` exists only *after* publishing.

So a scheduled piece — the entire upcoming half of the calendar, and the half
worth planning against — would have no lane. `contentPieces.type`
(`product_update` / `blog_post` / `social_post`) exists on every piece from
creation, so both halves land somewhere and the view answers the coverage
question the calendar is for.

Revisit only if a piece gains a real channel of its own. Deriving one from
delivery attempts would still leave the future blank.

## What it shows

Two statuses, each placed by its own date:

| Status | Placed by |
|---|---|
| `scheduled` | `scheduledFor` — when a human intends to publish it |
| `published` | `publishedAt` — when it actually went out |

Spec 7 clears `scheduledFor` when a piece publishes, so a piece moves cleanly
from its planned date to its actual one and never appears twice.

**A `published` piece with a null `publishedAt` is skipped and counted**, and the
count is shown. `publishedAt` is nullable, so this is reachable. It must not be
silently dropped — that would understate coverage, which is the one thing the
view exists to measure — and it must not be placed on a guessed date, which
would misstate it.

## The read

`src/lib/content/calendar.ts` owns `readMonth(tenantId, month)`, returning the
days of that month with their pieces grouped by type, plus the undated count. It
lives in `lib` rather than the route so it is testable without mocking Next
internals — the same shape as `src/lib/content/board.ts`.

Tenant-scoped, and bounded to the month's range in SQL rather than by filtering
a full read in memory.

## The route

`/calendar` under `(dashboard)`, an async Server Component. The month comes from
`?month=YYYY-MM`; `searchParams` is a **Promise in Next.js 16 and must be
awaited**. An unparseable or absent value falls back to the current month rather
than erroring — a bad query string is not an error condition.

Previous/next links move by one month. Cards show title and time, and link to
`/drafts/[id]`.

## Local time, and the hydration hazard

Times render in local time so a piece scheduled for 09:00 reads as 09:00,
matching the board's picker.

That is the exact mismatch the board hit: formatting a date in a client
component renders the server's zone on the server pass and the browser's after
hydration. `src/app/(dashboard)/board/card.tsx` already carries the fix — a
mount-gated read that shows a placeholder on the server pass and the real time
after. Reuse that approach rather than `suppressHydrationWarning`, which
silences the warning while leaving the wrong time on screen.

The month grid's day boundaries are local too. A piece scheduled at 23:30 local
must appear on that local day, not the next UTC one.

## Testing

- `readMonth` returns only `scheduled` and `published` pieces, and is
  tenant-scoped.
- A `scheduled` piece is placed by `scheduledFor`; a `published` one by
  `publishedAt`.
- A piece outside the requested month does not appear — including one whose
  *other* date falls inside it.
- A `published` piece with a null `publishedAt` is excluded from the grid and
  included in the undated count.
- Pieces are grouped by `type`, and a type with nothing that month is still
  present as an empty lane — a missing lane reads as a missing type, not an
  empty one.
- `?month=` garbage falls back to the current month rather than throwing.
- Per the standing rule, each guard is deleted and its test re-run to confirm it
  fails.

**`npm run build` is a mandatory gate** — it has caught a `"use server"` export
rule and a server-module-in-the-client-bundle leak that the suite missed. The UI
cannot be visually verified; the dev preview is behind an OAuth wall.

## Files

- Create: `src/lib/content/calendar.ts` and its tests
- Create: `src/app/(dashboard)/calendar/{page,month-grid,day-cell}.tsx`
- Modify: `src/app/(dashboard)/nav-links.tsx` — a Calendar entry
- No schema change.

## Open items

- Week and day views.
- Rescheduling by dragging, once the board has proved the interaction. It would
  need a rule set of its own: a day cell carries no time, and a published piece
  must not be draggable at all.
- A real channel on a content piece would make the doc's original axis possible.
