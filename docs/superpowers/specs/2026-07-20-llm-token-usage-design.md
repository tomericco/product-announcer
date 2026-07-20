# LLM token usage tracking

## Problem

Every LLM call in the app discards its token usage. `generateObject` returns a
`usage` object and nothing reads it, so there is no way to answer "how many
tokens did this workspace burn, and on what". With the app now calling Anthropic
directly against a prepaid balance, that is the number that matters.

## Goal

Persist per-call token usage to the database. Basic and testable: no UI, no
rollups, no cost maths.

## Design

### 1. Table: `llm_usage`

One row per LLM call.

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `tenant_id` | uuid, not null | FK → `tenants.id`, `onDelete: cascade` |
| `operation` | text, not null | `generation` / `enrichment` / `review` / `revision` / `brand_analysis` |
| `model` | text, not null | resolved id, e.g. `claude-sonnet-4-5` |
| `input_tokens` | integer, nullable | |
| `output_tokens` | integer, nullable | |
| `total_tokens` | integer, nullable | |
| `created_at` | timestamptz, not null, default now | |

Two deliberate choices:

- **Token columns are nullable.** The SDK types them `number | undefined`; a
  provider that omits a count must not cost us the row.
- **`operation` is plain `text`, not a pgEnum.** This list will grow, and
  Postgres has no `DROP VALUE` — removing an enum value means recreating the type
  and re-pointing the column (we just did exactly that to delete one value).

### 2. Recorder: `src/lib/ai/llm-usage.ts`

```ts
export type LlmOperation =
  | "generation" | "enrichment" | "review" | "revision" | "brand_analysis";

export async function recordLlmUsage(
  entry: {
    tenantId: string;
    operation: LlmOperation;
    model: string;
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  },
  database?: typeof db
): Promise<void>
```

Two properties are load-bearing:

- **It never throws.** The body is wrapped in try/catch and logs on failure.
  Accounting must not be able to break a generation — the same lesson as the
  auto-publish guard, where an unguarded post-save step reported a saved draft as
  failed.
- **It tolerates a missing or partial `usage`.** Absent counts are written as
  `null`. This is not hypothetical: no existing test supplies a `usage` field in
  its `generateObject` mock, so assuming its presence would break the suite.

### 3. Model naming

Call sites hold gateway-style specs (`anthropic/claude-sonnet-4-5`). `model.ts`
already strips that prefix inside `resolveModel`; extract that into an exported
`modelId(spec)` and reuse it in both places, so recorded names are consistent and
the stripping logic exists once.

### 4. Call sites (5)

| operation | site | tenantId from |
|---|---|---|
| `generation` | `generateUpdateDraft` (`generation.ts`) | `brandProfile.tenantId` |
| `review` | `reviewDraft` (`review-draft.ts`) | `brandProfile.tenantId` |
| `revision` | `reviseDraft` (`review-draft.ts`) | `brandProfile.tenantId` |
| `enrichment` | `enrichChangeItem` (`enrich-change-item.ts`) | new `EnrichmentInput.tenantId` |
| `brand_analysis` | `analyzeBrandStyle` (`analyze-brand-style.ts`) | new `tenantId` parameter |

Generation and review already receive a `brandProfile`, which carries `tenantId`
— no signature change needed there.

### 5. Signature changes

- `EnrichmentInput` gains `tenantId: string`. Its three construction sites
  (`ingest-pull-request.ts`, `ingest-push.ts`, `import-commits.ts`) all already
  have a tenant id in scope.
- `analyzeBrandStyle(pageText, tenantId)`; the `ImportBrandStyleDeps.analyze` dep
  type widens to match. Its caller `importBrandStyleForTenant` already takes a
  `tenantId`.

Both are backward-compatible with the existing injected test fakes: in
TypeScript a function declared with fewer parameters is assignable to one
expecting more.

### 6. Tests

- **Unit** (`recordLlmUsage`): writes a row with the given fields; a missing
  `usage` produces null token columns; a database failure is swallowed rather
  than propagated.
- **Integration**: a batch run records a `generation` row for the right tenant
  and model.

## Constraints

- Recording must never throw, and never change the result of the LLM call.
- Must not break the existing suite: `usage` is absent from every current mock.
- The migration applies to BOTH databases (`db:migrate` and `db:migrate:test`).
- Do not add a pgEnum for `operation`.

## Out of scope (YAGNI)

- No UI or reporting.
- No aggregation/rollup tables.
- No cost-in-currency calculation.
- No linkage from a usage row to the update or change item it produced.
