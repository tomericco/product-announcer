# Curated Example Library — Design

**Date:** 2026-07-16
**Status:** Approved (pending spec review)
**Sub-project:** B of the "smarter AI generation" initiative

## Context

Second of four sub-projects improving AI-generated product updates:

- **A — Per-commit enrichment** (done): classify each change item at import time.
- **B — Curated example library** (this doc): seeded few-shot exemplars, selected by
  industry + persona, wired into generation.
- **C — Richer prompt composition** (later): a broad prompt-composition refactor that
  consumes A's enrichment, B's examples, full personas, and `examplePhrases`.
- **D — Post-generation review pass** (later).

Dependency note: B reaches end-to-end (it wires examples into the live generation prompt),
so it delivers a visible quality gain on its own. C later subsumes B's ad-hoc prompt
edits into a unified composition module.

### Current state

- `generateUpdateDraft` ([src/lib/generation.ts](../../../src/lib/generation.ts)) builds a
  system prompt from the brand profile (tone, reading level, do/don't) and resolved
  personas, then serializes the change-item batch. It uses **no exemplars** — the model
  has no reference for what a good update looks like in the tenant's domain/voice.
- The seeded-catalog pattern already exists: `system_personas` is a table seeded via a
  migration `INSERT … ON CONFLICT ("key") DO NOTHING`
  ([0009_round_blade.sql](../../../src/db/migrations/0009_round_blade.sql)). B mirrors it.
- Industry is free-text on the brand profile, chosen from a canonical `INDUSTRIES` list in
  [industry-select.tsx](<../../../src/app/(dashboard)/settings/industry-select.tsx>) (custom
  values allowed). Personas are `PersonaRef[]` where system refs carry a `key`.

## Goal

Give the generation model curated, on-target few-shot exemplars. Seed a global catalog of
example updates tagged by industry, persona, and category; at generation time select the
best-matching few (strict match, capped) and inject them into the prompt so the output
mirrors their structure, depth, and voice.

## Design

### 1. Data model — `system_update_examples`

A new seeded catalog table, mirroring `system_personas`:

| Column | Type | Meaning |
|---|---|---|
| `id` | uuid PK | |
| `key` | text unique | stable slug; enables idempotent re-seeding via `ON CONFLICT` |
| `industry` | text (nullable) | canonical industry string (from the `INDUSTRIES` list) |
| `persona_key` | text (nullable) | soft reference to a `system_personas.key` (not a FK) |
| `category` | `update_category` enum | reuses existing `new` / `improved` / `fixed` |
| `title` | text | the exemplar update title |
| `body` | text | the exemplar body, Markdown (same format as real output) |
| `sort_order` | integer default 0 | tiebreak ordering |
| `created_at` | timestamptz default now() | |

Seeded in a new migration with **~12–16 hand-authored examples** spanning ~4–5 industries
(SaaS, Developer Tools, Fintech, E-commerce, Healthcare) × key personas (developer,
product-manager, marketing-manager, support-lead), covering all three categories. Every
seeded row has at least an `industry` **or** a `persona_key` so it is matchable.

### 2. Selection — `src/lib/select-examples.ts`

- `type ExampleRow = typeof systemUpdateExamples.$inferSelect`
- `type ExampleCriteria = { industry: string | null; personaKeys: string[] }`
- Pure `selectExamples(examples: ExampleRow[], criteria: ExampleCriteria, limit = 3): ExampleRow[]`:
  - Score each example: `+1` if `example.industry` is non-null and case-insensitively equals
    `criteria.industry`; `+1` if `example.persona_key` is in `criteria.personaKeys`.
  - **Strict:** drop every example scoring 0. Sort by score descending, then `sort_order`
    ascending. Return the top `limit` (default 3).
  - No matches → empty array (generation then includes no examples block).

### 3. Criteria derivation

- `criteria.industry` = `brandProfile.industry`.
- `criteria.personaKeys` = system persona keys from `brandProfile.userPersonas`, via a new
  helper `systemPersonaKeys(refs: PersonaRef[]): string[]` (added to
  [src/lib/personas.ts](../../../src/lib/personas.ts)) that returns `ref.key` for
  `type: "system"` refs and ignores custom refs (which have no key).

### 4. Generation wiring

- `generateUpdateDraft(items, brandProfile, reposById, personas, examples = [])` gains an
  `examples: ExampleRow[]` parameter (defaults to `[]`).
- `buildSystemPrompt` appends an examples block **only when `examples` is non-empty**:
  a lead-in line — *"Here are example updates for a similar audience — mirror their
  structure, depth, and voice; do not reuse their wording or specifics:"* — followed by each
  example rendered as `Example (<category>):\nTitle: <title>\nBody: <body>`.
- `runBatchForWorkspace` ([src/lib/run-schedule.ts](../../../src/lib/run-schedule.ts))
  already loads the brand profile, personas, and persona catalog. It additionally: loads all
  `system_update_examples` rows, derives `ExampleCriteria` (industry from the brand profile,
  persona keys via `systemPersonaKeys`), calls `selectExamples`, and passes the result into
  `generateUpdateDraft`. Loading the whole ~16-row table each run is trivial.

### 5. Testing

- **`selectExamples`** (pure unit): both-match ranks above single-match; industry-only and
  persona-only matches each included; zero-match → empty; result capped at `limit`;
  `sort_order` breaks ties at equal score.
- **`systemPersonaKeys`** (pure unit): extracts keys from system refs, ignores custom refs,
  handles empty.
- **Migration round-trip** (integration): insert and read back an example row, confirming
  the columns and enum.
- **`generateUpdateDraft`** (extend existing mocked test in
  [tests/lib/generation.test.ts](../../../tests/lib/generation.test.ts)): the example block
  appears in the system prompt when `examples` are passed and is absent when the list is empty.

## Scope boundaries (explicitly NOT in B)

- No tenant-authored examples and no settings UI — the catalog is system-seeded only.
- Not the full C refactor: B adds few-shot examples only. It does **not** consume A's
  `impact_summary` / `suggested_category`, and does **not** wire in `examplePhrases`.
- Example selection matches on **industry OR persona, never on category** — the update's
  category is unknown before generation. `category` is stored and used only as a prompt
  label (`Example (<category>):`); C may use it for selection later.

## Accepted trade-offs

1. **Strict match means an unmatched tenant gets zero examples** — chosen for precision over
   always-injecting a generic set. Value scales with catalog breadth; the ~12–16 starter set
   is a foundation, not full coverage.
2. **`category` is stored but unused in selection** — kept now to avoid a later migration and
   to label examples in the prompt; C can drive selection by the enriched `suggested_category`.
