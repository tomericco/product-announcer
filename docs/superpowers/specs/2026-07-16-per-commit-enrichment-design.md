# Per-Commit Enrichment — Design

**Date:** 2026-07-16
**Status:** Approved (pending spec review)
**Sub-project:** A of the "smarter AI generation" initiative

## Context

This is the first of four sub-projects in an effort to improve AI-generated product
updates by making fuller use of the context we already collect:

- **A — Per-commit enrichment** (this doc): classify each change item at import time.
- **B — Curated example library**: tagged exemplars for few-shot generation.
- **C — Richer prompt composition**: a prompt-composition module that consumes A + B.
- **D — Post-generation review pass**: a reflection gate on the generated draft.

Dependency order: **A → B → C → D**. C depends on A's enrichment and B's examples;
D is independent and comes last. Each sub-project gets its own spec → plan → build cycle.

### Current state (why A is needed)

- Change items (`change_items`) store raw material only — `commitMessage` + truncated
  `diff`, or `prTitle` / `prDescription`. There is no semantic understanding of whether
  a change matters to users or how.
- `serializeBatchForPrompt` ([src/lib/generation.ts](../../../src/lib/generation.ts))
  dumps raw diffs into the prompt and drops diffs once it exceeds a 24k-char budget, so
  large batches feed noise and truncate somewhat blindly.
- Both ingestion paths are fully synchronous/inline — the GitHub webhook
  ([src/app/api/webhooks/github/route.ts](../../../src/app/api/webhooks/github/route.ts))
  awaits ingestion before responding, and manual import
  ([src/lib/import-commits.ts](../../../src/lib/import-commits.ts)) fetches diffs per
  commit in a server action. There is no background-job / queue machinery.

## Goal

At import time (both webhook and manual paths), run a cheap/fast LLM pass per change
item to determine whether the change is user-facing and, if so, how it affects the
user. Store the result on the row so it can (1) filter noise out of generation batches
and (2) later serve as high-quality prompt fuel for sub-project C.

A **produces, stores, and filters**. It does **not** change the generation prompt — that
is sub-project C.

## Design

### 1. Data model

Add nullable enrichment columns to `change_items`. Nullable so an un-enriched row is
distinguishable from an enriched one, and so existing rows remain valid without backfill.

| Column | Type | Meaning |
|---|---|---|
| `user_facing` | `boolean` (nullable) | `null` = not yet enriched → treated as facing (fail-safe) |
| `impact_summary` | `text` (nullable) | one-line user-visible benefit; `null` when not facing |
| `suggested_category` | `update_category` enum (nullable) | reuses existing `new` / `improved` / `fixed` |
| `enrichment_confidence` | `real` (nullable) | classifier confidence, 0–1 |
| `enriched_at` | `timestamptz` (nullable) | the "was enriched" marker |

New Drizzle migration `0010_*` (next after `0009_round_blade.sql`), generated via the
project's drizzle-kit generate flow.

### 2. Enrichment module — `src/lib/enrich-change-item.ts`

- `EnrichmentSchema` (Zod): `{ userFacing: boolean, impactSummary: string | null,
  suggestedCategory: "new" | "improved" | "fixed" | null, confidence: number }`.
- `buildEnrichmentPrompt(item, repoName)` — **pure** function assembling the classifier
  prompt from a change item (commit message + diff, or PR title + description) and its
  repo name. Unit-testable without a model.
- `enrichChangeItem(item, repoName)` → `generateObject` with model
  `process.env.ENRICHMENT_MODEL ?? "anthropic/claude-haiku-4-5"`.
- **Fail-open:** any error (model failure, invalid output) resolves to
  `{ userFacing: true, impactSummary: null, suggestedCategory: null, confidence: null }`
  so a genuinely user-facing change is never silently dropped.
- `mapWithConcurrency(items, limit, fn)` — a small, dependency-free, testable helper that
  runs `fn` over `items` with a concurrency cap (**5**). No new package.

The enrichment result maps to columns: `userFacing → user_facing`,
`impactSummary → impact_summary`, `suggestedCategory → suggested_category`,
`confidence → enrichment_confidence`, and `enriched_at = now()`.

### 3. Ingestion wiring

Both paths compute enrichment and persist it **on insert** (a single row write, not a
follow-up UPDATE):

- **Manual import** ([src/lib/import-commits.ts](../../../src/lib/import-commits.ts)):
  after fetching each diff, enrich via `mapWithConcurrency`, then insert with the
  enrichment columns populated.
- **Webhook push / PR ingest** (`ingest-push`, `ingest-pull-request`): enrich each item
  the same way before/at insert.

This matches the existing all-inline architecture; import returns once items are enriched.

### 4. Batch filtering + Pending UI

- `getPendingChangeItems` (`src/lib/change-item-batch.ts`) excludes rows where
  `user_facing = false`; it keeps `true` **and** `null` (fail-safe for un-enriched rows).
- The Pending list renders non-facing items **dimmed with a "not user-facing" label** and
  a **force-include** control.
  - **Force-include** = the user correcting the classifier → sets `user_facing = true`.
    (Accepted trade-off: this reuses the classifier field for a user correction rather
    than adding a separate override column. Simplest workable MVP.)
- Facing items with **low confidence** get a subtle "low confidence" hint in the UI. They
  are **not** filtered — the hint is informational only.

### 5. Testing

Pure / mockable unit tests:

- `buildEnrichmentPrompt` — includes the right fields for commit- vs PR-sourced items.
- `EnrichmentSchema` parsing — valid and invalid model outputs.
- Fail-open fallback — a throwing/mocked model yields the safe default.
- `mapWithConcurrency` — respects the cap, preserves order, surfaces results.
- `getPendingChangeItems` filter — `user_facing` of `true` / `false` / `null` behaves
  as specified (false excluded; true and null included).

## Scope boundaries (explicitly NOT in A)

- The generation prompt does **not** consume `impact_summary` / `suggested_category` yet.
  That is sub-project **C**. A only produces, stores, and filters.
- No backfill of existing rows — they read as `null` (= facing) until re-imported.
- No few-shot example library (**B**) and no post-generation review pass (**D**).

## Accepted trade-offs

1. **Force-include flips `user_facing`** rather than adding a dedicated override column —
   mixes a user correction into the classifier field, chosen for simplicity.
2. **Enrichment delivers no visible generation-quality gain until C** — A's value in
   isolation is noise-filtering in Pending and cleaner batches; the prompt-fuel payoff
   lands with C.
