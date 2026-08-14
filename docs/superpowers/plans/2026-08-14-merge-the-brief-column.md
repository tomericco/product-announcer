# Merge the Brief Column — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Remove the Generating column. A piece mid-generation stays in Brief, beside the briefs, and acceptance becomes a button instead of a drag.

**Spec:** `docs/superpowers/specs/2026-08-14-briefs-on-the-board-design.md` — read the **"Amended 2026-08-14"** section first; it supersedes the two-column design below it.

**Architecture:** `BOARD_DISPLAY_COLUMNS` drops the `brief`-status column from the display order; the Brief column renders `board.briefs` and `board.brief` together. `acceptBriefCard` is unchanged — only its trigger moves.

## Global Constraints

- **`BOARD_COLUMNS` must not change.** It doubles as the `contentPieces.status` enum: `moveContentPiece` writes `.set({ status: to })` and `ALLOWED_MOVES` is keyed by it. `brief` remains a valid *status*; it just stops being a *displayed column*. This is a display change only.
- **Do not touch `canMove`, `ALLOWED_MOVES` or `moveContentPiece`.** Confirm with `git diff` that their definitions in `src/lib/content/board.ts` are unchanged when you finish, and that their tests pass **untouched**.
- **Keep the collision fix** (`src/app/(dashboard)/board/collision.ts`, `pointerWithin` with a `rectIntersection` fallback when `pointerCoordinates` is null). Removing the brief drag does **not** make it redundant: it also fixed a pre-existing bug where a `draft` piece released over Published moved to whichever of Review/Scheduled was nearer. Its tests must still pass.
- Never import a runtime value from a server module into a `"use client"` file — type-only is safe.
- **`npm run build` is a mandatory gate.** `rm -rf .next` first, then grep `.next/static` for `pg`/`pg-protocol` with a **positive control from a `"use client"` file and a negative control from a server-only file**.
- **Read the relevant guide in `node_modules/next/dist/docs/`** before touching route code.
- jsdom and `@testing-library/react` are available — render and drive rather than testing pure rules alone.
- The suite is flaky against one shared Postgres — re-run a failing file once. Baseline: **192 files / 1605 tests**.
- The tree is clean. Stage explicit paths, never `git add -A`.

---

### Task 1: Merge the columns and replace the drag with a button

**Files:** `src/lib/content/board.ts`, `src/app/(dashboard)/board/{board,card}.tsx`, tests

- [ ] **Step 1: Write the failing tests**

- The board renders **five** columns: Brief, Draft, Review, Scheduled, Published. No column is labelled Generating.
- The Brief column shows both a `status = "new"` brief **and** a `brief`-status content piece, each rendered as its own card kind.
- A brief card offers an accept action that calls `acceptBriefCard`; there is no drag path to acceptance.
- **A brief card is not draggable**, like the generating pieces beside it.
- Dropping a piece into Brief is still refused.
- The assignee-filter empty state still behaves: with a filter active, briefs are hidden and the explanation shows — but generating **pieces** in that column still obey the filter normally. Be careful here: one column now has two populations with different filter semantics. Decide what the explanation says when briefs are hidden but pieces remain, and test it.

- [ ] **Step 2: Run them, confirm they fail**

- [ ] **Step 3: Drop the Generating column from the display order**

`BOARD_DISPLAY_COLUMNS` (`src/lib/content/board.ts:28`) is currently `[BRIEF_COLUMN, ...BOARD_COLUMNS]`. It must stop including the `brief` status as its own column. `BOARD_COLUMNS` itself is untouched — `readBoard` still groups pieces by status, and `board.brief` still exists; it is simply rendered inside the Brief column.

Update `COLUMN_LABEL` in `board.tsx` accordingly. Its long comment explains why the old column was renamed to Generating — **rewrite it** to explain what the merged Brief column now holds, rather than leaving an explanation of a column that no longer exists.

- [ ] **Step 4: Render both populations in the Brief column**

The column takes both `board.briefs` and `board.brief`. Order them so the distinction reads — decide and say why. `card.tsx` already branches on `card.kind`; a generating piece keeps its existing card, including its checklist and Generate/Retry affordances.

- [ ] **Step 5: Replace the drag with a button**

Remove the brief branch from `canDrop` and the brief case from `handleDragEnd`; make brief cards non-draggable. Add an accept action to the brief card calling `acceptBriefCard`, following the shape `card.tsx` already uses for `generateDraft` on a `brief`-status piece — including its optimistic/refresh handling, so the two read alike.

`acceptBriefCard` and `acceptBrief` are **unchanged**. Only the trigger moves.

- [ ] **Step 6: Delete now-dead code**

Whatever brief-drag machinery is left unreferenced goes. Say in your report what you removed, and confirm by grep that nothing still references it.

- [ ] **Step 7: Verify by mutation**

Make brief cards draggable again and confirm the not-draggable test fails; restore. Then confirm `git diff` shows `canMove`/`ALLOWED_MOVES`/`moveContentPiece` untouched and `collision.ts` intact.

- [ ] **Step 8: Verify and commit** — full suite, `npx tsc --noEmit`, `npm run lint`, `rm -rf .next && npm run build` with the controlled bundle grep.

## Out of scope

- Changing `BOARD_COLUMNS` or any move rule.
- Dismissing a brief from the board — still `/briefs` and the editor.
