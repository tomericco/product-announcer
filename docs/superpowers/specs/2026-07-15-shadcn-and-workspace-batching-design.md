# shadcn/ui Adoption + Workspace-Level Batching — Design

**Status:** Approved (brainstorm) — 2026-07-15
**Builds on:** the completed 5-plan MVP (see `2026-07-13-product-announcer-mvp-design.md`). This spec supersedes the MVP spec's "Bare UI (current MVP)" section and its "one Update per repo per batch" / per-repo schedule model.

## Overview

Two enhancements to the shipped product, delivered as two sequenced phases:

1. **Phase 1 — Adopt shadcn/ui across the app.** Replace the bare grayscale Tailwind UI with shadcn/ui components on every existing page. Behavior-preserving: same routes, same Server Actions, same data — only the presentation changes. This phase deliberately **relaxes the MVP's "no client-side JS / exactly one Client Component" constraint**, because shadcn's interactive primitives (Dialog, Popover, Command/Combobox, Select, etc.) are Radix-based Client Components.

2. **Phase 2 — Workspace-level batching + unified Pending + searchable branch picker.** Change the batching model from **per-repo** to **per-workspace**: all pending `ChangeItem`s across a tenant's repos batch into **one** cross-repo draft, on **one** workspace schedule. Rebuild the Pending page as a single unified list. Replace the free-text branch input with a shadcn **Combobox** populated with the repo's real branches.

Phase 1 lands and is verified first (pure visual migration, easy to eyeball); Phase 2 builds its new UI on the shadcn components Phase 1 establishes.

## Guiding constraints (updated from the MVP)

- **shadcn/ui is the UI system.** New UI uses shadcn components; we do not hand-roll bare Tailwind controls anymore.
- **Client Components are now allowed** wherever interactivity requires them (shadcn primitives). Server Components remain the default for data-fetching pages; mutations remain plain Server Actions bound to `<form action={…}>`. We do **not** introduce a client-side data-fetching or global-state library — forms still submit to Server Actions and the page re-renders from fresh server data.
- **Grayscale/neutral aesthetic is retained.** shadcn is initialized with the **`neutral`** base color so the app stays monochrome — no brand accent is introduced in this work (accent/identity remains deferred, per the MVP spec's "Design Direction (future)").
- **Tenant scoping is unchanged and non-negotiable.** Every page/action still re-derives `tenantId` from `requireSession()` and scopes every query and mutation to it.

---

## Phase 1 — shadcn/ui adoption + re-skin

### Setup

- Stack is compatible as-is: **Tailwind v4** (CSS-first, `@import "tailwindcss"`, no `tailwind.config`), **React 19**, **Next 16**, `@/*` → `./src/*` alias already present.
- Initialize via the shadcn CLI (Tailwind-v4 / React-19 path): creates `components.json`, adds the design tokens to `src/app/globals.css`, adds `src/lib/utils.ts` (`cn`), and pulls in `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, and the v4 animation helper. Components install into `src/components/ui/`.
- Base color: **neutral**. Dark mode is out of scope for this work (light only, matching today).

### Component inventory (installed once, reused everywhere)

`button`, `input`, `textarea`, `label`, `select`, `checkbox`, `card`, `table`, `dialog`, `badge`, `separator`, `dropdown-menu`, `sonner` (toasts are optional/nice-to-have; not required), plus `command` + `popover` (these back the Phase 2 Combobox but are installed here as part of adoption).

### Page-by-page mapping (behavior-preserving)

- **Dashboard shell** (`(dashboard)/layout.tsx`): the sidebar becomes shadcn primitives — the workspace-name dropdown moves from the native `<details>/<summary>` to a shadcn **DropdownMenu** (Settings + sign-out email inside); nav links become shadcn `Button`-styled links (`variant="ghost"`). The active route may be highlighted (a client `usePathname()` is now acceptable).
- **Onboarding** (`/onboarding`): sections become `Card`s; inputs → `Input`; the schedule cadence → `Select`; buttons → `Button`. (Repo picker is reworked in Phase 2.)
- **Pending** (`/pending`): buttons/list → shadcn `Button` + `Card`/`Table`. (Fully rebuilt in Phase 2 anyway; Phase 1 just brings it onto shadcn so nothing looks orphaned mid-migration.)
- **Drafts** (`/drafts`, `/drafts/[updateId]`): list → `Card`s; the edit form → `Input`/`Textarea`/`Select`/`Button`. The **preview modal migrates from the hand-rolled `<dialog>` + `PreviewDialog` client component to the shadcn `Dialog`** (still a client component, still open/close-state only). `Approve & publish` and `Reject` stay as Server-Action forms rendered inside/alongside the dialog.
- **History** (`/history`): the table → shadcn `Table`; category → `Badge`.
- **Settings** (`/settings`): sections → `Card`s; inputs → `Input`; cadence → `Select`; buttons → `Button`. (Repo picker + schedule section change in Phase 2.)
- **Integrations** (`/integrations`): the webhook form → `Input`/`Checkbox`/`Button` in a `Card`; the coming-soon list → `Badge`/`Card` items (still static).

### Phase 1 verification

- No behavior change: the full existing test suite (66 tests) must still pass unchanged — Server Actions, routes, and data logic are untouched.
- `tsc --noEmit` clean; `npm run build` compiles every route.
- Visual pass (manual): each page renders with shadcn styling; the draft preview opens/closes via the shadcn Dialog; approve/reject/save still work.

---

## Phase 2 — Workspace-level batching + unified Pending + searchable branch picker

### The model shift

The **workspace (tenant)** becomes the batching unit. All pending `ChangeItem`s across all of a tenant's repos are collected into **one** draft `Update` per batch, triggered by **one** workspace schedule (or a manual "Run now"). Manual and scheduled runs behave identically (both produce one cross-repo draft) — this is the consistency the workspace-level choice buys.

### Schema changes (one migration)

- **`updates.repoId` → nullable.** A draft can span repos, so it no longer has a single owning repo. The source repos are always recoverable via `sourceItems` → `changeItems.repoId`. New drafts leave `repoId` null; no current surface displays `updates.repoId`, so nothing downstream breaks.
- **`scheduleConfigs` → one row per workspace.** Drop the `repoId` column; make `tenantId` `.unique()`. One `cadence` + `threshold` + `lastRunAt` + `nextScheduledAt` for the whole workspace.
- Dev DB holds only disposable test data, so the migration resets `schedule_configs` (no data preservation needed). It must remain incremental against the other tables (no rebuild of `updates`/`change_items`/etc.).

### Engine changes (`src/lib`)

- `getPendingChangeItems(repoId)` → **`getPendingChangeItems(tenantId)`**: all `status='pending'` items across the tenant's repos, ordered by `createdAt` (stable prompt order).
- `claimBatchAndCreateUpdate({ tenantId, repoId, changeItemIds, draft })` → **drop `repoId`**: the transactional claim is unchanged (claim by ids that are still pending; create one Update with `repoId: null`; back-fill `updateId`).
- `runBatchForRepo(repoId, tenantId, pending)` → **`runBatchForWorkspace(tenantId, pending)`**: same generate-with-one-retry, non-throwing, publish-safe contract; returns whether a draft was created.
- `runSchedulerTick`: iterate the **one `scheduleConfig` per tenant**; `pendingCount` = **total** pending across the workspace; `shouldTriggerRun` unchanged (pure); on fire → one `runBatchForWorkspace`; advance `nextScheduledAt` only on a successful cadence fire (unchanged rule).
- `applyPostRunScheduleChoice(repoId, choice)` → **`applyPostRunScheduleChoice(tenantId, choice)`**: skip advances the workspace schedule's `nextScheduledAt` from its current value.
- `serializeBatchForPrompt`: prefix each item with its **source repo** so the model has cross-repo context, e.g. `1. [acme/web · PR #42] "…"`. The per-item repo name is looked up from the batch's repos.

### Unified Pending page (`/pending`)

- **One list** of every pending `ChangeItem` across the workspace, each row labeled with its **source repo** (`acme/web`) alongside the PR title / commit message. Built with shadcn `Table` (or `Card` rows).
- **Header (workspace-level):** next scheduled run (the single `scheduleConfig.nextScheduledAt`) and **total pending vs threshold**.
- **One "Run now"** → `runBatchForWorkspace` over all pending → then the **keep/skip next scheduled run** prompt, now workspace-level (no `repoId`).
- **Drop** stays per-item (already tenant-scoped by `changeItems.tenantId`). The repo switcher is removed.
- Empty states preserved: "no repos connected" (links to Settings) and "nothing pending".
- The per-repo API routes `/api/repos/[repoId]/run-now` and `/api/repos/[repoId]/schedule-choice` collapse to workspace-level routes (e.g. `/api/run-now`, `/api/schedule-choice`) — or are removed if only the dashboard Server Actions use them. (The dashboard uses Server Actions in `pending/actions.ts`; the standalone API routes were Plan 3 scaffolding — they move to workspace-level or are dropped.)

### Searchable branch picker (onboarding + settings)

- New **`listRepoBranches(installationId, repoFullName): Promise<string[]>`** in `src/lib/github.ts` — uses the installation Octokit's `repos.listBranches`, **paginated** to return *all* branches.
- The repo picker's free-text branch `<input>` becomes a shadcn **Combobox** (`Command` inside a `Popover`): type-to-filter, select a real branch. Because a Combobox is a Client Component holding its own selected value, each repo row is a small client component (`RepoRow`) that renders the checkbox + Combobox and **writes the selected branch into a hidden `<input name="repo-N-branch">`** — so the existing `parseRepoSelections` (indexed `repo-N-*` fields) is **unchanged**, and the form still submits to the same Server Action.
- The default selection is the repo's current `watchedBranch` (settings) or GitHub default branch (onboarding).
- The add-repos Server Action **server-validates** each chosen branch against that repo's real branch list (fetched via `listRepoBranches`) and ignores/rejects any branch that isn't real — so selection is effectively constrained even though the value travels as a hidden input.
- **Trade-off (documented):** the picker fetches branches for *every accessible repo* it renders, on page load (no lazy per-repo fetch without more client plumbing). Fine for a handful of repos; may be slow with dozens. Acceptable for this MVP; revisit if repo counts grow.

### Onboarding & Settings schedule

- Onboarding's schedule step and Settings' "Schedule per repo" both become a **single workspace schedule** (one `cadence` + `threshold`), writing the one-per-tenant `scheduleConfig`. Onboarding creates it on finish; Settings edits it (reset the `nextScheduledAt` anchor only when the cadence itself changes, matching today's rule).

### Phase 2 verification

- Update/extend the affected unit + integration tests: `change-item-batch` (tenant-level pending + claim), `run-schedule` (workspace batch + tenant scheduler tick + advance-on-success), plus a `listRepoBranches` pagination test (mocked Octokit) and a branch-validation test.
- `tsc --noEmit` clean; full suite green; `npm run build` compiles.
- Manual E2E (needs the GitHub App + AI key + tunnel, deferred to the operator): connect two repos, accumulate pending items in both, confirm the unified list shows both with repo labels, Run now → one cross-repo draft in Drafts, keep/skip adjusts the single workspace schedule; branch Combobox lists real branches and filters as you type.

---

## Non-goals (unchanged from the MVP, reaffirmed)

- No brand accent color / visual identity (shadcn stays neutral/grayscale).
- No dark mode.
- No client-side data-fetching or global-state library (Server Actions remain the mutation path).
- No read/polling API; webhook remains the only delivery mechanism.
- No per-repo drafts or per-repo schedules after this change — the workspace is the unit.

## Testing strategy

- **Phase 1:** behavior-preserving — the existing 66-test suite must pass unchanged; verification is `tsc`/`build`/visual.
- **Phase 2:** unit/integration tests updated to the tenant-level signatures; new tests for `listRepoBranches` pagination and branch validation; full suite green before merge. Real-GitHub / real-AI E2E remains an operator step.
