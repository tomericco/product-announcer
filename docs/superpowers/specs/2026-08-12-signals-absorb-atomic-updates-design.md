# Signals Absorb Atomic Updates — Design

**Date:** 2026-08-12
**Status:** approved, not implemented
**Spec:** 10 in the content-hub pivot decomposition. Depends on 3 (signals) and on
the shipped-work reconciler, both complete.

## Context

The navigation still carries ten tabs, two of which — **Change events** and
**Atomic updates** — are the changelog-era ingestion pipeline exposed as
top-level destinations. The pivot made the product about content, not product
updates, and those two tabs now read as plumbing promoted to the front page.

The proposal: fold atomic updates into Signals under their existing
`shipped_work` label, with change events reachable as evidence, and retire the
standalone tabs.

## What is already true

Most of the data work is done, which changes the shape of this spec from a
migration to a UI reorganization.

- `signals.kind` already includes `shipped_work`, rendered as **"Shipped work"**
  in `signal-row.tsx` and filterable from the kind dropdown in
  `signals-filters.tsx`.
- `signals.atomicUpdateId` is already a foreign key to the atomic update.
- `syncShippedWorkSignals` is an **upsert, not a one-time copy**
  (`src/lib/signals/shipped-work.ts`). Every cron run refreshes `title` and
  `excerpt` from the atomic update, so an edit propagates. Hiding an atomic
  update marks its signal `stale`.
- `changeEvents.atomicUpdateId` gives the second hop, from atomic update to its
  constituent events.

So Signals is not a stale copy of the Atomic updates tab — it is already a live
view of it. What is missing is the evidence hop and a home for curation.

## The split: by purpose, not by table

The two tabs are not views. Signals has exactly one action (`addSignal`). Atomic
updates has eight; Change events has four plus repo import. Retiring the tabs
means those actions move, and where they move is the whole design.

They divide cleanly along a line that already exists in the product:

| Surface | Question it answers | Window |
|---|---|---|
| **Signals** | "What could I write about?" | 60 days |
| **Company → Pipeline** | "Is my ingestion healthy?" | all time |

Signals stays a read-first feed with single-item actions in a drawer. The
curation and bulk work moves to Company, next to Competitors and Industry news —
which are already the *what we watch* settings, making Company the single place
where ingestion is configured and corrected.

## The evidence drawer

Each `shipped_work` row on `/signals` gains a control opening a side panel built
on the existing `Dialog` primitive (`@base-ui/react/dialog`). No new dependency;
there is no Sheet component today and Dialog is sufficient.

The drawer shows, for one signal:

- The atomic update: title and summary, **editable**, plus `category` and `size`
  selects and a hide control.
- Its change events, newest first, each with the provider, type, and title —
  and per-event **reassign** and **remove from this update**.

Contents load through a server action on open rather than being embedded in the
list payload. A tenant-scoped read of one atomic update plus its events, so the
signals page does not pay for evidence nobody expanded.

The drawer is reachable only for `shipped_work` signals. Other kinds have no
atomic update and must not render the control.

### Editing propagates by the existing path

An edit in the drawer writes to `atomicUpdates`, exactly as the current tab does.
The signal's `title` and `excerpt` refresh on the next `syncShippedWorkSignals`
run, through the `onConflictDoUpdate` already in place. Nothing writes to the
signal directly — one writer for that column, and the reconciler stays the only
one.

This means an edit is **not immediately visible in the signals list**. That lag
is inherent to the reconciler and is the honest trade for not having two writers.
The drawer shows the atomic update's own values, so the edit is visible where it
was made.

## Company → Pipeline

Two new sections on `/company`, following the page's existing `Card` +
`CardHeader`/`CardDescription`/`CardContent` shape.

### Change events

The ungrouped queue: events where `atomicUpdateId IS NULL`, which the current tab
exposes through its `assignment: "unassigned"` filter. These have **no signal to
hang a drawer off** — that is the one thing the drawer genuinely cannot cover, and
the reason this section is not optional.

Carries the existing `type`, `provider`, `assignment` and `showHidden` filters,
plus reassign, bulk reassign, and bulk delete.

**Empty state required.** When nothing is ungrouped the section says so plainly
rather than rendering an empty table — this is the healthy state and should read
as such, not as a broken list.

### Atomic updates

The all-time ledger with the bulk operations: bulk hide, bulk delete, unhide, and
the `category` / `size` / `showHidden` filters from `AtomicUpdateListFilters`.

This section exists for two reasons the drawer cannot serve:

1. **Bulk is a list operation.** A per-signal drawer is single-item by
   construction.
2. **The 60-day boundary.** `listSignals` applies `signalWindowCondition()`
   unconditionally, and `syncShippedWorkSignals` only syncs atomic updates newer
   than `SIGNAL_WINDOW_DAYS` — so an atomic update older than 60 days has **no
   signal at all** and would become unreachable if Signals were its only surface.

Raising the window was considered and rejected: brief ideation reuses
`signalWindowCondition()` (`src/lib/signals/query.ts`), so widening it would change
what briefs get proposed from. The window stays at 60 days for content; the ledger
is simply un-windowed.

## Repo import

`listImportRepos` stays where it is. Connected repos already live under
**Integrations**, and the import flow belongs with them.

The cost of this, recorded deliberately: someone debugging "why is nothing coming
in" moves between Integrations (is the repo connected?) and Company (are events
arriving and getting grouped?). The alternative — moving change events to
Integrations — keeps ingestion together but separates it from Competitors and
Industry news, splitting *what we watch* instead. Neither is clean; this one keeps
the two halves of "what we watch" together.

## Routes

`/atomic-updates` and `/change-events` are deleted, and their nav entries with
them. Navigation drops from ten items to eight.

Both paths **redirect to `/company`** rather than 404. They have been in the nav
for the life of the project and will be bookmarked. Implemented as a `page.tsx`
calling `redirect()` — the folders are replaced, not removed outright.

### The root redirect is the sharp edge

`src/app/page.tsx:8` sends every user with completed onboarding to
**`/atomic-updates`**. That route is the app's post-login landing page, so
deleting it without changing this line breaks the entry point for every existing
user — and a redirect chain through `/company` would land them on settings, which
is the wrong first screen.

It is retargeted to **`/briefs`**: the inbox is what the pivot made the daily
driver, and it is the one surface that says "here is what you could write today".

Also retargeted, not left to the redirect:

- `src/app/(dashboard)/settings/actions.ts:45` and `:75` —
  `revalidatePath("/atomic-updates")`, which after this change must point at
  `/company`.

**`src/app/api/atomic-updates/draft/route.ts` is unrelated** and must not be
touched. It shares a path prefix with the retired tab and is an easy accidental
deletion.

## Data

**No schema change.** Every column and foreign key this needs already exists.

Server-side logic moves out of the two route folders into `src/lib`, so it is
testable without mocking Next internals — the shape spec 7 and 8 both used:

- `src/lib/change-events/list.ts` — `listChangeEvents` and the reassign/bulk
  mutations, lifted from `(dashboard)/change-events/actions.ts`.
- `src/lib/atomic-updates/list.ts` — `listAtomicUpdates` and the curation
  mutations, lifted from `(dashboard)/atomic-updates/actions.ts`.
- `src/lib/signals/evidence.ts` — `readSignalEvidence(tenantId, signalId)`,
  returning the atomic update and its change events, or null for a signal with no
  `atomicUpdateId`.

Tenant scoping is non-negotiable on every one of these, including the drawer read:
a signal id arrives from the browser and must never be trusted to belong to the
caller's tenant.

## Testing

- `readSignalEvidence` returns the atomic update and its change events for a
  `shipped_work` signal.
- It returns null for a signal whose `atomicUpdateId` is null, and for a
  `news`-kind signal.
- It **refuses a signal belonging to another tenant** — asserted by id, not by
  empty result.
- Editing an atomic update through the drawer's action changes the atomic update,
  and a subsequent `syncShippedWorkSignals` run carries the new title into the
  signal.
- Hiding an atomic update through the drawer marks its signal stale on the next
  sync, and the signal disappears from the default list.
- The ungrouped-events read returns only events with a null `atomicUpdateId`, is
  tenant-scoped, and returns empty (not an error) when everything is grouped.
- The atomic-updates ledger read is **not** windowed: an atomic update older than
  60 days appears there and has no signal.
- Reassigning an event moves it between atomic updates and is tenant-scoped.
- Per the standing rule, each guard is deleted and its test re-run to confirm it
  fails.

**`npm run build` is a mandatory gate.** It has caught a `"use server"`
export-shape rule twice and a server-module-in-the-client-bundle leak that the
suite missed. Note that the drawer is a client component reading through a server
action — the exact boundary those failures lived on.

The UI cannot be visually verified; the dev preview is behind an OAuth wall.

## Files

- Create: `src/lib/signals/evidence.ts` and its tests
- Create: `src/lib/change-events/list.ts`, `src/lib/atomic-updates/list.ts`, and
  their tests (logic lifted from the two route folders, with tests moved too)
- Create: `src/app/(dashboard)/signals/evidence-drawer.tsx` and its actions
- Create: `src/app/(dashboard)/company/change-events-section.tsx`,
  `atomic-updates-section.tsx`
- Modify: `src/app/(dashboard)/signals/signal-row.tsx` — the drawer control on
  `shipped_work` rows only
- Modify: `src/app/(dashboard)/company/page.tsx` — the two sections
- Modify: `src/app/(dashboard)/nav-links.tsx` — remove two entries
- Modify: `src/app/page.tsx` — root redirect `/atomic-updates` → `/briefs`
- Modify: `src/app/(dashboard)/settings/actions.ts` — two `revalidatePath` calls
- Replace: `src/app/(dashboard)/atomic-updates/` and
  `src/app/(dashboard)/change-events/` with a single `page.tsx` each calling
  `redirect("/company")`
- Do not touch: `src/app/api/atomic-updates/draft/route.ts`
- No schema change, no migration.

## Drafting is spec 11, and it gates the tab's removal

Not caught when this spec was written: `atomic-updates/draft-release-dialog.tsx`
is the only entry point to `POST /api/atomic-updates/draft`, the flow that turns
selected shipped work into a product-update draft. Retiring the tab removes it.

That path does not relocate — it **merges**. Atomic updates are signals for
drafting too, so the atomic-update composition becomes a branch inside
`generateDraftForPiece`, selected by `brief.contentType === "product_update"`.
See [Unified Drafting](2026-08-12-unified-drafting-design.md).

Spec 11 carries the one schema change this work needs
(`contentPieces.generationStep`); this spec still needs none of its own. **Spec
11 must land before the tabs are deleted.**

## Open items

- **`category` and `size` are very close to dead.** Nothing outside the
  atomic-updates tab reads `category`; `size` is only ever written, by
  `regenerate-atomic-summary`. Neither reaches a prompt or composition. They are
  carried forward here because the decision was to keep every action, but they are
  the first thing to delete if the Company sections feel heavy in use.
- Retiring `/drafts` in favour of the board, still open from spec 7.
- The reconciler lag on drawer edits could be closed by having the drawer's edit
  action call `syncShippedWorkSignals` for the one update it touched. Deferred
  because it needs a narrower entry point than the current tenant-wide sweep.
