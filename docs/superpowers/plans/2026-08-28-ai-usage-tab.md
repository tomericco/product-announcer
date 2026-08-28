# AI Usage Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An "AI usage" tab on the settings page showing credits (our-key tokens, 1:1) by day/week/month and by feature, plus a separate BYOK section tracking the AI-visibility sweep tokens spent on the customer's own keys.

**Architecture:** Read-side queries over the existing `llm_usage` table (live `GROUP BY date_trunc`, no rollup tables), one new write path (the three sweep-engine clients start parsing the token `usage` their raw responses already carry, recorded as operation `ai_visibility_engine`), and a two-tab restructure of the settings page. A `getMonthlyCreditLimit` seam returns `null` today so future package limits are a UI no-op until a limit source exists.

**Tech Stack:** Next.js App Router (this repo's version — `searchParams` is a Promise), Drizzle ORM over node-postgres, recharts via the existing `ChartContainer`, Vitest 4 (node project = real Postgres, jsdom project = Testing Library).

**Spec:** `docs/superpowers/specs/2026-08-28-ai-usage-tab-design.md`

## Global Constraints

- Migrations: after `npm run db:generate`, run BOTH `npm run db:migrate` AND `npm run db:migrate:test`.
- DB tests hit a real shared Postgres; the tenant NAME is the cleanup key — every new test file must use a tenant name unique to that file.
- The test suite is known flaky (shared Postgres, 155 files). Run a failing file in isolation before blaming your change; run the full suite twice before calling it green.
- Never render the word "credits" in BYOK/USD contexts (`ai-visibility-form.tsx`, `run-now-button.tsx`, the AI-engines card). The new usage tab's credit wording applies to our-key usage only; the BYOK section is labeled in tokens.
- Credits = `COALESCE(total_tokens, 0)`, uniformly. No per-image constant. Rows with `operation = 'ai_visibility_engine'` are excluded from every credit aggregate and selected exclusively by the BYOK functions.
- All bucketing is UTC; weeks are ISO (Monday start, `date_trunc('week', …)`).
- Verification commands: `npm run typecheck`, `npm run lint`, `npm test`. The dev preview is behind an OAuth wall — do not attempt browser verification; rely on typecheck + lint + tests.
- `recordLlmUsage` never throws (existing contract); nothing in this plan may make accounting able to fail a run or a generation.
- This repo's Next.js may differ from your training data — check `node_modules/next/dist/docs/` before using an unfamiliar Next API. `searchParams` is a `Promise` (see `src/app/(dashboard)/calendar/page.tsx:35`).

## File Structure

```
src/db/schema.ts                                    (modify: index on llm_usage)
src/db/migrations/00XX_*.sql                        (generated)
src/lib/ai/llm-usage.ts                             (modify: new operation, fix stale comment)
src/lib/ai-visibility/types.ts                      (modify: EngineUsage, usage? on answer/error)
src/lib/ai-visibility/engines/failure.ts            (modify: engineFailure passes usage through)
src/lib/ai-visibility/engines/openai.ts             (modify: parse usage)
src/lib/ai-visibility/engines/gemini.ts             (modify: parse usage)
src/lib/ai-visibility/engines/anthropic.ts          (modify: parse usage)
src/lib/ai-visibility/run.ts                        (modify: record usage rows)
src/lib/usage/features.ts                           (create: operation→feature map, BYOK engine labels)
src/lib/usage/queries.ts                            (create: credit + BYOK aggregates, bucket helpers)
src/lib/usage/limit.ts                              (create: getMonthlyCreditLimit seam)
src/app/(dashboard)/settings/page.tsx               (modify: thin tab switcher)
src/app/(dashboard)/settings/settings-tabs.tsx      (create: link-pill tab nav, server-safe)
src/app/(dashboard)/settings/workspace-settings.tsx (create: current page content, moved)
src/app/(dashboard)/settings/usage-settings.tsx     (create: usage tab server component)
src/app/(dashboard)/settings/usage-headline.tsx     (create: presentational month-to-date + limit)
src/app/(dashboard)/settings/usage-chart.tsx        (create: client — toggle + stacked chart + table)
src/app/(dashboard)/settings/byok-usage-chart.tsx   (create: client — BYOK monthly chart by engine)
```

Tests: `tests/lib/usage/features.test.ts`, `tests/lib/usage/queries.test.ts`, additions to `tests/lib/ai-visibility/engines/{openai,gemini,anthropic}.test.ts` and `tests/lib/ai-visibility/run.test.ts`, `tests/components/usage-headline.test.tsx`, `tests/components/usage-chart.test.tsx`.

---

### Task 1: Index on `llm_usage (tenant_id, created_at)`

**Files:**
- Modify: `src/db/schema.ts:1308-1325` (the `llmUsage` table)
- Generated: `src/db/migrations/` (new migration via drizzle-kit)

**Interfaces:**
- Consumes: nothing.
- Produces: index `llm_usage_tenant_created_idx`, which every query in Tasks 6-7 relies on.

- [ ] **Step 1: Add the index to the table definition**

`schema.ts` already imports `index` from `drizzle-orm/pg-core` (line 1). Change the `llmUsage` table to add the third argument:

```ts
export const llmUsage = pgTable(
  "llm_usage",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    // Plain text, not an enum: this list will grow, and Postgres has no DROP VALUE.
    operation: text("operation").notNull(),
    model: text("model").notNull(),
    // Nullable: the SDK types these as `number | undefined`, and a provider that
    // omits a count shouldn't cost us the row.
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),
    // Image renders also set the token columns (gpt-image models are
    // token-priced); imageCount is the per-image count on top of that.
    imageCount: integer("image_count"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Every usage-tab query is `WHERE tenant_id = ? AND created_at >= ?`.
    index("llm_usage_tenant_created_idx").on(table.tenantId, table.createdAt),
  ]
);
```

(The `imageCount` comment is corrected here as part of this edit — the old text claimed image rows have null token columns, which `renderImage` disproves at `src/lib/ai/images.ts:141`.)

- [ ] **Step 2: Generate and apply the migration**

Run: `npm run db:generate`
Expected: a new `src/db/migrations/00XX_*.sql` containing only `CREATE INDEX "llm_usage_tenant_created_idx" ...`. Inspect it — if it contains anything else, stop and investigate.

Run: `npm run db:migrate && npm run db:migrate:test`
Expected: both succeed.

- [ ] **Step 3: Verify the schema tests still pass**

Run: `npx vitest run tests/db/schema.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts src/db/migrations
git commit -m "feat: index llm_usage on (tenant_id, created_at) for usage queries"
```

---

### Task 2: `EngineUsage` type + OpenAI engine parses token usage

**Files:**
- Modify: `src/lib/ai-visibility/types.ts` (add `EngineUsage`, `usage?` on `EngineAnswer` and `EngineError`)
- Modify: `src/lib/ai-visibility/engines/failure.ts:183-214` (`engineFailure` passes `usage` through)
- Modify: `src/lib/ai-visibility/engines/openai.ts`
- Test: `tests/lib/ai-visibility/engines/openai.test.ts`

**Interfaces:**
- Consumes: existing `EngineAnswer`/`EngineError`/`engineFailure`.
- Produces: `EngineUsage = { inputTokens?: number; outputTokens?: number; totalTokens?: number }` exported from `types.ts`; `usage?: EngineUsage` on both result types; `engineFailure(engine, code, opts)` accepts `usage?: EngineUsage` in `opts`. Tasks 3-4 rely on these exact names.

- [ ] **Step 1: Write the failing tests**

In `tests/lib/ai-visibility/engines/openai.test.ts`, the module-level `ANSWER` fixture gains a `usage` field (this matches the real Responses API shape — snake_case):

```ts
// added to the ANSWER object literal, top level:
usage: { input_tokens: 23_388, output_tokens: 2_948, total_tokens: 26_336 },
```

Add tests (reuse the file's existing `json()` helper and env stubbing):

```ts
describe("askOpenAi usage", () => {
  it("returns token usage from a successful response", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const fetchImpl = vi.fn(async () => json(ANSWER));
    const result = await askOpenAi("best issue tracker", { fetchImpl });
    expect("kind" in result).toBe(false);
    if ("kind" in result) return;
    expect(result.usage).toEqual({ inputTokens: 23_388, outputTokens: 2_948, totalTokens: 26_336 });
  });

  it("returns token usage on a billed failure (truncation)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const truncated = {
      ...ANSWER,
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      usage: { input_tokens: 100, output_tokens: 4_096, total_tokens: 4_196 },
    };
    const fetchImpl = vi.fn(async () => json(truncated));
    const result = await askOpenAi("best issue tracker", { fetchImpl });
    expect("kind" in result).toBe(true);
    if (!("kind" in result)) return;
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 4_096, totalTokens: 4_196 });
  });

  it("omits usage on a transport failure", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const result = await askOpenAi("best issue tracker", { fetchImpl });
    expect("kind" in result).toBe(true);
    if (!("kind" in result)) return;
    expect(result.usage).toBeUndefined();
    consoleError.mockRestore();
  });

  it("drops non-finite counts instead of storing them", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const weird = { ...ANSWER, usage: { input_tokens: "many", output_tokens: 5 } };
    const fetchImpl = vi.fn(async () => json(weird));
    const result = await askOpenAi("best issue tracker", { fetchImpl });
    if ("kind" in result) return;
    expect(result.usage).toEqual({ outputTokens: 5 });
  });
});
```

Note: adding `usage` to `ANSWER` may make existing snapshot-ish assertions about `raw` fail if any compare the whole object — check the file's existing assertions and adjust only if one does exact-equality on `raw`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/lib/ai-visibility/engines/openai.test.ts`
Expected: new tests FAIL (`usage` is `undefined` / type error on `result.usage`).

- [ ] **Step 3: Implement**

In `src/lib/ai-visibility/types.ts` (this module imports nothing — define, don't import):

```ts
/**
 * Token counts the provider reported for one call, normalised to camelCase.
 *
 * Structurally identical to `TokenUsage` in `src/lib/ai/llm-usage.ts` but
 * declared here because this module deliberately imports nothing (see the
 * header comment). Recorded into `llm_usage` for the settings usage tab —
 * TRACKING of the tenant's own BYOK spend, never counted as credits.
 */
export type EngineUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};
```

Add to `EngineAnswer`: `usage?: EngineUsage;`
Add to `EngineError` (below `costUsd`):

```ts
  /**
   * Token counts, when the provider's response carried them. Present on the
   * same responses that can carry `costUsd` — a complete response we could
   * read — and absent on transport failures, where nothing was reported.
   */
  usage?: EngineUsage;
```

In `src/lib/ai-visibility/engines/failure.ts`, extend `engineFailure`'s `opts` with `usage?: EngineUsage` (import the type from `../types` — check the file's existing import path style; it already imports `EngineId` from types) and add to the returned object:

```ts
    ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
```

In `src/lib/ai-visibility/engines/openai.ts`:

Add to the `OpenAiResponse` type:

```ts
  usage?: { input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown };
```

Add a module-level helper (near `sanitizeRaw`):

```ts
/** A count is only a count if it is a finite number; anything else is dropped. */
function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Token usage from the raw response, or undefined when it reported none.
 * Undefined means "unknown", not zero — same contract as `costUsd`.
 */
function readUsage(raw: OpenAiResponse): EngineUsage | undefined {
  if (!isRecord(raw.usage)) return undefined;
  const usage: EngineUsage = {};
  const input = asCount(raw.usage.input_tokens);
  const output = asCount(raw.usage.output_tokens);
  const total = asCount(raw.usage.total_tokens);
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (total !== undefined) usage.totalTokens = total;
  return Object.keys(usage).length > 0 ? usage : undefined;
}
```

Import `EngineUsage` alongside the other type imports from `@/lib/ai-visibility/types`.

Wire it into every return that follows a complete, readable response — the same set that carries `costUsd`:
- the `incomplete_details` failure (openai.ts:267-275): add `usage: readUsage(raw)`
- the non-`completed` status failure (:276-281): add `usage: readUsage(raw)`
- the `refused` failure (:283-285): add `usage: readUsage(raw)`
- the empty-text `refused` failure (:286-291): add `usage: readUsage(raw)`
- the final success `return { ... }` (:305-313): add `usage: readUsage(raw)`

(`engineFailure` drops an `undefined` usage, so passing `usage: readUsage(raw)` unconditionally on those paths is fine. Transport-failure and non-2xx paths are untouched — no response body was read.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/lib/ai-visibility/engines/openai.test.ts tests/lib/ai-visibility/engines/failure.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/lib/ai-visibility/types.ts src/lib/ai-visibility/engines/failure.ts src/lib/ai-visibility/engines/openai.ts tests/lib/ai-visibility/engines/openai.test.ts
git commit -m "feat: openai engine reports token usage from its raw response"
```

---

### Task 3: Gemini + Anthropic engines parse token usage

**Files:**
- Modify: `src/lib/ai-visibility/engines/gemini.ts`
- Modify: `src/lib/ai-visibility/engines/anthropic.ts`
- Test: `tests/lib/ai-visibility/engines/gemini.test.ts`, `tests/lib/ai-visibility/engines/anthropic.test.ts`

**Interfaces:**
- Consumes: `EngineUsage`, `engineFailure` `usage` passthrough (Task 2).
- Produces: `usage?` populated on both engines' answers and billed failures. Same semantics as Task 2.

- [ ] **Step 1: Write the failing tests**

Follow the exact pattern of Task 2's tests, adapted to each file's existing fixtures (each has a module-level success-response fixture and a `json()`-style helper — reuse them).

Gemini — the raw field is `usageMetadata` (camelCase, per the Generative Language API):

```ts
// added to the success fixture, top level:
usageMetadata: { promptTokenCount: 21_652, candidatesTokenCount: 2_992, totalTokenCount: 24_644 },
```

```ts
it("returns token usage from a successful response", async () => {
  // ...same shape as openai test...
  expect(result.usage).toEqual({ inputTokens: 21_652, outputTokens: 2_992, totalTokens: 24_644 });
});

it("returns token usage on a MAX_TOKENS truncation", async () => {
  // fixture: candidates[0].finishReason = "MAX_TOKENS", with usageMetadata present
  // expect "kind" in result, and result.usage to equal the mapped counts
});

it("omits usage on a transport failure", async () => {
  // fetchImpl throws; expect result.usage toBeUndefined()
});
```

Anthropic — the raw field is `usage` (snake_case, Messages API; it reports no total):

```ts
// added to the success fixture, top level:
usage: { input_tokens: 17_882, output_tokens: 1_204 },
```

```ts
it("returns token usage with the total computed from input + output", async () => {
  expect(result.usage).toEqual({ inputTokens: 17_882, outputTokens: 1_204, totalTokens: 19_086 });
});

it("returns token usage on a billed refusal", async () => {
  // fixture shaped to hit the refusal path (see the existing refusal test in
  // this file for the exact shape), with `usage` present at top level
});

it("omits usage on a transport failure", async () => { /* fetchImpl throws */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/lib/ai-visibility/engines/gemini.test.ts tests/lib/ai-visibility/engines/anthropic.test.ts`
Expected: new tests FAIL.

- [ ] **Step 3: Implement**

`gemini.ts` — add to `GeminiResponse`:

```ts
type GeminiResponse = {
  modelVersion?: string;
  candidates?: GeminiCandidate[];
  usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown; totalTokenCount?: unknown };
};
```

Add the same `asCount` helper as Task 2 plus:

```ts
function readUsage(raw: GeminiResponse): EngineUsage | undefined {
  if (!isRecord(raw.usageMetadata)) return undefined;
  const usage: EngineUsage = {};
  const input = asCount(raw.usageMetadata.promptTokenCount);
  const output = asCount(raw.usageMetadata.candidatesTokenCount);
  const total = asCount(raw.usageMetadata.totalTokenCount);
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (total !== undefined) usage.totalTokens = total;
  return Object.keys(usage).length > 0 ? usage : undefined;
}
```

Wire `usage: readUsage(raw)` into: the no-candidate refusal (gemini.ts:224), the `MAX_TOKENS` failure (:233-237), the no-answer-text refusal (:244-248), the grounding-canary failure (:291-296), and the success return (:~300-310).

`anthropic.ts` — add to `AnthropicResponse`:

```ts
type AnthropicResponse = {
  model?: string;
  stop_reason?: string;
  content?: AnthropicBlock[];
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
};
```

Same `asCount`, plus (Anthropic reports no total — compute it only when both halves are real):

```ts
function readUsage(raw: AnthropicResponse): EngineUsage | undefined {
  if (!isRecord(raw.usage)) return undefined;
  const usage: EngineUsage = {};
  const input = asCount(raw.usage.input_tokens);
  const output = asCount(raw.usage.output_tokens);
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (input !== undefined && output !== undefined) usage.totalTokens = input + output;
  return Object.keys(usage).length > 0 ? usage : undefined;
}
```

Wire `usage: readUsage(raw)` into the billed paths at anthropic.ts:248, :255-259, :292-295, and the success return (:307-315). Both files import `EngineUsage` from `@/lib/ai-visibility/types`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/lib/ai-visibility/engines/`
Expected: PASS (all engine test files).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai-visibility/engines/gemini.ts src/lib/ai-visibility/engines/anthropic.ts tests/lib/ai-visibility/engines/gemini.test.ts tests/lib/ai-visibility/engines/anthropic.test.ts
git commit -m "feat: gemini and anthropic engines report token usage"
```

---

### Task 4: Record sweep-engine usage into `llm_usage`

**Files:**
- Modify: `src/lib/ai/llm-usage.ts:5-32` (add operation)
- Modify: `src/lib/ai-visibility/run.ts` (record on both result branches inside `runSlice`)
- Test: `tests/lib/ai-visibility/run.test.ts`

**Interfaces:**
- Consumes: `usage?` on engine results (Tasks 2-3), `recordLlmUsage` (existing).
- Produces: `llm_usage` rows with `operation: "ai_visibility_engine"`. Task 7's BYOK queries select exactly this operation string.

- [ ] **Step 1: Write the failing test**

In `tests/lib/ai-visibility/run.test.ts` (inside the `describe("runSlice")` block — reuse `planned()`, `fakeEngine`, `answer()`, `advancingClock`; import `llmUsage` from `../../../src/db/schema`):

```ts
it("records each engine sample's token usage as ai_visibility_engine rows", async () => {
  const { tenant, runId } = await planned();
  const openai = fakeEngine("openai", () =>
    answer({ usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } })
  );

  await runSlice(
    runId,
    { budgetMs: 60_000, concurrency: 1, now: advancingClock("2026-03-02T09:00:00Z", 10) },
    { engines: { openai } }
  );

  const rows = await db
    .select()
    .from(llmUsage)
    .where(eq(llmUsage.tenantId, tenant.id));
  // samplesPerPrompt is 3 in planned()'s settings.
  expect(rows).toHaveLength(3);
  expect(rows.every((r) => r.operation === "ai_visibility_engine")).toBe(true);
  expect(rows.every((r) => r.model === "gpt-5.1-2026-01-01")).toBe(true);
  expect(rows.every((r) => r.totalTokens === 120)).toBe(true);
});

it("records usage on a billed failure and skips samples that reported none", async () => {
  const { tenant, runId } = await planned();
  const openai = fakeEngine("openai", (_p, call) => {
    if (call === 1)
      return {
        kind: "refused" as const,
        code: "refused" as const,
        message: "declined",
        costUsd: 0.01,
        usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55 },
      };
    if (call === 2)
      return { kind: "error" as const, code: "provider_unavailable" as const, message: "down" };
    return answer(); // no usage on this one
  });

  await runSlice(
    runId,
    { budgetMs: 60_000, concurrency: 1, now: advancingClock("2026-03-02T09:00:00Z", 10) },
    { engines: { openai } }
  );

  const rows = await db.select().from(llmUsage).where(eq(llmUsage.tenantId, tenant.id));
  // Only the refusal carried usage; the transport-style error and the
  // usage-less answer record nothing.
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    operation: "ai_visibility_engine",
    // A failure has no modelId; the engine id is the honest fallback.
    model: "openai",
    totalTokens: 55,
  });
});
```

Note: the second fake's `provider_unavailable` error is retryable-less here (terminal), so it resolves in one slice. If the slice leaves it pending, mirror the existing "stores a refusal as refused and an error as error" test's shape, which uses the same codes and completes in one call.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/ai-visibility/run.test.ts`
Expected: the two new tests FAIL (0 rows found); everything else PASSES.

- [ ] **Step 3: Implement**

In `src/lib/ai/llm-usage.ts`, add to the `LlmOperation` union (after `ai_visibility_judge`):

```ts
  // AI-visibility ENGINE sweep calls — the raw-fetch BYOK calls to
  // OpenAI/Gemini/Anthropic. Recorded for the settings usage tab so a tenant
  // can track what the sweeps cost on their own keys; NEVER counted as
  // credits and never subject to a credit limit (see the usage-tab spec).
  // `model` holds the provider's reported snapshot id when known, else the
  // engine id.
  | "ai_visibility_engine"
```

Also update the stale comment above `ai_visibility_prompts` (llm-usage.ts:20-22): the engine calls are no longer absent from this table — their tokens land here as `ai_visibility_engine` while their USD estimates stay on `ai_visibility_runs.costUsd`.

In `src/lib/ai-visibility/run.ts`:
- Import: `import { recordLlmUsage } from "@/lib/ai/llm-usage";`
- In the failure branch of the per-row worker, directly after the `aiVisibilitySamples` update (after run.ts:747, before the `flipEngineKeyOnFailure` block):

```ts
          // Tokens the tenant's own key was billed for, when the provider said.
          // Tracking only — never credits. `recordLlmUsage` never throws.
          if (result.usage) {
            await recordLlmUsage(
              {
                tenantId: run.tenantId,
                operation: "ai_visibility_engine",
                // An EngineError carries no modelId; the engine id is the
                // honest fallback and the usage queries label it the same way.
                model: row.engine,
                usage: result.usage,
              },
              database
            );
          }
```

- In the success branch, directly after the sample's `ok` update (after run.ts:806, before the extraction block):

```ts
        if (result.usage) {
          await recordLlmUsage(
            {
              tenantId: run.tenantId,
              operation: "ai_visibility_engine",
              model: result.modelId,
              usage: result.usage,
            },
            database
          );
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/lib/ai-visibility/run.test.ts tests/lib/ai/llm-usage.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/llm-usage.ts src/lib/ai-visibility/run.ts tests/lib/ai-visibility/run.test.ts
git commit -m "feat: record sweep-engine token usage as ai_visibility_engine rows"
```

---

### Task 5: Feature display map

**Files:**
- Create: `src/lib/usage/features.ts`
- Test: `tests/lib/usage/features.test.ts`

**Interfaces:**
- Consumes: nothing (pure module — no imports, so client components can use it freely).
- Produces:
  - `type FeatureKey = "content_generation" | "review_revision" | "briefs_ideation" | "images" | "signals" | "linkedin" | "onboarding_brand" | "ai_visibility" | "other"`
  - `FEATURE_ORDER: FeatureKey[]` (display order, `other` last)
  - `FEATURE_LABELS: Record<FeatureKey, string>`
  - `featureForOperation(operation: string): FeatureKey`
  - `byokEngineLabel(model: string): string`

- [ ] **Step 1: Write the failing test**

`tests/lib/usage/features.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  FEATURE_LABELS,
  FEATURE_ORDER,
  featureForOperation,
  byokEngineLabel,
} from "../../../src/lib/usage/features";

describe("featureForOperation", () => {
  it("maps every known operation to its product feature", () => {
    expect(featureForOperation("generation")).toBe("content_generation");
    expect(featureForOperation("brief_draft")).toBe("content_generation");
    expect(featureForOperation("atomic_summary")).toBe("content_generation");
    expect(featureForOperation("resolution")).toBe("content_generation");
    expect(featureForOperation("review")).toBe("review_revision");
    expect(featureForOperation("revision")).toBe("review_revision");
    expect(featureForOperation("brief_proposal")).toBe("briefs_ideation");
    expect(featureForOperation("ideation")).toBe("briefs_ideation");
    expect(featureForOperation("image_generation")).toBe("images");
    expect(featureForOperation("illustration_plan")).toBe("images");
    expect(featureForOperation("signal_relevance")).toBe("signals");
    expect(featureForOperation("news_selection")).toBe("signals");
    expect(featureForOperation("enrichment")).toBe("signals");
    expect(featureForOperation("linkedin_copy")).toBe("linkedin");
    expect(featureForOperation("brand_analysis")).toBe("onboarding_brand");
    expect(featureForOperation("company_context_analysis")).toBe("onboarding_brand");
    expect(featureForOperation("ai_visibility_prompts")).toBe("ai_visibility");
    expect(featureForOperation("ai_visibility_judge")).toBe("ai_visibility");
  });

  it("routes an unknown operation to 'other', never dropping it", () => {
    expect(featureForOperation("some_future_operation")).toBe("other");
  });

  it("does NOT map ai_visibility_engine — it belongs to the BYOK channel", () => {
    // The queries exclude it before this map is consulted; if it ever arrives
    // here, "other" keeps it visible rather than counted under a feature.
    expect(featureForOperation("ai_visibility_engine")).toBe("other");
  });

  it("labels and orders every feature", () => {
    for (const key of FEATURE_ORDER) expect(FEATURE_LABELS[key]).toBeTruthy();
    expect(FEATURE_ORDER[FEATURE_ORDER.length - 1]).toBe("other");
  });
});

describe("byokEngineLabel", () => {
  it("maps snapshot ids and engine ids to engine names", () => {
    expect(byokEngineLabel("gpt-5.5-2026-04-23")).toBe("GPT");
    expect(byokEngineLabel("openai")).toBe("GPT");
    expect(byokEngineLabel("gemini-2.5-flash")).toBe("Gemini");
    expect(byokEngineLabel("gemini")).toBe("Gemini");
    expect(byokEngineLabel("claude-sonnet-4-5")).toBe("Claude");
    expect(byokEngineLabel("anthropic")).toBe("Claude");
  });

  it("passes an unknown model through unchanged", () => {
    expect(byokEngineLabel("mystery-model-9")).toBe("mystery-model-9");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/usage/features.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/lib/usage/features.ts`:

```ts
/**
 * How raw `llm_usage.operation` values roll up into product-facing features
 * for the settings usage tab.
 *
 * `operation` is the storage dimension and is deliberately finer-grained than
 * the product (four call sites all record `generation`). This map is the ONLY
 * place the grouping lives. An operation missing from it lands in "other"
 * rather than disappearing — the map must never silently drop usage.
 *
 * `ai_visibility_engine` is intentionally absent: those are BYOK sweep rows,
 * excluded from the credit channel by the queries before this map is asked.
 *
 * Imports nothing, so client components can use the labels without pulling
 * server code into the bundle.
 */

export type FeatureKey =
  | "content_generation"
  | "review_revision"
  | "briefs_ideation"
  | "images"
  | "signals"
  | "linkedin"
  | "onboarding_brand"
  | "ai_visibility"
  | "other";

export const FEATURE_ORDER: FeatureKey[] = [
  "content_generation",
  "review_revision",
  "briefs_ideation",
  "images",
  "signals",
  "linkedin",
  "onboarding_brand",
  "ai_visibility",
  "other",
];

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  content_generation: "Content generation",
  review_revision: "Review & revision",
  briefs_ideation: "Briefs & ideation",
  images: "Images",
  signals: "Signals",
  linkedin: "LinkedIn",
  onboarding_brand: "Onboarding & brand",
  ai_visibility: "AI visibility",
  other: "Other",
};

const OPERATION_FEATURES: Record<string, FeatureKey> = {
  generation: "content_generation",
  brief_draft: "content_generation",
  atomic_summary: "content_generation",
  resolution: "content_generation",
  review: "review_revision",
  revision: "review_revision",
  brief_proposal: "briefs_ideation",
  ideation: "briefs_ideation",
  image_generation: "images",
  illustration_plan: "images",
  signal_relevance: "signals",
  news_selection: "signals",
  enrichment: "signals",
  linkedin_copy: "linkedin",
  brand_analysis: "onboarding_brand",
  company_context_analysis: "onboarding_brand",
  ai_visibility_prompts: "ai_visibility",
  ai_visibility_judge: "ai_visibility",
};

export function featureForOperation(operation: string): FeatureKey {
  return OPERATION_FEATURES[operation] ?? "other";
}

/**
 * Engine name for a BYOK row's `model` column, which holds the provider's
 * dated snapshot id when the call succeeded (e.g. "gpt-5.5-2026-04-23") and
 * the engine id when it failed (e.g. "openai"). Unknown values pass through
 * unchanged — shown as-is beats shown wrong.
 */
export function byokEngineLabel(model: string): string {
  if (model === "openai" || model.startsWith("gpt-")) return "GPT";
  if (model === "gemini" || model.startsWith("gemini-")) return "Gemini";
  if (model === "anthropic" || model.startsWith("claude-")) return "Claude";
  return model;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/usage/features.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/usage/features.ts tests/lib/usage/features.test.ts
git commit -m "feat: operation-to-feature display map for the usage tab"
```

---

### Task 6: Credit queries

**Files:**
- Create: `src/lib/usage/queries.ts`
- Test: `tests/lib/usage/queries.test.ts`

**Interfaces:**
- Consumes: `llmUsage` schema, `featureForOperation`/`FeatureKey` (Task 5), index (Task 1).
- Produces (Task 8's UI and Task 7 build on these exact signatures):

```ts
export type Granularity = "daily" | "weekly" | "monthly";
export type UsagePoint = { bucket: string; feature: FeatureKey; credits: number };
export function bucketKeys(granularity: Granularity, now: Date): string[];
export function windowStart(granularity: Granularity, now: Date): Date;
export function creditsByPeriod(tenantId: string, granularity: Granularity, now?: Date): Promise<UsagePoint[]>;
export function creditsByFeature(tenantId: string, granularity: Granularity, now?: Date): Promise<{ feature: FeatureKey; credits: number }[]>;
export function monthToDateCredits(tenantId: string, now?: Date): Promise<number>;
```

Bucket key formats: daily `YYYY-MM-DD`, weekly `YYYY-MM-DD` (the ISO week's Monday), monthly `YYYY-MM`. Windows: last 30 days / last 12 ISO weeks / last 12 calendar months, all UTC, current period included.

- [ ] **Step 1: Write the failing tests**

`tests/lib/usage/queries.test.ts`. Tenant name must be unique to this file. Note `vitest.setup.ts` pins `TZ=Asia/Jerusalem` — that is the point of the UTC assertions below.

```ts
import { describe, it, expect, afterEach } from "vitest";
import { db } from "../../../src/db";
import { llmUsage } from "../../../src/db/schema";
import { seedTenant, dropTenant } from "../../helpers/fixtures";
import {
  bucketKeys,
  creditsByFeature,
  creditsByPeriod,
  monthToDateCredits,
  windowStart,
} from "../../../src/lib/usage/queries";

const NAME = "Usage Queries Test Tenant";
const NOW = new Date("2026-08-28T10:00:00Z"); // a Friday; ISO week starts Mon 2026-08-24

afterEach(async () => {
  await dropTenant(NAME);
});

async function seedRow(
  tenantId: string,
  overrides: Partial<typeof llmUsage.$inferInsert> = {}
) {
  await db.insert(llmUsage).values({
    tenantId,
    operation: "generation",
    model: "claude-sonnet-4-5",
    inputTokens: 80,
    outputTokens: 20,
    totalTokens: 100,
    createdAt: new Date("2026-08-28T09:00:00Z"),
    ...overrides,
  });
}

describe("bucketKeys", () => {
  it("produces 30 daily keys ending today (UTC)", () => {
    const keys = bucketKeys("daily", NOW);
    expect(keys).toHaveLength(30);
    expect(keys[29]).toBe("2026-08-28");
    expect(keys[0]).toBe("2026-07-30");
  });

  it("produces 12 weekly keys of ISO Mondays ending this week", () => {
    const keys = bucketKeys("weekly", NOW);
    expect(keys).toHaveLength(12);
    expect(keys[11]).toBe("2026-08-24"); // Monday of NOW's week
    expect(keys[10]).toBe("2026-08-17");
  });

  it("produces 12 monthly keys ending this month", () => {
    const keys = bucketKeys("monthly", NOW);
    expect(keys).toHaveLength(12);
    expect(keys[11]).toBe("2026-08");
    expect(keys[0]).toBe("2025-09");
  });
});

describe("creditsByPeriod", () => {
  it("sums total_tokens per UTC day per feature", async () => {
    const tenant = await seedTenant(NAME);
    await seedRow(tenant.id); // generation, 100, 2026-08-28
    await seedRow(tenant.id, { operation: "brief_draft", totalTokens: 50 }); // same feature
    await seedRow(tenant.id, { operation: "review", totalTokens: 7 });
    // 23:30 UTC on the 27th is already the 28th in the test TZ (Asia/Jerusalem);
    // it must land in the 27th's bucket, because buckets are UTC.
    await seedRow(tenant.id, { createdAt: new Date("2026-08-27T23:30:00Z"), totalTokens: 9 });

    const points = await creditsByPeriod(tenant.id, "daily", NOW);
    const on28 = points.filter((p) => p.bucket === "2026-08-28");
    expect(on28).toContainEqual({ bucket: "2026-08-28", feature: "content_generation", credits: 150 });
    expect(on28).toContainEqual({ bucket: "2026-08-28", feature: "review_revision", credits: 7 });
    expect(points).toContainEqual({ bucket: "2026-08-27", feature: "content_generation", credits: 9 });
  });

  it("excludes ai_visibility_engine rows and rows outside the window", async () => {
    const tenant = await seedTenant(NAME);
    await seedRow(tenant.id, { operation: "ai_visibility_engine", totalTokens: 999_999 });
    await seedRow(tenant.id, { createdAt: new Date("2026-06-01T00:00:00Z"), totalTokens: 888 });
    await seedRow(tenant.id, { totalTokens: 5 });

    const points = await creditsByPeriod(tenant.id, "daily", NOW);
    expect(points.reduce((sum, p) => sum + p.credits, 0)).toBe(5);
  });

  it("counts null-token rows as zero and routes unknown operations to other", async () => {
    const tenant = await seedTenant(NAME);
    await seedRow(tenant.id, { totalTokens: null, inputTokens: null, outputTokens: null });
    await seedRow(tenant.id, { operation: "brand_new_op", totalTokens: 3 });

    const points = await creditsByPeriod(tenant.id, "daily", NOW);
    expect(points).toContainEqual({ bucket: "2026-08-28", feature: "other", credits: 3 });
    const generation = points.find((p) => p.feature === "content_generation");
    expect(generation?.credits ?? 0).toBe(0); // the null row contributed nothing
  });

  it("buckets weekly rows onto their ISO Monday", async () => {
    const tenant = await seedTenant(NAME);
    await seedRow(tenant.id, { createdAt: new Date("2026-08-26T12:00:00Z"), totalTokens: 40 });

    const points = await creditsByPeriod(tenant.id, "weekly", NOW);
    expect(points).toContainEqual({ bucket: "2026-08-24", feature: "content_generation", credits: 40 });
  });

  it("scopes to the tenant", async () => {
    const tenant = await seedTenant(NAME);
    const other = await seedTenant(`${NAME} Neighbour`);
    await seedRow(other.id, { totalTokens: 777 });
    const points = await creditsByPeriod(tenant.id, "daily", NOW);
    expect(points).toHaveLength(0);
    await dropTenant(`${NAME} Neighbour`);
  });
});

describe("creditsByFeature", () => {
  it("totals the window per feature, descending", async () => {
    const tenant = await seedTenant(NAME);
    await seedRow(tenant.id, { totalTokens: 10 });
    await seedRow(tenant.id, { operation: "review", totalTokens: 30 });

    const rows = await creditsByFeature(tenant.id, "daily", NOW);
    expect(rows[0]).toEqual({ feature: "review_revision", credits: 30 });
    expect(rows[1]).toEqual({ feature: "content_generation", credits: 10 });
  });
});

describe("monthToDateCredits", () => {
  it("sums the current UTC calendar month, excluding BYOK rows", async () => {
    const tenant = await seedTenant(NAME);
    await seedRow(tenant.id, { totalTokens: 100 });
    await seedRow(tenant.id, { createdAt: new Date("2026-08-01T00:00:00Z"), totalTokens: 11 });
    await seedRow(tenant.id, { createdAt: new Date("2026-07-31T23:59:00Z"), totalTokens: 500 });
    await seedRow(tenant.id, { operation: "ai_visibility_engine", totalTokens: 9_000 });

    expect(await monthToDateCredits(tenant.id, NOW)).toBe(111);
  });
});

describe("windowStart", () => {
  it("is UTC midnight boundaries for all three granularities", () => {
    expect(windowStart("daily", NOW).toISOString()).toBe("2026-07-30T00:00:00.000Z");
    expect(windowStart("weekly", NOW).toISOString()).toBe("2026-06-08T00:00:00.000Z");
    expect(windowStart("monthly", NOW).toISOString()).toBe("2025-09-01T00:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/lib/usage/queries.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/lib/usage/queries.ts`:

```ts
import { and, eq, gte, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { llmUsage } from "@/db/schema";
import { featureForOperation, type FeatureKey } from "@/lib/usage/features";

/**
 * The usage tab's read side. Live GROUP BY over `llm_usage` — no rollup
 * tables, deliberately: the daily-only Hobby cron would make a rollup stale
 * by design, and the table is small and tenant-scoped (see the spec).
 *
 * CREDITS = COALESCE(total_tokens, 0), uniformly. Rows with
 * `operation = 'ai_visibility_engine'` are BYOK sweep tokens: excluded from
 * every credit aggregate here and selected exclusively by the byok*
 * functions. All bucketing is UTC; weeks are ISO Mondays.
 */

export type Granularity = "daily" | "weekly" | "monthly";
export type UsagePoint = { bucket: string; feature: FeatureKey; credits: number };

const BYOK_OPERATION = "ai_visibility_engine";

const TRUNC_UNIT: Record<Granularity, string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
};

/** "YYYY-MM-DD" for daily/weekly buckets, "YYYY-MM" for monthly. */
function keyFor(granularity: Granularity, date: Date): string {
  const iso = date.toISOString();
  return granularity === "monthly" ? iso.slice(0, 7) : iso.slice(0, 10);
}

/** UTC midnight of `date`'s ISO week's Monday. */
function isoWeekStart(date: Date): Date {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const back = (day.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  day.setUTCDate(day.getUTCDate() - back);
  return day;
}

export function windowStart(granularity: Granularity, now: Date): Date {
  if (granularity === "daily") {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    start.setUTCDate(start.getUTCDate() - 29);
    return start;
  }
  if (granularity === "weekly") {
    const start = isoWeekStart(now);
    start.setUTCDate(start.getUTCDate() - 11 * 7);
    return start;
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
}

/**
 * Every bucket key in the window, oldest first, current period last — the
 * zero-fill skeleton the chart plots over. Generated in code rather than SQL
 * so an empty week is a visible gap instead of a missing bar.
 */
export function bucketKeys(granularity: Granularity, now: Date): string[] {
  const keys: string[] = [];
  if (granularity === "daily") {
    const cursor = windowStart("daily", now);
    for (let i = 0; i < 30; i++) {
      keys.push(keyFor("daily", cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  } else if (granularity === "weekly") {
    const cursor = windowStart("weekly", now);
    for (let i = 0; i < 12; i++) {
      keys.push(keyFor("weekly", cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 7);
    }
  } else {
    for (let i = 11; i >= 0; i--) {
      keys.push(keyFor("monthly", new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
    }
  }
  return keys;
}

/**
 * `created_at` is timestamptz; truncating `created_at AT TIME ZONE 'UTC'`
 * pins the bucket boundary to UTC midnight regardless of the server TZ, and
 * `to_char` keys it as text so no Date round-trips through the driver.
 */
function bucketExpr(granularity: Granularity) {
  const pattern = granularity === "monthly" ? "YYYY-MM" : "YYYY-MM-DD";
  return sql<string>`to_char(date_trunc(${TRUNC_UNIT[granularity]}, ${llmUsage.createdAt} at time zone 'UTC'), ${pattern})`;
}

const creditsExpr = sql<number>`coalesce(sum(coalesce(${llmUsage.totalTokens}, 0)), 0)::int`;

/** bucket × feature credit sums over the granularity's window. Not zero-filled. */
export async function creditsByPeriod(
  tenantId: string,
  granularity: Granularity,
  now: Date = new Date()
): Promise<UsagePoint[]> {
  const bucket = bucketExpr(granularity);
  const rows = await db
    .select({ bucket, operation: llmUsage.operation, credits: creditsExpr })
    .from(llmUsage)
    .where(
      and(
        eq(llmUsage.tenantId, tenantId),
        ne(llmUsage.operation, BYOK_OPERATION),
        gte(llmUsage.createdAt, windowStart(granularity, now))
      )
    )
    .groupBy(bucket, llmUsage.operation);

  // Operations merge into features here, not in SQL — the map is TypeScript.
  const merged = new Map<string, UsagePoint>();
  for (const row of rows) {
    const feature = featureForOperation(row.operation);
    const key = `${row.bucket}|${feature}`;
    const existing = merged.get(key);
    if (existing) existing.credits += row.credits;
    else merged.set(key, { bucket: row.bucket, feature, credits: row.credits });
  }
  return [...merged.values()];
}

export async function creditsByFeature(
  tenantId: string,
  granularity: Granularity,
  now: Date = new Date()
): Promise<{ feature: FeatureKey; credits: number }[]> {
  const points = await creditsByPeriod(tenantId, granularity, now);
  const totals = new Map<FeatureKey, number>();
  for (const point of points) {
    totals.set(point.feature, (totals.get(point.feature) ?? 0) + point.credits);
  }
  return [...totals.entries()]
    .map(([feature, credits]) => ({ feature, credits }))
    .sort((a, b) => b.credits - a.credits);
}

export async function monthToDateCredits(tenantId: string, now: Date = new Date()): Promise<number> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [row] = await db
    .select({ credits: creditsExpr })
    .from(llmUsage)
    .where(
      and(
        eq(llmUsage.tenantId, tenantId),
        ne(llmUsage.operation, BYOK_OPERATION),
        gte(llmUsage.createdAt, monthStart)
      )
    );
  return row?.credits ?? 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/lib/usage/queries.test.ts`
Expected: PASS. If a bucket assertion fails, print the actual points before touching the SQL — the likely culprit is timezone handling, and the fix is in `bucketExpr`/`windowStart`, never in the test's UTC expectations.

- [ ] **Step 5: Commit**

```bash
git add src/lib/usage/queries.ts tests/lib/usage/queries.test.ts
git commit -m "feat: credit usage queries (daily/weekly/monthly, per feature)"
```

---

### Task 7: BYOK queries + limit seam

**Files:**
- Modify: `src/lib/usage/queries.ts`
- Create: `src/lib/usage/limit.ts`
- Test: `tests/lib/usage/queries.test.ts` (extend)

**Interfaces:**
- Consumes: Task 6's helpers (`bucketExpr`, `windowStart`, `bucketKeys`), `byokEngineLabel` (Task 5).
- Produces:

```ts
export type ByokPoint = { bucket: string; engine: string; tokens: number };
export function byokTokensByPeriod(tenantId: string, granularity: Granularity, now?: Date): Promise<ByokPoint[]>;
export function byokTokensMonthToDate(tenantId: string, now?: Date): Promise<number>;
// limit.ts:
export function getMonthlyCreditLimit(tenantId: string): Promise<number | null>;
```

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/usage/queries.test.ts` (import `byokTokensByPeriod`, `byokTokensMonthToDate` from queries and `getMonthlyCreditLimit` from `../../../src/lib/usage/limit`):

```ts
describe("byokTokensByPeriod", () => {
  it("selects only ai_visibility_engine rows, grouped by engine label", async () => {
    const tenant = await seedTenant(NAME);
    await seedRow(tenant.id, { totalTokens: 100 }); // credit row — excluded here
    await seedRow(tenant.id, {
      operation: "ai_visibility_engine",
      model: "gpt-5.5-2026-04-23",
      totalTokens: 200,
    });
    await seedRow(tenant.id, {
      operation: "ai_visibility_engine",
      model: "openai", // failure-path fallback model — same engine
      totalTokens: 50,
    });
    await seedRow(tenant.id, {
      operation: "ai_visibility_engine",
      model: "claude-sonnet-4-5",
      totalTokens: 30,
    });

    const points = await byokTokensByPeriod(tenant.id, "monthly", NOW);
    expect(points).toContainEqual({ bucket: "2026-08", engine: "GPT", tokens: 250 });
    expect(points).toContainEqual({ bucket: "2026-08", engine: "Claude", tokens: 30 });
    expect(points.some((p) => p.engine === "Gemini")).toBe(false);
  });
});

describe("byokTokensMonthToDate", () => {
  it("sums the current UTC month's engine rows only", async () => {
    const tenant = await seedTenant(NAME);
    await seedRow(tenant.id, { totalTokens: 100 });
    await seedRow(tenant.id, { operation: "ai_visibility_engine", totalTokens: 40 });
    await seedRow(tenant.id, {
      operation: "ai_visibility_engine",
      totalTokens: 999,
      createdAt: new Date("2026-07-15T00:00:00Z"),
    });
    expect(await byokTokensMonthToDate(tenant.id, NOW)).toBe(40);
  });
});

describe("getMonthlyCreditLimit", () => {
  it("returns null — no package model exists yet", async () => {
    const tenant = await seedTenant(NAME);
    expect(await getMonthlyCreditLimit(tenant.id)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/lib/usage/queries.test.ts`
Expected: new tests FAIL.

- [ ] **Step 3: Implement**

Append to `src/lib/usage/queries.ts`:

```ts
export type ByokPoint = { bucket: string; engine: string; tokens: number };

/**
 * The BYOK channel: tokens the AI-visibility sweeps spent on the TENANT'S OWN
 * keys. Tracking only — never credits, never limited. Grouped by engine label
 * because `model` holds a snapshot id on success and the engine id on billed
 * failures; `byokEngineLabel` folds both onto one engine.
 */
export async function byokTokensByPeriod(
  tenantId: string,
  granularity: Granularity,
  now: Date = new Date()
): Promise<ByokPoint[]> {
  const bucket = bucketExpr(granularity);
  const rows = await db
    .select({
      bucket,
      model: llmUsage.model,
      tokens: sql<number>`coalesce(sum(coalesce(${llmUsage.totalTokens}, 0)), 0)::int`,
    })
    .from(llmUsage)
    .where(
      and(
        eq(llmUsage.tenantId, tenantId),
        eq(llmUsage.operation, BYOK_OPERATION),
        gte(llmUsage.createdAt, windowStart(granularity, now))
      )
    )
    .groupBy(bucket, llmUsage.model);

  const merged = new Map<string, ByokPoint>();
  for (const row of rows) {
    const engine = byokEngineLabel(row.model);
    const key = `${row.bucket}|${engine}`;
    const existing = merged.get(key);
    if (existing) existing.tokens += row.tokens;
    else merged.set(key, { bucket: row.bucket, engine, tokens: row.tokens });
  }
  return [...merged.values()];
}

export async function byokTokensMonthToDate(tenantId: string, now: Date = new Date()): Promise<number> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [row] = await db
    .select({ tokens: sql<number>`coalesce(sum(coalesce(${llmUsage.totalTokens}, 0)), 0)::int` })
    .from(llmUsage)
    .where(
      and(
        eq(llmUsage.tenantId, tenantId),
        eq(llmUsage.operation, BYOK_OPERATION),
        gte(llmUsage.createdAt, monthStart)
      )
    );
  return row?.tokens ?? 0;
}
```

Add `byokEngineLabel` to the imports from `@/lib/usage/features`.

Create `src/lib/usage/limit.ts`:

```ts
/**
 * The monthly credit limit for a tenant, or null when there is none.
 *
 * THE LIMIT SEAM. There is no plan/package model yet, so every tenant is
 * unlimited and this returns null unconditionally — the usage tab renders a
 * plain month-to-date total for null and a progress-against-limit view for a
 * number (see `usage-headline.tsx`), so wiring a real source here is the only
 * change the UI needs when packages land. Enforcement (blocking calls at the
 * limit) is explicitly out of scope until then — see the usage-tab spec.
 */
export async function getMonthlyCreditLimit(_tenantId: string): Promise<number | null> {
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/lib/usage/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/usage/queries.ts src/lib/usage/limit.ts tests/lib/usage/queries.test.ts
git commit -m "feat: BYOK sweep-token queries and the monthly-limit seam"
```

---

### Task 8: Settings page becomes two tabs

**Files:**
- Create: `src/app/(dashboard)/settings/settings-tabs.tsx`
- Create: `src/app/(dashboard)/settings/workspace-settings.tsx`
- Modify: `src/app/(dashboard)/settings/page.tsx`

**Interfaces:**
- Consumes: the existing page's entire body and data loading (moved verbatim).
- Produces: `<WorkspaceSettings />` (async server component, no props), `<SettingsTabs active={"workspace" | "usage"} />`. Task 9 adds `<UsageSettings />` as the second panel; until then the usage tab renders a placeholder `<p>`.

- [ ] **Step 1: Move the current page body into `workspace-settings.tsx`**

Create `src/app/(dashboard)/settings/workspace-settings.tsx` containing everything `page.tsx` has today: the imports (minus none), the data loading (lines 30-95), and the returned JSX (lines 97-196), renamed:

```tsx
export async function WorkspaceSettings() {
  // ...the entire current body of SettingsPage, unchanged...
}
```

Keep `requireSession()` inside it — the component owns its data exactly as the page did. Do not change any card, id, or comment.

- [ ] **Step 2: Create the tab nav**

`src/app/(dashboard)/settings/settings-tabs.tsx` — a server-safe nav of links (no client state; the server decides the active tab from the URL, so deep links and back/forward work with zero JS):

```tsx
import Link from "next/link";
import { cn } from "@/lib/utils";

export type SettingsTab = "workspace" | "usage";

const TABS: { key: SettingsTab; label: string; href: string }[] = [
  { key: "workspace", label: "Workspace", href: "/settings" },
  { key: "usage", label: "AI usage", href: "/settings?tab=usage" },
];

/**
 * Links styled as tab pills rather than the client `Tabs` component: the
 * active tab is server state (the `?tab=` search param), the panels are
 * Server Components that must not both render, and a link keeps deep links,
 * back/forward and the sidebar's `#ai-engines` anchors working with no
 * hydration. Mirrors the ui/tabs.tsx pill styling.
 */
export function SettingsTabs({ active }: { active: SettingsTab }) {
  return (
    <nav
      aria-label="Settings sections"
      className="inline-flex w-fit items-center justify-center rounded-lg bg-muted p-[3px]"
    >
      {TABS.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={tab.key === active ? "page" : undefined}
          className={cn(
            "inline-flex items-center justify-center rounded-md px-3 py-1 text-sm font-medium whitespace-nowrap transition-all",
            tab.key === active
              ? "bg-background text-foreground shadow-sm"
              : "text-foreground/60 hover:text-foreground"
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
```

- [ ] **Step 3: Rewrite `page.tsx` as the thin switcher**

```tsx
import { SettingsTabs, type SettingsTab } from "./settings-tabs";
import { WorkspaceSettings } from "./workspace-settings";

/**
 * `?tab=` decides the panel and ONLY the active panel's Server Component
 * renders, so the usage tab's queries never run for a tenant reading the
 * workspace cards and vice versa. Workspace is the default, which keeps the
 * sidebar's existing `/settings#ai-engines` links landing on their cards.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const active: SettingsTab = tab === "usage" ? "usage" : "workspace";

  return (
    <div className="space-y-6">
      <SettingsTabs active={active} />
      {active === "usage" ? (
        <p className="text-sm text-muted-foreground">AI usage — coming in the next task.</p>
      ) : (
        <WorkspaceSettings />
      )}
    </div>
  );
}
```

(The placeholder `<p>` is replaced by `<UsageSettings />` in Task 9.)

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run lint`
Expected: clean.

Run: `npx vitest run tests/app 2>/dev/null || npm test`
Expected: no regressions (if any existing test imports `settings/page.tsx` or asserts on its output, fix the import path to `workspace-settings.tsx` — search `tests/` for `settings/page` first).

- [ ] **Step 5: Commit**

```bash
git add src/app/\(dashboard\)/settings/page.tsx src/app/\(dashboard\)/settings/settings-tabs.tsx src/app/\(dashboard\)/settings/workspace-settings.tsx
git commit -m "feat: settings page split into Workspace and AI usage tabs"
```

---

### Task 9: Usage tab — headline, chart, breakdown table

**Files:**
- Create: `src/app/(dashboard)/settings/usage-headline.tsx`
- Create: `src/app/(dashboard)/settings/usage-chart.tsx`
- Create: `src/app/(dashboard)/settings/usage-settings.tsx`
- Modify: `src/app/(dashboard)/settings/page.tsx` (swap placeholder for `<UsageSettings />`)
- Test: `tests/components/usage-headline.test.tsx`, `tests/components/usage-chart.test.tsx`

**Interfaces:**
- Consumes: Task 6/7 queries, Task 5 labels, `ChartContainer`/`ChartConfig`/`ChartTooltipContent` from `@/components/ui/chart`, `Card` family, `Tabs` family.
- Produces: `<UsageSettings />` (async server component, no props); `UsageHeadline({ credits, limit })`; `UsageChart({ datasets, features })` where:

```ts
// Chart row: one bucket, one numeric key per FeatureKey present in the window.
export type UsageChartRow = { bucket: string; label: string } & Partial<Record<FeatureKey, number>>;
export type UsageDataset = {
  rows: UsageChartRow[];
  totals: { feature: FeatureKey; credits: number }[];
};
// datasets: Record<Granularity, UsageDataset>; features: FeatureKey[] (ordered, only those with any usage)
```

- [ ] **Step 1: Write the failing component tests**

`tests/components/usage-headline.test.tsx` (jsdom project — anything under `tests/components/` runs there; follow an existing file in that directory for the render/cleanup conventions):

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { UsageHeadline } from "../../src/app/(dashboard)/settings/usage-headline";

describe("UsageHeadline", () => {
  it("renders a plain total when there is no limit", () => {
    render(<UsageHeadline credits={1234567} limit={null} />);
    expect(screen.getByText(/1,234,567 credits/)).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText(/of/)).not.toBeInTheDocument();
  });

  it("renders progress against a limit when one exists", () => {
    render(<UsageHeadline credits={250_000} limit={1_000_000} />);
    expect(screen.getByText(/250,000 of 1,000,000 credits/)).toBeInTheDocument();
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "250000");
    expect(bar).toHaveAttribute("aria-valuemax", "1000000");
  });
});
```

`tests/components/usage-chart.test.tsx` — recharts does not draw in jsdom (zero-size container), so assert on the breakdown TABLE and the toggle, which is the state logic worth testing:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UsageChart } from "../../src/app/(dashboard)/settings/usage-chart";

const DATASETS = {
  daily: {
    rows: [{ bucket: "2026-08-28", label: "Aug 28", content_generation: 100 }],
    totals: [{ feature: "content_generation" as const, credits: 100 }],
  },
  weekly: {
    rows: [{ bucket: "2026-08-24", label: "Aug 24", content_generation: 700 }],
    totals: [{ feature: "content_generation" as const, credits: 700 }],
  },
  monthly: {
    rows: [{ bucket: "2026-08", label: "Aug 2026", content_generation: 3000 }],
    totals: [{ feature: "content_generation" as const, credits: 3000 }],
  },
};

describe("UsageChart", () => {
  it("shows the daily dataset by default and switches on toggle", async () => {
    const user = userEvent.setup();
    render(<UsageChart datasets={DATASETS} features={["content_generation"]} />);

    expect(screen.getByText("100")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Monthly" }));
    expect(screen.getByText("3,000")).toBeInTheDocument();
    expect(screen.queryByText("100")).not.toBeInTheDocument();
  });

  it("renders a feature row with label and share", async () => {
    render(<UsageChart datasets={DATASETS} features={["content_generation"]} />);
    expect(screen.getByText("Content generation")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/components/usage-headline.test.tsx tests/components/usage-chart.test.tsx`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement the components**

`usage-headline.tsx` — presentational, no `"use client"` needed (no hooks or handlers), which is what lets both the server page and the jsdom test render it:

```tsx
/**
 * Month-to-date credits, and — the limit seam's UI half — progress against a
 * monthly limit when `getMonthlyCreditLimit` starts returning one. `null`
 * limit renders a plain total with NO mention of limits: today every tenant
 * is unlimited and the UI must not imply otherwise.
 *
 * Numbers via a pinned locale ("en-US") like `group-by-month.ts` — a
 * server/client locale mismatch here is a hydration error.
 */
const formatter = new Intl.NumberFormat("en-US");

export function UsageHeadline({ credits, limit }: { credits: number; limit: number | null }) {
  if (limit === null) {
    return (
      <div className="space-y-1">
        <p className="text-2xl font-semibold">{formatter.format(credits)} credits</p>
        <p className="text-sm text-muted-foreground">used this month (1 credit = 1 token)</p>
      </div>
    );
  }
  const pct = Math.min(100, Math.round((credits / limit) * 100));
  return (
    <div className="space-y-2">
      <p className="text-2xl font-semibold">
        {formatter.format(credits)} of {formatter.format(limit)} credits
      </p>
      <div
        role="progressbar"
        aria-valuenow={credits}
        aria-valuemin={0}
        aria-valuemax={limit}
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-sm text-muted-foreground">used this month (1 credit = 1 token)</p>
    </div>
  );
}
```

`usage-chart.tsx` — the one client component: granularity toggle + stacked bar chart + breakdown table sharing that state:

```tsx
"use client";

import { useState } from "react";
import { Bar, BarChart, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltipContent, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FEATURE_LABELS, type FeatureKey } from "@/lib/usage/features";
import type { Granularity } from "@/lib/usage/queries";

export type UsageChartRow = { bucket: string; label: string } & Partial<Record<FeatureKey, number>>;
export type UsageDataset = {
  rows: UsageChartRow[];
  totals: { feature: FeatureKey; credits: number }[];
};

const GRANULARITIES: { key: Granularity; label: string }[] = [
  { key: "daily", label: "Daily" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
];

const formatter = new Intl.NumberFormat("en-US");

/**
 * All three datasets arrive precomputed from the server (≤ 30 rows each), so
 * the toggle is pure client state — no fetch, no server round-trip.
 *
 * Bars are stacked by feature on the sequential --chart-* ramp. Unlike the
 * trend chart's 1px lines (see visibility-trend.tsx's contrast note), filled
 * bars carry enough area for the ramp to stay readable; identity is also in
 * the tooltip and the table below, never colour alone.
 */
export function UsageChart({
  datasets,
  features,
}: {
  datasets: Record<Granularity, UsageDataset>;
  features: FeatureKey[];
}) {
  const [granularity, setGranularity] = useState<Granularity>("daily");
  const { rows, totals } = datasets[granularity];
  const total = totals.reduce((sum, t) => sum + t.credits, 0);

  const config: ChartConfig = Object.fromEntries(
    features.map((feature, i) => [
      feature,
      { label: FEATURE_LABELS[feature], color: `var(--chart-${(i % 5) + 1})` },
    ])
  );

  return (
    <div className="space-y-6">
      <Tabs value={granularity} onValueChange={(value) => setGranularity(value as Granularity)}>
        <TabsList>
          {GRANULARITIES.map((g) => (
            <TabsTrigger key={g.key} value={g.key}>
              {g.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {total === 0 ? (
        <p className="text-sm text-muted-foreground">No AI usage in this period yet.</p>
      ) : (
        <ChartContainer config={config} className="h-56 w-full">
          <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
            <YAxis
              tickFormatter={(value: number) => formatter.format(value)}
              tickLine={false}
              axisLine={false}
              width={64}
            />
            <ChartTooltip content={<ChartTooltipContent />} />
            {features.map((feature) => (
              <Bar
                key={feature}
                dataKey={feature}
                stackId="credits"
                fill={`var(--color-${feature})`}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ChartContainer>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Feature</TableHead>
            <TableHead className="text-right">Credits</TableHead>
            <TableHead className="text-right">Share</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {totals.map((row) => (
            <TableRow key={row.feature}>
              <TableCell>{FEATURE_LABELS[row.feature]}</TableCell>
              <TableCell className="text-right">{formatter.format(row.credits)}</TableCell>
              <TableCell className="text-right">
                {total === 0 ? "—" : `${Math.round((row.credits / total) * 100)}%`}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
```

Check `src/components/ui/chart.tsx` for the exact exported names (`ChartTooltip` vs composing recharts' `Tooltip` directly) and `src/components/ui/table.tsx` for its export names before writing the imports — copy whatever `competitor-bars.tsx` and existing tables do. Check the `Tabs` value/onValueChange prop names against an existing usage (`engine-tabs.tsx`) — Base UI may name them differently (e.g. `value`/`onValueChange` vs `defaultValue`); mirror the working example.

`usage-settings.tsx` — the server component:

```tsx
import { requireSession } from "@/lib/workspace/session";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  bucketKeys,
  creditsByFeature,
  creditsByPeriod,
  monthToDateCredits,
  byokTokensByPeriod,
  byokTokensMonthToDate,
  type Granularity,
  type UsagePoint,
} from "@/lib/usage/queries";
import { getMonthlyCreditLimit } from "@/lib/usage/limit";
import { FEATURE_ORDER, type FeatureKey } from "@/lib/usage/features";
import { UsageHeadline } from "./usage-headline";
import { UsageChart, type UsageChartRow, type UsageDataset } from "./usage-chart";
import { ByokUsageChart } from "./byok-usage-chart"; // Task 10 — stub it as `export function ByokUsageChart() { return null; }` until then, or add this import in Task 10

/** Axis label for a bucket key: "Aug 28" (daily/weekly) or "Aug 2026" (monthly). */
function bucketLabel(granularity: Granularity, key: string): string {
  // Pinned locale + UTC, same reasoning as group-by-month.ts.
  if (granularity === "monthly") {
    const [year, month] = key.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  return new Date(`${key}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Zero-filled chart rows over the full bucket skeleton. */
function toRows(granularity: Granularity, points: UsagePoint[], now: Date): UsageChartRow[] {
  const rows = new Map<string, UsageChartRow>(
    bucketKeys(granularity, now).map((key) => [
      key,
      { bucket: key, label: bucketLabel(granularity, key) },
    ])
  );
  for (const point of points) {
    const row = rows.get(point.bucket);
    if (row) row[point.feature] = (row[point.feature] ?? 0) + point.credits;
  }
  return [...rows.values()];
}

export async function UsageSettings() {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const now = new Date();

  const [credits, limit, byokMtd, byokMonthly] = await Promise.all([
    monthToDateCredits(tenantId, now),
    getMonthlyCreditLimit(tenantId),
    byokTokensMonthToDate(tenantId, now),
    byokTokensByPeriod(tenantId, "monthly", now),
  ]);

  const granularities: Granularity[] = ["daily", "weekly", "monthly"];
  const datasets = Object.fromEntries(
    await Promise.all(
      granularities.map(async (granularity) => {
        const [points, totals] = await Promise.all([
          creditsByPeriod(tenantId, granularity, now),
          creditsByFeature(tenantId, granularity, now),
        ]);
        return [granularity, { rows: toRows(granularity, points, now), totals }];
      })
    )
  ) as Record<Granularity, UsageDataset>;

  // Ordered, and only features that appear in any window — no dead legend rows.
  const present = new Set<FeatureKey>(
    granularities.flatMap((g) => datasets[g].totals.map((t) => t.feature))
  );
  const features = FEATURE_ORDER.filter((feature) => present.has(feature));

  return (
    <div className="space-y-8">
      <Card>
        <CardHeader>
          <CardTitle>AI credits</CardTitle>
        </CardHeader>
        <CardContent>
          <UsageHeadline credits={credits} limit={limit} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Usage over time</CardTitle>
        </CardHeader>
        <CardContent>
          <UsageChart datasets={datasets} features={features} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your own API keys (AI visibility sweeps)</CardTitle>
        </CardHeader>
        <CardContent>
          <ByokUsageChart monthToDate={byokMtd} points={byokMonthly} />
        </CardContent>
      </Card>
    </div>
  );
}
```

Update `page.tsx`: replace the placeholder `<p>` with `<UsageSettings />` (import it). If Task 10 hasn't run yet, create `byok-usage-chart.tsx` as the one-line stub noted above so typecheck passes — Task 10 replaces it.

- [ ] **Step 4: Run tests and checks**

Run: `npx vitest run tests/components/usage-headline.test.tsx tests/components/usage-chart.test.tsx`
Expected: PASS

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/app/\(dashboard\)/settings tests/components/usage-headline.test.tsx tests/components/usage-chart.test.tsx
git commit -m "feat: AI usage tab — headline, stacked usage chart, feature breakdown"
```

---

### Task 10: BYOK section card

**Files:**
- Create (replace stub): `src/app/(dashboard)/settings/byok-usage-chart.tsx`

**Interfaces:**
- Consumes: `ByokPoint` (Task 7), `byokEngineLabel` already applied server-side; `bucketKeys`/labels come precomputed via props from `usage-settings.tsx` (already wired in Task 9).
- Produces: `ByokUsageChart({ monthToDate, points }: { monthToDate: number; points: ByokPoint[] })`.

- [ ] **Step 1: Implement**

```tsx
"use client";

import { Bar, BarChart, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import type { ByokPoint } from "@/lib/usage/queries";

const formatter = new Intl.NumberFormat("en-US");
const ENGINE_ORDER = ["GPT", "Gemini", "Claude"] as const;

/**
 * The BYOK channel's card body: tokens the AI-visibility sweeps spent on the
 * TENANT'S OWN keys, monthly over the last 12 months, stacked by engine.
 *
 * TOKENS, never "credits" — these calls bill the tenant's provider account
 * directly and are excluded from every credit number on this page. That
 * sentence is rendered, not just documented, because the distinction is the
 * whole reason this card is separate.
 */
export function ByokUsageChart({ monthToDate, points }: { monthToDate: number; points: ByokPoint[] }) {
  const engines = ENGINE_ORDER.filter((engine) => points.some((p) => p.engine === engine));
  // Anything byokEngineLabel passed through unmapped still gets a series.
  for (const point of points) {
    if (!engines.includes(point.engine as (typeof ENGINE_ORDER)[number]) && !engines.some((e) => e === point.engine)) {
      (engines as string[]).push(point.engine);
    }
  }

  const buckets = [...new Set(points.map((p) => p.bucket))].sort();
  const rows = buckets.map((bucket) => {
    const row: Record<string, number | string> = { bucket };
    for (const point of points.filter((p) => p.bucket === bucket)) {
      row[point.engine] = ((row[point.engine] as number) ?? 0) + point.tokens;
    }
    return row;
  });

  const config: ChartConfig = Object.fromEntries(
    engines.map((engine, i) => [engine, { label: engine, color: `var(--chart-${(i % 5) + 1})` }])
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Tracked for your cost visibility — these calls run on your own API keys and are
        not counted toward credits.
      </p>
      <p className="text-2xl font-semibold">
        {formatter.format(monthToDate)} <span className="text-sm font-normal text-muted-foreground">tokens this month</span>
      </p>
      {points.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No sweep usage tracked yet. Token tracking for AI-visibility sweeps starts with
          runs from this release onward.
        </p>
      ) : (
        <ChartContainer config={config} className="h-40 w-full">
          <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <XAxis dataKey="bucket" tickLine={false} axisLine={false} tickMargin={8} />
            <YAxis tickFormatter={(v: number) => formatter.format(v)} tickLine={false} axisLine={false} width={64} />
            <ChartTooltip content={<ChartTooltipContent />} />
            {engines.map((engine) => (
              <Bar key={engine} dataKey={engine} stackId="tokens" fill={`var(--color-${engine})`} isAnimationActive={false} />
            ))}
          </BarChart>
        </ChartContainer>
      )}
    </div>
  );
}
```

Note: `var(--color-${engine})` requires the config key to be the engine name; `ChartContainer` slugs config keys into CSS variables — check how `chart.tsx` derives variable names (read the file) and if keys must be lowercase/no-spaces, key the config and `dataKey` by a slug (`gpt`, `gemini`, `claude`) with `label` carrying the display name. Mirror whatever `competitor-bars.tsx` does.

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm run lint`
Expected: clean.

Run: `npx vitest run tests/components/`
Expected: PASS (no regressions).

- [ ] **Step 3: Commit**

```bash
git add src/app/\(dashboard\)/settings/byok-usage-chart.tsx
git commit -m "feat: BYOK sweep-token card on the usage tab"
```

---

### Task 11: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Full test suite, twice**

Run: `npm test`
Then run it again — the suite is known flaky on its shared Postgres. A file failing once and passing once is the known flake pattern (check whether the failing file is one this plan touched before dismissing it); a file failing twice is a real regression.
Expected: green on both runs, or only known-flaky untouched files differing.

- [ ] **Step 2: Typecheck, lint**

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 3: Verify the migration story end-to-end**

Run: `npm run db:migrate && npm run db:migrate:test`
Expected: both no-op cleanly (already applied). This is what the Vercel build (`vercel.ts` buildCommand) will run on deploy.

- [ ] **Step 4: Commit anything outstanding and report**

Report status per the repo owner's preference: what shipped, what is unverified (the rendered UI cannot be checked locally — the preview is behind an OAuth wall; typecheck, lint, and jsdom tests are the verification), and any judgement calls made mid-implementation.
