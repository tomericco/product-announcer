# Retire the Briefs Tab, Modal Draft Generation, Paced Loaders — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Three owner-requested changes — delete the Briefs list, put draft generation behind the same stepped modal brief creation uses, and stop deterministic steps flashing past.

**Tech Stack:** Next.js 16.2.10 App Router, Base UI `Dialog`, Vitest 4 (node + jsdom), `@testing-library/react`.

## The decision behind Task 1, recorded

Deleting the Briefs list makes **dismissed, accepted and expired briefs unreachable in the entire app**. The board's Brief column reads `eq(briefs.status, "new")` only.

This was raised with the owner, who chose it deliberately over two alternatives that preserved access. Those briefs continue to feed the ideation prompt's dedupe — they stop having a UI, they do not stop mattering. **Do not "helpfully" preserve a way to see them.** If that turns out to be wrong, it is a decision to revisit, not a bug to fix in passing.

## Global Constraints

- **Read the relevant guide in `node_modules/next/dist/docs/` before touching route code.** `searchParams`/`params` are Promises here.
- **`"use server"` files may export ONLY async functions.**
- **Never import a runtime value from a server module into a `"use client"` file** — type-only is safe.
- **`npm run build` is a mandatory gate.** `rm -rf .next` first, then grep `.next/static` for `pg`/`pg-protocol` with a **positive control from a `"use client"` file and a negative control from a server-only file**. A clean grep without controls proves nothing — that mistake has been made on this branch.
- Tenant scoping is the security boundary.
- **No test may reach the real Anthropic API.**
- jsdom and `@testing-library/react` are available — render and drive; do not extract pure functions to dodge rendering.
- The suite is flaky against one shared Postgres — re-run a failing file once. Baseline: **192 files / 1613 tests**.
- The UI cannot be visually verified; the preview is behind an OAuth wall.
- The tree is clean. Stage explicit paths, never `git add -A`.

---

### Task 1: Delete the Briefs list

**Files:** `src/app/(dashboard)/briefs/{page,briefs-list,briefs-filters}.tsx`, `src/lib/briefs/query.ts`, `src/app/page.tsx`, `src/lib/workspace/onboarding-step.ts`, `nav-links.tsx`, and the retargets below.

**Survives, and must keep working:**
- `/briefs/[briefId]` — the editor. The board links to it.
- `/briefs/new` — the hand-written path, and the create-brief modal's failure fallback (`/briefs/new?signals=…`).
- `acceptBrief` / `dismissBrief` in `briefs/actions.ts` — used by the editor and the board.
- `brief-decision.tsx` — shared by the editor.

- [ ] **Step 1: Retarget every reference before deleting anything**

I enumerated these; **re-grep to confirm nothing has shifted**, then retarget all to `/board`:

| File | What |
|---|---|
| `src/app/page.tsx:8` | **The post-login landing page.** Deleting `/briefs` without this 404s every returning user. |
| `src/lib/workspace/onboarding-step.ts:36` | `if (completed) return "/briefs"` — first-run lands here. |
| `src/app/(dashboard)/nav-links.tsx:21` | The nav entry — delete it, and its now-unused icon import. |
| `briefs/new/brief-form.tsx:152, :245` | After-save and Cancel. |
| `briefs/[briefId]/brief-header.tsx:35`, `[briefId]/page.tsx:84` | "Back to briefs" links. |
| `briefs/new/actions.ts:156`, `[briefId]/actions.ts:91`, `actions.ts:114, :182` | Four `revalidatePath("/briefs")` calls. |

- [ ] **Step 2: Delete the list**

`page.tsx`, `briefs-list.tsx`, `briefs-filters.tsx`, and `listBriefs` in `src/lib/briefs/query.ts` once nothing calls it. **Check `listBriefs`' consumers by grep before removing it** — a previous task on this branch found consumers a plan had not named.

Delete tests that covered deleted code; **do not delete a test that still covers surviving code.** Account for the count delta in your report.

- [ ] **Step 3: Verify and commit** — full suite, `npx tsc --noEmit`, `npm run lint`, `rm -rf .next && npm run build`. Confirm `/board` is the landing target and that `/briefs/[briefId]` and `/briefs/new` still route.

---

### Task 2: Pace deterministic steps

**Files:** the shared checklist/step-advance code, its tests

**Do this before Task 3** — Task 3's modal should inherit the pacing rather than needing it retrofitted.

The problem: deterministic steps complete in milliseconds and flash past, so a user sees a checklist jump straight to the slow step. The owner wants each such step held long enough to read.

- [ ] **Step 1: Decide where the pacing lives, and record it**

**It must be client-side presentation, not a server delay.** Do not add `sleep` to a server action or `after()` callback — making the server genuinely slower to look better is the wrong trade, and it would also slow the cron paths that share this code.

The natural shape is a minimum-visible duration when advancing a step: if a step has been displayed for less than the floor, wait out the remainder before showing the next.

- [ ] **Step 2: Two rules that must hold, and be tested**

1. **The LLM step is never paced.** It is genuinely slow; adding a floor to it does nothing but risk masking a fast failure.
2. **Terminal states are never paced.** A failure, or a give-up, shows **immediately**. Making someone wait out a fake second to be told it broke is the worst version of this feature.

- [ ] **Step 3: Test it**

Use fake timers. Cover: a fast deterministic step is still visible for the floor; the LLM step is not delayed; a failure arriving mid-pace surfaces at once. **Verify by mutation** — remove the floor, confirm the visibility test fails; remove the terminal-state exemption, confirm the failure test fails.

- [ ] **Step 4: Verify and commit**

---

### Task 3: Draft generation in a modal

**Files:** a shared generation modal, the board card and the brief editor, tests

Generating a draft from a brief currently happens in the background: the board card shows an inline checklist, and the editor's Accept redirects to `/drafts/[id]`. The owner wants the same stepped modal that brief creation uses.

**This is a presentation change over machinery that already exists — do not build a second progress system.** `contentPieces.generationStep` is already persisted and polled; `DRAFT_STEPS` is real; `GenerationChecklist` already renders it. The modal wraps that.

- [ ] **Step 1: Build the modal around the existing poll**

Reuse `GenerationChecklist` and its polling rather than duplicating it. On completion, offer **Open draft** (to `/drafts/[id]`) and **Close** — matching the create-brief modal, so the two read alike.

**Closing is not a cancel.** Generation runs in `after()` and continues regardless; the piece is on the board either way. Do not add a cancel.

- [ ] **Step 2: Wire both entry points**

- **Board:** the existing Accept confirmation (added in `3f55bc4`) leads into the modal instead of dismissing to an inline checklist. Keep the confirmation — it exists because Accept is irreversible and spends a model call.
- **Editor:** Accept opens the modal instead of redirecting. The redirect exists today; replacing it means the author stays on the brief they just read.

**`acceptBrief`, `acceptBriefCard` and `generateDraftForPiece` are unchanged.** Only presentation moves.

- [ ] **Step 3: Keep the inline checklist working**

The board card's inline checklist still matters — a generation started in one tab, or continuing after a modal was closed, must still show progress on the card. **Do not remove it.** Confirm its tests still pass.

- [ ] **Step 4: Test by rendering**

Cover: the modal opens on Accept and advances through real steps; Open draft appears on completion; closing mid-generation leaves it running and the card still shows progress; a generation failure surfaces in the modal without pacing.

**Verify by mutation** — make the modal stop polling, confirm the advance test fails.

- [ ] **Step 5: Verify and commit** — full suite, `npx tsc --noEmit`, `npm run lint`, `rm -rf .next && npm run build` with the controlled grep.

## Out of scope

- Restoring any view of dismissed / accepted / expired briefs. Decided against, deliberately.
- Changing `generationStep`, `DRAFT_STEPS`, or any generation logic.
