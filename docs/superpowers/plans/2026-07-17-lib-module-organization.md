# Library Module Organization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group `src/lib`'s 29 flat modules into domain folders (mirrored by the test tree) and update all import paths — a pure relocation with zero logic changes.

**Architecture:** `git mv` files into domain folders; rewrite import specifiers per fixed conventions; gate every folder's commit on green `tsc` + full test suite. `tsc --noEmit` is the completeness oracle — it flags every un-updated import.

**Tech Stack:** TypeScript (Next.js App Router), Vitest, Drizzle. Platform: macOS (`sed -i ''`).

## Global Constraints

- **Pure move.** No module's contents change except its import specifiers. No barrels, no new tsconfig aliases, no colocation into `app/`.
- **`utils.ts` and `concurrency.ts` stay at `src/lib/` root** (and `tests/lib/concurrency.test.ts` stays at `tests/lib/` root).
- **Import conventions:** a same-folder sibling → relative `./sibling`; anything crossing a folder, or importing the database → the `@/…` alias (`@/lib/<folder>/<mod>`, `@/db`, `@/db/schema`). **Tests always use relative paths** (the `@/` alias is not configured for Vitest) at their new depth.
- **Hard gate per folder:** `npx tsc --noEmit` reports **0 errors** AND `npm test` is **fully green** (currently **145 passing**) before committing. Run `npm run lint` too if it exists.
- Preserve history: move with `git mv`, never delete-and-recreate.

## Master module → import-path mapping

Every import of a module — whether written `@/lib/<mod>`, `./<mod>`, `../<mod>`, or (in a test) `../../src/lib/<mod>` — is rewritten to this module's canonical location. Same-folder siblings keep a relative `./` form; everything else uses the alias shown (tests use the relative equivalent at their depth).

| Module | New location / alias |
|---|---|
| generation, compose-prompt, select-examples, enrich-change-item, review-draft, review-status | `@/lib/ai/<mod>` |
| ingest-push, ingest-pull-request, import-commits, change-item-batch, change-item-display | `@/lib/change-items/<mod>` |
| github, github-webhook | `@/lib/integrations/github/<mod>` |
| run-schedule, scheduler-decision, format-schedule | `@/lib/scheduling/<mod>` |
| webhook-delivery | `@/lib/publishing/webhook-delivery` |
| auth, session, tenant, tenant-bootstrap, onboarding, brand-profile, personas, persona-form, repo-sync, repo-selection-form | `@/lib/workspace/<mod>` |
| utils, concurrency | `@/lib/<mod>` (unchanged — stay at root) |

## Task ordering — why this sequence

A module's importers can only be pointed at its **new** path once that module has actually moved (otherwise the alias resolves to a not-yet-existing file and the `tsc` gate fails). So every target moves **before** the folders that depend on it:

1. **ai** — depends on nothing in `lib` (only `db`, root `concurrency`).
2. **integrations/github** — no `lib` deps.
3. **publishing** — no `lib` deps.
4. **workspace** — no cross-folder deps (internal `auth→tenant-bootstrap→tenant` chain only).
5. **change-items** — depends on `ai` (enrich-change-item), `integrations/github` (github) → both already moved.
6. **scheduling** — `run-schedule` depends on `ai`, `change-items`, `workspace`, `publishing` → all already moved.

Each task rewrites the **relative** importers of *its own* modules (which still live in flat `lib` until their own task) to the new alias — pointing at the just-moved files. Alias importers (from `app`/`components`) are rewritten with `sed`.

## Universal transformation rules (applied in every task)

1. **`git mv`** each source file into `src/lib/<folder>/` and each test into `tests/lib/<folder>/` (create dirs first).
2. **Moved source files' own imports:** `../db` → `@/db`; `../db/schema` → `@/db/schema`; a relative import of a module in a *different* folder → that module's alias (per the table); a relative import of a *same-folder* module → `./<mod>`.
3. **Moved test files' imports:** every `../../src/…` goes one level deeper (`../../../src/…`, and `../../../../src/…` for the two-deep `integrations/github`), and each `src/lib/<mod>` import gains its folder segment per the table. `vi.mock("…/src/lib/<mod>")` paths update identically.
4. **External references to the moved modules** (from `src/app`, `src/components`, and any still-flat `src/lib` file): rewrite to the module's alias. Alias importers via `sed`; the specific still-flat relative importers are listed per task.
5. **Gate:** `npx tsc --noEmit` (0 errors — fix every flagged import to its table location), then `npm test` (all green), then commit.

`sed` recipe for alias importers of module `M` → folder `F` (anchored on the trailing quote so `github` never matches `github-webhook`):

```bash
grep -rl "@/lib/M\"" src tests | xargs -r sed -i '' 's#@/lib/M"#@/lib/F/M"#g'
```

---

### Task 1: `ai/`

**Modules:** generation, compose-prompt, select-examples, enrich-change-item, review-draft, review-status.

- [ ] **Step 1: Move sources and tests**

```bash
mkdir -p src/lib/ai tests/lib/ai
git mv src/lib/generation.ts src/lib/compose-prompt.ts src/lib/select-examples.ts src/lib/enrich-change-item.ts src/lib/review-draft.ts src/lib/review-status.ts src/lib/ai/
git mv tests/lib/generation.test.ts tests/lib/compose-prompt.test.ts tests/lib/select-examples.test.ts tests/lib/enrich-change-item.test.ts tests/lib/review-draft.test.ts tests/lib/review-status.test.ts tests/lib/system-update-examples.test.ts tests/lib/update-review-columns.test.ts tests/lib/ai/
```

(`system-update-examples` and `update-review-columns` are schema tests for the examples catalog and review columns — they belong with the `ai` domain.)

- [ ] **Step 2: Fix moved source imports** (rule 2)

- `ai/generation.ts`: `../db/schema` → `@/db/schema`. Keep `./compose-prompt` (same folder).
- `ai/compose-prompt.ts`: `../db/schema` → `@/db/schema`.
- `ai/select-examples.ts`: `../db/schema` → `@/db/schema`.
- `ai/review-draft.ts`: `../db/schema` → `@/db/schema`. Keep `./generation` (same folder).
- `ai/enrich-change-item.ts`, `ai/review-status.ts`: no db/relative imports — no change.

- [ ] **Step 3: Fix still-flat relative importers of ai modules**

- `src/lib/run-schedule.ts`: `./generation` → `@/lib/ai/generation`; `./select-examples` → `@/lib/ai/select-examples`; `./review-draft` → `@/lib/ai/review-draft`.
- `src/lib/change-item-batch.ts`: `./review-draft` → `@/lib/ai/review-draft`.
- `src/lib/ingest-push.ts`, `src/lib/ingest-pull-request.ts`, `src/lib/import-commits.ts`: `./enrich-change-item` → `@/lib/ai/enrich-change-item`.

- [ ] **Step 4: Rewrite alias importers + moved-test paths**

```bash
for m in generation compose-prompt select-examples enrich-change-item review-draft review-status; do
  grep -rl "@/lib/$m\"" src tests | xargs -r sed -i '' "s#@/lib/$m\"#@/lib/ai/$m\"#g"
done
```

(Of these, only `review-status` is imported by the app via `@/lib`; the other seds are harmless no-ops.) Apply rule 3 to the 8 moved tests: `../../src/…` → `../../../src/…`, with `src/lib/<mod>` gaining its folder segment (e.g. `../../../src/lib/ai/generation`, `../../../src/db`, `../../../src/db/schema`).

- [ ] **Step 5: Gate + commit**

```bash
npx tsc --noEmit   # 0 errors — fix any flagged import to its table location, then re-run
npm test           # all green
git add -A && git commit -m "refactor: group ai modules under lib/ai"
```

---

### Task 2: `integrations/github/`

**Modules:** github, github-webhook.

- [ ] **Step 1: Move sources and tests**

```bash
mkdir -p src/lib/integrations/github tests/lib/integrations/github
git mv src/lib/github.ts src/lib/github-webhook.ts src/lib/integrations/github/
git mv tests/lib/github.test.ts tests/lib/github-webhook.test.ts tests/lib/integrations/github/
```

- [ ] **Step 2: Fix moved source imports** (rule 2)

- `github.ts` (imports `octokit`) and `github-webhook.ts` (imports `@octokit/webhooks-methods`): no internal/db imports — no change.

- [ ] **Step 3: Fix still-flat relative importers of github modules**

- `src/lib/ingest-push.ts` and `src/lib/import-commits.ts`: `./github` → `@/lib/integrations/github/github`. (`ingest-pull-request.ts` does not import github.)

- [ ] **Step 4: Rewrite alias importers + moved-test paths**

```bash
for m in github github-webhook; do
  grep -rl "@/lib/$m\"" src tests | xargs -r sed -i '' "s#@/lib/$m\"#@/lib/integrations/github/$m\"#g"
done
```

(Trailing-quote anchor keeps `@/lib/github"` from matching `@/lib/github-webhook"`.) The 2 moved tests are now **two** folders deep (`tests/lib/integrations/github/`), so their `../../src/…` becomes `../../../../src/…` and the module import is `../../../../src/lib/integrations/github/<mod>`.

- [ ] **Step 5: Gate + commit**

```bash
npx tsc --noEmit && npm test
git add -A && git commit -m "refactor: group github modules under lib/integrations/github"
```

---

### Task 3: `publishing/`

**Modules:** webhook-delivery.

- [ ] **Step 1: Move source and test**

```bash
mkdir -p src/lib/publishing tests/lib/publishing
git mv src/lib/webhook-delivery.ts src/lib/publishing/
git mv tests/lib/webhook-delivery.test.ts tests/lib/publishing/
```

- [ ] **Step 2: Fix moved source imports** (rule 2)

- `webhook-delivery.ts`: `../db` → `@/db`; `../db/schema` → `@/db/schema`.

- [ ] **Step 3: Fix still-flat relative importers of webhook-delivery**

- `src/lib/run-schedule.ts`: `./webhook-delivery` → `@/lib/publishing/webhook-delivery`.

- [ ] **Step 4: Rewrite alias importers + moved-test path**

```bash
grep -rl "@/lib/webhook-delivery\"" src tests | xargs -r sed -i '' 's#@/lib/webhook-delivery"#@/lib/publishing/webhook-delivery"#g'
```

Apply rule 3 to `tests/lib/publishing/webhook-delivery.test.ts`.

- [ ] **Step 5: Gate + commit**

```bash
npx tsc --noEmit && npm test
git add -A && git commit -m "refactor: move webhook delivery under lib/publishing"
```

---

### Task 4: `workspace/`

**Modules:** auth, session, tenant, tenant-bootstrap, onboarding, brand-profile, personas, persona-form, repo-sync, repo-selection-form.

- [ ] **Step 1: Move sources and tests**

```bash
mkdir -p src/lib/workspace tests/lib/workspace
git mv src/lib/auth.ts src/lib/session.ts src/lib/tenant.ts src/lib/tenant-bootstrap.ts src/lib/onboarding.ts src/lib/brand-profile.ts src/lib/personas.ts src/lib/persona-form.ts src/lib/repo-sync.ts src/lib/repo-selection-form.ts src/lib/workspace/
git mv tests/lib/auth.test.ts tests/lib/session.test.ts tests/lib/tenant.test.ts tests/lib/tenant-bootstrap.test.ts tests/lib/onboarding.test.ts tests/lib/brand-profile.test.ts tests/lib/personas.test.ts tests/lib/persona-form.test.ts tests/lib/repo-sync.test.ts tests/lib/repo-selection-form.test.ts tests/lib/workspace/
```

- [ ] **Step 2: Fix moved source imports** (rule 2)

- `brand-profile.ts`, `onboarding.ts`, `repo-sync.ts`, `tenant-bootstrap.ts`: `../db` → `@/db`; `../db/schema` → `@/db/schema`.
- Keep same-folder chains relative: `tenant-bootstrap.ts` `./tenant`; `auth.ts` `./tenant-bootstrap`; `session.ts` `./auth`.
- `personas.ts` / `persona-form.ts` already import `@/db/schema` (alias) — no change. `tenant.ts`, `repo-selection-form.ts`: convert any `../db*` to `@/db*` if present (the `tsc` gate confirms).

- [ ] **Step 3: Fix still-flat relative importers of workspace modules**

- `src/lib/run-schedule.ts`: `./brand-profile` → `@/lib/workspace/brand-profile`; `./personas` → `@/lib/workspace/personas`.
  (All other workspace modules are only referenced by `app` via `@/lib` — handled by `sed` — or within the same-folder `auth`/`session`/`tenant` chain.)

- [ ] **Step 4: Rewrite alias importers + moved-test paths**

```bash
for m in auth session tenant tenant-bootstrap onboarding brand-profile personas persona-form repo-sync repo-selection-form; do
  grep -rl "@/lib/$m\"" src tests | xargs -r sed -i '' "s#@/lib/$m\"#@/lib/workspace/$m\"#g"
done
```

(Trailing-quote anchor keeps `@/lib/tenant"` from matching `@/lib/tenant-bootstrap"`.) Apply rule 3 to the 10 moved tests.

- [ ] **Step 5: Gate + commit**

```bash
npx tsc --noEmit && npm test
git add -A && git commit -m "refactor: group workspace modules under lib/workspace"
```

---

### Task 5: `change-items/`

**Modules:** ingest-push, ingest-pull-request, import-commits, change-item-batch, change-item-display.

By now `ai` and `integrations/github` are moved, so these files' cross-folder imports (`enrich-change-item`, `github`, `review-draft`) were already converted to aliases in Tasks 1–2 and point at real files.

- [ ] **Step 1: Move sources and tests**

```bash
mkdir -p src/lib/change-items tests/lib/change-items
git mv src/lib/ingest-push.ts src/lib/ingest-pull-request.ts src/lib/import-commits.ts src/lib/change-item-batch.ts src/lib/change-item-display.ts src/lib/change-items/
git mv tests/lib/ingest-push.test.ts tests/lib/ingest-pull-request.test.ts tests/lib/import-commits.test.ts tests/lib/change-item-batch.test.ts tests/lib/change-item-display.test.ts tests/lib/change-item-enrichment-columns.test.ts tests/lib/change-items/
```

(`change-item-enrichment-columns` is the schema test for the change-items enrichment columns.)

- [ ] **Step 2: Fix moved source imports** (rule 2)

- `ingest-push.ts`, `ingest-pull-request.ts`, `import-commits.ts`, `change-item-batch.ts`: `../db` → `@/db`; `../db/schema` → `@/db/schema`. Their `@/lib/ai/enrich-change-item`, `@/lib/integrations/github/github`, `@/lib/ai/review-draft`, and `@/lib/concurrency` imports are already correct — leave them.
- `change-item-display.ts`: no imports — no change.

- [ ] **Step 3: Fix still-flat relative importers of change-items modules**

- `src/lib/run-schedule.ts`: `./change-item-batch` → `@/lib/change-items/change-item-batch`.

- [ ] **Step 4: Rewrite alias importers + moved-test paths**

```bash
for m in ingest-push ingest-pull-request import-commits change-item-batch change-item-display; do
  grep -rl "@/lib/$m\"" src tests | xargs -r sed -i '' "s#@/lib/$m\"#@/lib/change-items/$m\"#g"
done
```

Apply rule 3 to the 6 moved tests (their `enrich-change-item` imports become `../../../src/lib/ai/enrich-change-item`, etc.).

- [ ] **Step 5: Gate + commit**

```bash
npx tsc --noEmit && npm test
git add -A && git commit -m "refactor: group change-item modules under lib/change-items"
```

---

### Task 6: `scheduling/`

**Modules:** run-schedule, scheduler-decision, format-schedule.

By now every module `run-schedule` imports (`ai`, `change-items`, `workspace`, `publishing`) is moved, and `run-schedule`'s imports of them were converted to aliases in Tasks 1–5. Only its `db` imports and the same-folder `scheduler-decision` remain.

- [ ] **Step 1: Move sources and tests**

```bash
mkdir -p src/lib/scheduling tests/lib/scheduling
git mv src/lib/run-schedule.ts src/lib/scheduler-decision.ts src/lib/format-schedule.ts src/lib/scheduling/
git mv tests/lib/run-schedule.test.ts tests/lib/scheduler-decision.test.ts tests/lib/format-schedule.test.ts tests/lib/auto-publish.test.ts tests/lib/scheduling/
```

(`auto-publish.test.ts` exercises `runBatchForWorkspace` — it belongs with `scheduling`.)

- [ ] **Step 2: Fix moved source imports** (rule 2)

- `run-schedule.ts`: `../db` → `@/db`; `../db/schema` → `@/db/schema`; keep `./scheduler-decision` (same folder). All other imports are already aliases from earlier tasks — leave them.
- `scheduler-decision.ts`, `format-schedule.ts`: no db/relative imports — no change.

- [ ] **Step 3: Fix still-flat relative importers of scheduling modules**

- None — no other `lib` file relative-imports a scheduling module (`run-schedule` is referenced only by `app` via `@/lib` and by tests).

- [ ] **Step 4: Rewrite alias importers + moved-test paths**

```bash
for m in run-schedule scheduler-decision format-schedule; do
  grep -rl "@/lib/$m\"" src tests | xargs -r sed -i '' "s#@/lib/$m\"#@/lib/scheduling/$m\"#g"
done
```

Apply rule 3 to the 4 moved tests. `run-schedule.test.ts` and `auto-publish.test.ts` import several cross-folder modules and mock `review-draft`; map each per the master table at the new `../../../src/` depth (e.g. `../../../src/lib/change-items/change-item-batch`, `vi.mock("../../../src/lib/ai/review-draft")`).

- [ ] **Step 5: Final gate + commit**

```bash
npx tsc --noEmit   # 0 errors across the whole tree
npm test           # all 145 green
git add -A && git commit -m "refactor: group scheduling modules under lib/scheduling"
```

- [ ] **Step 6: Whole-tree sanity check**

```bash
ls src/lib/*.ts   # expect ONLY utils.ts and concurrency.ts
grep -rnE '@/lib/(generation|compose-prompt|select-examples|enrich-change-item|review-draft|review-status|ingest-push|ingest-pull-request|import-commits|change-item-batch|change-item-display|github|github-webhook|run-schedule|scheduler-decision|format-schedule|webhook-delivery|auth|session|tenant|tenant-bootstrap|onboarding|brand-profile|personas|persona-form|repo-sync|repo-selection-form)"' src tests || echo "clean"
```

Expected: only `utils.ts` / `concurrency.ts` remain flat; the grep prints `clean` (every alias now carries a folder segment).

---

## Self-Review

**Spec coverage:**
- Target structure (6 folders incl. `integrations/github/` and `publishing/`; `utils`/`concurrency` at root) → master table + Tasks 1–6. ✓
- Import conventions (deep paths, no barrels; same-folder relative / cross-folder+db alias; tests relative) → Global Constraints + rules 2–4. ✓
- Test tree mirrors source, incl. depth updates and the three schema/DB tests + `auto-publish` mapped to their domains → each task's git mv + rule 3. ✓
- `git mv`, folder-by-folder, green `tsc`+`test` gate per commit → each task's Step 5. ✓
- Zero logic changes → only import specifiers edited; the unchanged 145-test suite is the correctness bar. ✓

**Placeholder scan:** No TBD/TODO. Every `git mv` is exact; every import fix is an explicit file:old→new or an unambiguous rule (2–4) plus the `tsc`-0-errors gate. ✓

**Consistency / ordering check (the critical one):** Targets move before dependents (ai, github, publishing, workspace all before change-items and scheduling), so no task rewrites an importer to a path that doesn't exist yet. Each folder's still-flat relative importers are converted to the just-moved alias in that same task's Step 3. The trailing-quote `sed` anchor is called out for both prefix-collision pairs (`github`/`github-webhook`, `tenant`/`tenant-bootstrap`). Test depth is `../../../src` for one-level folders and `../../../../src` for `integrations/github`. ✓

**Ordering:** ai → integrations/github → publishing → workspace → change-items → scheduling. Every commit is independently green; the `tsc` gate at each Step 5 forbids committing a broken tree.
