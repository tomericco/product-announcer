# Atomic Updates — Phase 3 (Change-events list + manual reassignment) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/change-events` page listing every change event, filterable, where the user manually overrides the resolver — reassigning an event to a different open atomic update, detaching it, splitting it into a new atomic update, or rescuing an event the classifier wrongly dropped.

**Architecture:** Reassignment is the manual override on the resolver's clustering. It operates only among **open** atomic updates — published (`released`) ones are frozen, since moving an event in or out of them would rewrite a shipped announcement's evidence. Detaching an event marks it `status='excluded'` (reusing the existing exclude infrastructure) so the orphaned-event sweep won't silently re-attach it. Moving an event bumps the affected open atomic updates' summaries (respecting the hand-edit freeze) and their `updatedAt`, so an in-draft release's catch-up banner reflects the change. No schema change — this phase reuses `changeEvents.atomicUpdateId` / `status` / `excludedAt` / `excludedBy`.

**Tech Stack:** Next.js 16 (App Router), Drizzle ORM + Postgres, Vercel AI SDK v7 with `@ai-sdk/anthropic`, Vitest.

## Decisions baked into this plan

| Decision | Choice | Why |
| --- | --- | --- |
| Reassign scope | Among OPEN atomic updates only; released frozen | Moving events in/out of a published AU rewrites a shipped announcement's evidence. |
| Moves supported | Move-to-existing-open, detach, split-to-new | Full curation power within the open set. |
| Reassign target set | ALL open atomic updates (incl. in-draft, any `releaseId`) | Moving an event into an open in-draft AU is allowed; its release's catch-up surfaces it. Same shape as `loadOpenAtomicUpdates`. |
| Rescue (dropped events) | Manual assign IS the override — no re-classify | Spec: "manual override on the resolver." The user overrules the classifier deterministically. |
| Detach semantics | `atomicUpdateId=null`, `status='excluded'` | Prevents the resolve-sweep (which requires `status='pending'`) from re-attaching a deliberately-detached event. |
| Empty source AU | Deleted when the last event leaves an OPEN AU | An atomic update with no evidence is meaningless. |
| Summary on reassign | Regenerate affected OPEN AUs (best-effort, respects `summaryEditedAt`) | Keeps summaries honest; bumps `updatedAt` so in-draft catch-up fires. A regen failure must not fail the reassign. |
| Split-to-new title/summary | Seed from the event's `impactSummary`/title, then refresh | No extra LLM call at creation; `refreshAtomicUpdates` regenerates it from evidence. |
| Schema | No change | Reuses existing columns. |

## Global Constraints

- **This version of Next.js differs from training data.** Per `AGENTS.md`, read the relevant guide under `node_modules/next/dist/docs/` before any Server Component / Server Action / route-handler / `revalidatePath` code.
- **Model resolution goes through `src/lib/ai/model.ts`**; every LLM call records usage via `recordLlmUsage`. Reassignment's summary regen reuses `refreshAtomicUpdates` (`src/lib/ai/regenerate-atomic-summary.ts`) unchanged.
- **No test may reach the live Anthropic API** (a live key is present) — inject/mock `refreshAtomicUpdates` in the reassignment tests.
- **Tenant scoping is per-query** — every event, atomic update, and reassignment target must be tenant-checked. Reassignment takes user-supplied ids; the event, the source AU, and the target AU must all belong to the session tenant.
- **The lifecycle invariant from phase 2b holds:** an atomic update is `open` until its release publishes. Reassignment must reject any move whose source OR target atomic update is not `open`.
- **A client component must not import `db`/`pg`** (the phase-2a boundary lesson) — the page computes data server-side and passes it as props.
- Keep `npm run typecheck && npm run lint && npx vitest run && npm run build` green at the end of every task.
- The `/change-events` page sits behind GitHub OAuth with no dev bypass — do NOT build a bypass; verify via build/route-table/tests and state what's unverified.

---

### Task 1: Reassignment core (`reassignChangeEvent`)

**Files:**
- Create: `src/lib/change-events/reassign.ts`
- Test: `tests/lib/change-events/reassign.test.ts`

**Interfaces:**
- Produces:
  - `type ReassignTarget = { kind: "existing"; atomicUpdateId: string } | { kind: "detach" } | { kind: "new" }`
  - `reassignChangeEvent(input: { tenantId: string; userId: string; eventId: string; target: ReassignTarget }, deps?: { database?; refresh? }): Promise<{ ok: true } | { ok: false; reason: string }>`
  - `openAtomicUpdatesForReassign(tenantId, database?): Promise<AtomicUpdateRow[]>` — all `status='open'` AUs for the tenant (any `releaseId`), the valid reassign targets

**Context:** The correctness core. All mutation is transactional and tenant-scoped. Validation rejects a move whose source or target AU is not `open` (returns `{ ok: false, reason }`, does not throw — the UI surfaces the reason). After a successful move, regenerate the affected open AUs' summaries **best-effort** via the injected `refresh` (default `refreshAtomicUpdates`), so a regen error is logged and swallowed, never failing the reassign.

Read `src/lib/change-events/release-claim.ts` (transaction + `Executor` style, exclusivity guards), `apply-resolution.ts` (`loadOpenAtomicUpdates` shape, tenant EXISTS guard), and `regenerate-atomic-summary.ts` (`refreshAtomicUpdates`) first.

Behavior per target kind (all after validating the event belongs to the tenant, and loading its current `atomicUpdateId` = the source AU):

- **Validate source:** if the event currently belongs to an AU, that AU must be `status='open'`. If it's `released`, return `{ ok: false, reason: "..." }` — you can't move an event out of a published atomic update.
- **`existing`:** the target AU must belong to the tenant and be `status='open'` (any `releaseId`). Set `changeEvents.atomicUpdateId = target`, `status='pending'` (a normal assigned state — clears any prior `excluded`), and clear `excludedAt`/`excludedBy`.
- **`detach`:** set `atomicUpdateId=null`, `status='excluded'`, `excludedAt=now`, `excludedBy=userId`. (The sweep requires `status='pending'`, so this stays put.)
- **`new`:** insert a new `open` atomic update owned by the tenant, seeded from the event (`title` from `prTitle`/first line of `commitMessage`; `summary` from `impactSummary` ?? that title; `category` from `suggestedCategory`); set the event's `atomicUpdateId` to it, `status='pending'`.
- **Empty-source cleanup:** after the move, if the source AU exists, is `open`, and now has zero change events, delete it.
- **Regen (best-effort, after the transaction commits):** collect the affected still-existing open AU ids (the target for existing/new; the source if it survived) and call `refresh(database, tenantId, ids)`. Wrap so a failure is logged, not thrown.

- [ ] **Step 1: Write failing tests** (`reassign.test.ts`, DB-backed, `refresh` stubbed with `vi.fn()`):
  - `existing`: event moves to the target open AU; its `atomicUpdateId` updates; `refresh` called with the target (and surviving source) id.
  - moving the last event out of an open source AU deletes that AU.
  - `detach`: event ends `atomicUpdateId=null`, `status='excluded'`, `excludedBy=userId`.
  - `new`: a new open AU is created seeded from the event, event linked to it.
  - **rescue:** a `status='ignored'` (deterministically filtered) or `userFacing=false` event can be assigned to an open AU via `existing`/`new` (the override) — assert it lands `atomicUpdateId=target`, `status='pending'`.
  - **released source frozen:** an event whose AU is `status='released'` returns `{ ok:false }` and does NOT move.
  - **released target frozen:** `existing` targeting a `released` AU returns `{ ok:false }`.
  - **cross-tenant:** an event / target AU of another tenant returns `{ ok:false }` and mutates nothing.
  - `openAtomicUpdatesForReassign` returns all open AUs (including one with a `releaseId` set) and excludes released ones.
- [ ] **Step 2: Run — fail** (module absent).
- [ ] **Step 3: Implement `reassign.ts`.**
- [ ] **Step 4: Verify** — `npx vitest run tests/lib/change-events/reassign.test.ts && npm run typecheck`.
- [ ] **Step 5: Commit** — `git commit -m "feat: manual reassignment of change events among open atomic updates"`.

---

### Task 2: The change-events list query

**Files:**
- Create: `src/app/(dashboard)/change-events/actions.ts` (or `list-change-events.ts` in lib if you prefer separation — match the codebase's colocated-actions convention)
- Test: `tests/app/change-events-actions.test.ts`

**Interfaces:**
- Produces:
  - `type ChangeEventRow = { id; type; provider; title; externalUrl; createdAt; atomicUpdateId; atomicUpdateTitle: string | null; status; filterReason; userFacing }`
  - `type ChangeEventFilters = { type?; provider?; assignment?: "assigned" | "unassigned"; showHidden?: boolean }`
  - `listChangeEvents(filters: ChangeEventFilters): Promise<ChangeEventRow[]>` (tenant from session)

**Context:** All change events for the tenant, joined to their atomic update (for `atomicUpdateTitle`). **Hidden by default:** events that are non-user-facing (`userFacing=false`) OR deterministically filtered (`filterReason IS NOT NULL`) OR `status='excluded'`, AND currently unassigned (`atomicUpdateId IS NULL`), are excluded unless `showHidden` is true. An assigned event always shows (it's live evidence regardless of how it was originally classified). `title` derives from `prTitle` ?? first line of `commitMessage`. Order newest first (`createdAt desc`, `id` tie-break). Reuse the `requireSession` tenant pattern from `atomic-updates/actions.ts`.

- [ ] **Step 1: Failing test** — seed events across the axes and assert:
  - an assigned event shows regardless of `userFacing`/`filterReason`.
  - an unassigned `filterReason`-set event is hidden by default, shown with `showHidden`.
  - an unassigned `userFacing=false` event is hidden by default, shown with `showHidden`.
  - a `type`/`provider` filter narrows correctly.
  - `assignment: "unassigned"` returns only `atomicUpdateId IS NULL`.
  - `atomicUpdateTitle` is populated for an assigned event, null otherwise.
  - another tenant's events never appear.
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Implement `listChangeEvents`** (tenant-scoped left join to `atomicUpdates`).
- [ ] **Step 4: Verify + commit** — `git commit -m "feat: list change events with filters"`.

---

### Task 3: The `/change-events` page, reassignment UI, and server actions

**Files:**
- Create: `src/app/(dashboard)/change-events/page.tsx`, `change-event-row.tsx` (client), `reassign-control.tsx` (client), and the reassign server action (in `change-events/actions.ts`)
- Modify: `src/app/(dashboard)/nav-links.tsx` (add "Change events")
- Test: extend `tests/app/change-events-actions.test.ts` for the reassign action

**Interfaces:**
- Consumes: `reassignChangeEvent`, `openAtomicUpdatesForReassign` (Task 1); `listChangeEvents` (Task 2)
- Produces: `reassign(formData)` server action (reads `eventId` + a target descriptor; tenant-checked; calls `reassignChangeEvent`; `revalidatePath("/change-events")`)

**Context:** **Read `node_modules/next/dist/docs/` for Server Components / Server Actions / `revalidatePath` first.** The page is an async Server Component: it calls `listChangeEvents` (with filters from search params) and `openAtomicUpdatesForReassign` server-side, and passes the events + the open-AU target list into client rows as PROPS (no `db` in any client component). Each row shows the event's type/provider icon, title (linked to `externalUrl`), its current atomic update (or "Unassigned" / "Excluded"), and a reassign control — a menu offering: assign to / move to an existing open AU (from the passed-in list), detach, or split to new. Hidden events surface under a "Show hidden" toggle (a filter, driven by a search param) with a clear "rescue" affordance (assign to an AU) since these are the classifier's rejects.

- [ ] **Step 1: Failing reassign-action test** — `reassign` calls `reassignChangeEvent` for an owned event with the parsed target and revalidates; refuses (or surfaces `{ok:false}` for) a foreign event; a `{ok:false}` from the core (e.g. released-frozen) is surfaced, not thrown. Mock `reassignChangeEvent`; no live API.
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Implement the `reassign` action** (tenant-checked; parse the target kind from formData; return/surface the `{ok,reason}` result). Verify the test.
- [ ] **Step 4: Build the page + client rows + reassign control.** Filters (type/provider/assignment/showHidden) via search params. Read `atomic-updates/page.tsx` + `atomic-update-card.tsx` for the styling/prop conventions and reuse `src/components/ui`. The reassign control is a client component receiving the open-AU list as a prop and posting to the `reassign` action with a pending state; put "Split to new" and "Detach" alongside the AU list. Show a toast on `{ok:false}` (e.g. "Can't move an event out of a published update").
- [ ] **Step 5: Add the nav link** — "Change events" in `nav-links.tsx`, placed after "Atomic updates".
- [ ] **Step 6: Verify** — `npm run typecheck && npm run lint && npx vitest run && npm run build`; route table includes `/change-events`. State that interactive rendering is unverified (OAuth-gated).
- [ ] **Step 7: Commit** — `git commit -m "feat: change-events page with manual reassignment"`.

---

## Verification

- [ ] `npm run typecheck && npm run lint && npx vitest run && npm run build` all clean.
- [ ] The list shows all events; non-user-facing / filtered / excluded UNassigned events are hidden until "Show hidden"; assigned events always show.
- [ ] Reassigning an event to a different open atomic update moves it and (best-effort) regenerates both AUs' summaries; if the source AU is emptied, it's deleted.
- [ ] Detaching marks the event `excluded` so the next cron sweep does NOT re-attach it.
- [ ] Splitting creates a new open atomic update seeded from the event.
- [ ] Rescuing a filtered / non-user-facing event by assigning it to an atomic update works and does not re-run the classifier.
- [ ] An event whose atomic update is `released` cannot be moved (in or out) — the action surfaces a clear reason.
- [ ] Reassigning into an open in-draft atomic update bumps its `updatedAt`, so that release's catch-up banner reflects the new evidence.
- [ ] No cross-tenant reassignment is possible.

## Out of scope

- Notion / task sources (separate spec).
- Bulk reassignment (multi-select) — single-event moves only this phase.
- Editing a change event's raw content (title/diff) — reassignment only.
- Re-running the classifier on demand — rescue is manual assignment by design.
