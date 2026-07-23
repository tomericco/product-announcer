# Atomic-Update Sizing + Size-Aware Composer + Category Rename — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every atomic update a size (S/M/L/XL) that the release composer uses to allocate space (XL leads, S's grouped into a list), and rename the category enum to `new`/`improvement`/`fix`/`announcement`.

**Architecture:** Category rename first (enum + migration + all references + rubrics + labels). Then the size axis: schema, LLM generation (resolver + regenerate-summary) with a two-independent-freeze apply, manual size/category controls on the card, and finally the size-aware composer.

**Tech Stack:** Drizzle ORM + Postgres (hand-authored enum migration for renames), Vercel AI SDK `generateObject` (Zod schemas), Next.js server actions + shadcn `Select`, Vitest (all LLM calls injected/mocked).

## Global Constraints

- No test may reach the live Anthropic API — inject/mock every model call (resolver, regenerate-summary, enrichment) as the existing tests do.
- Client components must not import `@/db`/pg; card controls call server actions; the composer reads size server-side.
- Server actions derive tenant/user from the session; mutations are tenant- and `status='open'`-scoped. Released atomic updates are never edited or re-derived.
- Size values are the lowercase enum `s|m|l|xl`, displayed uppercase. Category values are `new|improvement|fix|announcement`, displayed Title-cased.
- Sizing basis = user-facing significance (not code volume). A `null` size composes as **M**.
- Test DB = Docker `product-announcer-postgres` :5434; apply migrations with `npm run db:migrate:test`. If `ECONNREFUSED :5434`: `open -a Docker`; `docker start product-announcer-postgres`.

## File Structure

- `src/db/schema.ts` + generated/hand-authored migrations — enum rename (Task 1), size enum + columns (Task 2).
- `src/lib/ai/enrich-change-item.ts`, `src/lib/ai/resolve-atomic-updates.ts` — category rubric+enum (Task 1), resolver size (Task 3).
- `src/lib/ai/regenerate-atomic-summary.ts` — size in schema/rubric + two-freeze refresh (Task 3).
- `src/lib/change-events/apply-resolution.ts` — persist size on create (Task 3).
- `src/app/(dashboard)/atomic-updates/actions.ts` — row shape + `setAtomicUpdateSize`/`setAtomicUpdateCategory` (Task 4).
- `src/app/(dashboard)/atomic-updates/atomic-update-card.tsx`, `page.tsx` — selectors + badges + labels (Tasks 1 & 4).
- `src/lib/ai/compose-prompt.ts` + prompt build sites (`run-schedule.ts`, `catch-up.ts`, `release-claim.ts`) — size-aware composer (Task 5).

---

### Task 1: Category rename → `new` / `improvement` / `fix` / `announcement`

**Files:**
- Modify: `src/db/schema.ts:50` (enum) + a migration
- Modify: `src/lib/ai/enrich-change-item.ts`, `src/lib/ai/resolve-atomic-updates.ts` (schema enums + rubrics + types)
- Modify: `src/lib/ai/compose-prompt.ts`, `src/app/(dashboard)/atomic-updates/actions.ts` (category unions)
- Modify: `src/app/(dashboard)/atomic-updates/page.tsx` (`CATEGORY_LABEL`)
- Modify: any other file with `"improved"`/`"fixed"` category literals (grep)
- Test: extend `tests/lib/ai/*` enrichment/resolver tests if they assert category values; `db:migrate:test`

**Interfaces:**
- Produces: `updateCategoryEnum = ["new","improvement","fix","announcement"]`; every category union/`z.enum` includes the four values.

- [ ] **Step 1: Change the enum in schema.ts**

```ts
export const updateCategoryEnum = pgEnum("update_category", ["new", "improvement", "fix", "announcement"]);
```

- [ ] **Step 2: Generate the migration, then hand-fix the category SQL**

Run: `npm run db:generate` (drives the interactive prompt via pty if it asks). Drizzle cannot infer enum-value *renames* — it will emit destructive/incorrect SQL for `update_category`. **Replace the category-enum statements in the generated `.sql`** with the safe, data-preserving form:

```sql
ALTER TYPE "update_category" RENAME VALUE 'improved' TO 'improvement';
ALTER TYPE "update_category" RENAME VALUE 'fixed' TO 'fix';
ALTER TYPE "update_category" ADD VALUE 'announcement';
```

`RENAME VALUE` updates every existing row (all three columns) atomically; `ADD VALUE` is additive. Keep the drizzle **snapshot** as generated (it reflects the final four-value enum). If drizzle produced no other statements for this diff, the migration is exactly these three lines.

Apply: `npm run db:migrate` and `npm run db:migrate:test`.

- [ ] **Step 3: Rename the value literals + extend the enums everywhere (typecheck-driven)**

Run: `grep -rn '"improved"\|"fixed"' src` and change every **category** occurrence (`improved`→`improvement`, `fixed`→`fix`). Verify each hit is a category value, not an unrelated string. Concretely:

- `enrich-change-item.ts`: `EnrichmentResult.suggestedCategory` union → `"new" | "improvement" | "fix" | "announcement" | null`; `EnrichmentSchema` → `z.enum(["new", "improvement", "fix", "announcement"]).nullable()`.
- `resolve-atomic-updates.ts`: `ResolutionAction` create `category` union and `ActionSchema` create `z.enum` → the four values.
- `compose-prompt.ts`: `AtomicUpdateForPrompt.category` union → the four values.
- `atomic-updates/actions.ts`: `AtomicUpdateRow.category` union (and the inner `listAtomicUpdates`/`listHiddenAtomicUpdates` type literals at lines ~24 and ~175) → the four values.

`npm run typecheck` after this step is the checklist — it fails until every union matches the enum.

- [ ] **Step 4: Update the LLM rubrics to describe all four categories**

`enrich-change-item.ts` `ENRICHMENT_SYSTEM` — replace the `suggestedCategory` line with:
```ts
  "and pick suggestedCategory: 'new' (a new capability), 'improvement' (better existing behavior),",
  "'fix' (a bug fix), or 'announcement' (a user-facing notice rather than a feature/fix — a deprecation,",
  "a sunset/removal, a pricing/policy change, or an availability/'now in X' heads-up; pick this only when the",
  "change is fundamentally an announcement, not a code capability).",
```

`resolve-atomic-updates.ts` `RESOLVER_SYSTEM` — replace the category line with:
```ts
  "When you create a new atomic update, also pick category: 'new' (a new capability), 'improvement' (better",
  "existing behavior), 'fix' (a bug fix), or 'announcement' (a user-facing notice rather than a feature/fix:",
  "a deprecation, a sunset/removal, a pricing/policy change, or an availability heads-up).",
```

- [ ] **Step 5: Update display labels**

`atomic-updates/page.tsx`:
```ts
export const CATEGORY_LABEL: Record<string, string> = {
  new: "New",
  improvement: "Improvement",
  fix: "Fix",
  announcement: "Announcement",
};
```

- [ ] **Step 6: Fix any tests asserting old category values, then verify**

Grep tests for `"improved"`/`"fixed"` category literals (e.g. resolver/enrichment tests) and update. Run: `npm test`; `npm run typecheck`; `npm run lint`; `npm run build`. Grep-confirm no stale category literals: `grep -rn '"improved"\|"fixed"' src tests` returns nothing category-related.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: rename update category to new/improvement/fix/announcement"
```

---

### Task 2: Size schema (enum + columns + migration)

**Files:**
- Modify: `src/db/schema.ts`
- Create: a generated migration
- Test: `db:migrate:test`

**Interfaces:**
- Produces: `atomicUpdateSizeEnum = pgEnum("atomic_update_size", ["s","m","l","xl"])`; `atomic_updates.size` (nullable), `atomic_updates.size_edited_at` (nullable timestamptz).

- [ ] **Step 1: Add the enum + columns**

In `schema.ts`, near `atomicUpdateStatusEnum`:
```ts
export const atomicUpdateSizeEnum = pgEnum("atomic_update_size", ["s", "m", "l", "xl"]);
```
In the `atomicUpdates` table, after `category`:
```ts
  size: atomicUpdateSizeEnum("size"),
  // Non-null freezes size against re-derivation — the size analogue of
  // summaryEditedAt. Set when a user manually picks a size on the card.
  sizeEditedAt: timestamp("size_edited_at", { withTimezone: true }),
```

- [ ] **Step 2: Generate + apply the migration**

Run: `npm run db:generate` (this diff is additive — a `CREATE TYPE "atomic_update_size"` + two `ALTER TABLE atomic_updates ADD COLUMN`; no prompt expected). Then `npm run db:migrate` and `npm run db:migrate:test`.

- [ ] **Step 3: Verify + commit**

Run: `npm run typecheck` (clean). Add a one-line assertion to `tests/db/atomic-updates-schema.test.ts` (or the nearest schema test) that an atomic update inserts with a `size` of `"m"` and reads it back, if that file's pattern makes it cheap; otherwise rely on migrate:test + typecheck.

```bash
git add -A
git commit -m "feat: add atomic_update size + size_edited_at columns"
```

---

### Task 3: Size generation (resolver + regenerate) with two independent freezes

**Files:**
- Modify: `src/lib/ai/resolve-atomic-updates.ts` (create action + rubric)
- Modify: `src/lib/change-events/apply-resolution.ts` (persist size on create)
- Modify: `src/lib/ai/regenerate-atomic-summary.ts` (schema + rubric + return type + `refreshAtomicUpdates` two-freeze)
- Test: `tests/lib/ai/…` resolver + regenerate; `tests/lib/change-events/…` refresh/reassign paths

**Interfaces:**
- Consumes: the size enum (Task 2).
- Produces: resolver `create` action carries `size`; `regenerateAtomicSummary` returns `{ title, summary, size }`; `refreshAtomicUpdates` writes size respecting `sizeEditedAt`.
- **Shared sizing rubric** (paste into both `RESOLVER_SYSTEM` and `SUMMARY_SYSTEM`):
  ```
  Also pick a size by USER-FACING SIGNIFICANCE (not amount of code): 's' (a minor fix, tweak, or polish —
  small individual user impact), 'm' (a standard improvement or small feature noticeable to users of that
  area), 'l' (a significant feature or major improvement worth calling out to many users), 'xl' (a flagship
  or headline change — a major new capability or overhaul you would lead an announcement with).
  ```

- [ ] **Step 1: Add size to the resolver create action + rubric**

`resolve-atomic-updates.ts`:
- `ResolutionAction` create variant: add `size: "s" | "m" | "l" | "xl";`.
- `ActionSchema` create: add `size: z.enum(["s", "m", "l", "xl"]),`.
- Append the shared sizing rubric to `RESOLVER_SYSTEM`.

- [ ] **Step 2: Persist size when apply-resolution creates an atomic update**

`apply-resolution.ts` (the `insert(atomicUpdates).values({ … title, summary, category })` for a `create` action): add `size: action.size,`.

- [ ] **Step 3: Write the failing test for the resolver size**

Extend the resolver test (`tests/lib/ai/resolve-atomic-updates.test.ts` or wherever the resolver is tested with a mocked model): assert a `create` action's `size` flows through `resolveAtomicUpdates` (mock the model to return a create action with `size: "l"`, assert it survives the validation filters). If apply-resolution has a DB test, assert the inserted row's `size`.

Run: `npm test -- <resolver test>` → FAIL (schema/type mismatch until Step 1–2 land). Then confirm PASS.

- [ ] **Step 4: Add size to regenerateAtomicSummary**

`regenerate-atomic-summary.ts`:
- `AtomicSummarySchema` → `z.object({ title: z.string(), summary: z.string(), size: z.enum(["s","m","l","xl"]) })`.
- Append the shared sizing rubric to `SUMMARY_SYSTEM`.
- `regenerateAtomicSummary` return type → `{ title: string; summary: string; size: "s"|"m"|"l"|"xl" } | null`; return `{ title: object.title.trim(), summary: object.summary.trim(), size: object.size }`.

- [ ] **Step 5: Two-independent-freeze `refreshAtomicUpdates`**

Rewrite `refreshAtomicUpdates`'s per-id body so the LLM call runs unless BOTH freezes are set, and each field is written under its own freeze via TWO gated updates. Add `or` to the drizzle import.

```ts
export async function refreshAtomicUpdates(
  database: Database,
  tenantId: string,
  atomicUpdateIds: string[]
): Promise<void> {
  for (const id of new Set(atomicUpdateIds)) {
    const [atomic] = await database
      .select()
      .from(atomicUpdates)
      .where(
        and(
          eq(atomicUpdates.id, id),
          eq(atomicUpdates.tenantId, tenantId),
          eq(atomicUpdates.status, "open"),
          // Run unless BOTH title/summary and size are frozen.
          or(isNull(atomicUpdates.summaryEditedAt), isNull(atomicUpdates.sizeEditedAt))
        )
      )
      .limit(1);
    if (!atomic) continue;

    const evidenceRows = await database
      .select({
        type: changeEvents.type,
        prTitle: changeEvents.prTitle,
        commitMessage: changeEvents.commitMessage,
        impactSummary: changeEvents.impactSummary,
      })
      .from(changeEvents)
      .where(eq(changeEvents.atomicUpdateId, id));

    const evidence: AtomicEvidence[] = evidenceRows.map((r) => ({
      type: r.type,
      title: r.prTitle ?? r.commitMessage ?? "",
      summary: r.impactSummary,
    }));
    if (evidence.length === 0) continue;

    const next = await regenerateAtomicSummary({
      tenantId,
      current: { title: atomic.title, summary: atomic.summary },
      evidence,
    });
    if (!next) continue;

    const now = new Date();
    // Two independent, self-gated updates: each re-checks its own freeze (and
    // open status) so a concurrent hand-edit mid-model-call suppresses only the
    // field the user touched — and a release claim suppresses both.
    await database
      .update(atomicUpdates)
      .set({ title: next.title, summary: next.summary, updatedAt: now })
      .where(and(eq(atomicUpdates.id, id), eq(atomicUpdates.status, "open"), isNull(atomicUpdates.summaryEditedAt)));
    await database
      .update(atomicUpdates)
      .set({ size: next.size, updatedAt: now })
      .where(and(eq(atomicUpdates.id, id), eq(atomicUpdates.status, "open"), isNull(atomicUpdates.sizeEditedAt)));
  }
}
```

Note: `forceRegenerate` (in `reassign.ts`) clears `summaryEditedAt` but NOT `sizeEditedAt` — a manual size survives an evidence edit, by design. No change needed there.

- [ ] **Step 6: Write the two-freeze tests**

Extend `tests/lib/ai/regenerate-atomic-summary.test.ts` (or wherever `refreshAtomicUpdates` is tested with an injected/mocked `regenerateAtomicSummary`/model). Seed an open atomic update + one change event, mock the summary generation to return `{ title:"T2", summary:"S2", size:"l" }`, and assert:
  - (a) neither frozen → title/summary AND size all updated to the new values;
  - (b) `summaryEditedAt` set, `sizeEditedAt` null → size becomes `l`, title/summary unchanged;
  - (c) `sizeEditedAt` set, `summaryEditedAt` null → title/summary updated, size unchanged;
  - (d) both set → nothing changes (and, ideally, the model isn't called).

Run the test → FAIL first (before Step 5), then PASS. Also run the existing `regenerate`/`reassign`/`create-from-events`/`add-events` tests to confirm the added `size` field and new gate didn't break them.

- [ ] **Step 7: Verify + commit**

Run: `npm test`; `npm run typecheck`; `npm run lint`; `npm run build`.

```bash
git add -A
git commit -m "feat: LLM-derived atomic-update size with an independent size freeze"
```

---

### Task 4: Manual size/category controls + badges

**Files:**
- Modify: `src/app/(dashboard)/atomic-updates/actions.ts` (row `size`, `setAtomicUpdateSize`, `setAtomicUpdateCategory`)
- Modify: `src/app/(dashboard)/atomic-updates/atomic-update-card.tsx` (selectors + size badge)
- Test: `tests/app/atomic-updates-actions.test.ts`

**Interfaces:**
- Consumes: size columns (Task 2), `CATEGORY_LABEL` (Task 1).
- Produces: `AtomicUpdateRow` gains `size: "s"|"m"|"l"|"xl"|null`; `setAtomicUpdateSize(id, size)`, `setAtomicUpdateCategory(id, category)` actions.

- [ ] **Step 1: Add `size` to `AtomicUpdateRow` + the list selects**

`actions.ts`: add `size: "s" | "m" | "l" | "xl" | null;` to `AtomicUpdateRow`; add `size: atomicUpdates.size,` to the select in `listAtomicUpdates` (and `listHiddenAtomicUpdates`, keeping their shapes identical), and map it through.

- [ ] **Step 2: Write the failing action tests**

Add to `tests/app/atomic-updates-actions.test.ts` (session mocked as elsewhere):
```ts
it("setAtomicUpdateSize writes the size and freezes it, tenant+open scoped", async () => {
  const { tenant } = await /* seed tenant */;
  const [au] = await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "T", summary: "S", status: "open" }).returning();
  currentTenantId = tenant.id;
  const res = await setAtomicUpdateSize(au.id, "l");
  expect(res.ok).toBe(true);
  const [row] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, au.id));
  expect(row.size).toBe("l");
  expect(row.sizeEditedAt).not.toBeNull();
});
it("setAtomicUpdateSize refuses a released or other-tenant update", async () => { /* status:"released" and cross-tenant → {ok:false}, unchanged */ });
it("setAtomicUpdateCategory writes the category (no freeze), tenant+open scoped", async () => { /* returns {ok:true}, row.category updated */ });
```
Run → FAIL (actions undefined).

- [ ] **Step 3: Implement the actions**

`actions.ts` (mirror `editAtomicUpdate`'s tenant+open scoping and `{ ok }` shape):
```ts
export async function setAtomicUpdateSize(
  id: string,
  size: "s" | "m" | "l" | "xl"
): Promise<{ ok: boolean }> {
  const session = await requireSession();
  const rows = await db
    .update(atomicUpdates)
    .set({ size, sizeEditedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(atomicUpdates.id, id), eq(atomicUpdates.tenantId, session.user.tenantId), eq(atomicUpdates.status, "open")))
    .returning({ id: atomicUpdates.id });
  revalidatePath("/atomic-updates");
  return { ok: rows.length > 0 };
}

export async function setAtomicUpdateCategory(
  id: string,
  category: "new" | "improvement" | "fix" | "announcement"
): Promise<{ ok: boolean }> {
  const session = await requireSession();
  const rows = await db
    .update(atomicUpdates)
    // No freeze column: category is set once by the LLM and otherwise only by
    // a user; it is never auto-regenerated, so nothing needs to be protected.
    .set({ category, updatedAt: new Date() })
    .where(and(eq(atomicUpdates.id, id), eq(atomicUpdates.tenantId, session.user.tenantId), eq(atomicUpdates.status, "open")))
    .returning({ id: atomicUpdates.id });
  revalidatePath("/atomic-updates");
  return { ok: rows.length > 0 };
}
```
Run the Step-2 tests → PASS.

- [ ] **Step 4: Size + category selectors in the card's edit mode**

In `atomic-update-card.tsx` (edit mode block, near the title/summary inputs), add a shadcn `Select` for size and one for category, each calling its action in a `useTransition` with a `toast.error` on `!ok`. Import `Select, SelectContent, SelectItem, SelectTrigger, SelectValue` from `@/components/ui/select`, and `CATEGORY_LABEL` from `./page`. Size options: `s|m|l|xl` labelled `S|M|L|XL`; category options: the four values labelled via `CATEGORY_LABEL`. Seed each Select's value from `row.size` / `row.category`. (No unit test — UI, per the codebase convention.)

- [ ] **Step 5: Size badge (read-only) next to the category badge**

Add a `SizeBadge` (in `page.tsx`, beside `CategoryBadge`):
```tsx
export function SizeBadge({ size }: { size: string | null }) {
  if (!size) return null;
  return <Badge variant="outline">{size.toUpperCase()}</Badge>;
}
```
Render `<SizeBadge size={row.size} />` next to `<CategoryBadge category={row.category} />` in the card (line ~204 region).

- [ ] **Step 6: Verify + commit**

Run: `npm test -- tests/app/atomic-updates-actions.test.ts`; `npm run typecheck`; `npm run lint`; `npm run build`.

```bash
git add -A
git commit -m "feat: editable size/category on the atomic update card + size badge"
```

---

### Task 5: Size-aware composer

**Files:**
- Modify: `src/lib/ai/compose-prompt.ts` (`AtomicUpdateForPrompt`, `formatAtomicUpdate`, both prompt builders)
- Modify: every site that builds `AtomicUpdateForPrompt[]` from atomic_updates rows (typecheck-driven — `run-schedule.ts`, `catch-up.ts`, `release-claim.ts`, and any other caller of `generateReleaseDraft`/`mergeReleaseDraft`)
- Test: `tests/lib/ai/compose-prompt.test.ts` (or add one)

**Interfaces:**
- Consumes: `atomic_updates.size` (Task 2).
- Produces: `AtomicUpdateForPrompt` gains `size: "s"|"m"|"l"|"xl"|null`; prompts carry the size token + depth-ladder instruction.

- [ ] **Step 1: Add size to the prompt type + serialization**

`compose-prompt.ts`:
```ts
export type AtomicUpdateForPrompt = {
  id: string;
  title: string;
  summary: string;
  category: "new" | "improvement" | "fix" | "announcement" | null;
  size: "s" | "m" | "l" | "xl" | null;
};

function formatAtomicUpdate(item: AtomicUpdateForPrompt, index: number): string {
  const parts = [item.category, item.size ? item.size.toUpperCase() : null].filter(Boolean);
  const tag = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `${index + 1}. "${item.title}"${tag} — ${item.summary}`;
}
```
Making `size` required (nullable) makes `npm run typecheck` list every build site — the checklist for Step 3.

- [ ] **Step 2: Depth-ladder instruction in both prompt builders**

Define a shared constant and append it to the prompt body of BOTH `composeReleasePrompt` and `composeMergePrompt`:
```ts
const SIZE_GUIDANCE =
  "Give each update space proportional to its size. XL updates are the headline — lead with them, each in " +
  "its own short paragraph. L updates each get their own short paragraph. M updates get a sentence or two and " +
  "may share a paragraph. S updates are minor: when there are two or more, gather them into a single bulleted " +
  "list (e.g. under \"Also improved\" or \"Smaller fixes\") rather than a paragraph each; a lone S update may be " +
  "a brief one-liner. Treat an update with no stated size as M.";
```
- `composeReleasePrompt` prompt: `…Format the body as Markdown (short paragraphs, and bullet lists where helpful). ${SIZE_GUIDANCE}\n\n${serializeAtomicUpdates(args.items)}`.
- `composeMergePrompt` prompt: append `${SIZE_GUIDANCE}` after the existing Markdown-format instruction and before the sections (subordinate to the "preserve existing wording" system instruction — fold new items in at the depth their size implies).

- [ ] **Step 3: Add `size` to every prompt-item build site**

Run `npm run typecheck`; for each error where an `AtomicUpdateForPrompt` (or the array) is constructed from atomic_updates rows, add `size: <row>.size` to the select and the mapped object. Sites to expect (verify by following the compiler): the release-claim compose path, `catch-up.ts` (new/changed items), and `run-schedule.ts`. Each already selects `category: atomicUpdates.category` next to `title`/`summary` — add `size: atomicUpdates.size` beside it.

- [ ] **Step 4: Prompt-shape test**

Add/extend `tests/lib/ai/compose-prompt.test.ts`:
```ts
it("serializes size + category and includes the size guidance", () => {
  const { prompt } = composeReleasePrompt({
    items: [
      { id: "1", title: "Big feature", summary: "…", category: "new", size: "xl" },
      { id: "2", title: "Tiny fix", summary: "…", category: "fix", size: "s" },
      { id: "3", title: "Unsized", summary: "…", category: "improvement", size: null },
    ],
    brandProfile: /* minimal */, personas: [], examples: [],
  });
  expect(prompt).toContain(`"Big feature" (new, XL)`);
  expect(prompt).toContain(`"Tiny fix" (fix, S)`);
  expect(prompt).toContain(`"Unsized" (improvement)`); // no size token when null
  expect(prompt).toContain("gather them into a single bulleted list");
});
```
(Model the `brandProfile` minimal object on the existing compose-prompt tests, if any; otherwise construct the smallest object satisfying `buildSystemPrompt`.)

- [ ] **Step 5: Verify + commit**

Run: `npm test`; `npm run typecheck`; `npm run lint`; `npm run build`.

```bash
git add -A
git commit -m "feat: size-aware release composer (depth ladder, S grouped into a list)"
```

---

## Self-Review

**1. Spec coverage:**
- Part A (category rename) → Task 1 (enum + hand-authored migration, all literals, rubrics, labels). ✓
- Part B (size axis): schema → Task 2; generation (resolver + regenerate) + rubric → Task 3; two independent freezes → Task 3 Step 5–6; manual size/category + badges → Task 4. ✓
- Part C (size-aware composer) → Task 5 (type + serialize + depth ladder + build-site selects). ✓
- Non-goals honored: no backfill (null→M in Task 5 serialization/guidance); category not frozen (Task 4 `setAtomicUpdateCategory` has no freeze column); announcement examples not added. ✓

**2. Placeholder scan:** Task 4 Step 2 and Task 5 Step 4 leave `/* seed tenant */` / `/* minimal */` to match each test file's existing seed/brandProfile helpers rather than inventing divergent ones — the implementer copies the surrounding file's pattern. All production-code steps carry complete code.

**3. Type consistency:** category values `new|improvement|fix|announcement` and size values `s|m|l|xl` are used identically across the enum, every `z.enum`, every union (`EnrichmentResult`, `ResolutionAction`, `AtomicUpdateRow`, `AtomicUpdateForPrompt`), the actions, and the composer. `regenerateAtomicSummary` returns `{title,summary,size}` and `refreshAtomicUpdates` consumes exactly that. `AtomicUpdateForPrompt.size` being required (nullable) forces every build site (Task 5 Step 3) via typecheck.
