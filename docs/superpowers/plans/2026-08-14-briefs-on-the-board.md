# Briefs on the Board — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Put real briefs in a Brief column, rename today's misnamed column to Generating, and let a drag from Brief to Generating accept the brief.

**Architecture:** `readBoard` gains a second read and returns a discriminated card union — `{ kind: "piece" }` and `{ kind: "brief" }`. `canMove` and `moveContentPiece` are untouched and keep operating on pieces only; brief acceptance is a separate action delegating to the existing `acceptBrief`.

**Spec:** `docs/superpowers/specs/2026-08-14-briefs-on-the-board-design.md` — read it before Task 1.

**Tech Stack:** `@dnd-kit/core` 6.3.1, Next.js 16.2.10, Drizzle, Vitest 4 (node + jsdom), `@testing-library/react`.

## Global Constraints

- **Read the relevant guide in `node_modules/next/dist/docs/` before writing route or server-action code.** `searchParams`/`params` are Promises here.
- **`"use server"` files may export ONLY async functions.**
- **Never import a runtime value from a server module into a `"use client"` file** — type-only is safe.
- **`npm run build` is a mandatory gate.** `rm -rf .next` first if route types go stale, then grep `.next/static` for `pg`/`pg-protocol` and **sanity-check the grep with a string confirmed to come from a file whose first line is `"use client"`.** An earlier task in this project sanity-checked with a Server Component string, so its clean result proved nothing.
- Tenant scoping is the security boundary. Ids arrive from the browser via drag payloads.
- **Do not reimplement acceptance.** `acceptBrief` re-reads the brief tenant-scoped, creates the piece, seeds its body from `briefBody`, and triggers generation. The board calls it and inherits every guard.
- **Do not extend `canMove` or `moveContentPiece` to handle briefs.** Their guards are written for content pieces — they refuse moves to `published` and to or from `brief`. Two authorisation models in one function is how this goes wrong.
- Tests live in `tests/`, mirroring `src/`. Two Vitest projects — check `vitest.config.ts` globs. `tests/helpers/fixtures.ts` provides `seedTenant`/`dropTenant`.
- The suite is flaky against one shared Postgres — re-run a failing file once. Baseline: **186 files / 1537 tests** (or higher if spec B landed first — measure, don't assume).
- The UI cannot be visually verified; the preview is behind an OAuth wall.
- **The working tree has pre-existing uncommitted changes that are NOT ours:** `src/app/(dashboard)/board/column.tsx`, `src/app/(dashboard)/layout.tsx`, untracked `src/app/(dashboard)/main-container.tsx`. **Never `git add -A`.** Note `column.tsx` is one of them — coordinate carefully if this task needs to touch it.

---

### Task 1: The card union and the brief read

**Files:** `src/lib/content/board.ts`, `tests/lib/content/board.test.ts`

**Produces:** `BoardBriefCard`, a discriminated union with the existing `BoardCard`, and briefs in the Brief column.

- [ ] **Step 1: Write the failing tests**

- `readBoard` returns `status = "new"` briefs in the Brief column.
- It excludes `accepted`, `dismissed` and `expired` briefs. `accepted` matters most: that brief already has a content piece on the board in a later column, so including it double-counts the same work.
- The brief read is **tenant-scoped** — seed a brief under tenant B, read as tenant A, assert **by id** that B's brief is absent. Not an empty-result assertion.
- Existing content-piece behaviour is unchanged: the published cap, the assignee filter, archived exclusion.

- [ ] **Step 2: Run them, confirm they fail**

- [ ] **Step 3: Add the union and the read**

`BoardCard` gains `kind: "piece"`; add:

```ts
export type BoardBriefCard = {
  kind: "brief";
  id: string;
  title: string;
  contentType: Brief["contentType"];
  score: number;
  status: Brief["status"];
};
```

The discriminant is what keeps a brief id from ever reaching `moveContentPiece`. **Do not merge these into one type with nullable fields** — that pushes the distinction into scattered runtime checks.

- [ ] **Step 4: Delete each guard, confirm its test fails, restore** — the tenant filter and the status filter.

- [ ] **Step 5: Verify and commit** — the new tests, the full suite, `npx tsc --noEmit`. Expect type errors at every `BoardCard` consumer; fixing them is Task 3's job, so if `tsc` is red here, note precisely which files and why rather than half-fixing them.

---

### Task 2: Accepting from the board

**Files:** the board's actions file, its tests

- [ ] **Step 1: Write the failing tests**

- Accepting from the board creates a content piece and flips the brief to `accepted` — **assert those outcomes, do not mock `acceptBrief` away.** Mocking it would test that a function was called, not that acceptance happened.
- It is tenant-scoped: another tenant's brief id creates nothing.
- A brief that is not `status = "new"` is refused.

Generation runs in `after()`; follow how existing tests handle that — the `after` mock must still **run** its callback, and the generator must be injected. **No test may reach the real Anthropic API.**

- [ ] **Step 2: Run them, confirm they fail**

- [ ] **Step 3: Write the action**

One async export in a `"use server"` module, taking a brief id, resolving `tenantId` from `requireSession()`, delegating to `acceptBrief`. It is a thin wrapper — if it grows a second responsibility, that is the signal it is turning into the thing the spec says not to build.

- [ ] **Step 4: Delete each guard, confirm its test fails, restore**

- [ ] **Step 5: Verify and commit**

---

### Task 3: The board UI

**Files:** `src/app/(dashboard)/board/board.tsx`, `card.tsx`, possibly `column.tsx`, tests

- [ ] **Step 1: Rename the column, add the new one**

In `board.tsx`, `COLUMN_LABEL` currently maps `brief: "Brief"`. That entry becomes **"Generating"**, and a new Brief column is added **first**.

The rename is the load-bearing half — without it, two columns are both plausibly "brief" and the confusion this spec exists to end just moves.

- [ ] **Step 2: Render brief cards**

`card.tsx` branches on `card.kind`. A brief card shows title, content type and score, and links to `/briefs/[briefId]`. Reuse the existing card chrome; only the badges differ, since a brief has no assignee, schedule or review status.

- [ ] **Step 3: Wire the drag rules**

`handleDragEnd` (`board.tsx:162` calls `moveCard`) must route a `kind: "brief"` card to Task 2's action when dropped on **Generating**, and refuse every other target.

The board already uses `disabled` in `useDroppable` when `canMove` forbids a target (see the comment near `board.tsx:185`) — extend that same mechanism rather than adding a second refusal path. Refuse: any brief dropped anywhere but Generating, and **anything dropped into Brief**.

- [ ] **Step 4: The assignee-filter empty state**

`assignedTo` is a content-piece concept. With the filter set to anything but "Everyone", the Brief column renders a short explanation rather than vanishing or ignoring the filter.

- [ ] **Step 5: Test by rendering**

jsdom and `@testing-library/react` are available. **Render the board and drive the drag** — do not test only the pure rules. Every UI defect on this branch has lived in wiring that pure-function tests could not see, and one survived a mutation with all its tests green.

Cover: a brief card renders and links to its editor; dropping on Generating calls the accept action; dropping elsewhere does not; nothing drops into Brief; the filtered empty state appears.

**Verify by mutation:** remove the "brief may only drop on Generating" rule, confirm the matching test fails, restore.

- [ ] **Step 6: Confirm `canMove` was not touched**

`git diff` on `src/lib/content/board.ts` must show no change to `ALLOWED_MOVES` or `canMove`, and their existing tests must pass **untouched**. That is the check that acceptance did not get tangled into `moveContentPiece`.

- [ ] **Step 7: Verify and commit** — tests, `npx tsc --noEmit`, `npm run lint`, `rm -rf .next && npm run build` with the sanity-checked grep.

## Out of scope

- Dismissing from the board. Dismissal takes a reason, and a reason picker on a drag target is the wrong shape; it stays on `/briefs` and in the editor.
- Paginating the Brief column.
- Separating `BOARD_COLUMNS`' two jobs (display order and status enum). It holds while Brief is first and never a move target; a second non-status column would force the split.
