# Library Module Organization — Design

**Date:** 2026-07-17
**Status:** Approved (pending spec review)

## Context

`src/lib/` has grown to **29 flat modules** (`wc -l src/lib/*.ts` totals ~1537 lines). They
are imported by ~41 files under `src/app` / `src/components` via the `@/lib/*` alias, by 29
test files via relative paths, and by ~20 lib-internal relative imports. The flat layout makes
navigation harder as the codebase grows.

This is a **pure reorganization**: group modules into domain folders and update import paths.
No module's behavior or internals change.

## Goal

Group `src/lib` modules into cohesive domain folders (mirrored by the test tree) so a
developer can find and reason about related code by folder, without changing any logic.

## Design

### 1. Target structure

```
src/lib/
  ai/
    generation.ts
    compose-prompt.ts
    select-examples.ts
    enrich-change-item.ts
    review-draft.ts
    review-status.ts
  change-items/
    ingest-push.ts
    ingest-pull-request.ts
    import-commits.ts
    change-item-batch.ts
    change-item-display.ts
  integrations/
    github/
      github.ts
      github-webhook.ts
  scheduling/
    run-schedule.ts
    scheduler-decision.ts
    format-schedule.ts
  publishing/
    webhook-delivery.ts
  workspace/
    auth.ts
    session.ts
    tenant.ts
    tenant-bootstrap.ts
    onboarding.ts
    brand-profile.ts
    personas.ts
    persona-form.ts
    repo-sync.ts
    repo-selection-form.ts
  utils.ts          (stays at root — cross-cutting)
  concurrency.ts    (stays at root — cross-cutting)
```

All 29 modules are placed. Deliberate calls:

- **`enrich-change-item` → `ai/`** — it is an LLM call, grouped with the other AI modules even
  though it operates on change items (`change-items/` imports it cross-folder).
- **`review-status` and `change-item-display`** (small UI label helpers) live with their
  domain (`ai/`, `change-items/`) rather than in a separate `ui/` folder.
- **`integrations/github/`** — `github` (REST client) and `github-webhook` (signature verify)
  are external-system connectors; `integrations/` is their parent so future connectors have a
  home.
- **`publishing/webhook-delivery`** — the outbound step that delivers a published update to the
  tenant's endpoint; named by purpose (publishing) rather than the old, unclear `delivery`.
- **`utils` and `concurrency`** are cross-cutting primitives and stay at the `lib/` root.

### 2. Import conventions

- **Deep paths, no barrels.** No `index.ts` re-export files. Consumers import the exact module:
  `@/lib/ai/generation`, `@/lib/change-items/ingest-push`, `@/lib/integrations/github/github`,
  `@/lib/publishing/webhook-delivery`, `@/lib/workspace/session`, etc.
- **Lib-internal imports:** a same-folder sibling uses a relative import (`./compose-prompt`);
  anything crossing a folder boundary, or importing the database, uses the `@/…` alias
  (`@/lib/ai/generation`, `@/db`, `@/db/schema`) — so there are no `../../db` chains.
- The `@/*` → `./src/*` tsconfig alias is unchanged; no new aliases are added.

### 3. Test tree mirrors source

Each test moves to the matching folder and its relative import depth is updated:

```
tests/lib/generation.test.ts        → tests/lib/ai/generation.test.ts
tests/lib/ingest-push.test.ts        → tests/lib/change-items/ingest-push.test.ts
tests/lib/github.test.ts             → tests/lib/integrations/github/github.test.ts
tests/lib/run-schedule.test.ts       → tests/lib/scheduling/run-schedule.test.ts
tests/lib/webhook-delivery.test.ts   → tests/lib/publishing/webhook-delivery.test.ts
tests/lib/auth.test.ts               → tests/lib/workspace/auth.test.ts
… (and so on for every test)
```

A test at `tests/lib/<folder>/x.test.ts` imports its source as `../../../src/lib/<folder>/x`
(one directory deeper than today's `../../src/lib/x`). Tests that import `@/…` (if any) are
unaffected by depth.

### 4. Migration approach

- **`git mv`** every source and test file to its new path (preserves history).
- **Rewrite every import specifier** that references a moved module — across `src/app`,
  `src/components`, `tests`, and other `src/lib` files — to its new deep path, and fix each
  moved module's own imports per the §2 conventions.
- **One folder per step.** After each step, `npx tsc --noEmit`, `npm test`, and `eslint` must
  all be green before committing. This keeps every commit a working tree.
- The suggested order (dependency-light first): `ai/`, `change-items/`, `integrations/github/`,
  `scheduling/`, `publishing/`, `workspace/`. Order is not strictly required because each step
  fully reconciles all references, but this order minimizes churn between steps.

## Scope boundaries (explicitly NOT in this work)

- **No behavior changes and no internal refactoring** — only file relocation and import-path
  updates. Module contents are otherwise byte-identical.
- **No barrel/`index.ts` files.**
- **`utils.ts` and `concurrency.ts` are not moved.**
- **No colocation into `src/app` route folders** — everything stays under `src/lib`.
- **No new tsconfig path aliases.**

## Verification

Green `npx tsc --noEmit`, full `npm test` (currently **145 passing**), and `eslint` after every
folder step and once at the end. Because there are no logic changes, an unchanged passing test
suite is the correctness bar.

## Accepted trade-offs

1. **Wide but shallow churn** — most `@/lib/*` importers change a path segment. Mitigated by
   doing it folder-by-folder with a green build gate at each commit, so a mistake is caught
   immediately and localized.
2. **`workspace/` is the loosest bucket** (auth + tenant + brand + repos, 10 files) — accepted
   as the medium-granularity trade-off; it can be split later if it grows.
