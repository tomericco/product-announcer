# Atomic-Update Sizing (S/M/L/XL) + Size-Aware Composer + Category Rename — Design

**Date:** 2026-07-23
**Branch:** TBD (feature branch off `main`)
**Status:** Approved

## Summary

Two related changes to how atomic updates are classified and composed into a release:

1. **Size axis (S/M/L/XL).** Every atomic update gets a *size* reflecting its
   user-facing significance. Size is LLM-generated (and re-derived when
   evidence changes), user-overridable on the card, and — the payoff — drives
   how much room the composer gives each update: XL/L lead with their own
   paragraphs, M gets a sentence or two, and multiple S updates are gathered
   into a single bulleted list rather than a paragraph each.

2. **Category rename + new value.** The `update_category` enum changes from
   `new` / `improved` / `fixed` to **`new` / `improvement` / `fix` /
   `announcement`**. The LLM may assign `announcement` for notice-style
   changes (deprecations, pricing/policy changes, sunset notices,
   availability), and users can set any category on the card via a selector
   (added alongside the size selector).

Size and category are orthogonal axes — an update is both (e.g. a `new`
feature that is `xl`).

## Decisions (locked)

- Size = **user-facing significance** judged by the LLM, not code/diff volume.
- Size **re-derives on evidence change**, alongside title/summary, respecting a
  hand-edit freeze.
- Size and category are **user-editable on the card**.
- `announcement` is **both** LLM-assignable (rubric) **and** user-settable.
- Composer: **XL leads / L own paragraph / M a sentence or two / S grouped into
  one list when there are ≥2** (a lone S may be a one-liner).
- **No backfill** of existing atomic updates. A `null` size composes as **M**;
  real sizes fill in on the next evidence-change regeneration. Existing
  `improved`/`fixed` rows are preserved by the enum RENAME (see below).

## Global Constraints

- No test may reach the live Anthropic API — all LLM calls (resolver,
  regenerate-summary, enrichment) are injected/mocked in tests, matching the
  existing conventions.
- Client components must not import `@/db`/pg; card controls call server
  actions; the composer/generation reads size server-side.
- Server actions derive tenant/user from the session; every mutation is
  tenant- and status-scoped (only an `open` atomic update is editable).
- Released atomic updates stay frozen (size/category edits and re-derivation
  never touch a `released` update).

---

## Part A — Category rename (`new` / `improvement` / `fix` / `announcement`)

### A1. Schema + migration

`update_category` enum today: `["new", "improved", "fixed"]`. Target:
`["new", "improvement", "fix", "announcement"]`.

The enum is used by three columns: `change_events.suggested_category`,
`atomic_updates.category`, `system_update_examples.category`.

- **Migration (hand-authored — drizzle-kit can't infer enum-value renames):**
  ```sql
  ALTER TYPE "update_category" RENAME VALUE 'improved' TO 'improvement';
  ALTER TYPE "update_category" RENAME VALUE 'fixed' TO 'fix';
  ALTER TYPE "update_category" ADD VALUE 'announcement';
  ```
  `RENAME VALUE` updates every existing row of every column atomically (no
  per-row data migration). `ADD VALUE` is additive. Note: a newly-added enum
  value can't be *used* in the same transaction — this migration only alters
  the type, so that's fine.
- Update `schema.ts`: `updateCategoryEnum = pgEnum("update_category", ["new", "improvement", "fix", "announcement"])`.
- Regenerate the drizzle snapshot to match (the generated migration for the
  schema diff may be replaced by the hand-authored SQL above, or the SQL
  pasted into the generated file — the snapshot must end consistent with the
  four-value enum).

### A2. Update every reference to the renamed values

Replace the string literals `"improved"` → `"improvement"` and `"fixed"` →
`"fix"` across the codebase (TypeScript unions, `z.enum([...])`, comparisons).
Known sites (grep `"improved"|"fixed"` before implementing — this list is
indicative, not exhaustive):
- `src/lib/ai/enrich-change-item.ts` — `EnrichmentResult.suggestedCategory`
  type, `EnrichmentSchema` `z.enum`, and the rubric line.
- `src/lib/ai/resolve-atomic-updates.ts` — the `create` action type + schema
  `z.enum` + rubric.
- `src/lib/ai/compose-prompt.ts` — `AtomicUpdateForPrompt.category` union.
- `src/app/(dashboard)/atomic-updates/actions.ts` — `AtomicUpdateRow.category`
  union and any comparisons.
- Any other union/literal found by grep (`reassign.ts`, `release-deltas.ts`,
  `create-from-events.ts`, `change-events/actions.ts`,
  `reassign-control.tsx` — verify whether each `"new"/"improved"/"fixed"`
  hit is a *category* value vs an unrelated string, and only change category
  ones).

### A3. LLM rubrics — describe all four categories

- **`enrich-change-item.ts`** (`ENRICHMENT_SYSTEM`) and
  **`resolve-atomic-updates.ts`** (`RESOLVER_SYSTEM`): update the category
  rubric to:
  - `new` — a new capability.
  - `improvement` — better existing behavior.
  - `fix` — a bug fix.
  - `announcement` — a user-facing notice rather than a feature/fix: a
    deprecation, a sunset/removal, a pricing/policy change, or an
    availability/"now in X" heads-up. Pick this only when the change is
    fundamentally an announcement, not a code capability.
  - Extend the `z.enum` in both `EnrichmentSchema` and the resolver
    `ActionSchema.create` to include `announcement`.

### A4. Display labels

`atomic-updates/page.tsx` `CATEGORY_LABEL`:
```ts
export const CATEGORY_LABEL: Record<string, string> = {
  new: "New",
  improvement: "Improvement",
  fix: "Fix",
  announcement: "Announcement",
};
```
`CategoryBadge` unchanged (reads the map).

### A5. Seeded examples

`system_update_examples` rows seeded with `improved`/`fixed` are auto-renamed
by the `RENAME VALUE` migration — no per-row change needed. Adding
`announcement` example rows is **optional** (few-shot examples are selected by
category/industry match; absence just means no announcement exemplar). Out of
scope for this feature unless desired.

---

## Part B — Size axis (S/M/L/XL)

### B1. Schema + migration

- New enum: `atomicUpdateSizeEnum = pgEnum("atomic_update_size", ["s", "m", "l", "xl"])`.
- On `atomic_updates`:
  - `size: atomicUpdateSizeEnum("size")` — **nullable** (existing rows null
    until re-derived).
  - `sizeEditedAt: timestamp("size_edited_at", { withTimezone: true })` — the
    size analogue of `summaryEditedAt`; non-null freezes size against
    re-derivation.
- Migration: `CREATE TYPE` + two `ALTER TABLE atomic_updates ADD COLUMN`
  (generated by drizzle-kit from the schema diff).

### B2. Sizing rubric (shared)

A single rubric, injected into both generators, judging **user-facing
significance** (not code volume):
- **`s`** — a minor fix, tweak, or polish; small individual user impact (a
  small bug fix, a copy/UI nit).
- **`m`** — a standard improvement or small feature; noticeable to users of
  that area.
- **`l`** — a significant feature or major improvement; worth calling out to
  many users.
- **`xl`** — a flagship / headline change; a major new capability or overhaul
  you'd lead an announcement with.

### B3. Size generation

Size is produced wherever title/summary/category are:

- **Auto-resolver** (`resolve-atomic-updates.ts`): add `size` to the `create`
  action schema (`z.enum(["s","m","l","xl"])`) and the rubric to
  `RESOLVER_SYSTEM`. Persist `size` when the resolver creates an atomic update
  (the `apply-resolution` path that inserts atomic updates must write `size`).
- **`regenerateAtomicSummary`** (`regenerate-atomic-summary.ts`): extend
  `AtomicSummarySchema` to `{ title, summary, size }`; add the sizing rubric to
  `SUMMARY_SYSTEM`. This is what re-derives size on evidence change.
- **Manual create** (`create-from-events.ts` `seedFromEvent`): seed `size =
  null`; the post-create best-effort refresh (which calls
  `regenerateAtomicSummary`) sets the real size.

### B4. Two independent freezes on the regeneration apply

Today `refreshAtomicUpdates` skips an atomic update whose `summaryEditedAt` is
non-null. With size added, title/summary and size have **independent** freezes:

- The regeneration call now yields `{ title, summary, size }`.
- **Skip the LLM call only when BOTH `summaryEditedAt` and `sizeEditedAt` are
  set** (nothing left to regenerate). Gate changes from
  `summaryEditedAt IS NULL` to `summaryEditedAt IS NULL OR sizeEditedAt IS NULL`.
- **On apply:** write `title`/`summary` only if `summaryEditedAt IS NULL`;
  write `size` only if `sizeEditedAt IS NULL`. (So a hand-set size sticks
  while the summary keeps tracking evidence, and vice-versa.)
- The existing `forceRegenerate` mechanism (clears `summaryEditedAt` before the
  refresh, used by the add/remove-evidence flow) is unchanged; it does **not**
  clear `sizeEditedAt` — a user's manual size survives an evidence edit, which
  matches "editable, frozen like a hand-edited summary".

### B5. Manual size + category override on the card

- New server actions in `atomic-updates/actions.ts`:
  - `setAtomicUpdateSize(id, size)` — writes `size` + `sizeEditedAt = now`,
    scoped to `tenantId` + `status = 'open'`; `revalidatePath('/atomic-updates')`.
  - `setAtomicUpdateCategory(id, category)` — writes `category` (no freeze —
    category isn't auto-regenerated); same scoping + revalidate.
- Card edit mode (`atomic-update-card.tsx`): add a **size** selector (S/M/L/XL)
  and a **category** selector (New/Improvement/Fix/Announcement), each calling
  its action in a transition (toast on error, like the other card controls).
  Read the current `size`/`category` from the row.

### B6. Size badge on the card

Render a **size badge** on every card next to the `CategoryBadge` (a small
`Badge` showing `S`/`M`/`L`/`XL`, or nothing when size is null). `AtomicUpdateRow`
gains `size` (already selected in `listAtomicUpdates`).

---

## Part C — Size-aware composer

### C1. Carry size into the prompt

- `compose-prompt.ts` `AtomicUpdateForPrompt` gains `size: "s" | "m" | "l" | "xl" | null`.
- `formatAtomicUpdate` serializes size alongside category:
  `N. "title" (improvement, M) — summary` (size upper-cased; omit the size
  token when null, which the model then treats as M per the instructions
  below).
- The draft generation (`generation.ts` / the `/api/atomic-updates/draft`
  route and the catch-up merge path) must **select `size`** when building the
  `AtomicUpdateForPrompt[]` for a release.

### C2. Depth-ladder instructions

Add to both `composeReleasePrompt` and `composeMergePrompt` a size-handling
instruction block (in the prompt body, after the serialized list):

> Give each update space proportional to its size. **XL** updates are the
> headline — lead with them, each in its own short paragraph. **L** updates
> each get their own short paragraph. **M** updates get a sentence or two and
> may share a paragraph. **S** updates are minor — when there are two or more,
> gather them into a single bulleted list (e.g. under "Also improved" or
> "Smaller fixes") rather than a paragraph each; a lone S update may be a brief
> one-liner. Treat an update with no stated size as M.

For `composeMergePrompt`, the same block applies, subordinate to the existing
"preserve the current body's wording/structure" instruction (fold new items in
at the depth their size implies).

### C3. Ordering

The lead/paragraph/list ladder implies ordering (XL/L first, S list last); the
instruction wording above conveys it. No separate sort is required — the model
orders by the ladder — but the serialized list may optionally be pre-sorted
xl→s to nudge it. (Implementation detail; default to instruction-only.)

---

## Testing

- **Category rename**: unit-level — the enrichment/resolver schemas accept the
  four values; a small assertion that `announcement` is a valid category. The
  migration is exercised by `db:migrate:test`. Grep-verify no stale
  `"improved"`/`"fixed"` category literals remain.
- **Size generation**: `regenerateAtomicSummary` (with a mocked model) returns
  and the caller persists a size; the resolver create path persists size.
  Injected model — no live Anthropic.
- **Two-freeze apply**: with `refresh` injected, assert (a) neither frozen →
  title/summary/size all updated; (b) `summaryEditedAt` set, `sizeEditedAt`
  null → size updated, title/summary preserved; (c) `sizeEditedAt` set,
  `summaryEditedAt` null → title/summary updated, size preserved; (d) both set
  → call skipped, nothing changed. (Extend the existing
  `regenerate-atomic-summary` / `refreshAtomicUpdates` tests.)
- **Manual actions**: `setAtomicUpdateSize` writes size + `sizeEditedAt`,
  rejects a released/other-tenant update; `setAtomicUpdateCategory` writes
  category, same scoping. Tenant isolation.
- **Composer**: `serializeAtomicUpdates` includes the size token (and omits it
  for null); the depth-ladder instruction text is present in
  `composeReleasePrompt`/`composeMergePrompt` output. (Prompt-shape assertions,
  no live model — matching existing compose-prompt tests if any.)
- UI (card selectors, badges) untested by design, per the codebase's dialog/UI
  convention.

## Out of scope / non-goals

- Backfilling existing atomic updates with sizes (forward-only; null→M).
- New `announcement` few-shot example rows (optional; not built).
- Category freeze / category re-derivation (category is set once by the LLM
  and only changed by a user; it is never auto-regenerated).
- Any change to the size taxonomy beyond S/M/L/XL.
