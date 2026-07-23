# PR follow-ups: Import on Change events + create atomic update from selected events

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two changes on the open `feat/atomic-updates` PR: (1) move commit import onto a `/change-events` tab positioned first in the nav, framed generically for future PR/task sources; (2) add a "New atomic update" modal on `/atomic-updates` that creates one atomic update from a user-selected set of change events.

**Architecture:** Creating an atomic update from a set of events is a batched sibling of phase-3's `reassignChangeEvent` — it reuses the same guards (open-only, released frozen, tenant-scoped, deterministic `updatedAt` bump, best-effort summary regen) and the same empty-source **confirmation gate**, extended to multiple source atomic updates at once. The import move is mechanical relocation + generalized naming + a nav reorder.

**Tech Stack:** Next.js 16 (App Router), Drizzle ORM + Postgres, Vercel AI SDK v7 with `@ai-sdk/anthropic`, Vitest.

## Decisions baked into this plan

| Decision | Choice | Why |
| --- | --- | --- |
| Import location | Moves from `/atomic-updates` to `/change-events` | Import produces raw change events; that's the change-events surface. |
| Import naming | Generalized to "Import" (commits are the first source) | The owner intends PR + Notion-task import later; the label/dialog shouldn't say "commits". |
| Nav order | `Change events` first, then Atomic updates, Drafts, History, Integrations | Owner's request. |
| Create-modal selectable set | Unassigned events AND events currently in an OPEN atomic update; released-AU events excluded | Owner chose "any event in an open atomic update too" — selecting one moves it. |
| Emptying a source AU | Same confirmation gate as reassign, batched — lists ALL atomic updates that would be emptied+deleted, deletes only on confirm | Consistent with phase-3; a draft's body still describes an emptied in-draft AU. |
| New AU title/summary | Seeded from the first event, then best-effort regenerated from the combined evidence; editable on the card | Reuses `seedFromEvent` + `refreshAtomicUpdates`; no extra modal field. |
| Released events in a create selection | Reject the whole operation, naming the frozen atomic update | All-or-nothing is clearer than silently dropping some selected events. |
| Schema | No change | Reuses `changeEvents.atomicUpdateId` / `status`, `atomicUpdates`. |

## Global Constraints

- **This version of Next.js differs from training data.** Per `AGENTS.md`, read the relevant guide under `node_modules/next/dist/docs/` before any Server Component / Server Action / route-handler / `revalidatePath` code.
- **No client component may import `db`/`pg`** (the phase-2a boundary lesson) — pages pass data as props.
- **Model resolution goes through `src/lib/ai/model.ts`**; the create core reuses `refreshAtomicUpdates` (`src/lib/ai/regenerate-atomic-summary.ts`) unchanged for its best-effort regen.
- **No test may reach the live Anthropic API** (a live key is present) — inject/mock `refresh` in the core tests; mock the core in the action tests.
- **Tenant scoping is per-query.** The create core and its action derive tenant/user from the session (`requireSession`), never from client input, and re-validate ownership of every event and atomic update.
- **The lifecycle invariant holds:** an atomic update is `open` until its release publishes. The create core operates only among `open` atomic updates; a selected event currently in a `released` atomic update freezes the operation.
- **The test DB is a Docker Postgres (`product-announcer-postgres`) on `:5434`.** If DB tests fail en masse with `ECONNREFUSED :5434`, Docker is down — `open -a Docker`, `docker start product-announcer-postgres`, `npm run db:migrate:test`. Never run two full DB-backed vitest suites concurrently (they clean up by tenant name and trample each other).
- The dashboard pages are OAuth-gated with no dev bypass — do NOT build a bypass; verify via build/route-table/tests and state what's unverified (interactive rendering).
- Keep `npm run typecheck && npm run lint && npx vitest run && npm run build` green at the end of every task.

---

### Task 1: Move import to `/change-events`; generalize naming; reorder nav

**Files:**
- `git mv src/app/(dashboard)/atomic-updates/import-commits-dialog.tsx src/app/(dashboard)/change-events/import-dialog.tsx`
- `git mv src/app/(dashboard)/atomic-updates/import-actions.ts src/app/(dashboard)/change-events/import-actions.ts`
- Move: `listImportRepos` + `type ImportRepo` from `atomic-updates/actions.ts` → `change-events/actions.ts`
- Modify: `src/app/(dashboard)/change-events/page.tsx` (render the import dialog in the header)
- Modify: `src/app/(dashboard)/atomic-updates/page.tsx`, `atomic-updates-list.tsx` (remove the import dialog)
- Modify: `src/app/(dashboard)/nav-links.tsx` (Change events first)
- Tests: move/update any test importing the relocated modules

**Interfaces:**
- Produces: no new exports; the import surface now lives under `change-events/`
- Changes: the dialog is renamed `ImportDialog` and its user-facing copy is generalized (see below)

**Context:** Mechanical relocation. Read `atomic-updates-list.tsx` (renders `<ImportCommitsDialog repos={repos} />` alongside `<DraftReleaseDialog>`), `atomic-updates/page.tsx`, and `change-events/page.tsx` first. `listImportableCommits`/`importCommits` (commit-specific) stay as-is — only their location and the user-facing framing change. The underlying `importSelectedCommits` lib is unchanged.

- [ ] **Step 1: Relocate the files**

`git mv` the dialog and the import actions into `change-events/`. Move `listImportRepos` and `type ImportRepo` out of `atomic-updates/actions.ts` into `change-events/actions.ts` (keep them exported). Fix all imports: `import-dialog.tsx` imports from `./import-actions`; anything that imported `ImportRepo`/`listImportRepos`/`ImportCommitsDialog` from the atomic-updates paths now imports from the change-events paths. `npm run typecheck` after this step should surface every stale import.

- [ ] **Step 2: Generalize the naming**

In `import-dialog.tsx`: rename the exported component `ImportCommitsDialog` → `ImportDialog`. Change the user-facing trigger label and dialog title from "Import commits" (or similar) to **"Import"**, and add a short subtitle/comment noting commits are the first source and PRs / Notion tasks will follow. Keep the internal commit-listing UI as-is. Do NOT rename `listImportableCommits`/`importCommits`/`ImportableCommit`/`CommitSelection` — those stay commit-specific until real PR/task import exists; add a one-line comment at the top of `import-actions.ts` stating the file currently handles commit import and is the seam for future sources.

- [ ] **Step 3: Re-home the dialog in the UI**

Remove `<ImportCommitsDialog>` and its `repos`/`listImportRepos` plumbing from `atomic-updates/page.tsx` and `atomic-updates-list.tsx` (leave the Draft-release selection UI intact). In `change-events/page.tsx`, call `listImportRepos()` server-side and render `<ImportDialog repos={importRepos} />` in the page header (next to the filters). The change-events page is a Server Component — pass `repos` as a prop; `import-dialog.tsx` stays a client component with no `db` import.

- [ ] **Step 4: Reorder the nav**

In `nav-links.tsx`, move `{ href: "/change-events", label: "Change events" }` to the FIRST position: `Change events`, `Atomic updates`, `Drafts`, `History`, `Integrations`.

- [ ] **Step 5: Verify + commit**

`npm run typecheck && npm run lint && npx vitest run && npm run build`. Confirm the route table still has `/change-events` and `/atomic-updates`, `grep -rn "ImportCommitsDialog\|import-commits-dialog" src/` is empty, and no `/atomic-updates` code still imports the moved modules.

```bash
git add -A && git commit -m "feat: move import to the change-events tab and put it first in the nav"
```

---

### Task 2: `createAtomicUpdateFromEvents` core (batched)

**Files:**
- Create: `src/lib/change-events/create-from-events.ts`
- Modify: `src/lib/change-events/reassign.ts` (export `seedFromEvent` for reuse) OR extract it to a shared module both import — pick the smaller diff; do NOT duplicate the logic
- Test: `tests/lib/change-events/create-from-events.test.ts`

**Interfaces:**
- Produces:
  - `type CreateFromEventsInput = { tenantId: string; userId: string; eventIds: string[]; confirmEmptyDeletion?: boolean }`
  - `type CreateFromEventsResult = { ok: true; atomicUpdateId: string; deletedAtomicUpdates?: { id; title }[] } | { ok: false; reason: string } | { ok: false; reason: "needs_confirmation"; needsConfirmation: true; emptiedAtomicUpdates: { id; title; inDraft }[] }`
  - `createAtomicUpdateFromEvents(input, deps?): Promise<CreateFromEventsResult>`

**Context:** A batched `reassignChangeEvent` with `target.kind = "new"` semantics over many events, creating ONE new open atomic update. Read `reassign.ts` fully first (it's the template — same `now` bump, same `refresh` best-effort, same confirmation gate, same `Executor`/`Tx` types) and `regenerate-atomic-summary.ts` (`refreshAtomicUpdates`). All mutation is one transaction; validation short-circuits before any write.

Algorithm (inside one transaction, `const now`):
1. Load the selected events, tenant-scoped (`inArray(id, eventIds) AND tenantId`). If fewer rows come back than `eventIds` (some foreign/nonexistent) → `{ ok:false, reason }`, no mutation. Empty input → `{ ok:false, reason }`.
2. Load the distinct source atomic updates of those events (tenant-scoped). **If ANY selected event's current atomic update is `released` → `{ ok:false, reason }`** naming it (frozen; all-or-nothing).
3. Determine which source **open** atomic updates would be EMPTIED: for each such source AU, count its change events NOT in `eventIds`; zero remaining ⇒ it will be emptied. If any would be emptied AND `confirmEmptyDeletion` is not `true` → `{ ok:false, reason:"needs_confirmation", needsConfirmation:true, emptiedAtomicUpdates:[{id,title,inDraft: releaseId!==null}, …] }`, no mutation.
4. Otherwise: insert one new `open` atomic update seeded from the FIRST selected event (`seedFromEvent`), `updatedAt: now`. Set every selected event's `atomicUpdateId` = the new id, `status='pending'`, clear `excludedAt`/`excludedBy` (tenant-scoped update over `inArray(id, eventIds)`).
5. For each distinct source open AU (excluding the new one): if it now has zero events, delete it (tenant + `status='open'` guard) and record it in `deletedAtomicUpdates`; else bump its `updatedAt = now` and add it to the affected set. Reuse `cleanupOrTouch` from `reassign.ts` if you export it, or mirror it.
6. Commit. Then best-effort `refresh(database, tenantId, [newId, ...survivingSourceIds])` in a try/catch (a regen failure is logged, never fails the create). Return `{ ok:true, atomicUpdateId: newId, deletedAtomicUpdates }`.

- [ ] **Step 1: Write failing tests** (DB-backed, `refresh` stubbed with `vi.fn()`):
  - create from 2 UNASSIGNED events → one new open AU, both events linked to it; `refresh` called with the new id.
  - create from events spanning two OPEN source AUs where one source is fully emptied → unconfirmed returns `needsConfirmation` listing the emptied AU, and performs NO mutation (events unmoved, AUs intact); the SAME call with `confirmEmptyDeletion:true` creates the new AU, moves the events, and deletes the emptied source (in `deletedAtomicUpdates`); a source that keeps some events is NOT deleted and IS refreshed.
  - a selected event in a `released` AU → `{ok:false}`, whole op, no mutation.
  - cross-tenant: an event id from another tenant → `{ok:false}`, no mutation.
  - deterministic bump: the new AU's `updatedAt` is set (assert it's non-null / recent) so an in-draft membership/evidence signal is coherent; and a surviving in-draft source AU's `updatedAt` is bumped.
  - `inDraft` true when an emptied source AU has a `releaseId`, false otherwise.
- [ ] **Step 2: Run — fail** (module absent).
- [ ] **Step 3: Implement `create-from-events.ts`** (+ export/extract `seedFromEvent` / `cleanupOrTouch` from `reassign.ts` for reuse — smallest diff).
- [ ] **Step 4: Verify** — `npx vitest run tests/lib/change-events/create-from-events.test.ts tests/lib/change-events/reassign.test.ts && npm run typecheck` (run the reassign tests too, since you touched that file's exports).
- [ ] **Step 5: Commit** — `git commit -m "feat: create an atomic update from a set of change events"`.

---

### Task 3: The "New atomic update" modal on `/atomic-updates`

**Files:**
- Modify: `src/app/(dashboard)/atomic-updates/actions.ts` (add a selectable-events query + the `createFromEvents` action)
- Create: `src/app/(dashboard)/atomic-updates/new-atomic-update-dialog.tsx` (client)
- Modify: `src/app/(dashboard)/atomic-updates/page.tsx`, `atomic-updates-list.tsx` (render the button/modal)
- Test: `tests/app/atomic-updates-actions.test.ts` (extend for the action)

**Interfaces:**
- Consumes: `createAtomicUpdateFromEvents` (Task 2)
- Produces:
  - `listSelectableEvents(): Promise<SelectableEventRow[]>` — events selectable for a new atomic update: `atomicUpdateId IS NULL` OR the event's atomic update is `status='open'` (released excluded); each row carries `{ id, type, provider, title, externalUrl, atomicUpdateId, atomicUpdateTitle | null }`
  - `createFromEvents(formData)` server action — reads `eventIds[]` + `confirmEmptyDeletion`; tenant/user from session; calls the core; `revalidatePath("/atomic-updates")`; returns the result

**Context:** **Read `node_modules/next/dist/docs/` for Server Components / Server Actions / `revalidatePath` / `useTransition` first.** The selectable-events query is close to phase-3's `listChangeEvents` but its selection axis is "unassigned OR in an open AU" (not the hidden-by-default list) — a dedicated query is clearer than overloading the filters. Model the row shape and the tenant-scoped left-join on `listChangeEvents` (`change-events/actions.ts`). A "show hidden" affordance can reuse the same hidden predicate to surface classifier rejects for rescue; keep it a simple toggle.

- [ ] **Step 1: Failing action test** — `createFromEvents` calls `createAtomicUpdateFromEvents` with the session `tenantId`/`userId` and the parsed `eventIds`/`confirmEmptyDeletion` (assert session wins over any formData-supplied tenant/user); returns `{ok:false}`/`needsConfirmation` without throwing; revalidates. Mock the core; no live API.
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Implement `listSelectableEvents` + `createFromEvents`** (tenant-scoped; the action derives ids from session, parses `eventIds` as a repeated formData field, `confirmEmptyDeletion` as a boolean).
- [ ] **Step 4: Build the modal + wire the page**

`new-atomic-update-dialog.tsx` (client): receives `events: SelectableEventRow[]` as a prop, multi-select (checkbox list showing type/provider, title linked to `externalUrl` with `rel="noopener noreferrer"`, and the current atomic update or "Unassigned"), a "Create atomic update" button posting the selected ids to `createFromEvents` with a `useTransition` pending state, and — on a `needsConfirmation` result — a confirm dialog that NAMES the atomic updates that will be emptied+deleted (from `emptiedAtomicUpdates`, flagging in-draft ones) and re-posts with `confirmEmptyDeletion=true`. Toast on `{ok:false}` and on success (with the count deleted, if any). Reuse the `Dialog` + toast patterns from `change-events/reassign-control.tsx` and `drafts/[releaseId]/catch-up-banner.tsx`. No `db` import in the client.

In `atomic-updates/page.tsx`: call `listSelectableEvents()` server-side and pass its rows to the list/header; render a "New atomic update" button that opens the dialog. Place it near the existing "Draft release" affordance in `atomic-updates-list.tsx`.

- [ ] **Step 5: Verify** — `npm run typecheck && npm run lint && npx vitest run && npm run build`; route table unaffected; state that interactive rendering is unverified (OAuth-gated).
- [ ] **Step 6: Commit** — `git commit -m "feat: create an atomic update from selected change events on the atomic-updates page"`.

---

## Verification

- [ ] `npm run typecheck && npm run lint && npx vitest run && npm run build` all clean.
- [ ] Import lives on `/change-events`, labelled generically; `/change-events` is the first nav item; `/atomic-updates` no longer renders the import dialog.
- [ ] "New atomic update" on `/atomic-updates` creates one open atomic update from selected events; events pulled from other open atomic updates are moved; a fully-emptied source atomic update is deleted only after the confirmation dialog names it.
- [ ] Selecting an event in a published (released) atomic update is rejected with a clear reason; nothing is mutated.
- [ ] The new atomic update's `updatedAt` is set, and a surviving in-draft source atomic update's `updatedAt` is bumped, so catch-up stays coherent.
- [ ] No cross-tenant create/import is possible; the action derives tenant/user from session only.

## Out of scope

- Real PR / Notion-task import (only the naming/seam is generalized; the implementation stays commit-only).
- Bulk operations beyond a single create per modal submit.
- Choosing the new atomic update's title in the modal (auto-seeded + regenerated; editable on the card).
