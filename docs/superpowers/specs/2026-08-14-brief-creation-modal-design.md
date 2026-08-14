# Brief Creation Modal — Design

**Date:** 2026-08-14
**Status:** approved, not implemented
**Spec:** B of three. Depends on A (briefs as documents), which is complete. C
(briefs on the board) is independent.

## Context, and a correction

An earlier overview of this work said spec B would "mirror `generationStep` onto
`brief_runs`". **That was wrong.** `brief_runs` records the cron ideation sweep,
which runs unattended — no user ever watches it. Brief creation does not work
like draft generation, and the design below reflects what the code actually does.

What actually happens when a human makes a brief from signals:

1. They select signals on `/signals` and follow a link to `/briefs/new?signals=…`.
2. **`/briefs/new` awaits `proposeBriefFromSignals` during its server render**
   (`page.tsx:104`) to pre-fill the form.
3. `createManualBrief` then inserts the edited form. It makes **no model call of
   its own** — it is a plain insert.

There is **no `loading.tsx` anywhere in the dashboard**. So step 2 is a frozen
navigation with zero feedback for as long as one model call takes.

## What this spec is, and what it is honestly not

It makes that wait visible, as a modal with three steps, and it is deliberately
**briefs only** — draft generation keeps the inline checklists built earlier and
gets no modal. That narrowing was a deliberate call, not an oversight.

The steps are honest about a hard limit: a proposal is **one `generateObject`
call**. There are three real moments — resolving the signals, asking the model,
and the brief existing — and step two is the overwhelming majority of the wait. A
five-step animated checklist here would be theatre. Three steps, one of which
visibly carries the time, is the truthful version.

## The brief exists when the modal finishes

This is the design's pivot, and it comes straight from the requirement: *"when
it's done, the user can open the piece or just close the modal."* You can only
open a piece that exists.

So the action **creates the brief**, rather than pre-filling a form:

```
select signals → [Create brief] → modal
    ✓ Resolved 3 signals
    ● Proposing an angle…
    ✓ Brief created
  [Open brief] [Close]
```

`Open brief` goes to `/briefs/[briefId]` — the editor from spec A. That is the
substantial reuse win: a proposal is no longer a special pre-filled form, it is
an ordinary brief you edit in the ordinary editor.

**Closing the modal is not a cancel.** The brief is already in the inbox with
`status = "new"`, exactly like an agent-proposed one, and can be dismissed there.
Nothing is lost by closing, which is what makes Close a safe default.

### What this retires

`/briefs/new` **keeps existing for the hand-written path** and loses its proposal
branch — the `?signals=` pre-fill, the `droppedUnavailable` notice, and the
in-render `proposeBriefFromSignals` call. Writing a brief by hand is unchanged.

## The action

`proposeAndCreateBrief(signalIds)` — one async export in a `"use server"` module.

- Resolves the signals **tenant-scoped**, never trusting the ids. This guard
  already exists in `createManualBrief` with a comment explaining that attaching
  another tenant's signal leaks its title into this tenant's brief and into every
  draft generated from it. Reuse that path rather than writing a second one.
- Calls `proposeBriefFromSignals`.
- Persists through **`createManualBrief`**, which already inserts, links
  `brief_signals`, renders the body via `renderBriefBody`, and refuses a blank
  body. Do not add a fourth writer of `briefs.body`.
- Returns the new `briefId`, or a reason.

Because a single action does all three, the modal's steps are reported by the
client around one round trip rather than polled from a database. That is the
right trade at this size: persisted progress would need a row, a poll, and a
sync path to report on **one** model call.

### Degradation

`proposeBriefFromSignals` returning a failure must not lose the selection. The
modal shows the reason and offers `Write it by hand` — a link to `/briefs/new`
carrying the same ids — so the existing "never block the form" rule survives.
That rule is why the proposal is skipped for an empty selection today.

## Steps and reuse

`PROPOSAL_STEPS` joins `DRAFT_STEPS` and `EDIT_STEPS` in
`src/lib/drafting/draft-progress.ts`, which already establishes that different
flows carry different step lists against the same renderer:

```ts
export const PROPOSAL_STEPS = [
  { key: "resolving", label: "Resolving your signals" },
  { key: "proposing", label: "Proposing an angle" },
  { key: "saving", label: "Creating the brief" },
];
```

`ProgressChecklist` (`src/components/draft-progress-checklist.tsx`) renders it
unchanged, including the non-spinning `stalled` state added earlier.

**`DraftStepKey` is a closed union** — `"collecting" | "preparing" | "generating"
| "reviewing" | "saving"`. `resolving` and `proposing` are new members, so this
is not a free addition, and the consequence is concrete rather than theoretical:
`drafts/[releaseId]/agent-edit-dialog.tsx:44` and `extract-dialog.tsx:44` both
hold a `Record<DraftStepKey, StepStatus>`, and a `Record` over a widened union
requires an entry for every new key. Both initialisers must be updated, or those
two dialogs stop compiling.

The alternative is to give `PROPOSAL_STEPS` its own key type rather than
widening the shared one. **Decide this deliberately at implementation time and
record which you chose** — do not reach for a cast to make the error go away.

## Testing

- The action refuses another tenant's signal ids — asserted **by id**, not by an
  empty result.
- A proposal failure returns a reason and creates no brief.
- A successful run creates exactly one brief, linked to the resolved signals,
  with a non-blank body.
- The modal advances through all three steps and ends with `Open brief`.
- Closing the modal after success leaves the brief in place — it is not a cancel.
- `/briefs/new` still works with no `?signals=`, and no longer calls the model.
- Per the standing rule, each guard is deleted and its test re-run to confirm it
  fails.

The repo has jsdom and `@testing-library/react`. **Render the modal and drive it**
rather than extracting pure functions — the last three defects on this branch all
lived in untested effect wiring, and one survived a mutation with every test
green.

**`npm run build` is a mandatory gate.** When sanity-checking the `.next/static`
bundle grep, use a string confirmed to come from a file whose first line is
`"use client"` — an earlier task sanity-checked with a Server Component string,
so its clean result proved nothing.

## Files

- Create: `src/app/(dashboard)/signals/propose-actions.ts`,
  `src/app/(dashboard)/signals/create-brief-modal.tsx`
- Modify: `src/lib/drafting/draft-progress.ts` — `PROPOSAL_STEPS`, `DraftStepKey`
- Modify: `src/app/(dashboard)/signals/signals-list.tsx` — the button opens the
  modal instead of linking
- Modify: `src/app/(dashboard)/briefs/new/page.tsx` — drop the proposal branch
- No schema change.

## Open items

- The cron ideation sweep still reports nothing to anyone. It is unattended, so a
  modal is meaningless; a run history on `/briefs` reading `brief_runs` would be
  the right surface if it is ever wanted.
- If `proposeBriefFromSignals` ever gains real internal phases, the middle step
  is where they belong, and persisted progress becomes worth its cost.
