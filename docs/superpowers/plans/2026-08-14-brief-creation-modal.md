# Brief Creation Modal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn the invisible model call behind "Create brief" into a modal with three honest steps, ending on a brief that already exists.

**Architecture:** One server action resolves signals, proposes, and persists through the existing `createManualBrief`. The modal reports three steps around that single round trip — no persisted progress, because there is only one model call to report on. `Open brief` goes to the spec A editor.

**Spec:** `docs/superpowers/specs/2026-08-14-brief-creation-modal-design.md` — read it before Task 1, including its opening correction.

**Tech Stack:** Next.js 16.2.10 App Router, Base UI `Dialog`, Vitest 4 (node + jsdom projects), `@testing-library/react`.

## Global Constraints

- **Read the relevant guide in `node_modules/next/dist/docs/` before writing route or server-action code.** This Next.js differs from training data; `searchParams` and `params` are Promises.
- **`"use server"` files may export ONLY async functions.** No `const`, no type alias, no re-exported type.
- **Never import a runtime value from a server module into a `"use client"` file** — type-only is safe.
- **`npm run build` is a mandatory gate.** `rm -rf .next` first if route types go stale. Then grep `.next/static` for `pg`/`pg-protocol`, and **sanity-check the grep with a string you have confirmed comes from a file whose first line is `"use client"`.** An earlier task in this project sanity-checked with a Server Component string — never present in client chunks — so its clean result proved nothing.
- Tenant scoping is the security boundary. Signal ids arrive from client state seeded by a URL and are untrusted.
- **No test may reach the real Anthropic API.** `proposeBriefFromSignals` takes a `ProposeDeps` seam (`{ generate? }`) — use it.
- **Do not add a fourth writer of `briefs.body`.** Persist through `createManualBrief`, which already inserts, links `brief_signals`, renders the body and refuses a blank one. Spec A's final review caught the "one writer guarded, its sibling forgotten" bug twice; do not create a third sibling.
- Tests live in `tests/`, mirroring `src/`. Two Vitest projects — check `vitest.config.ts` globs, they must not overlap. `tests/helpers/fixtures.ts` provides `seedTenant`/`dropTenant`.
- The suite is flaky against one shared Postgres — re-run a failing file once. Baseline: **186 files / 1537 tests**.
- The UI cannot be visually verified; the dev preview is behind an OAuth wall.
- **The working tree has pre-existing uncommitted changes that are NOT ours:** `src/app/(dashboard)/board/column.tsx`, `src/app/(dashboard)/layout.tsx`, untracked `src/app/(dashboard)/main-container.tsx`. **Never `git add -A`.**

---

### Task 1: `PROPOSAL_STEPS` and the step-key decision

**Files:** `src/lib/drafting/draft-progress.ts`, plus whatever the decision below forces.

**This task is small but has a trap, which is why it is first and separate.**

`DraftStepKey` is a **closed union**: `"collecting" | "preparing" | "generating" | "reviewing" | "saving"`. `PROPOSAL_STEPS` needs `resolving` and `proposing`, which it does not have.

Widening it is not free: `src/app/(dashboard)/drafts/[releaseId]/agent-edit-dialog.tsx:44` and `extract-dialog.tsx:44` each hold a `Record<DraftStepKey, StepStatus>`, and a `Record` over a widened union requires an entry for **every** new key. Both initialisers stop compiling until updated.

- [ ] **Step 1: Choose, and record why**

Either widen `DraftStepKey` and fix both `Record` initialisers, or give `PROPOSAL_STEPS` its own key type and let `ProgressChecklist` take a generic key. **Do not cast to make the error go away.** Write the choice and its reasoning in your report — a later reader needs to know this was decided, not stumbled into.

- [ ] **Step 2: Add `PROPOSAL_STEPS`**

```ts
export const PROPOSAL_STEPS = [
  { key: "resolving", label: "Resolving your signals" },
  { key: "proposing", label: "Proposing an angle" },
  { key: "saving", label: "Creating the brief" },
];
```

`DRAFT_STEPS` and `EDIT_STEPS` already establish that different flows carry different lists against the same renderer.

- [ ] **Step 3: Verify and commit** — `npx tsc --noEmit` must be clean, which is the whole point of doing this first. Then the full suite.

---

### Task 2: `proposeAndCreateBrief`

**Files:** `src/app/(dashboard)/signals/propose-actions.ts`, its tests

**Produces:** one async export returning `{ ok: true; briefId } | { ok: false; error }`.

- [ ] **Step 1: Write the failing tests**

- Refuses another tenant's signal ids — **asserted by id**, not by an empty result. Seed a signal under tenant B, call as tenant A, and assert nothing of B's leaks into the created brief.
- A proposal failure returns a reason and **creates no brief** (assert the tenant's brief count is unchanged).
- A successful run creates exactly one brief, linked to the resolved signals, with a non-blank body.

Inject the model through `proposeBriefFromSignals`'s `ProposeDeps` seam. No test may reach a real model.

- [ ] **Step 2: Run them, confirm they fail**

- [ ] **Step 3: Write the action**

Resolve signals tenant-scoped, call `proposeBriefFromSignals`, persist via `createManualBrief`. Read `createManualBrief`'s existing tenant re-read and its comment about another tenant's signal title leaking into every draft — **reuse that path rather than writing a second guard**.

Map the proposal's fields onto `ManualBriefInput` (`contentType`, `title`, `angle`, `whyNow`, `keyPoints`, `suggestedChannel`, `targetLength`, `audience`, `score`, `scoreRationale`, `signalIds`).

- [ ] **Step 4: Delete each guard, confirm its test fails, restore**

- [ ] **Step 5: Verify and commit** — the new tests, the full suite, `npx tsc --noEmit`.

---

### Task 3: The modal

**Files:** `src/app/(dashboard)/signals/create-brief-modal.tsx`, `signals-list.tsx`, tests

- [ ] **Step 1: Replace the link with a modal trigger**

`signals-list.tsx` currently renders:

```tsx
<Button size="sm" render={<Link href={`/briefs/new?signals=${selectedIds.join(",")}`} />}>
  Create brief
</Button>
```

It becomes a button that opens the modal with `selectedIds`. Built on the existing Base UI `Dialog` (`src/components/ui/dialog.tsx`) — **no new dependency**.

- [ ] **Step 2: The modal's behaviour**

Renders `ProgressChecklist` with `PROPOSAL_STEPS`. Advances `resolving` → `proposing` → `saving` around the single action call. On success shows `Open brief` (to `/briefs/[briefId]`) and `Close`.

**Closing is not a cancel** — the brief exists, at `status = "new"` in the inbox, dismissable there. Do not add a delete-on-close.

On failure: show the reason and offer `Write it by hand`, linking `/briefs/new?signals=…` with the same ids. That preserves the existing "never block the form" rule.

- [ ] **Step 3: Test it by rendering**

jsdom and `@testing-library/react` are available. **Render the modal and drive it** — do not extract pure functions to avoid rendering. The last three defects on this branch lived in untested effect wiring and one survived a mutation with every test green.

Cover: all three steps are reached; success shows `Open brief`; closing after success does not delete the brief; a failure shows the reason and the by-hand link.

**Verify the step test by mutation** — make the action resolve without advancing past `resolving`, confirm the test fails, restore.

- [ ] **Step 4: Verify and commit** — tests, `npx tsc --noEmit`, `npm run lint`, `rm -rf .next && npm run build` with the sanity-checked bundle grep.

---

### Task 4: Retire the proposal branch on `/briefs/new`

**Files:** `src/app/(dashboard)/briefs/new/page.tsx`, its tests

- [ ] **Step 1: Remove the in-render model call**

Drop the `proposeBriefFromSignals` call, the proposal pre-fill, and the `droppedUnavailable` notice that exists only to explain a partially-resolved proposal.

**Keep the hand-written path exactly as it is**, including reaching it with `?signals=` from the modal's failure branch — those ids still seed the form's evidence selection, they just no longer trigger a proposal.

- [ ] **Step 2: Confirm nothing else called it**

`grep -rn "proposeBriefFromSignals" src` — after this, the only caller should be Task 2's action. If another exists, stop and report.

- [ ] **Step 3: Verify and commit** — `/briefs/new` still works with and without `?signals=`, makes no model call, full suite, `npx tsc --noEmit`, `npm run build`.

## Out of scope

- The cron ideation sweep reporting to anyone. It is unattended.
- Persisted proposal progress. One model call does not justify a row, a poll and a sync path.
- Spec C (briefs on the board).
