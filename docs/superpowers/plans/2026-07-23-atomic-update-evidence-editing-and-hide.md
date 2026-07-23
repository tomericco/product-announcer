# Atomic updates: edit evidence (regenerating) + mark non-user-facing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two additions to the atomic-updates page. (1) While editing an atomic update, add/remove the change events it's based on; each change force-regenerates its title/summary from the new evidence. (2) Mark an atomic update non-user-facing ("hidden") to remove it from the pipeline, reversibly.

**Architecture:** Adding/removing evidence reuses phase-3's `reassignChangeEvent` (move = reassign to this update; remove = detach), extended with a `forceRegenerate` option that clears the hand-edit freeze so the summary always tracks the evidence. Hiding uses a new `hidden` value on the `atomic_update_status` enum — every candidate/list/resolver query already filters `status = 'open'`, so a hidden update is automatically excluded from all of them (list, compose, reassign targets, resolver), making it fully out of the pipeline; a follow-up commit therefore spins up a new visible update.

**Tech Stack:** Next.js 16 (App Router), Drizzle ORM + Postgres, Vercel AI SDK v7 with `@ai-sdk/anthropic`, Vitest.

## Decisions baked into this plan

| Decision | Choice | Why |
| --- | --- | --- |
| Regenerate vs hand-edit | Add/remove evidence ALWAYS regenerates title+summary, overwriting a prior hand-edit and clearing the freeze | Owner: "each change triggers generation to update its contents." |
| Hidden semantics | `hidden` status = fully out of the pipeline (resolver, list, compose, reassign all skip it) | Owner: a follow-up commit should spin up a new visible update, not re-group into the hidden one. |
| Hidden model | A `hidden` value on `atomicUpdateStatusEnum` (not a boolean) | Every candidate query already filters `status='open'`, so `hidden` is auto-excluded with no per-query change. |
| Add-evidence source | Unassigned events + events in OTHER open updates (moving them); released excluded; events already in this update excluded | Consistent with the "New atomic update" modal. |
| Remove evidence | Detach (event → unassigned/`excluded`); removing the LAST event confirms deleting the now-empty update | Reuses phase-3 detach + the empty-source confirmation. |
| Hide scope | Only an OPEN, unlinked (`releaseId IS NULL`) update can be hidden | The list only shows those; hiding never desyncs a draft. |
| Reversible | A "Show hidden" toggle lists hidden updates with "Un-hide" (`hidden`→`open`) | Non-destructive. |
| Schema | One migration adding the `hidden` enum value | Nothing else. |

## Global Constraints

- **This version of Next.js differs from training data.** Per `AGENTS.md`, read the relevant guide under `node_modules/next/dist/docs/` before any Server Component / Server Action / `revalidatePath` / client-component code.
- **The database has no production data**; migrations continue from the latest. `drizzle-kit generate` may prompt — the agent has no TTY: STOP and report NEEDS_CONTEXT so the controller drives it under a pseudo-terminal. **Enum-add note:** `ALTER TYPE ... ADD VALUE` is fine on this Postgres 16, but do NOT reference the new `hidden` value in the same migration.
- **Model resolution goes through `src/lib/ai/model.ts`**; regeneration reuses `refreshAtomicUpdates`. **No test may reach the live Anthropic API** (live key) — inject/mock `refresh`/the core.
- **Tenant scoping is per-query.** Every action derives tenant/user from `requireSession` (never formData) and re-validates ownership.
- **No client component imports `db`/`pg`** — pages pass data as props.
- **The lifecycle invariant holds:** an update is `open` until its release publishes. Hiding applies only to open, unlinked updates.
- **The test DB is Docker postgres `product-announcer-postgres` on `:5434`.** If DB tests fail en masse with `ECONNREFUSED :5434`, Docker is down — `open -a Docker`, `docker start product-announcer-postgres`, `npm run db:migrate:test`. Never run two full DB-backed vitest suites at once.
- The dashboard pages are OAuth-gated with no dev bypass — do NOT build one; verify via build/route-table/tests, state what's unverified.
- Keep `npm run typecheck && npm run lint && npx vitest run && npm run build` green at the end of every task.

---

### Task 1: `hidden` status — hide / un-hide / list-hidden

**Files:**
- Modify: `src/db/schema.ts` (add `hidden` to `atomicUpdateStatusEnum`), migration
- Modify: `src/app/(dashboard)/atomic-updates/actions.ts` (add the three functions)
- Test: `tests/app/atomic-updates-actions.test.ts` (extend); a resolver-exclusion test

**Interfaces:**
- Produces:
  - `markAtomicUpdateHidden(id: string): Promise<{ ok: boolean }>` — sets an OPEN, unlinked update to `hidden` (tenant-scoped WHERE `status='open' AND releaseId IS NULL`)
  - `unhideAtomicUpdate(id: string): Promise<{ ok: boolean }>` — sets a `hidden` update back to `open`
  - `listHiddenAtomicUpdates(): Promise<AtomicUpdateRow[]>` — the tenant's `status='hidden'` updates, with their events (mirror `listAtomicUpdates`'s shape + event join)

**Context:** The key property is that **no existing query needs changing** — all 12 `atomicUpdates.status='open'` filters (verified: `apply-resolution.ts:48,137`, `reassign.ts:68,308`, `release-claim.ts:25,93`, `catch-up.ts:66`, `release-deltas.ts:42`, `regenerate-atomic-summary.ts:77,118`, `atomic-updates/actions.ts:49,172`) already exclude anything not `open`, so a `hidden` update falls out of the list, compose set, reassign targets, resolver candidate set, and refresh automatically. This task adds the flag and the three actions, and proves the exclusion with a test.

- [ ] **Step 1: Write failing tests**
  - schema/action: `markAtomicUpdateHidden` flips an open, unlinked update to `hidden`; it refuses (no-op) an update that is `released` or has a `releaseId` (assert `{ok:false}` / unchanged).
  - `unhideAtomicUpdate` flips a `hidden` update back to `open`.
  - `listAtomicUpdates` does NOT return a hidden update; `listHiddenAtomicUpdates` returns only hidden ones (with events), tenant-scoped (no cross-tenant leak).
  - **resolver exclusion:** a hidden update is not in `loadOpenAtomicUpdates(tenantId)` (import it in the test) — proving a follow-up commit can't attach to it.
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Add `hidden` to the enum + migrate.** `atomicUpdateStatusEnum = pgEnum("atomic_update_status", ["open", "released", "hidden"])`. `npm run db:generate` (HUMAN-RUN if it prompts) → migration adds the value; confirm it does NOT use the value elsewhere. `npm run db:migrate && npm run db:migrate:test`.
- [ ] **Step 4: Implement the three actions** in `atomic-updates/actions.ts` (tenant-scoped; `markAtomicUpdateHidden` WHERE `id AND tenantId AND status='open' AND releaseId IS NULL`, `.returning()` to report ok; `unhideAtomicUpdate` WHERE `id AND tenantId AND status='hidden'`; `listHiddenAtomicUpdates` mirrors `listAtomicUpdates` but `status='hidden'`). `revalidatePath("/atomic-updates")` on the mutations.
- [ ] **Step 5: Verify + commit** — full green; `git commit -m "feat: mark atomic updates non-user-facing (hidden), reversibly"`.

---

### Task 2: Force-regenerating evidence add/remove

**Files:**
- Modify: `src/lib/change-events/reassign.ts` (add `forceRegenerate` option)
- Modify: `src/app/(dashboard)/atomic-updates/actions.ts` (add the two actions)
- Test: `tests/lib/change-events/reassign.test.ts` (extend), `tests/app/atomic-updates-actions.test.ts` (extend)

**Interfaces:**
- Produces (extends reassign):
  - `ReassignInput` gains `forceRegenerate?: boolean` — when true, the affected still-open atomic updates have their `summaryEditedAt` cleared before the best-effort refresh runs, so a hand-edited update regenerates from the new evidence (overriding the freeze).
  - `addEventToAtomicUpdate(atomicUpdateId: string, eventId: string, confirmEmptyDeletion?: boolean)` — server action; moves the event into this update via `reassignChangeEvent({ target: { kind: "existing", atomicUpdateId } }, forceRegenerate)`.
  - `removeEventFromAtomicUpdate(atomicUpdateId: string, eventId: string, confirmEmptyDeletion?: boolean)` — server action; detaches the event via `reassignChangeEvent({ target: { kind: "detach" } }, forceRegenerate)`; a remove that empties this update returns `needsConfirmation` (then deletes on confirm).

**Context:** Read `reassign.ts` fully. The move mechanics, released-frozen guard, empty-source confirmation, deterministic `updatedAt` bump, and best-effort refresh already exist. The only new behavior is `forceRegenerate`: inside `reassignChangeEvent`, when `forceRegenerate` is set, before calling `refresh(database, tenantId, affectedIds)`, run `UPDATE atomicUpdates SET summaryEditedAt = NULL WHERE id IN (affectedIds) AND tenantId AND status='open'` — then the freeze-check inside `refreshAtomicUpdates` passes and it regenerates. (`refreshAtomicUpdates` itself is unchanged — clearing the flag is what unfreezes it.) The two server actions are thin wrappers deriving tenant/user from `requireSession`, calling reassign with `forceRegenerate: true`, `revalidatePath("/atomic-updates")`, and returning the result (including `needsConfirmation`).

Note: the add action targets a specific `atomicUpdateId` (the one being edited); the event may be unassigned or in another open update — reassign's `existing` path + empty-source confirmation handle both. `openAtomicUpdatesForReassign` / `listSelectableEvents` supply the pickable events (Task 3).

- [ ] **Step 1: Write failing tests**
  - `reassign.ts` with `forceRegenerate: true`: a target update whose `summaryEditedAt` is SET (frozen) gets its flag cleared and `refresh` is invoked for it (stub `refresh`, assert it's called with the target id AND that `summaryEditedAt` is null after) — versus `forceRegenerate` false/absent leaving the flag set. This is the load-bearing test: without the clear, `refreshAtomicUpdates` would skip a frozen update.
  - `addEventToAtomicUpdate`: moves an unassigned event into the update; moves an event from another open update (empties it → `needsConfirmation` → confirm deletes it); rejects an event in a released update; cross-tenant rejects.
  - `removeEventFromAtomicUpdate`: detaches the event (event ends `atomicUpdateId=null, status='excluded'`); removing the LAST event returns `needsConfirmation`, and with confirm deletes the emptied update; the surviving update is force-regenerated (flag cleared, refresh called).
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Implement `forceRegenerate` in `reassign.ts`** (the pre-refresh clear of `summaryEditedAt` on affected ids), then the two thin actions.
- [ ] **Step 4: Verify** — `npx vitest run tests/lib/change-events/reassign.test.ts tests/app/atomic-updates-actions.test.ts && npm run typecheck`. Confirm existing reassign callers (no `forceRegenerate`) are unchanged (default false → freeze respected).
- [ ] **Step 5: Commit** — `git commit -m "feat: add/remove atomic-update evidence with forced regeneration"`.

---

### Task 3: Card evidence editor + hide/un-hide UI

**Files:**
- Modify: `src/app/(dashboard)/atomic-updates/atomic-update-card.tsx` (evidence editor + hide action)
- Modify: `src/app/(dashboard)/atomic-updates/atomic-updates-list.tsx`, `page.tsx` (show-hidden toggle, pass data as props)
- Create: `src/app/(dashboard)/atomic-updates/add-event-picker.tsx` (client) if the picker warrants its own component
- Test: extend the actions test if any new action is added; the client components have no jsdom harness (state that)

**Interfaces:**
- Consumes: `addEventToAtomicUpdate` / `removeEventFromAtomicUpdate` (Task 2); `markAtomicUpdateHidden` / `unhideAtomicUpdate` / `listHiddenAtomicUpdates` (Task 1); `listSelectableEvents` (existing) for the add-picker
- Produces: no new server function beyond Tasks 1-2 (this is UI wiring)

**Context:** **Read `node_modules/next/dist/docs/` first.** Read `atomic-update-card.tsx` (its edit mode with `editing`/`title`/`summary` state and the `events` list), `atomic-updates-list.tsx`, `page.tsx`, and reuse the `Dialog`/toast/`useTransition` patterns from `new-atomic-update-dialog.tsx` and `reassign-control.tsx`. No client component imports `db` — the page queries `listSelectableEvents()` and `listHiddenAtomicUpdates()` server-side and passes results as props.

- [ ] **Step 1: Evidence editor on the card.** In `atomic-update-card.tsx` edit mode, render the update's `events` each with a **Remove** button (posts to `removeEventFromAtomicUpdate`, with a confirm dialog when it's the last event / on a `needsConfirmation` result) and an **Add change event** control that opens a picker of `listSelectableEvents()` rows **excluding events already in this update** (filter client-side by `atomicUpdateId !== this update`), posting the chosen event to `addEventToAtomicUpdate` (with the empties-a-source confirm dialog on `needsConfirmation`). Toast on `{ok:false}`. After a successful add/remove the card re-renders with regenerated title/summary via `revalidatePath`.
- [ ] **Step 2: Hide action on the card.** A **"Mark not user-facing"** control (posts to `markAtomicUpdateHidden`); after it, the card disappears from the list (it's now hidden) — a success toast confirms.
- [ ] **Step 3: Show-hidden section.** In `page.tsx`, fetch `listHiddenAtomicUpdates()` server-side and pass to the list; in `atomic-updates-list.tsx` add a **"Show hidden"** toggle that reveals the hidden updates (rendered read-only or with just an **"Un-hide"** action → `unhideAtomicUpdate`). Keep the primary list = open updates.
- [ ] **Step 4: Wire the pickers' data as props** (selectable events + hidden updates) from the Server Component; ensure no `db` import leaks into a client component.
- [ ] **Step 5: Verify** — `npm run typecheck && npm run lint && npx vitest run && npm run build`; route table unaffected; state interactive rendering is unverified (OAuth-gated).
- [ ] **Step 6: Commit** — `git commit -m "feat: atomic-update evidence editor and hide/un-hide UI"`.

---

## Verification

- [ ] `npm run typecheck && npm run lint && npx vitest run && npm run build` all clean.
- [ ] Adding a change event to an atomic update (from unassigned or another open update) regenerates its title/summary, **even if it was previously hand-edited** (the freeze is cleared); pulling from another open update that empties it confirms before deleting the source.
- [ ] Removing a change event regenerates the update from the remaining evidence; removing the last one confirms deleting the now-empty update.
- [ ] Marking an atomic update non-user-facing hides it from the list; it's excluded from the resolver, so a new commit for that feature creates a NEW visible atomic update.
- [ ] Hidden updates appear under "Show hidden" and can be un-hidden back to the list.
- [ ] Only an open, unlinked atomic update can be hidden; no cross-tenant hide/edit is possible.

## Out of scope

- Bulk hide / bulk evidence edits.
- A per-event "why hidden" audit trail.
- Re-running the classifier on a hidden update (hiding is a manual, reversible curation state).
