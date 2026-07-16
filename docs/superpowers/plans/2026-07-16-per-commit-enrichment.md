# Per-Commit Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At import time (webhook + manual), run a cheap LLM pass per change item to classify whether it is user-facing and how it affects the user, store the result, and filter non-facing items out of generation batches while keeping them visible in Pending.

**Architecture:** A new `enrich-change-item` module (pure prompt builder + Zod schema + fail-open `generateObject` wrapper) is injected into the three ingestion entry points and run with a concurrency-capped mapper. Enrichment is persisted on the `change_items` row at insert time. Generation reads a new `getBatchableChangeItems` query that drops non-facing rows; the Pending page keeps showing everything, dimming non-facing items and offering a force-include action.

**Tech Stack:** Next.js (App Router), Drizzle ORM + Postgres, `ai` v7 (`generateObject`), Zod, Vitest.

## Global Constraints

- **This is NOT stock Next.js** — per `AGENTS.md`, read `node_modules/next/dist/docs/` before writing framework code; this plan touches no new Next.js APIs, only a server action and a server component, both matching existing patterns.
- **Model default:** `process.env.ENRICHMENT_MODEL ?? "anthropic/claude-haiku-4-5"`.
- **Fail-open:** any enrichment error resolves to `{ userFacing: true, impactSummary: null, suggestedCategory: null, confidence: null }` — never drop a real change.
- **Concurrency cap:** `5`.
- **Enrichment columns are nullable** — `null` means "not enriched" and is treated as user-facing everywhere.
- **Enrichment is injected as a function parameter** into ingestion functions (default = real `enrichChangeItem`) so DB integration tests stay hermetic — mirrors the existing `getCommitDiff` injection.
- **Category enum** reuse: `"new" | "improved" | "fixed"` (existing `update_category` pgEnum).
- Test commands run with `npm test` (`vitest run`). Migrations: `npm run db:generate` then `npm run db:migrate`.

---

### Task 1: Enrichment columns on `change_items` + migration

**Files:**
- Modify: `src/db/schema.ts:1` (import `real`) and `src/db/schema.ts:62-95` (`changeItems` table)
- Create: `src/db/migrations/0010_*.sql` (generated)
- Test: `tests/lib/change-item-enrichment-columns.test.ts`

**Interfaces:**
- Produces: five new columns on `changeItems` — `userFacing: boolean | null`, `impactSummary: string | null`, `suggestedCategory: "new"|"improved"|"fixed" | null`, `enrichmentConfidence: number | null`, `enrichedAt: Date | null`. All later tasks read/write these.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/change-item-enrichment-columns.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, repos, changeItems } from "../../src/db/schema";

const NAME = "Enrichment Columns Test Tenant";

describe("change_items enrichment columns", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, NAME));
  });

  it("persists and reads back enrichment fields, defaulting them to null", async () => {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();
    const [repo] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/e", githubInstallationId: "1", watchedBranch: "main" })
      .returning();

    const [defaulted] = await db
      .insert(changeItems)
      .values({ tenantId: tenant.id, repoId: repo.id, sourceType: "pr", prNumber: 1, prTitle: "a" })
      .returning();
    expect(defaulted.userFacing).toBeNull();
    expect(defaulted.impactSummary).toBeNull();
    expect(defaulted.suggestedCategory).toBeNull();
    expect(defaulted.enrichmentConfidence).toBeNull();
    expect(defaulted.enrichedAt).toBeNull();

    const [enriched] = await db
      .insert(changeItems)
      .values({
        tenantId: tenant.id,
        repoId: repo.id,
        sourceType: "pr",
        prNumber: 2,
        prTitle: "b",
        userFacing: true,
        impactSummary: "Faster search",
        suggestedCategory: "improved",
        enrichmentConfidence: 0.9,
        enrichedAt: new Date(),
      })
      .returning();
    expect(enriched.userFacing).toBe(true);
    expect(enriched.impactSummary).toBe("Faster search");
    expect(enriched.suggestedCategory).toBe("improved");
    expect(enriched.enrichmentConfidence).toBeCloseTo(0.9);
    expect(enriched.enrichedAt).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- change-item-enrichment-columns`
Expected: FAIL — DB error `column "user_facing" of relation "change_items" does not exist` (columns not yet added).

- [ ] **Step 3: Add columns to the schema**

In `src/db/schema.ts`, add `real` to the import on line 1:

```ts
import { pgTable, pgEnum, uuid, text, timestamp, primaryKey, integer, jsonb, uniqueIndex, boolean, real } from "drizzle-orm/pg-core";
```

Inside the `changeItems` table definition, immediately after the `createdAt` column (`src/db/schema.ts:89`) and before the closing `}`, add:

```ts
    // enrichment (sub-project A): classifier output, null until enriched
    userFacing: boolean("user_facing"),
    impactSummary: text("impact_summary"),
    suggestedCategory: updateCategoryEnum("suggested_category"),
    enrichmentConfidence: real("enrichment_confidence"),
    enrichedAt: timestamp("enriched_at", { withTimezone: true }),
```

Note: `updateCategoryEnum` is declared at `src/db/schema.ts:99`, after `changeItems`. Move the three category/status enum declarations (`cadenceEnum`, `updateStatusEnum`, `updateCategoryEnum` — lines 97-99) to above the `changeItems` table (i.e. before line 62) so `updateCategoryEnum` is defined before use. Only reorder these declarations; do not change them.

- [ ] **Step 4: Generate and apply the migration**

Run: `npm run db:generate`
Expected: creates `src/db/migrations/0010_*.sql` adding the five columns.

Run: `npm run db:migrate`
Expected: migration applies cleanly to the dev database.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- change-item-enrichment-columns`
Expected: PASS.

- [ ] **Step 6: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: all existing tests still PASS (the reordered enums and new nullable columns are backward-compatible).

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/db/migrations tests/lib/change-item-enrichment-columns.test.ts
git commit -m "feat: add enrichment columns to change_items"
```

---

### Task 2: `mapWithConcurrency` helper

**Files:**
- Create: `src/lib/concurrency.ts`
- Test: `tests/lib/concurrency.test.ts`

**Interfaces:**
- Produces: `mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>` — results in input order; at most `limit` invocations of `fn` in flight at once.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/concurrency.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "../../src/lib/concurrency";

describe("mapWithConcurrency", () => {
  it("preserves input order in the results", async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const delay = () => new Promise((r) => setTimeout(r, 5));
    await mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 3, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay();
      inFlight--;
      return i;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("passes the index to fn and handles an empty list", async () => {
    const idx = await mapWithConcurrency(["a", "b"], 5, async (_item, i) => i);
    expect(idx).toEqual([0, 1]);
    expect(await mapWithConcurrency([], 5, async (x) => x)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- concurrency`
Expected: FAIL — `Cannot find module '../../src/lib/concurrency'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/concurrency.ts`:

```ts
/**
 * Maps `fn` over `items` with at most `limit` calls in flight at once.
 * Results are returned in input order regardless of completion order.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workerCount = Math.min(Math.max(limit, 1), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });

  await Promise.all(workers);
  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- concurrency`
Expected: PASS (all three tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/concurrency.ts tests/lib/concurrency.test.ts
git commit -m "feat: add mapWithConcurrency helper"
```

---

### Task 3: Enrichment module

**Files:**
- Create: `src/lib/enrich-change-item.ts`
- Test: `tests/lib/enrich-change-item.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type EnrichmentResult = { userFacing: boolean; impactSummary: string | null; suggestedCategory: "new"|"improved"|"fixed" | null; confidence: number | null }`
  - `type EnrichmentInput = { sourceType: "pr"|"commit"; repoName: string; commitMessage?: string | null; diff?: string | null; prTitle?: string | null; prDescription?: string | null }`
  - `type EnrichChangeItem = (input: EnrichmentInput) => Promise<EnrichmentResult>`
  - `buildEnrichmentPrompt(input: EnrichmentInput): string`
  - `enrichChangeItem: EnrichChangeItem` (fail-open)

- [ ] **Step 1: Write the failing test**

Create `tests/lib/enrich-change-item.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));

import { generateObject } from "ai";
import { buildEnrichmentPrompt, enrichChangeItem } from "../../src/lib/enrich-change-item";

describe("buildEnrichmentPrompt", () => {
  it("includes commit message and diff for commit-sourced items", () => {
    const prompt = buildEnrichmentPrompt({
      sourceType: "commit",
      repoName: "acme/api",
      commitMessage: "fix export timeout",
      diff: "diff --git a/x b/x\n+fix",
    });
    expect(prompt).toContain("acme/api");
    expect(prompt).toContain("fix export timeout");
    expect(prompt).toContain("diff --git a/x b/x");
  });

  it("includes PR title and description for pr-sourced items", () => {
    const prompt = buildEnrichmentPrompt({
      sourceType: "pr",
      repoName: "acme/web",
      prTitle: "Add dark mode",
      prDescription: "Adds a toggle.",
    });
    expect(prompt).toContain("acme/web");
    expect(prompt).toContain("Add dark mode");
    expect(prompt).toContain("Adds a toggle.");
  });
});

describe("enrichChangeItem", () => {
  beforeEach(() => vi.mocked(generateObject).mockReset());

  it("maps a user-facing model result through", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { userFacing: true, impactSummary: "Exports finish faster", suggestedCategory: "improved", confidence: 0.8 },
    } as never);

    const result = await enrichChangeItem({ sourceType: "commit", repoName: "acme/api", commitMessage: "x", diff: "y" });
    expect(result).toEqual({
      userFacing: true,
      impactSummary: "Exports finish faster",
      suggestedCategory: "improved",
      confidence: 0.8,
    });
  });

  it("nulls impact and category when the model says not user-facing", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { userFacing: false, impactSummary: "internal refactor", suggestedCategory: "improved", confidence: 0.95 },
    } as never);

    const result = await enrichChangeItem({ sourceType: "commit", repoName: "acme/api", commitMessage: "refactor", diff: "z" });
    expect(result).toEqual({ userFacing: false, impactSummary: null, suggestedCategory: null, confidence: 0.95 });
  });

  it("fails open to user-facing when the model throws", async () => {
    vi.mocked(generateObject).mockRejectedValue(new Error("model down"));

    const result = await enrichChangeItem({ sourceType: "pr", repoName: "acme/web", prTitle: "t", prDescription: "d" });
    expect(result).toEqual({ userFacing: true, impactSummary: null, suggestedCategory: null, confidence: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- enrich-change-item`
Expected: FAIL — `Cannot find module '../../src/lib/enrich-change-item'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/enrich-change-item.ts`:

```ts
import { generateObject } from "ai";
import { z } from "zod";

export type EnrichmentResult = {
  userFacing: boolean;
  impactSummary: string | null;
  suggestedCategory: "new" | "improved" | "fixed" | null;
  confidence: number | null;
};

export type EnrichmentInput = {
  sourceType: "pr" | "commit";
  repoName: string;
  commitMessage?: string | null;
  diff?: string | null;
  prTitle?: string | null;
  prDescription?: string | null;
};

export type EnrichChangeItem = (input: EnrichmentInput) => Promise<EnrichmentResult>;

export const EnrichmentSchema = z.object({
  userFacing: z.boolean(),
  impactSummary: z.string().nullable(),
  suggestedCategory: z.enum(["new", "improved", "fixed"]).nullable(),
  confidence: z.number().min(0).max(1),
});

const ENRICHMENT_SYSTEM = [
  "You classify a single code change for a user-facing product-update changelog.",
  "Decide whether the change is user-facing (affects what an end user sees, can do, or experiences).",
  "Refactors, tests, chores, CI, and internal-only changes are NOT user-facing.",
  "If user-facing: write impactSummary as one plain sentence describing the end-user benefit,",
  "and pick suggestedCategory: 'new' (new capability), 'improved' (better existing behavior), or 'fixed' (bug fix).",
  "If not user-facing: set impactSummary and suggestedCategory to null.",
  "Always set confidence between 0 and 1.",
].join(" ");

export function buildEnrichmentPrompt(input: EnrichmentInput): string {
  const source =
    input.sourceType === "pr"
      ? `Pull request in ${input.repoName}:\nTitle: ${input.prTitle ?? ""}\nDescription: ${input.prDescription ?? ""}`
      : `Commit in ${input.repoName}:\nMessage: ${input.commitMessage ?? ""}\nDiff:\n${input.diff ?? "(no diff available)"}`;

  return `Classify the following code change.\n\n${source}`;
}

export const enrichChangeItem: EnrichChangeItem = async (input) => {
  try {
    const { object } = await generateObject({
      model: process.env.ENRICHMENT_MODEL ?? "anthropic/claude-haiku-4-5",
      schema: EnrichmentSchema,
      system: ENRICHMENT_SYSTEM,
      prompt: buildEnrichmentPrompt(input),
    });

    return {
      userFacing: object.userFacing,
      impactSummary: object.userFacing ? object.impactSummary?.trim() || null : null,
      suggestedCategory: object.userFacing ? object.suggestedCategory : null,
      confidence: object.confidence,
    };
  } catch {
    // Fail open: never drop a genuinely user-facing change on a classifier error.
    return { userFacing: true, impactSummary: null, suggestedCategory: null, confidence: null };
  }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- enrich-change-item`
Expected: PASS (all five tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/enrich-change-item.ts tests/lib/enrich-change-item.test.ts
git commit -m "feat: add change-item enrichment module"
```

---

### Task 4: Wire enrichment into manual import

**Files:**
- Modify: `src/lib/import-commits.ts` (whole file)
- Test: `tests/lib/import-commits.test.ts` (add injected fake enricher + assertions)

**Interfaces:**
- Consumes: `mapWithConcurrency` (Task 2); `EnrichChangeItem`, `enrichChangeItem` (Task 3); enrichment columns (Task 1).
- Produces: `importSelectedCommits(input, getCommitDiff, enrich?, database?)` — `enrich` defaults to real `enrichChangeItem`; every inserted row carries enrichment columns.

- [ ] **Step 1: Update the test to inject a fake enricher and assert persistence**

In `tests/lib/import-commits.test.ts`, add the import at the top:

```ts
import type { EnrichChangeItem } from "../../src/lib/enrich-change-item";
```

Add this fake near the top of the `describe` block (after `const NAME`):

```ts
  const fakeEnrich: EnrichChangeItem = async (input) => ({
    userFacing: input.commitMessage !== "chore: lint",
    impactSummary: input.commitMessage !== "chore: lint" ? "does a user thing" : null,
    suggestedCategory: input.commitMessage !== "chore: lint" ? "improved" : null,
    confidence: 0.7,
  });
```

Change the first test's call to pass the fake as the third argument, and add enrichment assertions. Replace the `importSelectedCommits(..., getCommitDiff)` call in the "imports selected commits…" test with:

```ts
    const result = await importSelectedCommits(
      {
        tenantId: tenant.id,
        selections: [
          { repoId: repo.id, sha: "aaa111", message: "fix timeout", url: "https://x/aaa111", committedAt: "2026-07-01T00:00:00Z" },
          { repoId: repo.id, sha: "bbb222", message: "chore: lint", url: "https://x/bbb222", committedAt: "2026-07-02T00:00:00Z" },
        ],
      },
      getCommitDiff,
      fakeEnrich
    );
```

Then add, after the existing assertions in that test:

```ts
    const facing = items.find((i) => i.commitSha === "aaa111")!;
    const nonFacing = items.find((i) => i.commitSha === "bbb222")!;
    expect(facing.userFacing).toBe(true);
    expect(facing.impactSummary).toBe("does a user thing");
    expect(facing.suggestedCategory).toBe("improved");
    expect(facing.enrichmentConfidence).toBeCloseTo(0.7);
    expect(facing.enrichedAt).toBeInstanceOf(Date);
    expect(nonFacing.userFacing).toBe(false);
    expect(nonFacing.impactSummary).toBeNull();
    expect(nonFacing.suggestedCategory).toBeNull();
```

In the other two tests (`is idempotent…`, `skips repos…`), pass `fakeEnrich` as the third argument to `importSelectedCommits` as well (keeps them hermetic; they don't assert enrichment).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- import-commits`
Expected: FAIL — `importSelectedCommits` still ignores the third arg and does not set enrichment columns, so `facing.userFacing` is `null`/undefined, not `true`.

- [ ] **Step 3: Rewrite `importSelectedCommits`**

Replace the entire body of `src/lib/import-commits.ts` with:

```ts
import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { repos, changeItems } from "../db/schema";
import { truncateDiff } from "./github";
import { mapWithConcurrency } from "./concurrency";
import { enrichChangeItem, type EnrichChangeItem } from "./enrich-change-item";

export type CommitSelection = {
  repoId: string;
  sha: string;
  message: string;
  url: string;
  committedAt: string | null;
};

export type GetCommitDiff = (
  installationId: string,
  repoFullName: string,
  sha: string
) => Promise<string>;

const ENRICH_CONCURRENCY = 5;

/**
 * Imports user-selected commits as pending commit-sourced change items.
 *
 * Unlike push ingestion, this ignores the repo's configured `sourceTypes` — the
 * user is explicitly choosing these commits. Each repo is loaded tenant-scoped
 * (IDOR guard), the diff is fetched and the commit enriched per item (capped
 * concurrency), and inserts use onConflictDoNothing so re-importing an
 * already-imported commit is a no-op. Returns how many commits were newly inserted.
 */
export async function importSelectedCommits(
  input: { tenantId: string; selections: CommitSelection[] },
  getCommitDiff: GetCommitDiff,
  enrich: EnrichChangeItem = enrichChangeItem,
  database: typeof defaultDb = defaultDb
): Promise<{ importedCount: number }> {
  if (input.selections.length === 0) return { importedCount: 0 };

  const byRepo = new Map<string, CommitSelection[]>();
  for (const selection of input.selections) {
    const list = byRepo.get(selection.repoId) ?? [];
    list.push(selection);
    byRepo.set(selection.repoId, list);
  }

  let importedCount = 0;

  for (const [repoId, selections] of byRepo) {
    const [repo] = await database
      .select()
      .from(repos)
      .where(and(eq(repos.id, repoId), eq(repos.tenantId, input.tenantId)))
      .limit(1);
    if (!repo) continue;

    const insertedCounts = await mapWithConcurrency(selections, ENRICH_CONCURRENCY, async (selection) => {
      const diff = truncateDiff(await getCommitDiff(repo.githubInstallationId, repo.githubRepoFullName, selection.sha));
      const enrichment = await enrich({
        sourceType: "commit",
        repoName: repo.githubRepoFullName,
        commitMessage: selection.message,
        diff,
      });

      const inserted = await database
        .insert(changeItems)
        .values({
          tenantId: input.tenantId,
          repoId: repo.id,
          sourceType: "commit",
          commitSha: selection.sha,
          commitMessage: selection.message,
          commitUrl: selection.url,
          committedAt: selection.committedAt ? new Date(selection.committedAt) : null,
          diff,
          userFacing: enrichment.userFacing,
          impactSummary: enrichment.impactSummary,
          suggestedCategory: enrichment.suggestedCategory,
          enrichmentConfidence: enrichment.confidence,
          enrichedAt: new Date(),
        })
        .onConflictDoNothing()
        .returning({ id: changeItems.id });

      return inserted.length;
    });

    importedCount += insertedCounts.reduce((a, b) => a + b, 0);
  }

  return { importedCount };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- import-commits`
Expected: PASS.

- [ ] **Step 5: Verify the caller still type-checks**

The caller `src/app/(dashboard)/pending/actions.ts:121` calls `importSelectedCommits({...}, getCommitDiff)` — the new `enrich` and `database` params default, so no change is needed there.

Run: `npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/import-commits.ts tests/lib/import-commits.test.ts
git commit -m "feat: enrich commits during manual import"
```

---

### Task 5: Wire enrichment into webhook ingestion (push + PR)

**Files:**
- Modify: `src/lib/ingest-push.ts` (whole file)
- Modify: `src/lib/ingest-pull-request.ts` (whole file)
- Test: `tests/lib/ingest-push.test.ts` (inject fake enricher), `tests/lib/ingest-pull-request.test.ts` (new)
- Verify: `src/app/api/webhooks/github/route.ts` still type-checks (no change expected)

**Interfaces:**
- Consumes: `mapWithConcurrency` (Task 2); `EnrichChangeItem`, `enrichChangeItem` (Task 3); enrichment columns (Task 1).
- Produces: `ingestPush(input, getCommitDiff, enrich?, database?)` and `ingestMergedPullRequest(input, enrich?, database?)` — `enrich` defaults to real `enrichChangeItem`; inserted rows carry enrichment columns.

- [ ] **Step 1: Update `ingest-push.test.ts` to inject a fake enricher**

At the top of `tests/lib/ingest-push.test.ts` add:

```ts
import type { EnrichChangeItem } from "../../src/lib/enrich-change-item";

const fakeEnrich: EnrichChangeItem = async (input) => ({
  userFacing: input.commitMessage !== "tweak logging",
  impactSummary: input.commitMessage !== "tweak logging" ? "user benefit" : null,
  suggestedCategory: input.commitMessage !== "tweak logging" ? "fixed" : null,
  confidence: 0.6,
});
```

In every `ingestPush(...)` call in this file, pass `fakeEnrich` as the third argument (before any `database` arg — none of these tests pass a database). For the first test (`creates one commit-sourced ChangeItem per commit…`), add after the existing assertions:

```ts
    const fix = items.find((i) => i.commitSha === "abc123")!;
    const log = items.find((i) => i.commitSha === "def456")!;
    expect(fix.userFacing).toBe(true);
    expect(fix.impactSummary).toBe("user benefit");
    expect(fix.suggestedCategory).toBe("fixed");
    expect(fix.enrichmentConfidence).toBeCloseTo(0.6);
    expect(log.userFacing).toBe(false);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ingest-push`
Expected: FAIL — `ingestPush` ignores the third arg; `fix.userFacing` is `null`, not `true`.

- [ ] **Step 3: Rewrite `ingestPush`**

Replace the entire body of `src/lib/ingest-push.ts` with:

```ts
import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { repos, changeItems } from "../db/schema";
import { truncateDiff } from "./github";
import { mapWithConcurrency } from "./concurrency";
import { enrichChangeItem, type EnrichChangeItem } from "./enrich-change-item";

export type PushInput = {
  installationId: string;
  repoFullName: string;
  ref: string;
  commits: Array<{ id: string; message: string; url: string; timestamp: string }>;
};

export type GetCommitDiff = (owner: string, repo: string, sha: string) => Promise<string>;

const ENRICH_CONCURRENCY = 5;

export async function ingestPush(
  input: PushInput,
  getCommitDiff: GetCommitDiff,
  enrich: EnrichChangeItem = enrichChangeItem,
  database: typeof defaultDb = defaultDb
): Promise<void> {
  const [repo] = await database
    .select()
    .from(repos)
    .where(
      and(eq(repos.githubInstallationId, input.installationId), eq(repos.githubRepoFullName, input.repoFullName))
    )
    .limit(1);

  if (!repo || !repo.sourceTypes.includes("commit")) return;
  if (input.ref !== `refs/heads/${repo.watchedBranch}`) return;

  const [owner, repoName] = input.repoFullName.split("/");

  await mapWithConcurrency(input.commits, ENRICH_CONCURRENCY, async (commit) => {
    const diff = truncateDiff(await getCommitDiff(owner, repoName, commit.id));
    const enrichment = await enrich({
      sourceType: "commit",
      repoName: input.repoFullName,
      commitMessage: commit.message,
      diff,
    });

    await database
      .insert(changeItems)
      .values({
        tenantId: repo.tenantId,
        repoId: repo.id,
        sourceType: "commit",
        commitSha: commit.id,
        commitMessage: commit.message,
        commitUrl: commit.url,
        committedAt: new Date(commit.timestamp),
        diff,
        userFacing: enrichment.userFacing,
        impactSummary: enrichment.impactSummary,
        suggestedCategory: enrichment.suggestedCategory,
        enrichmentConfidence: enrichment.confidence,
        enrichedAt: new Date(),
      })
      .onConflictDoNothing();
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- ingest-push`
Expected: PASS.

- [ ] **Step 5: Write the failing test for PR ingestion**

Create `tests/lib/ingest-pull-request.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, repos, changeItems } from "../../src/db/schema";
import { ingestMergedPullRequest } from "../../src/lib/ingest-pull-request";
import type { EnrichChangeItem } from "../../src/lib/enrich-change-item";

const NAME = "PR Ingest Test Tenant";

const fakeEnrich: EnrichChangeItem = async (input) => ({
  userFacing: true,
  impactSummary: `impact for ${input.prTitle}`,
  suggestedCategory: "new",
  confidence: 0.85,
});

describe("ingestMergedPullRequest", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, NAME));
  });

  it("creates a pr-sourced change item carrying enrichment", async () => {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();
    const [repo] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/web", githubInstallationId: "80001", watchedBranch: "main", sourceTypes: ["pr"] })
      .returning();

    await ingestMergedPullRequest(
      {
        installationId: "80001",
        repoFullName: "acme/web",
        baseBranch: "main",
        prNumber: 7,
        prTitle: "Add dark mode",
        prDescription: "Adds a toggle.",
        prUrl: "https://github.com/acme/web/pull/7",
        mergedAt: new Date("2026-07-01T00:00:00Z"),
      },
      fakeEnrich
    );

    const [item] = await db.select().from(changeItems).where(eq(changeItems.repoId, repo.id));
    expect(item).toMatchObject({ sourceType: "pr", status: "pending", prNumber: 7 });
    expect(item.userFacing).toBe(true);
    expect(item.impactSummary).toBe("impact for Add dark mode");
    expect(item.suggestedCategory).toBe("new");
    expect(item.enrichmentConfidence).toBeCloseTo(0.85);
    expect(item.enrichedAt).toBeInstanceOf(Date);
  });

  it("does nothing for a repo whose sourceTypes doesn't include 'pr'", async () => {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();
    const [repo] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/commit-only", githubInstallationId: "80001", watchedBranch: "main", sourceTypes: ["commit"] })
      .returning();

    await ingestMergedPullRequest(
      {
        installationId: "80001",
        repoFullName: "acme/commit-only",
        baseBranch: "main",
        prNumber: 1,
        prTitle: "x",
        prDescription: "y",
        prUrl: "https://x",
        mergedAt: new Date("2026-07-01T00:00:00Z"),
      },
      fakeEnrich
    );

    const items = await db.select().from(changeItems).where(eq(changeItems.repoId, repo.id));
    expect(items).toHaveLength(0);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- ingest-pull-request`
Expected: FAIL — `ingestMergedPullRequest` does not accept an `enrich` param / does not set enrichment columns, so `item.userFacing` is `null`.

- [ ] **Step 7: Rewrite `ingestMergedPullRequest`**

Replace the entire body of `src/lib/ingest-pull-request.ts` with:

```ts
import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { repos, changeItems } from "../db/schema";
import { enrichChangeItem, type EnrichChangeItem } from "./enrich-change-item";

export type MergedPullRequestInput = {
  installationId: string;
  repoFullName: string;
  baseBranch: string;
  prNumber: number;
  prTitle: string;
  prDescription: string;
  prUrl: string;
  mergedAt: Date;
};

export async function ingestMergedPullRequest(
  input: MergedPullRequestInput,
  enrich: EnrichChangeItem = enrichChangeItem,
  database: typeof defaultDb = defaultDb
): Promise<void> {
  const [repo] = await database
    .select()
    .from(repos)
    .where(
      and(eq(repos.githubInstallationId, input.installationId), eq(repos.githubRepoFullName, input.repoFullName))
    )
    .limit(1);

  if (!repo || !repo.sourceTypes.includes("pr")) return;
  if (input.baseBranch !== repo.watchedBranch) return;

  const enrichment = await enrich({
    sourceType: "pr",
    repoName: input.repoFullName,
    prTitle: input.prTitle,
    prDescription: input.prDescription,
  });

  await database
    .insert(changeItems)
    .values({
      tenantId: repo.tenantId,
      repoId: repo.id,
      sourceType: "pr",
      prNumber: input.prNumber,
      prTitle: input.prTitle,
      prDescription: input.prDescription,
      prUrl: input.prUrl,
      mergedAt: input.mergedAt,
      userFacing: enrichment.userFacing,
      impactSummary: enrichment.impactSummary,
      suggestedCategory: enrichment.suggestedCategory,
      enrichmentConfidence: enrichment.confidence,
      enrichedAt: new Date(),
    })
    .onConflictDoNothing();
}
```

- [ ] **Step 8: Run both ingestion tests and confirm the route type-checks**

Run: `npm test -- ingest-push ingest-pull-request`
Expected: PASS.

The route `src/app/api/webhooks/github/route.ts` calls `ingestMergedPullRequest({...})` (one arg) and `ingestPush({...}, cb)` (two args). Both new params default, so no change is needed.

Run: `npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 9: Commit**

```bash
git add src/lib/ingest-push.ts src/lib/ingest-pull-request.ts tests/lib/ingest-push.test.ts tests/lib/ingest-pull-request.test.ts
git commit -m "feat: enrich commits and PRs during webhook ingestion"
```

---

### Task 6: Batchable filter + wire generation entry points

**Files:**
- Modify: `src/lib/change-item-batch.ts` (add `getBatchableChangeItems`)
- Modify: `src/lib/run-schedule.ts:79` (use it in `runSchedulerTick`)
- Modify: `src/app/(dashboard)/pending/actions.ts:31` (use it in `runNow`)
- Test: `tests/lib/change-item-batch.test.ts` (add filter tests)

**Interfaces:**
- Consumes: enrichment columns (Task 1).
- Produces: `getBatchableChangeItems(tenantId: string, database?): Promise<ChangeItemRow[]>` — pending rows where `user_facing` is `true` OR `null`; excludes `false`. `getPendingChangeItems` is unchanged (still returns all pending, for display).

- [ ] **Step 1: Write the failing test**

In `tests/lib/change-item-batch.test.ts`, update the import on line 5 to include the new function:

```ts
import { getPendingChangeItems, getBatchableChangeItems, claimBatchAndCreateUpdate } from "../../src/lib/change-item-batch";
```

Add this test inside the `describe` block:

```ts
  it("getBatchableChangeItems excludes non-facing items but keeps facing and un-enriched (null)", async () => {
    const { tenant, repoA } = await seed();
    await db.insert(changeItems).values([
      { tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "facing", userFacing: true },
      { tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "pending", prNumber: 2, prTitle: "non-facing", userFacing: false },
      { tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "pending", prNumber: 3, prTitle: "unenriched" }, // userFacing null
    ]);

    const batchable = await getBatchableChangeItems(tenant.id);
    expect(batchable.map((p) => p.prTitle).sort()).toEqual(["facing", "unenriched"]);

    const all = await getPendingChangeItems(tenant.id);
    expect(all.map((p) => p.prTitle).sort()).toEqual(["facing", "non-facing", "unenriched"]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- change-item-batch`
Expected: FAIL — `getBatchableChangeItems` is not exported (`is not a function`).

- [ ] **Step 3: Add `getBatchableChangeItems`**

In `src/lib/change-item-batch.ts`, update the drizzle import on line 1:

```ts
import { and, eq, inArray, isNull, or } from "drizzle-orm";
```

Add this function directly below `getPendingChangeItems` (after line 17):

```ts
/**
 * Pending items eligible for a generation batch: excludes items the enricher
 * classified as non-user-facing (`user_facing = false`). Keeps `true` and
 * `null` — a null means "not yet enriched" and is treated as user-facing so a
 * classifier gap never silently drops a change.
 */
export async function getBatchableChangeItems(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<ChangeItemRow[]> {
  return database
    .select()
    .from(changeItems)
    .where(
      and(
        eq(changeItems.tenantId, tenantId),
        eq(changeItems.status, "pending"),
        or(isNull(changeItems.userFacing), eq(changeItems.userFacing, true))
      )
    )
    .orderBy(changeItems.createdAt);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- change-item-batch`
Expected: PASS.

- [ ] **Step 5: Point the generation entry points at the batchable query**

In `src/lib/run-schedule.ts`, update the import on line 4:

```ts
import { getPendingChangeItems, getBatchableChangeItems, claimBatchAndCreateUpdate } from "./change-item-batch";
```

In `runSchedulerTick` (line 79), change:

```ts
      const pending = await getBatchableChangeItems(config.tenantId, database);
```

(Leave the `shouldTriggerRun` threshold logic as-is — it now counts batchable items, which is the intended behavior: non-facing noise no longer trips the threshold.)

In `src/app/(dashboard)/pending/actions.ts`, update the import on line 9:

```ts
import { getBatchableChangeItems } from "@/lib/change-item-batch";
```

In `runNow` (line 31), change:

```ts
  const pending = await getBatchableChangeItems(session.user.tenantId);
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all PASS (existing `run-schedule` tests use seeded facing/null items, so batchable == pending for them).

Run: `npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/change-item-batch.ts src/lib/run-schedule.ts "src/app/(dashboard)/pending/actions.ts" tests/lib/change-item-batch.test.ts
git commit -m "feat: exclude non-user-facing items from generation batches"
```

---

### Task 7: Pending UI — dim non-facing, force-include, low-confidence hint

**Files:**
- Create: `src/lib/change-item-display.ts` (pure display-state helper)
- Test: `tests/lib/change-item-display.test.ts`
- Modify: `src/app/(dashboard)/pending/actions.ts` (add `includeChangeItem` server action)
- Modify: `src/app/(dashboard)/pending/page.tsx` (render state + Include button)

**Interfaces:**
- Consumes: enrichment columns (Task 1).
- Produces: `changeItemFacingState(item): "facing" | "non-facing" | "low-confidence"`; server action `includeChangeItem(formData: FormData)`.

- [ ] **Step 1: Write the failing test for the display helper**

Create `tests/lib/change-item-display.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { changeItemFacingState } from "../../src/lib/change-item-display";

describe("changeItemFacingState", () => {
  it("is non-facing when userFacing is false", () => {
    expect(changeItemFacingState({ userFacing: false, enrichmentConfidence: 0.9 })).toBe("non-facing");
  });

  it("is low-confidence when facing with confidence below threshold", () => {
    expect(changeItemFacingState({ userFacing: true, enrichmentConfidence: 0.3 })).toBe("low-confidence");
  });

  it("is facing when confidence is high", () => {
    expect(changeItemFacingState({ userFacing: true, enrichmentConfidence: 0.8 })).toBe("facing");
  });

  it("is facing when un-enriched (null userFacing / null confidence)", () => {
    expect(changeItemFacingState({ userFacing: null, enrichmentConfidence: null })).toBe("facing");
    expect(changeItemFacingState({ userFacing: true, enrichmentConfidence: null })).toBe("facing");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- change-item-display`
Expected: FAIL — `Cannot find module '../../src/lib/change-item-display'`.

- [ ] **Step 3: Write the display helper**

Create `src/lib/change-item-display.ts`:

```ts
export type FacingState = "facing" | "non-facing" | "low-confidence";

// Facing items whose classifier confidence is below this get a soft "low
// confidence" hint in the UI — informational only, never filtered.
export const LOW_CONFIDENCE_THRESHOLD = 0.5;

export function changeItemFacingState(item: {
  userFacing: boolean | null;
  enrichmentConfidence: number | null;
}): FacingState {
  if (item.userFacing === false) return "non-facing";
  if (
    item.userFacing === true &&
    item.enrichmentConfidence !== null &&
    item.enrichmentConfidence < LOW_CONFIDENCE_THRESHOLD
  ) {
    return "low-confidence";
  }
  return "facing";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- change-item-display`
Expected: PASS.

- [ ] **Step 5: Add the `includeChangeItem` server action**

In `src/app/(dashboard)/pending/actions.ts`, add this action (it mirrors the existing `dropChangeItem` at line 14, which is the established pattern for a tenant-scoped change-item mutation):

```ts
export async function includeChangeItem(formData: FormData) {
  const session = await requireSession();
  const changeItemId = formData.get("changeItemId") as string;

  // Force-include: the user is overriding the classifier. Scope to the caller's
  // tenant so a caller can only ever flip their own rows.
  await db
    .update(changeItems)
    .set({ userFacing: true })
    .where(and(eq(changeItems.id, changeItemId), eq(changeItems.tenantId, session.user.tenantId)));

  revalidatePath("/pending");
}
```

(`and`, `eq`, `db`, `changeItems`, `requireSession`, `revalidatePath` are already imported in this file.)

- [ ] **Step 6: Render facing state in the Pending table**

In `src/app/(dashboard)/pending/page.tsx`:

Add to the imports at the top:

```ts
import { changeItemFacingState } from "@/lib/change-item-display";
import { dropChangeItem, runNow, includeChangeItem } from "./actions";
```

(Replace the existing `import { dropChangeItem, runNow } from "./actions";` on line 9 with the line above.)

Inside the `pending.map((item) => { ... })` body (starting line 124), after the existing `const when = ...` line, add:

```ts
              const facingState = changeItemFacingState(item);
              const isNonFacing = facingState === "non-facing";
```

Change the opening `<TableRow key={item.id}>` (line 130) to dim non-facing rows:

```tsx
                <TableRow key={item.id} className={isNonFacing ? "opacity-60" : undefined}>
```

In the "Change" cell (the `<div className="max-w-[22rem] truncate font-medium">` block, lines 134-144), add a state badge below the title. Replace that `<TableCell>` with:

```tsx
                  <TableCell>
                    <div className="max-w-[22rem] truncate font-medium">
                      {url ? (
                        <a href={url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                          {change}
                        </a>
                      ) : (
                        change
                      )}
                    </div>
                    {facingState === "non-facing" && (
                      <Badge variant="outline" className="mt-1 text-muted-foreground">
                        Not user-facing
                      </Badge>
                    )}
                    {facingState === "low-confidence" && (
                      <Badge variant="outline" className="mt-1 text-muted-foreground">
                        Low confidence
                      </Badge>
                    )}
                  </TableCell>
```

In the actions cell (the last `<TableCell className="pr-4 text-right">`, lines 151-158), show an Include button for non-facing items alongside Drop. Replace that `<TableCell>` with:

```tsx
                  <TableCell className="pr-4 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {isNonFacing && (
                        <form action={includeChangeItem}>
                          <input type="hidden" name="changeItemId" value={item.id} />
                          <Button type="submit" variant="ghost" size="sm">
                            Include
                          </Button>
                        </form>
                      )}
                      <form action={dropChangeItem}>
                        <input type="hidden" name="changeItemId" value={item.id} />
                        <Button type="submit" variant="ghost" size="sm" className="text-muted-foreground">
                          Drop
                        </Button>
                      </form>
                    </div>
                  </TableCell>
```

- [ ] **Step 7: Verify build and full suite**

Run: `npx tsc --noEmit`
Expected: no type errors.

Run: `npm test`
Expected: all PASS.

- [ ] **Step 8: Manually verify the Pending page (per the `verify` skill)**

Start the dev server and open `/pending`. Confirm: a non-facing item renders dimmed with a "Not user-facing" badge and an "Include" button; clicking Include makes the row render normally (it becomes batchable); a low-confidence facing item shows the "Low confidence" badge and no Include button.

- [ ] **Step 9: Commit**

```bash
git add src/lib/change-item-display.ts tests/lib/change-item-display.test.ts "src/app/(dashboard)/pending/actions.ts" "src/app/(dashboard)/pending/page.tsx"
git commit -m "feat: surface enrichment state in the Pending list"
```

---

## Self-Review

**Spec coverage:**
- Data model (5 nullable columns + migration) → Task 1. ✓
- Enrichment module (pure prompt builder, Zod schema, Haiku default, fail-open) → Task 3. ✓
- `mapWithConcurrency` cap 5 → Task 2, used in Tasks 4 & 5. ✓
- Inline enrichment persisted on insert, both paths → Tasks 4 (manual) & 5 (push + PR). ✓
- Batch filter keeps `true`/`null`, drops `false`; generation entry points rewired → Task 6. ✓
- Pending UI: dim non-facing + force-include (flips `user_facing` true) + low-confidence hint → Task 7. ✓
- Testing (prompt builder, schema parse, fail-open, concurrency, filter, display state) → Tasks 2, 3, 6, 7. ✓
- Scope boundaries respected: generation prompt untouched (no change to `generation.ts`); no backfill; no examples/review. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N" — every code step shows complete code. ✓

**Type consistency:** `EnrichmentResult`/`EnrichmentInput`/`EnrichChangeItem` defined in Task 3 are consumed with matching field names (`userFacing`, `impactSummary`, `suggestedCategory`, `confidence`) in Tasks 4, 5. Column names (`userFacing`, `impactSummary`, `suggestedCategory`, `enrichmentConfidence`, `enrichedAt`) from Task 1 are used identically in Tasks 4, 5, 6, 7. `getBatchableChangeItems` signature matches its call sites. `changeItemFacingState` return union matches its usage in `page.tsx`. ✓

**Note on ordering:** Task 1 must run first (columns), then Task 2 & 3 (independent, either order), then Task 4 & 5 (need 2 & 3), then Task 6, then Task 7. Tasks 2 and 3 have no interdependency and could be parallelized.
