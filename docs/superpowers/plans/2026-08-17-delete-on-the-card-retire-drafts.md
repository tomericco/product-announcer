# Delete on the Card, Retire /drafts, Move the Counter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Put Delete on board cards, retire the `/drafts` list, and move the board's counter into the nav.

**Tech Stack:** Next.js 16.2.10, Drizzle, Vitest 4 (node + jsdom), `@testing-library/react`.

## Task order is load-bearing

`deleteDraft`'s **only** UI is `drafts/draft-row-menu.tsx`. Retiring `/drafts` before Delete exists on the card would strand deletion — the failure this branch has already hit four times (evidence, Unhide, backfill import, the from-scratch brief path). **Task 1 must land before Task 2.**

## What exists, checked

- **`deleteDraft` already does the right thing.** `assertDraftDeletable` refuses a **published** piece but deliberately allows `brief` status, and it does **not** consult `reviewStatus` — so "at any review" is already satisfied. **Reuse it; do not write a second guard.**
- **There is no brief deletion at all.** `grep "delete(briefs)"` returns nothing — a brief can only be *dismissed*. Task 1 writes a genuinely new destructive action.
- **The layout already runs a count query** for `["brief","draft"]` pieces and passes `draftCount` to `NavLinks`, which already renders a `Badge`. Task 3 changes what it counts and where it hangs, adding no new round trip beyond the briefs table.

## Global Constraints

- **Read the relevant guide in `node_modules/next/dist/docs/`** before touching route code. `searchParams`/`params` are Promises here.
- **`"use server"` files may export ONLY async functions.**
- **Never import a runtime value from a server module into a `"use client"` file** — type-only is safe.
- **`npm run build` is a mandatory gate.** `rm -rf .next` first, then grep `.next/static` for `pg`/`pg-protocol` with a **positive control from a `"use client"` file and a negative control from a server-only file**.
- Tenant scoping is the security boundary — assert **by id**, not by an empty result.
- jsdom and `@testing-library/react` are available — render and drive.
- The suite is flaky against one shared Postgres — re-run a failing file once. Baseline: **199 files / 1710 tests**.
- The tree is clean; stage explicit paths, never `git add -A`. Commit when verified.

---

### Task 1: Delete on both card kinds

**Files:** a brief-delete action, `board/card.tsx`, `board/actions.ts`, tests

- [ ] **Step 1: Write the failing tests**

- Deleting a **draft** card removes the piece; a **published** piece is still refused; a `brief`-status (generating) piece is allowed.
- Deleting a **brief** card removes the brief row, tenant-scoped, asserted **by id**.
- Both are refused for another tenant.
- Delete is offered regardless of `reviewStatus`.

- [ ] **Step 2: Run them, confirm they fail**

- [ ] **Step 3: The brief delete action**

New, with no precedent — so decide and record: what happens to its `brief_signals` rows (check the FK's on-delete), and whether an `accepted` brief may be deleted (it has a content piece; deleting the brief would orphan or strand it). **Refuse what you cannot make coherent** rather than cascading silently.

**Flag, do not solve:** a *dismissed* brief still feeds the ideation prompt's dedupe, so the agent does not re-propose it. A *deleted* one cannot. Deleting is therefore not "dismiss, but tidier" — say so in the action's doc comment.

- [ ] **Step 4: Wire Delete into the card** for both kinds, behind a confirmation — it is irreversible. Reuse the confirm shape `card.tsx` already uses for accepting a brief; do not invent a second.

- [ ] **Step 5: Delete each guard, confirm its test fails, restore**

- [ ] **Step 6: Verify and commit**

---

### Task 2: Retire the `/drafts` list

**Files:** `drafts/{page,draft-row-menu}.tsx`, `nav-links.tsx`, retargets

**Survives:** `/drafts/[releaseId]` — the draft editor. The board and the generation modal both link to it.

- [ ] **Step 1: Retarget every `/drafts` reference first, then delete**

**Grep for them yourself** — a plan on this branch named 9 references when there were 15, and the six it missed would have 404'd every tenant finishing onboarding. Check `src/app/page.tsx`, `src/lib/workspace/onboarding-step.ts`, `src/app/onboarding/`, every `revalidatePath`, and the three "back to drafts" links in `drafts/[releaseId]/page.tsx`.

- [ ] **Step 2: Delete the list and its now-unused row menu.** Anything the menu owned that is not on the card is a capability being dropped — list it in your report.

- [ ] **Step 3: Verify and commit** — confirm `/drafts/[releaseId]` still routes.

---

### Task 3: The counter moves to the nav

**Files:** `board/page.tsx`, `layout.tsx`, `nav-links.tsx`, tests

- [ ] **Step 1: Remove the `Badge` beside the board's `<h1>`.**

- [ ] **Step 2: Recount, and hang it on the Board nav item.**

The count is the **Brief + Draft + Review columns**: `briefs` with `status = "new"`, plus content pieces with status `brief` (generating, rendered in Draft), `draft`, or `review`. Scheduled and Published are excluded.

The layout's existing query covers `["brief","draft"]` — extend it and add the briefs count. `NavLinks` already renders a badge for `/drafts`; repoint it to `/board`.

- [ ] **Step 3: Test the count** — a piece in each counted status, a brief, and one Scheduled plus one Published proving exclusion.

- [ ] **Step 4: Verify and commit**

## Out of scope

- The assignee filter interacting with the nav count. The board's own total was filter-aware; a sidebar badge on every page is not, and pretending otherwise would need the filter in the layout. Count everything, and say so if it looks wrong.
