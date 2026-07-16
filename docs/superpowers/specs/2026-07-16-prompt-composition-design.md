# Prompt Composition — Design

**Date:** 2026-07-16
**Status:** Approved (pending spec review)
**Sub-project:** C of the "smarter AI generation" initiative

## Context

Third of four sub-projects improving AI-generated product updates:

- **A — Per-commit enrichment** (done): each change item classified into
  `{ userFacing, impactSummary, suggestedCategory, confidence }` at import time.
- **B — Curated example library** (done): seeded few-shot exemplars selected by
  industry + persona and injected into the generation prompt.
- **C — Prompt composition** (this doc): a composition refactor that finally *consumes*
  A's enrichment and folds in every remaining unused signal.
- **D — Post-generation review pass** (later).

C is the payoff: A produces enrichment and B produces examples, but the generation prompt
still ignores A's `impactSummary` and several brand-profile fields. C closes those gaps.

### Current state (unused signals)

- `formatChangeItem` ([src/lib/generation.ts](../../../src/lib/generation.ts)) serializes
  raw commit messages, PR descriptions, and truncated **diffs** — A's `impactSummary`
  (the LLM-extracted user-facing benefit) is unused. `serializeBatchForPrompt` carries a
  `maxChars` / `includeDiffFlags` machine that drops diffs to fit a budget.
- `brandProfile.examplePhrases` (a `string[]`) is referenced **nowhere** in the prompt.
- Personas contribute their long steering text (the confusingly-named `brief`); the short
  identity (`description`, e.g. "Engineers who build with or integrate your product") is
  dropped by `resolvePersonaRefs`.
- `selectExamples` ([src/lib/select-examples.ts](../../../src/lib/select-examples.ts)) ranks
  by industry+persona score then `sort_order`; it ignores category. B's review flagged that
  `sort_order` (assigned in ascending industry blocks) biases single-tag ties toward SaaS.

## Goal

Compose the richest, cleanest generation prompt from all context we already have: lead each
change with its distilled user-facing impact (not raw diffs), fold in preferred vocabulary
and fuller persona identity, and make example selection track what the batch is about.

## Design

### 1. Change-item serialization (enrichment-driven)

Rewrite `formatChangeItem` to use, for every item, the enriched `impactSummary` (when
present) plus the raw title/message — and **never the diff**:

- PR item: `N. [<repo> · PR #<n>] "<prTitle>" — <impactSummary ?? prDescription ?? "">`
- Commit item: `N. [<repo> · commit <sha7>] "<commitMessage>" — <impactSummary ?? "">`

Un-enriched items (null `impactSummary`) fall back to title/message only. The diff's
information already reached the prompt indirectly — A's enricher reads the diff to produce
`impactSummary` — so excluding raw diffs loses no signal while removing noise.

Because diffs are gone, the `includeDiffFlags` diff-dropping logic is dead and is removed.
A **safety cap** remains: `serializeBatch(items, reposById, maxChars = 24000)` renders all
items; if the result exceeds `maxChars`, it keeps the leading items that fit and appends a
single line `…and <N> more changes not shown.` (whole-item drop, not diff drop).

### 2. System-prompt additions

- **`examplePhrases`**: when `brandProfile.examplePhrases` is non-empty, add a line —
  `Prefer this vocabulary and phrasing where natural: <phrases joined with "; ">.`
- **Fuller personas**: extend `ResolvedPersona` with an optional `description?: string`.
  `resolvePersonaRefs` ([src/lib/personas.ts](../../../src/lib/personas.ts)) populates it
  from the system persona's `description` for system refs; custom personas leave it unset.
  The prompt renders `name (description): brief` when `description` is present, and
  `name: brief` otherwise (today's behavior). Adding an optional field is backward-safe for
  the other `ResolvedPersona` consumer (the settings UI).

### 3. Category-aware example selection

Extend `ExampleCriteria` to `{ industry: string | null; personaKeys: string[]; categories: string[] }`,
where `categories` is the distinct set of non-null `suggestedCategory` values across the
batch's change items. `selectExamples` ranks candidates by:

1. **primary** — industry+persona match score (descending), as today;
2. **then** category match — an example whose `category` is in `criteria.categories` ranks
   above one that isn't (descending boolean);
3. **then** `sort_order` (ascending), as today.

Strict candidacy is unchanged (industry OR persona must match; category alone never
qualifies an example). Empty `categories` → step 2 is a no-op and behavior is identical to
B. **Equal weights** are kept (persona is *not* weighted above industry).

### 4. `compose-prompt` module

Extract prompt assembly out of `generation.ts` into `src/lib/compose-prompt.ts`:

- `serializeBatch(items, reposById, maxChars?)` — §1.
- `buildSystemPrompt(brandProfile, personas, examples)` — §2 (moved + extended).
- `renderExample(example)` — moved.
- `composePrompt({ items, brandProfile, reposById, personas, examples })` →
  `{ system: string; prompt: string }`.

`generateUpdateDraft` in `generation.ts` slims to: call `composePrompt`, then
`generateObject`. Its public signature (`items, brandProfile, reposById, personas?, examples?`)
is unchanged, so callers are untouched.

### 5. Wiring

`runBatchForWorkspace` ([src/lib/run-schedule.ts](../../../src/lib/run-schedule.ts)) derives
`categories` — the distinct non-null `suggestedCategory` across the pending items — and passes
it into the `selectExamples` criteria alongside the existing industry/persona keys. Nothing
else changes.

### 6. Testing

- **`serializeBatch`**: leads with `impactSummary` when present; falls back to title/message
  when `impactSummary` is null; **never** emits diff text; the safety cap drops whole trailing
  items with the "…and N more" note when over `maxChars`.
- **`buildSystemPrompt`**: includes the `examplePhrases` line when non-empty and omits it when
  empty; renders `name (description): brief` for a system persona and `name: brief` for a
  custom one.
- **`selectExamples`**: a category-matching example outranks an equal industry/persona-score
  example that doesn't match category; empty `categories` reproduces B's ordering exactly.
- **`resolvePersonaRefs`**: carries `description` for system refs, leaves it unset for custom.
- **`composePrompt` / `generateUpdateDraft`**: end-to-end shape via the existing mocked-`ai`
  test, relocated to `compose-prompt.test.ts`.

## Scope boundaries (explicitly NOT in C)

- No post-generation review pass — that is sub-project **D**.
- No new columns or migrations — C is pure prompt/selection logic over existing data.
- Diffs remain stored on change items and still feed A's enricher; they are only excluded
  from the generation prompt.
- Persona-match weighting is **not** changed (equal weights kept).

## Accepted trade-offs

1. **Category-awareness reduces but does not eliminate B's `sort_order`/SaaS tie-break bias.**
   A SaaS + developer tenant with a "new"-heavy batch still sees `saas-*-new` and
   `devtools-developer-new` tie on (score 1, category-match), with `sort_order` favoring the
   SaaS row. Fully fixing "a developer should get developer examples" would require weighting
   persona above industry, which is out of scope for C (kept equal by decision).
2. **Un-enriched items contribute only title/message.** Items imported before A, or where
   enrichment failed open, have no `impactSummary`; they still appear but with less signal.
   This is acceptable — new items are enriched at import, and the fallback is the pre-C prompt
   content minus the diff.
