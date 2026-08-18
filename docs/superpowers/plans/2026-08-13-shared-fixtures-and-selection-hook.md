# Shared Test Fixtures and a Row-Selection Hook — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Remove the two largest genuine duplications on this branch — the per-file test tenant fixture, and the row-selection state repeated across list components.

**Architecture:** One shared test-helper module for the fixture shapes that are actually uniform, and one `useRowSelection` hook for the list components that actually agree. Both are deliberately scoped *narrower* than the review that prompted them, for reasons measured below.

**Tech Stack:** Vitest (node environment, no jsdom), React 19.2.4, Next.js 16.2.10, Drizzle ORM.

## What was measured, and why the scope is narrower than it looked

The review that prompted this said "28 near-identical `seedTenant` helpers". Checking the code rather than trusting that number:

- **25** `async function seedTenant` declarations, of which 19 are byte-identical (`insert(tenants).values({ name: TENANT }).returning()`), 5 take a `name` parameter, 2 use a differently-named constant, 2 return only `{ id }`. **Genuinely uniform. Safe to share.**
- **129** teardowns of the form `delete(tenants).where(eq(tenants.name, …))`, relying on cascade. Uniform.
- The rest of the family is **not** uniform, despite sharing names:
  - `seedPiece` ×7 — three different signatures (`(tenantId, overrides)` ×4, `()` ×2, `(tenantId)` ×1)
  - `seedSignal` ×3 — three different signatures
  - `seedRepo` ×5 — four different signatures
  - `seedBrief` ×3 — three different signatures
  - plus ~17 one-off domain seeders

**So this plan shares `seedTenant` and the teardown only.** Forcing the divergent seeders into one shape would rewrite test semantics across dozens of files — a large, silent-weakening risk for a cosmetic gain. The `(tenantId, overrides: Partial<typeof table.$inferInsert>)` shape is the best of the existing variants and is offered in the helper module for *new* tests, but **no existing divergent call site is migrated**.

## Global Constraints

- Tests live in `tests/`, mirroring `src/`. Vitest runs `environment: "node"` — **there is no jsdom and none may be added.**
- **The suite is flaky against one shared Postgres.** Re-run a failing file once before believing it. A refactor touching 25 test files must be judged on two full runs, not one.
- Tests must run against a database whose name ends in `_test`.
- **No test may reach the real Anthropic API.**
- Tenant scoping is the security boundary — a refactor must not weaken a cross-tenant assertion. Several tests deliberately seed two tenants; the shared helper must support that.
- **Never import a runtime value from a server module into a `"use client"` file.**
- `npm run build` is a mandatory gate for the hook task.
- Next.js is 16.2.10 with breaking changes vs. training data.
- **The working tree has pre-existing uncommitted changes that are NOT ours:** `src/app/(dashboard)/board/column.tsx`, `src/app/(dashboard)/layout.tsx`, untracked `src/app/(dashboard)/main-container.tsx`. Never `git add -A`.

---

### Task 1: Shared test fixtures

**Files:**
- Create: `tests/helpers/fixtures.ts`
- Modify: the test files declaring their own `seedTenant`

**Produces:** `seedTenant(name)`, `dropTenant(name)`, and the generic `(tenantId, overrides)` seeders for later use.

- [ ] **Step 1: Write the helper module**

```ts
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants } from "../../src/db/schema";

/**
 * Seeds a tenant by name. The name is the cleanup key — `dropTenant` deletes
 * by it and every child row cascades — so each test file must use a name
 * unique to that file, or two files running against this shared Postgres will
 * delete each other's fixtures mid-run.
 */
export async function seedTenant(name: string) {
  const [tenant] = await db.insert(tenants).values({ name }).returning();
  return tenant;
}

/** Teardown counterpart. Cascades to every table keyed on the tenant. */
export async function dropTenant(name: string) {
  await db.delete(tenants).where(eq(tenants.name, name));
}
```

- [ ] **Step 2: Migrate the uniform call sites**

Only files whose local `seedTenant` is equivalent to the above. For each: delete the local declaration, import from the helper, pass the file's existing `TENANT` constant explicitly.

**Do not touch** files whose seeder differs — `seedTenantWithSource`, `seedTenantWithRepo`, `seedTenantAndUser`, and any returning a narrowed selection. Leave those local and say which you skipped.

- [ ] **Step 3: Verify nothing weakened**

Run the full suite **twice**. Confirm the total test count is unchanged from the pre-refactor baseline — record both numbers. A drop means a file stopped running, not that a test was legitimately removed.

- [ ] **Step 4: Commit**

```bash
git add tests/helpers/fixtures.ts tests/
git commit -m "test: share the tenant fixture"
```

---

### Task 2: `useRowSelection`

**Files:**
- Create: `src/app/(dashboard)/_components/use-row-selection.ts` and its test
- Modify: `src/app/(dashboard)/company/atomic-updates-list.tsx`, `company/change-events-list.tsx`

**Produces:** `useRowSelection(rows)` → `{ selected, setSelected, onSelectChange, toggleAll, clear }`.

**What actually duplicates.** `atomic-updates-list.tsx:37` and `change-events-list.tsx:49` carry byte-identical `useState<Set<string>>` + `onSelectChange(id, isSelected)` + `toggleAll(checked)`. Clean extraction.

`signals-list.tsx` is **not** the same: its API is `toggle(id)` rather than `onSelectChange(id, isSelected)`, and it additionally carries a `retainVisible` effect with a documented `react-hooks/set-state-in-effect` suppression plus a selection cap. **Do not force it to adopt the hook** — evaluate it, and if adoption would mean bending either side, leave it and say so.

**The latent bug this surfaces.** `signals-list.tsx` drops selected ids that are no longer in `rows`, because filters navigate via `router.push` — a soft navigation — so the list is never remounted and stale ids would keep riding along invisibly. **The two Company lists have the same soft-navigation filters and no such guard**, so a selection made before a filter change survives it with no row on screen, and a subsequent bulk hide or bulk delete acts on rows the user can no longer see. Confirm this against the code before fixing; if real, the hook carries the retain-visible behaviour and closes it for both.

- [ ] **Step 1: Write failing tests for the hook's pure logic**

No jsdom, so the reducer logic must be pure and exported separately from the hook. Cover: add, remove, toggle-all-on, toggle-all-off, and — if the bug is confirmed — that ids absent from the current rows are dropped.

- [ ] **Step 2: Run them, confirm they fail**

- [ ] **Step 3: Write the hook over that pure core**

- [ ] **Step 4: Adopt in both Company lists**

Behaviour must be identical apart from the retain-visible fix. Diff each file against its pre-change version and confirm nothing beyond the selection wiring moved.

- [ ] **Step 5: Verify**

`npx vitest run` on the new test plus both lists' tests, then `npx tsc --noEmit`, `npm run lint`, and `rm -rf .next && npm run build`.

- [ ] **Step 6: Commit**

## Out of scope

- Migrating the divergent `seedPiece` / `seedSignal` / `seedRepo` / `seedBrief` variants.
- Adding jsdom. It is the highest-leverage test investment on this branch, but it is its own decision.
