# Drag Briefs to Draft — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Accept a brief by dragging it to Draft, like every other column transition, and move the New brief affordance into the Brief column header.

**Tech Stack:** `@dnd-kit/core` 6.3.1, Next.js 16.2.10, Vitest 4 (node + jsdom), `@testing-library/react`.

## The decision this rests on, and what it reverses

An earlier instruction was: *"no need for the generating column in board. when generated, keep brief in 'brief' column."* That put generating pieces (`contentPieces.status = "brief"`) in the Brief column alongside briefs.

Dragging a brief to Draft conflicts with that: acceptance creates a piece with `status = "brief"`, so the card would snap back to Brief and only reach Draft when generation finished — a drag that visibly does not stick.

**The owner chose: generating pieces move to Draft.** So:

- **Brief column holds only briefs.**
- **Draft column holds generating pieces and generated drafts.**
- A brief dropped on Draft lands there, generates in place, and becomes an ordinary draft.

That is what makes the drag behave like every other column, which is the point of the change.

## Global Constraints

- **`BOARD_COLUMNS` must not change.** It doubles as the `contentPieces.status` enum — `moveContentPiece` writes `.set({ status: to })` and `ALLOWED_MOVES` is keyed by it. `brief` remains a valid *status*; this is a display change only.
- **Do not touch `canMove`, `ALLOWED_MOVES` or `moveContentPiece`.** Accepting a brief is a different transition with a different authorisation model — it goes through `acceptBriefCard` → `acceptBrief`, which is already the authority. Confirm with `git diff` that their definitions are unchanged when you finish, and that their tests pass **untouched**.
- **Keep `src/app/(dashboard)/board/collision.ts`.** It fixed a pre-existing piece-level bug (a `draft` released over Published moving to whichever of Review/Scheduled was nearer), independent of any brief drag. Its tests must still pass.
- **`acceptBrief`, `acceptBriefCard` and `generateDraftForPiece` are unchanged.** Only presentation and the trigger move.
- **Read the relevant guide in `node_modules/next/dist/docs/`** before touching route code.
- Never import a runtime value from a server module into a `"use client"` file — type-only is safe.
- **`npm run build` is a mandatory gate.** `rm -rf .next` first, then grep `.next/static` for `pg`/`pg-protocol` with a **positive control from a `"use client"` file and a negative control from a server-only file**.
- jsdom and `@testing-library/react` are available — render the board and drive the drag.
- The suite is flaky against one shared Postgres — re-run a failing file once. Baseline: **193 files / 1636 tests**.
- The tree is clean. Stage explicit paths, never `git add -A`.

---

### Task 1: Generating pieces render in Draft

**Files:** `src/app/(dashboard)/board/board.tsx`, `src/lib/content/board.ts` if the display grouping lives there, tests

- [ ] **Step 1: Write the failing tests**

- A `brief`-status content piece renders in the **Draft** column, not Brief.
- The Brief column contains only briefs.
- A generating piece keeps its inline checklist and its Generate/Retry affordances wherever it now renders.
- The assignee filter still behaves: briefs do not obey it (they have no assignee) and the column's explanatory note still appears when a filter is active — **but that note now belongs to a column holding only briefs**, which simplifies the two-population logic added earlier. Check `filterHidesBriefs` and simplify it if the second population is gone.

- [ ] **Step 2: Run them, confirm they fail**

- [ ] **Step 3: Move the population**

`board.tsx:378` currently renders the Brief column as `[...board.brief, ...(filterHidesBriefs ? [] : board[BRIEF_COLUMN])]`. `board.brief` moves to the Draft column's list; Brief renders `board.briefs` alone.

Mind the ordering within Draft: generating pieces are work in flight and their state changes while you watch. Decide where they sit relative to finished drafts and say why.

- [ ] **Step 4: Verify and commit**

---

### Task 2: The drag, replacing the button

**Files:** `src/app/(dashboard)/board/{board,card}.tsx`, tests

- [ ] **Step 1: Write the failing tests**

- A brief card **is draggable**.
- Dropping it on **Draft** calls `acceptBriefCard` with that brief's id.
- Dropping it on Review, Scheduled, Published or Brief does **nothing** — Draft is the only valid target.
- Nothing can be dropped **into** Brief. A content piece cannot become a brief; that relationship is one-way.
- The generation modal opens on a successful drop, as it does today from the button.

- [ ] **Step 2: Run them, confirm they fail**

- [ ] **Step 3: Make brief cards draggable, Draft-only**

The board already disables non-viable droppables via `useDroppable`'s `disabled` — extend that same mechanism rather than adding a second refusal path.

- [ ] **Step 4: Remove the Accept button**

`card.tsx:203`'s "Accept brief" goes, along with any state and handlers left unreferenced. Say what you removed and confirm by grep.

**Keep the confirmation dialog for now.** It was added at the owner's explicit request when Accept was a one-click button. A drag is a more deliberate gesture and arguably makes it redundant, but that is the owner's call to reverse, not yours — leave it wired to the drop and **flag it in your report** so the question is put to them rather than silently answered.

- [ ] **Step 5: Verify by mutation**

Make Draft refuse briefs; confirm the drop test fails; restore. Then confirm `git diff` shows `canMove`/`ALLOWED_MOVES`/`moveContentPiece` untouched and `collision.ts` intact.

- [ ] **Step 6: Verify and commit**

---

### Task 3: New brief becomes a plus in the column header

**Files:** `src/app/(dashboard)/board/{column,board}.tsx`, tests

The "New brief" button currently sits in the Brief column's body (`board.tsx:406-413`). It becomes a **plus button beside the column title**.

- [ ] **Step 1: Give `Column` an optional header action**

`Column`'s header is `<h2>{title}</h2>` plus a count `Badge` (`column.tsx:38-41`). Add an optional slot for a trailing action, so the plus sits with the title rather than being special-cased. Only the Brief column passes one — do not make it Brief-specific inside `Column` itself.

- [ ] **Step 2: Move the button**

An icon button linking to `/briefs/new`, with an accessible label — a bare `+` with no accessible name is unusable with a screen reader, and this is the only route to writing a brief from scratch.

- [ ] **Step 3: Test it**

The board offers a route to `/briefs/new` **without** requiring signals, and it is reachable by its accessible name. **Verify by mutation** — remove it, confirm the test fails, restore.

That path has already been lost once on this branch and had to be restored; the test is what stops it happening a third time.

- [ ] **Step 4: Verify and commit** — full suite, `npx tsc --noEmit`, `npm run lint`, `rm -rf .next && npm run build` with the controlled grep.

## Out of scope

- Changing `BOARD_COLUMNS` or any move rule.
- Dismissing a brief from the board.
