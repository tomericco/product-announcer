# One Loader, in the Modal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan.

**Goal:** `GenerationChecklist` mounts in exactly one place — the modal. Every surface that showed it inline shows a clickable "Generating…" badge that opens the modal instead.

**Tech Stack:** Next.js 16.2.10, Vitest 4 (node + jsdom), `@testing-library/react`.

## What this reverses, and the consequence that makes it work

An earlier plan deliberately **kept** the board card's inline checklist, on the reasoning that a generation started in another tab, or continuing after a modal was closed, must still show progress somewhere. The owner has now chosen the opposite: the modal is the only loader.

**That reasoning was not wrong, so it has to be answered rather than ignored.** The answer is that the badge becomes the way back in: **"Generating…" opens the modal for that piece.** Without it, closing the modal would leave a live run with no loader anywhere — strictly worse than today, and exactly the "made unreachable" failure this branch has hit repeatedly.

So awareness stays on every surface; only the *detail* moves.

## The three inline mounts to remove

- `src/app/(dashboard)/board/card.tsx:335`
- `src/app/(dashboard)/drafts/page.tsx:166`
- `src/app/(dashboard)/drafts/[releaseId]/page.tsx:100`

After this, `grep -rn "<GenerationChecklist" src` must return **exactly one** hit: `src/components/generation-modal.tsx`.

## Global Constraints

- **Read the relevant guide in `node_modules/next/dist/docs/` before touching route code.** `params`/`searchParams` are Promises here.
- Never import a runtime value from a server module into a `"use client"` file — type-only is safe.
- **`npm run build` is a mandatory gate.** `rm -rf .next` first, then grep `.next/static` for `pg`/`pg-protocol` with a **positive control from a `"use client"` file and a negative control from a server-only file**.
- **Do not change** `generationStep`, `DRAFT_STEPS`, the pacing hook, `generateDraftForPiece`, `acceptBrief`, or `acceptBriefCard`. This is presentation only — confirm with `git diff`.
- jsdom and `@testing-library/react` are available — render and drive.
- The suite is flaky against one shared Postgres — re-run a failing file once. Baseline: **194 files / 1668 tests**.
- The tree is clean; stage explicit paths, never `git add -A`.

---

### Task 1: The badge opens the modal

**Files:** `src/components/generation-modal.tsx` and/or a small wrapper, `board/card.tsx`, `drafts/page.tsx`, `drafts/[releaseId]/page.tsx`, tests

- [ ] **Step 1: Write the failing tests**

- Each of the three surfaces renders a **"Generating…" control** while a piece is generating, and **no inline checklist**.
- Activating that control opens the modal for **that** piece.
- Closing the modal leaves the run going and the badge still present — reopening shows current progress, not a restart.
- On a **failed** generation the surfaces still show their existing failure affordance (Retry / "Generation failed"). Read what each does today before changing it; the badge replaces the *loader*, not the error state.
- `grep`-equivalent assertion: the checklist has exactly one mount site.

- [ ] **Step 2: Run them, confirm they fail**

- [ ] **Step 3: Make the modal openable for an in-flight piece**

Today the modal opens on Accept. It now also opens on demand for a piece already generating. **Reuse the existing modal — do not fork it.** Check what it assumes about how it was opened (an accept result, a starting state) and make the on-demand path honest about that: it is joining a run in progress, not starting one.

The badge must be a real control with an accessible name — not a `div` with an `onClick`. It is now the only route to watching a generation.

- [ ] **Step 4: Remove the three inline mounts**

Then confirm `grep -rn "<GenerationChecklist" src` returns exactly one hit.

- [ ] **Step 5: Check what became dead**

`GenerationChecklist` gained a `refreshOnTerminal` flag (default `true`) specifically because inline consumers needed the completion refresh while the modal did not. With the inline consumers gone, **is the flag still earning its keep?** If every remaining caller passes the same value, remove it and say so. If not, say why it survives.

Also check whether the surfaces still refresh when a generation lands — that was the inline checklist's job. If the modal is closed when a run completes, does the board still update? Say what you found; if it does not, that is a finding, not a detail.

- [ ] **Step 6: Verify by mutation** — remove the badge's open handler, confirm the "opens the modal" test fails; restore.

- [ ] **Step 7: Verify and commit** — full suite, `npx tsc --noEmit`, `npm run lint`, `rm -rf .next && npm run build` with the controlled grep.

## Out of scope

- Changing the steps, the pacing, or any generation logic.
- The brief-creation modal, which is a different flow.
