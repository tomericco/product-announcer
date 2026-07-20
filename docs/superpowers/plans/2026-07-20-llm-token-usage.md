# LLM Token Usage Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist one row of token usage per LLM call, with no UI and no aggregation.

**Architecture:** A new `llm_usage` table plus a `recordLlmUsage` helper that never throws, called from the five `generateObject` sites. Two of those sites need a tenant id threaded in.

**Tech Stack:** Drizzle + Postgres, AI SDK v7 (`generateObject` returns `usage`), Vitest.

## Global Constraints

- `recordLlmUsage` MUST never throw and MUST never change the LLM call's result. Accounting cannot be allowed to break a generation.
- It MUST tolerate a missing or partial `usage` object. No existing test supplies `usage` in its `generateObject` mock, so assuming it exists would break the suite.
- Token columns are nullable (the SDK types them `number | undefined`).
- `operation` is a plain `text` column — do NOT introduce a pgEnum (Postgres has no `DROP VALUE`).
- The migration must be applied to BOTH databases: `npm run db:migrate` and `npm run db:migrate:test`.

---

### Task 1: Table, migration, and the recorder

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/lib/ai/model.ts` (extract `modelId`)
- Create: `src/lib/ai/llm-usage.ts`
- Create (generated): `src/db/migrations/*`
- Test: `tests/lib/ai/llm-usage.test.ts`

**Interfaces:**
- Produces: `llmUsage` table; `LlmOperation` type; `recordLlmUsage(entry, database?)`; `modelId(spec)`.

- [ ] **Step 1: Add the table**

In `src/db/schema.ts`, after the `updates` table, add:

```ts
export const llmUsage = pgTable("llm_usage", {
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

(`pgTable`, `uuid`, `text`, `integer`, `timestamp` are already imported at the top of the file.)

- [ ] **Step 2: Extract `modelId` so the recorded name is consistent**

In `src/lib/ai/model.ts`, the prefix-stripping currently lives inside `resolveModel`. Extract and export it, and have `resolveModel` use it:

```ts
/** Strips a gateway-style "anthropic/" prefix: "anthropic/claude-sonnet-4-5" -> "claude-sonnet-4-5". */
export function modelId(spec: string): string {
  return spec.startsWith("anthropic/") ? spec.slice("anthropic/".length) : spec;
}

export function resolveModel(spec: string) {
  return anthropic(modelId(spec));
}
```

- [ ] **Step 3: Write the failing tests**

Create `tests/lib/ai/llm-usage.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, llmUsage } from "../../../src/db/schema";
import { recordLlmUsage } from "../../../src/lib/ai/llm-usage";

const NAME = "LLM Usage Test Tenant";

describe("recordLlmUsage", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, NAME));
    vi.restoreAllMocks();
  });

  async function seed() {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();
    return tenant;
  }

  it("writes a row with the operation, model and token counts", async () => {
    const tenant = await seed();

    await recordLlmUsage({
      tenantId: tenant.id,
      operation: "generation",
      model: "claude-sonnet-4-5",
      usage: { inputTokens: 120, outputTokens: 45, totalTokens: 165 },
    });

    const [row] = await db.select().from(llmUsage).where(eq(llmUsage.tenantId, tenant.id));
    expect(row).toMatchObject({
      operation: "generation",
      model: "claude-sonnet-4-5",
      inputTokens: 120,
      outputTokens: 45,
      totalTokens: 165,
    });
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("writes nulls when usage is missing or partial", async () => {
    const tenant = await seed();

    await recordLlmUsage({ tenantId: tenant.id, operation: "enrichment", model: "claude-haiku-4-5" });
    await recordLlmUsage({
      tenantId: tenant.id,
      operation: "review",
      model: "claude-sonnet-4-5",
      usage: { inputTokens: 10 },
    });

    const rows = await db.select().from(llmUsage).where(eq(llmUsage.tenantId, tenant.id));
    const missing = rows.find((r) => r.operation === "enrichment")!;
    const partial = rows.find((r) => r.operation === "review")!;

    expect(missing.inputTokens).toBeNull();
    expect(missing.outputTokens).toBeNull();
    expect(missing.totalTokens).toBeNull();
    expect(partial.inputTokens).toBe(10);
    expect(partial.outputTokens).toBeNull();
  });

  it("never throws when the insert fails", async () => {
    // A tenant id that violates the foreign key -- the insert must fail, and the
    // failure must be swallowed so accounting can't break a generation.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      recordLlmUsage({
        tenantId: "00000000-0000-0000-0000-000000000000",
        operation: "generation",
        model: "claude-sonnet-4-5",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      })
    ).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/ai/llm-usage.test.ts`
Expected: FAIL — `src/lib/ai/llm-usage.ts` doesn't exist yet.

- [ ] **Step 5: Implement the recorder**

Create `src/lib/ai/llm-usage.ts`:

```ts
import { db as defaultDb } from "@/db";
import { llmUsage } from "@/db/schema";

export type LlmOperation =
  | "generation"
  | "enrichment"
  | "review"
  | "revision"
  | "brand_analysis";

/** The subset of the SDK's usage object we persist. Every field is optional. */
export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

/**
 * Records one LLM call's token usage.
 *
 * Deliberately swallows its own errors: this is accounting, and it must never
 * be able to fail a generation that already succeeded. A missing or partial
 * `usage` is normal (the SDK types the counts as `number | undefined`) and is
 * stored as nulls.
 */
export async function recordLlmUsage(
  entry: {
    tenantId: string;
    operation: LlmOperation;
    model: string;
    usage?: TokenUsage;
  },
  database: typeof defaultDb = defaultDb
): Promise<void> {
  try {
    await database.insert(llmUsage).values({
      tenantId: entry.tenantId,
      operation: entry.operation,
      model: entry.model,
      inputTokens: entry.usage?.inputTokens ?? null,
      outputTokens: entry.usage?.outputTokens ?? null,
      totalTokens: entry.usage?.totalTokens ?? null,
    });
  } catch (error) {
    console.error(`Failed to record ${entry.operation} token usage:`, error);
  }
}
```

- [ ] **Step 6: Generate and apply the migration**

Run: `npm run db:generate`
Expected: a migration creating `llm_usage`. Read the generated `.sql` and confirm it only CREATEs the new table (it must not touch existing tables).

Run: `npm run db:migrate && npm run db:migrate:test`
Expected: both databases apply cleanly.

- [ ] **Step 7: Run the tests + typecheck**

Run: `npx vitest run tests/lib/ai/llm-usage.test.ts && npm run typecheck && npm test`
Expected: new tests pass; typecheck clean; the whole suite still passes.

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts src/db/migrations src/lib/ai/model.ts src/lib/ai/llm-usage.ts tests/lib/ai/llm-usage.test.ts
git commit -m "feat: persist per-call LLM token usage"
```

---

### Task 2: Record usage at the five call sites

**Files:**
- Modify: `src/lib/ai/generation.ts`, `src/lib/ai/review-draft.ts`, `src/lib/ai/enrich-change-item.ts`, `src/lib/workspace/analyze-brand-style.ts`
- Modify: `src/lib/change-items/ingest-pull-request.ts`, `src/lib/change-items/ingest-push.ts`, `src/lib/change-items/import-commits.ts` (pass the new `tenantId`)
- Modify: `src/lib/workspace/brand-import.ts` (pass `tenantId`, widen the `analyze` dep type)
- Test: `tests/lib/scheduling/run-schedule.test.ts` (integration assertion)

**Interfaces:**
- Consumes: `recordLlmUsage`, `LlmOperation`, `modelId` from Task 1.
- Produces: `EnrichmentInput` gains `tenantId: string`; `analyzeBrandStyle(pageText, tenantId)`.

- [ ] **Step 1: Generation**

In `src/lib/ai/generation.ts`, capture the spec once and record after the call. `brandProfile.tenantId` is already in scope:

```ts
import { resolveModel, modelId } from "./model";
import { recordLlmUsage } from "./llm-usage";
```

```ts
  const spec = process.env.GENERATION_MODEL ?? "anthropic/claude-sonnet-4-5";
  const result = await generateObject({
    model: resolveModel(spec),
    schema: UpdateDraftSchema,
    system,
    prompt,
  });

  await recordLlmUsage({
    tenantId: brandProfile.tenantId,
    operation: "generation",
    model: modelId(spec),
    usage: result.usage,
  });

  return result.object;
```

- [ ] **Step 2: Review and revision**

In `src/lib/ai/review-draft.ts`, `reviewModel()` currently returns a resolved model. Change it to return the spec string, and resolve at the call sites so both the model and its id are available:

```ts
function reviewModelSpec(): string {
  return process.env.REVIEW_MODEL ?? "anthropic/claude-sonnet-4-5";
}
```

In `reviewDraft`:

```ts
  const spec = reviewModelSpec();
  const result = await generateObject({
    model: resolveModel(spec),
    schema: ReviewCritiqueSchema,
    system: REVIEW_SYSTEM,
    prompt: buildReviewPrompt(draft, brandProfile),
  });
  await recordLlmUsage({
    tenantId: brandProfile.tenantId,
    operation: "review",
    model: modelId(spec),
    usage: result.usage,
  });
  return result.object;
```

In `reviseDraft`, the same shape with `operation: "revision"` and the `RevisionSchema`/`REVISION_SYSTEM` call it already makes. Import `resolveModel, modelId` and `recordLlmUsage`.

- [ ] **Step 3: Enrichment**

In `src/lib/ai/enrich-change-item.ts`:

1. Add `tenantId: string;` to `EnrichmentInput`.
2. Record after the call, mirroring Step 1, with `operation: "enrichment"`, `tenantId: input.tenantId`, and the spec `process.env.ENRICHMENT_MODEL ?? "anthropic/claude-haiku-4-5"`.

Note the function has a `try/catch` that fail-opens on error — put the recording INSIDE the `try`, after the `generateObject` call, so a failed generation records nothing.

Then pass `tenantId` at the three construction sites:
- `src/lib/change-items/import-commits.ts` (~line 62) — `tenantId: input.tenantId`
- `src/lib/change-items/ingest-push.ts` (~line 113)
- `src/lib/change-items/ingest-pull-request.ts` (~line 35)

Read each to find the tenant id already in scope (they all create tenant-scoped change items, so one is available — if any genuinely lacks one, STOP and report rather than inventing a value).

- [ ] **Step 4: Brand analysis**

In `src/lib/workspace/analyze-brand-style.ts`, change the signature to
`analyzeBrandStyle(pageText: string, tenantId: string)` and record with
`operation: "brand_analysis"` and the spec
`process.env.ONBOARDING_ANALYSIS_MODEL ?? "anthropic/claude-sonnet-4-5"`, inside the
existing `try` after the `generateObject` call.

In `src/lib/workspace/brand-import.ts`:
- widen the dep type to `analyze?: (text: string, tenantId: string) => Promise<DerivedBrandProfile>;`
- call `analyze(scraped.text, tenantId)`.

(Existing injected fakes that declare only `(text)` remain assignable — a function with fewer parameters satisfies one expecting more.)

- [ ] **Step 5: Integration test**

In `tests/lib/scheduling/run-schedule.test.ts`, add a test asserting a generation row is written. `generateObject` is mocked there, so supply a `usage` in the mock:

```ts
  it("records token usage for the generation call", async () => {
    const { tenant, repoA } = await seed();
    await db.insert(changeItems).values({
      tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "a",
    });
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "T", body: "B" },
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    } as never);

    const pending = await getPendingChangeItems(tenant.id);
    await runBatchForWorkspace(tenant.id, pending);

    const rows = await db.select().from(llmUsage).where(eq(llmUsage.tenantId, tenant.id));
    const generation = rows.find((r) => r.operation === "generation");
    expect(generation).toBeTruthy();
    expect(generation!.inputTokens).toBe(100);
    expect(generation!.outputTokens).toBe(20);
  });
```

Add `llmUsage` to the schema import at the top of that file. Note `reviewAndReconcile` is module-mocked there, so only the generation row is expected — do not assert review rows in this file.

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass, including the pre-existing ones whose `generateObject` mocks supply no `usage` (they must now write rows with null token counts rather than failing).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: record token usage for generation, review, enrichment and brand analysis"
```

---

## Self-Review Notes

- **Spec coverage:** table (Task 1 Step 1), recorder with never-throw + partial-usage handling (Task 1 Steps 3/5), `modelId` extraction (Task 1 Step 2), all five call sites (Task 2 Steps 1-4), both signature changes (Task 2 Steps 3-4), unit + integration tests (Task 1 Step 3, Task 2 Step 5), migration to both DBs (Task 1 Step 6). All spec sections mapped.
- **Type consistency:** `LlmOperation` values used in the call sites match the union defined in Task 1 exactly (`generation`, `enrichment`, `review`, `revision`, `brand_analysis`). `modelId(spec)` is the single source of prefix-stripping, used by both `resolveModel` and every recording site.
- **Ordering:** Task 1 delivers the table and helper before Task 2 consumes them; each task's build is green on its own.
- **Risk:** the pre-existing mocks supply no `usage`, so Task 2 exercises the null path across the whole suite — that is the main thing Step 6 is verifying, not just "tests still pass".
