# Scheduler + Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn accumulated `ChangeItem`s into AI-drafted `Update`s, on a schedule — batching by cadence or backlog threshold (whichever comes first), or on manual demand, always landing as a `draft` for human review.

**Architecture:** A pure decision layer (`shouldTriggerRun`, `advanceNextScheduledAt`) decides *when* to fire, independent of the DB. An hourly Vercel Cron hits a route that reads every tenant/repo's `ScheduleConfig`, asks the decision layer whether to fire, and if so hands the repo's pending `ChangeItem`s to a generation worker (AI SDK `generateObject` against a Zod schema, with the tenant's `BrandProfile` injected and a diff-truncation fallback for oversized batches). A transactional claim step (re-check-then-update) creates the `Update` and marks only the `ChangeItem`s that were still actually pending, so a manual run racing the cron tick can't double-batch. A "Run now" route reuses the same worker outside the schedule; a schedule-choice route lets the operator keep or skip the next cadence occurrence after a manual run.

**Tech Stack:** AI SDK `generateObject` (via Vercel AI Gateway, model as a plain string), Zod, Drizzle transactions, Vercel Cron (`vercel.ts`).

## Global Constraints

- A scheduled or manual run always produces exactly one `Update` per repo per batch — never multiple, never a partial one. (Design spec: "Batching mode")
- A batch is claimed transactionally: `ChangeItem`s only move `pending` → `batched` inside the same transaction that creates their `Update`, and only items still `pending` at claim time are included — a losing concurrent trigger simply claims fewer (or zero) items rather than double-batching. (Design spec: "Error Handling" — racing triggers)
- A cadence tick with zero pending items never creates an empty `Update`, and never advances `nextScheduledAt`. (Design spec: Scheduler architecture)
- "Skip" after a manual run advances `nextScheduledAt` by one cadence interval **from its current value**, not from "now" — this must land exactly one cycle later than originally planned. (Design spec: "Post-run schedule")
- Explicit "failed" status surfacing for a doubly-failed generation is deferred to the Dashboard plan (Plan 4); this plan's fallback on double-failure is to leave the batch's `ChangeItem`s `pending` so they're picked up automatically by the next run — no data loss, but no dashboard-visible failure flag yet.

---

### Task 1: Extend the schema — `ScheduleConfig`, `BrandProfile`, `Update`

**Files:**
- Modify: `src/db/schema.ts`
- Test: `tests/db/scheduler-generation-schema.test.ts`

**Interfaces:**
- Consumes: `tenants`, `users`, `repos`, `changeItems` (Plans 1–2).
- Produces: `scheduleConfigs`, `brandProfiles`, `updates` tables + `cadenceEnum`, `updateStatusEnum`, `updateCategoryEnum`. Also backfills a foreign key on `changeItems.updateId`, which existed as a plain `uuid` column since Plan 2.

- [ ] **Step 1: Add the FK reference and the new tables**

Modify `src/db/schema.ts`:

1. Update the `pg-core` import line to add `jsonb`:
   ```typescript
   import { pgTable, pgEnum, uuid, text, timestamp, primaryKey, integer, jsonb } from "drizzle-orm/pg-core";
   ```
2. Change the `changeItems.updateId` field from:
   ```typescript
   updateId: uuid("update_id"),
   ```
   to:
   ```typescript
   updateId: uuid("update_id").references(() => updates.id),
   ```
3. Append to the end of the file:
   ```typescript
   export const cadenceEnum = pgEnum("cadence", ["daily", "weekly", "biweekly", "monthly", "none"]);
   export const updateStatusEnum = pgEnum("update_status", ["draft", "approved", "published", "rejected"]);
   export const updateCategoryEnum = pgEnum("update_category", ["new", "improved", "fixed"]);

   export const scheduleConfigs = pgTable("schedule_configs", {
     id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
     tenantId: uuid("tenant_id")
       .notNull()
       .references(() => tenants.id, { onDelete: "cascade" }),
     repoId: uuid("repo_id")
       .notNull()
       .references(() => repos.id, { onDelete: "cascade" }),
     cadence: cadenceEnum("cadence").notNull().default("weekly"),
     threshold: integer("threshold"),
     lastRunAt: timestamp("last_run_at", { withTimezone: true }),
     nextScheduledAt: timestamp("next_scheduled_at", { withTimezone: true }),
     createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
   });

   export const brandProfiles = pgTable("brand_profiles", {
     id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
     tenantId: uuid("tenant_id")
       .notNull()
       .unique()
       .references(() => tenants.id, { onDelete: "cascade" }),
     tone: text("tone"),
     readingLevel: text("reading_level"),
     doList: text("do_list").array().notNull().default([]),
     dontList: text("dont_list").array().notNull().default([]),
     examplePhrases: text("example_phrases").array().notNull().default([]),
     industry: text("industry"),
     userPersonas: text("user_personas").array().notNull().default([]),
     createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
     updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
   });

   export const updates = pgTable("updates", {
     id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
     tenantId: uuid("tenant_id")
       .notNull()
       .references(() => tenants.id, { onDelete: "cascade" }),
     repoId: uuid("repo_id")
       .notNull()
       .references(() => repos.id, { onDelete: "cascade" }),
     title: text("title").notNull(),
     body: text("body").notNull(),
     category: updateCategoryEnum("category").notNull(),
     status: updateStatusEnum("status").notNull().default("draft"),
     sourceItems: jsonb("source_items").$type<string[]>().notNull(),
     createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
     publishedAt: timestamp("published_at", { withTimezone: true }),
     editedBy: uuid("edited_by").references(() => users.id),
   });
   ```

- [ ] **Step 2: Generate and apply the migration**

```bash
npm run db:generate
```
Expected: `3 tables` (`brand_profiles`, `schedule_configs`, `updates`) reported as new/changed, plus a change to `change_items` (the FK addition). The migration file should contain `CREATE TABLE` statements for the three new tables and a single `ALTER TABLE "change_items" ADD CONSTRAINT ...` — not a full `change_items` rebuild. If you see `DROP TABLE "change_items"` anywhere in the generated SQL, stop and re-check Step 1.

```bash
npm run db:migrate
```
Expected: no errors.

- [ ] **Step 3: Write a round-trip test covering the FK backfill**

Create `tests/db/scheduler-generation-schema.test.ts`:
```typescript
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, repos, changeItems, updates } from "../../src/db/schema";

describe("scheduler/generation schema", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, "Scheduler Schema Test Tenant"));
  });

  it("links a ChangeItem to a real Update via the now-present FK", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "Scheduler Schema Test Tenant" }).returning();
    const [repo] = await db
      .insert(repos)
      .values({
        tenantId: tenant.id,
        githubRepoFullName: "acme/widgets",
        githubInstallationId: "1",
        defaultBranch: "main",
      })
      .returning();

    const [update] = await db
      .insert(updates)
      .values({
        tenantId: tenant.id,
        repoId: repo.id,
        title: "Test update",
        body: "Body",
        category: "improved",
        sourceItems: [],
      })
      .returning();

    const [item] = await db
      .insert(changeItems)
      .values({
        tenantId: tenant.id,
        repoId: repo.id,
        sourceType: "pr",
        status: "batched",
        updateId: update.id,
        prNumber: 1,
        prTitle: "x",
      })
      .returning();

    expect(item.updateId).toBe(update.id);
  });
});
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
npx vitest run tests/db/scheduler-generation-schema.test.ts
```
Expected: `Tests  1 passed (1)`.

- [ ] **Step 5: Commit**

```bash
git add src/db tests/db
git commit -m "$(cat <<'EOF'
Add ScheduleConfig, BrandProfile, Update tables

Backfills the FK on ChangeItem.updateId that was intentionally left
off in Plan 2 (updates didn't exist yet) — confirmed via a clean
incremental migration, not a table rebuild.
EOF
)"
```

---

### Task 2: Batch collection + transactional claim

**Files:**
- Create: `src/lib/change-item-batch.ts`
- Test: `tests/lib/change-item-batch.test.ts`

**Interfaces:**
- Consumes: `changeItems`, `updates` (Task 1).
- Produces: `getPendingChangeItems(repoId, database?)`, `claimBatchAndCreateUpdate(input, database?)` — Task 5's orchestration calls both.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/change-item-batch.test.ts`:
```typescript
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, repos, changeItems, updates } from "../../src/db/schema";
import { getPendingChangeItems, claimBatchAndCreateUpdate } from "../../src/lib/change-item-batch";

describe("change-item-batch", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, "Batch Test Tenant"));
  });

  async function seed() {
    const [tenant] = await db.insert(tenants).values({ name: "Batch Test Tenant" }).returning();
    const [repo] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/x", githubInstallationId: "1", defaultBranch: "main" })
      .returning();
    return { tenant, repo };
  }

  it("getPendingChangeItems returns only pending items for the repo", async () => {
    const { tenant, repo } = await seed();
    await db.insert(changeItems).values([
      { tenantId: tenant.id, repoId: repo.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "a" },
      { tenantId: tenant.id, repoId: repo.id, sourceType: "pr", status: "excluded", prNumber: 2, prTitle: "b" },
    ]);

    const pending = await getPendingChangeItems(repo.id);
    expect(pending).toHaveLength(1);
    expect(pending[0].prTitle).toBe("a");
  });

  it("claimBatchAndCreateUpdate creates an Update and marks the items batched", async () => {
    const { tenant, repo } = await seed();
    const [item] = await db
      .insert(changeItems)
      .values({ tenantId: tenant.id, repoId: repo.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "a" })
      .returning();

    const update = await claimBatchAndCreateUpdate({
      tenantId: tenant.id,
      repoId: repo.id,
      changeItemIds: [item.id],
      draft: { title: "T", body: "B", category: "new" },
    });

    expect(update).not.toBeNull();
    expect(update!.sourceItems).toEqual([item.id]);

    const [reloaded] = await db.select().from(changeItems).where(eq(changeItems.id, item.id));
    expect(reloaded.status).toBe("batched");
    expect(reloaded.updateId).toBe(update!.id);
  });

  it("only claims items still pending, excluding ones already batched (race simulation)", async () => {
    const { tenant, repo } = await seed();
    const [stillPending, alreadyBatched] = await db
      .insert(changeItems)
      .values([
        { tenantId: tenant.id, repoId: repo.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "a" },
        { tenantId: tenant.id, repoId: repo.id, sourceType: "pr", status: "batched", prNumber: 2, prTitle: "b" },
      ])
      .returning();

    const update = await claimBatchAndCreateUpdate({
      tenantId: tenant.id,
      repoId: repo.id,
      changeItemIds: [stillPending.id, alreadyBatched.id],
      draft: { title: "T", body: "B", category: "new" },
    });

    expect(update!.sourceItems).toEqual([stillPending.id]);
  });

  it("returns null and creates no Update when none of the ids are still pending", async () => {
    const { tenant, repo } = await seed();
    const [item] = await db
      .insert(changeItems)
      .values({ tenantId: tenant.id, repoId: repo.id, sourceType: "pr", status: "batched", prNumber: 1, prTitle: "a" })
      .returning();

    const update = await claimBatchAndCreateUpdate({
      tenantId: tenant.id,
      repoId: repo.id,
      changeItemIds: [item.id],
      draft: { title: "T", body: "B", category: "new" },
    });

    expect(update).toBeNull();
    const allUpdates = await db.select().from(updates).where(eq(updates.repoId, repo.id));
    expect(allUpdates).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run tests/lib/change-item-batch.test.ts
```
Expected: FAIL — `Cannot find module '../../src/lib/change-item-batch'`.

- [ ] **Step 3: Implement it**

Create `src/lib/change-item-batch.ts`:
```typescript
import { and, eq, inArray } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { changeItems, updates } from "../db/schema";

type ChangeItemRow = typeof changeItems.$inferSelect;
type UpdateRow = typeof updates.$inferSelect;

export async function getPendingChangeItems(
  repoId: string,
  database: typeof defaultDb = defaultDb
): Promise<ChangeItemRow[]> {
  return database
    .select()
    .from(changeItems)
    .where(and(eq(changeItems.repoId, repoId), eq(changeItems.status, "pending")));
}

export type DraftInput = { title: string; body: string; category: "new" | "improved" | "fixed" };

export async function claimBatchAndCreateUpdate(
  input: { tenantId: string; repoId: string; changeItemIds: string[]; draft: DraftInput },
  database: typeof defaultDb = defaultDb
): Promise<UpdateRow | null> {
  return database.transaction(async (tx) => {
    const claimed = await tx
      .update(changeItems)
      .set({ status: "batched" })
      .where(and(inArray(changeItems.id, input.changeItemIds), eq(changeItems.status, "pending")))
      .returning({ id: changeItems.id });

    if (claimed.length === 0) return null;

    const claimedIds = claimed.map((c) => c.id);

    const [update] = await tx
      .insert(updates)
      .values({
        tenantId: input.tenantId,
        repoId: input.repoId,
        title: input.draft.title,
        body: input.draft.body,
        category: input.draft.category,
        sourceItems: claimedIds,
      })
      .returning();

    await tx.update(changeItems).set({ updateId: update.id }).where(inArray(changeItems.id, claimedIds));

    return update;
  });
}
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
npx vitest run tests/lib/change-item-batch.test.ts
```
Expected: `Tests  4 passed (4)`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/change-item-batch.ts tests/lib/change-item-batch.test.ts
git commit -m "$(cat <<'EOF'
Add transactional ChangeItem batch claim + Update creation

Only items still pending at claim time are included, so a manual run
racing a cron tick claims fewer items rather than double-batching.
EOF
)"
```

---

### Task 3: Generation worker

**Files:**
- Create: `src/lib/generation.ts`
- Test: `tests/lib/generation.test.ts`

**Interfaces:**
- Consumes: `changeItems.$inferSelect`, `brandProfiles.$inferSelect` (Task 1 / Plan 2).
- Produces: `generateUpdateDraft(items, brandProfile): Promise<UpdateDraft>`, `serializeBatchForPrompt(items, maxChars?): string` — Task 5's orchestration calls `generateUpdateDraft`.

- [ ] **Step 1: Install the AI SDK and Zod**

```bash
npm install ai@7.0.22 zod@4.4.3 @vercel/config@0.5.5
```

- [ ] **Step 2: Write the failing test for prompt serialization (pure, no AI call)**

Create `tests/lib/generation.test.ts`:
```typescript
import { describe, it, expect, vi } from "vitest";
import { serializeBatchForPrompt } from "../../src/lib/generation";

type FakeChangeItem = {
  id: string;
  sourceType: "pr" | "commit";
  prNumber: number | null;
  prTitle: string | null;
  prDescription: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  diff: string | null;
};

function prItem(overrides: Partial<FakeChangeItem> = {}): FakeChangeItem {
  return {
    id: "ci_1",
    sourceType: "pr",
    prNumber: 1,
    prTitle: "Add dark mode",
    prDescription: "Adds a toggle.",
    commitSha: null,
    commitMessage: null,
    diff: null,
    ...overrides,
  };
}

function commitItem(overrides: Partial<FakeChangeItem> = {}): FakeChangeItem {
  return {
    id: "ci_2",
    sourceType: "commit",
    prNumber: null,
    prTitle: null,
    prDescription: null,
    commitSha: "abcdef1234567",
    commitMessage: "fix export timeout",
    diff: "diff --git a/x b/x\n+fix",
    ...overrides,
  };
}

describe("serializeBatchForPrompt", () => {
  it("formats PR and commit items with their diff included when the batch is small", () => {
    const result = serializeBatchForPrompt([prItem(), commitItem()] as never);

    expect(result).toContain('1. [PR #1] "Add dark mode" — Adds a toggle.');
    expect(result).toContain('2. [commit abcdef1] "fix export timeout" — diff --git a/x b/x\n+fix');
  });

  it("drops diffs starting with the largest when the batch exceeds maxChars", () => {
    const bigDiff = "x".repeat(1000);
    const smallDiff = "y".repeat(10);

    const items = [
      commitItem({ id: "big", commitSha: "1111111111111", commitMessage: "big change", diff: bigDiff }),
      commitItem({ id: "small", commitSha: "2222222222222", commitMessage: "small change", diff: smallDiff }),
    ];

    const result = serializeBatchForPrompt(items as never, 100);

    expect(result).not.toContain(bigDiff);
    expect(result).toContain("small change");
    expect(result.length).toBeLessThanOrEqual(100 + 200); // some slack for marker text
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

```bash
npx vitest run tests/lib/generation.test.ts
```
Expected: FAIL — `Cannot find module '../../src/lib/generation'`.

- [ ] **Step 4: Implement `serializeBatchForPrompt` and the schema/types**

Create `src/lib/generation.ts`:
```typescript
import { generateObject } from "ai";
import { z } from "zod";
import type { changeItems, brandProfiles } from "../db/schema";

type ChangeItemRow = typeof changeItems.$inferSelect;
type BrandProfileRow = typeof brandProfiles.$inferSelect;

export const UpdateDraftSchema = z.object({
  title: z.string(),
  body: z.string(),
  category: z.enum(["new", "improved", "fixed"]),
});

export type UpdateDraft = z.infer<typeof UpdateDraftSchema>;

const DEFAULT_MAX_PROMPT_CHARS = 24000;

function formatChangeItem(item: ChangeItemRow, index: number, includeDiff: boolean): string {
  if (item.sourceType === "pr") {
    return `${index + 1}. [PR #${item.prNumber}] "${item.prTitle}" — ${item.prDescription ?? ""}`;
  }
  const shortSha = item.commitSha?.slice(0, 7) ?? "unknown";
  const diffPart = includeDiff && item.diff ? ` — ${item.diff}` : "";
  return `${index + 1}. [commit ${shortSha}] "${item.commitMessage}"${diffPart}`;
}

export function serializeBatchForPrompt(items: ChangeItemRow[], maxChars = DEFAULT_MAX_PROMPT_CHARS): string {
  const includeDiffFlags = items.map(() => true);

  const render = () => items.map((item, i) => formatChangeItem(item, i, includeDiffFlags[i])).join("\n");

  let current = render();
  if (current.length <= maxChars) return current;

  const byDiffSizeDesc = items
    .map((item, index) => ({ index, diffLength: item.diff?.length ?? 0 }))
    .sort((a, b) => b.diffLength - a.diffLength);

  for (const { index, diffLength } of byDiffSizeDesc) {
    if (current.length <= maxChars || diffLength === 0) break;
    includeDiffFlags[index] = false;
    current = render();
  }

  return current;
}

function buildSystemPrompt(brandProfile: BrandProfileRow): string {
  const lines = [
    "You write concise, user-facing product update announcements.",
    brandProfile.industry ? `Industry: ${brandProfile.industry}.` : null,
    brandProfile.userPersonas.length > 0 ? `Audience: ${brandProfile.userPersonas.join(", ")}.` : null,
    brandProfile.tone ? `Tone: ${brandProfile.tone}.` : null,
    brandProfile.readingLevel ? `Reading level: ${brandProfile.readingLevel}.` : null,
    brandProfile.doList.length > 0 ? `Do: ${brandProfile.doList.join("; ")}.` : null,
    brandProfile.dontList.length > 0 ? `Avoid: ${brandProfile.dontList.join("; ")}.` : null,
  ].filter((line): line is string => Boolean(line));

  return lines.join(" ");
}

export async function generateUpdateDraft(
  items: ChangeItemRow[],
  brandProfile: BrandProfileRow
): Promise<UpdateDraft> {
  const batchText = serializeBatchForPrompt(items);

  const result = await generateObject({
    model: process.env.GENERATION_MODEL ?? "anthropic/claude-sonnet-4-5",
    schema: UpdateDraftSchema,
    system: buildSystemPrompt(brandProfile),
    prompt: `Here are the changes to summarize into one product update:\n\n${batchText}`,
  });

  return result.object;
}
```

- [ ] **Step 5: Run the serialization tests and confirm they pass**

```bash
npx vitest run tests/lib/generation.test.ts
```
Expected: `Tests  2 passed (2)`.

- [ ] **Step 6: Add the failing test for `generateUpdateDraft` (mocking the AI call)**

Append to `tests/lib/generation.test.ts`:
```typescript
vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

import { generateObject } from "ai";
import { generateUpdateDraft } from "../../src/lib/generation";

describe("generateUpdateDraft", () => {
  it("passes the serialized batch and brand profile into the prompt, and returns the object", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "Faster search", body: "We rebuilt search.", category: "improved" },
    } as never);

    const items = [prItem()] as never;
    const brandProfile = {
      tone: "friendly",
      readingLevel: "simple",
      doList: ["be concise"],
      dontList: ["no jargon"],
      examplePhrases: [],
      industry: "B2B SaaS",
      userPersonas: ["engineering managers"],
    } as never;

    const draft = await generateUpdateDraft(items, brandProfile);

    expect(draft).toEqual({ title: "Faster search", body: "We rebuilt search.", category: "improved" });

    const callArgs = vi.mocked(generateObject).mock.calls[0][0];
    expect(callArgs.system).toContain("Industry: B2B SaaS.");
    expect(callArgs.system).toContain("Audience: engineering managers.");
    expect(callArgs.prompt).toContain('Add dark mode');
  });
});
```

Note: this `vi.mock("ai", ...)` must be declared before the `import { generateObject } from "ai"` line for Vitest's hoisting to apply correctly — keep it at the top of this new block, above the imports it affects.

- [ ] **Step 7: Run it and confirm it fails, then passes**

```bash
npx vitest run tests/lib/generation.test.ts
```
First run (before Step 4's code — should already pass since `generateUpdateDraft` was implemented in Step 4). Expected: `Tests  3 passed (3)`. If any test fails, check that the `vi.mock("ai", ...)` call sits above its corresponding imports in the test file.

- [ ] **Step 8: Commit**

```bash
git add src/lib/generation.ts tests/lib/generation.test.ts package.json package-lock.json
git commit -m "$(cat <<'EOF'
Add the generation worker: prompt serialization + AI SDK generateObject

Batches serialize PR/commit ChangeItems with the tenant's BrandProfile
as system context; oversized batches drop diffs starting with the
largest before dropping any item's title/message.
EOF
)"
```

---

### Task 4: Scheduler decision logic (pure)

**Files:**
- Create: `src/lib/scheduler-decision.ts`
- Test: `tests/lib/scheduler-decision.test.ts`

**Interfaces:**
- Produces: `shouldTriggerRun(state, now): "cadence" | "threshold" | null`, `advanceNextScheduledAt(current, cadence): Date`, and the `Cadence` type — Task 5's orchestration and Task 6's schedule-choice route both use these.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/scheduler-decision.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { shouldTriggerRun, advanceNextScheduledAt } from "../../src/lib/scheduler-decision";

describe("shouldTriggerRun", () => {
  const now = new Date("2026-07-13T12:00:00Z");

  it("returns null when there is nothing pending, even if the cadence deadline passed", () => {
    const result = shouldTriggerRun(
      { cadence: "weekly", nextScheduledAt: new Date("2026-07-01T00:00:00Z"), threshold: 5, pendingCount: 0 },
      now
    );
    expect(result).toBeNull();
  });

  it("returns 'cadence' when the deadline has passed and something is pending", () => {
    const result = shouldTriggerRun(
      { cadence: "weekly", nextScheduledAt: new Date("2026-07-01T00:00:00Z"), threshold: 5, pendingCount: 1 },
      now
    );
    expect(result).toBe("cadence");
  });

  it("returns null when the cadence deadline has not passed and the threshold isn't met", () => {
    const result = shouldTriggerRun(
      { cadence: "weekly", nextScheduledAt: new Date("2026-07-20T00:00:00Z"), threshold: 5, pendingCount: 2 },
      now
    );
    expect(result).toBeNull();
  });

  it("returns 'threshold' when the pending count meets it, even if the cadence deadline hasn't passed", () => {
    const result = shouldTriggerRun(
      { cadence: "weekly", nextScheduledAt: new Date("2026-07-20T00:00:00Z"), threshold: 5, pendingCount: 5 },
      now
    );
    expect(result).toBe("threshold");
  });

  it("ignores nextScheduledAt entirely when cadence is 'none'", () => {
    const result = shouldTriggerRun(
      { cadence: "none", nextScheduledAt: new Date("2026-01-01T00:00:00Z"), threshold: 5, pendingCount: 3 },
      now
    );
    expect(result).toBeNull();
  });

  it("treats a null/zero threshold as 'threshold trigger disabled'", () => {
    const result = shouldTriggerRun(
      { cadence: "weekly", nextScheduledAt: new Date("2026-07-20T00:00:00Z"), threshold: null, pendingCount: 999 },
      now
    );
    expect(result).toBeNull();
  });
});

describe("advanceNextScheduledAt", () => {
  it("adds 1 day for daily", () => {
    expect(advanceNextScheduledAt(new Date("2026-07-13T00:00:00Z"), "daily")).toEqual(
      new Date("2026-07-14T00:00:00Z")
    );
  });

  it("adds 7 days for weekly", () => {
    expect(advanceNextScheduledAt(new Date("2026-07-13T00:00:00Z"), "weekly")).toEqual(
      new Date("2026-07-20T00:00:00Z")
    );
  });

  it("adds 14 days for biweekly", () => {
    expect(advanceNextScheduledAt(new Date("2026-07-13T00:00:00Z"), "biweekly")).toEqual(
      new Date("2026-07-27T00:00:00Z")
    );
  });

  it("adds 1 calendar month for monthly", () => {
    expect(advanceNextScheduledAt(new Date("2026-07-13T00:00:00Z"), "monthly")).toEqual(
      new Date("2026-08-13T00:00:00Z")
    );
  });

  it("skipping a run due tomorrow lands 8 days out on a weekly cadence, not 7 from today", () => {
    const dueTomorrow = new Date("2026-07-14T00:00:00Z"); // "now" is 2026-07-13
    expect(advanceNextScheduledAt(dueTomorrow, "weekly")).toEqual(new Date("2026-07-21T00:00:00Z"));
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run tests/lib/scheduler-decision.test.ts
```
Expected: FAIL — `Cannot find module '../../src/lib/scheduler-decision'`.

- [ ] **Step 3: Implement it**

Create `src/lib/scheduler-decision.ts`:
```typescript
export type Cadence = "daily" | "weekly" | "biweekly" | "monthly" | "none";

export type ScheduleState = {
  cadence: Cadence;
  nextScheduledAt: Date | null;
  threshold: number | null;
  pendingCount: number;
};

export type TriggerReason = "cadence" | "threshold";

export function shouldTriggerRun(state: ScheduleState, now: Date): TriggerReason | null {
  if (state.pendingCount === 0) return null;

  const cadenceDue =
    state.cadence !== "none" && state.nextScheduledAt !== null && now.getTime() >= state.nextScheduledAt.getTime();
  if (cadenceDue) return "cadence";

  const thresholdMet =
    state.threshold !== null && state.threshold > 0 && state.pendingCount >= state.threshold;
  if (thresholdMet) return "threshold";

  return null;
}

export function advanceNextScheduledAt(current: Date, cadence: Exclude<Cadence, "none">): Date {
  const next = new Date(current);
  switch (cadence) {
    case "daily":
      next.setUTCDate(next.getUTCDate() + 1);
      break;
    case "weekly":
      next.setUTCDate(next.getUTCDate() + 7);
      break;
    case "biweekly":
      next.setUTCDate(next.getUTCDate() + 14);
      break;
    case "monthly":
      next.setUTCMonth(next.getUTCMonth() + 1);
      break;
  }
  return next;
}
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
npx vitest run tests/lib/scheduler-decision.test.ts
```
Expected: `Tests  11 passed (11)`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/scheduler-decision.ts tests/lib/scheduler-decision.test.ts
git commit -m "$(cat <<'EOF'
Add pure scheduler decision logic (cadence vs threshold, skip math)

advanceNextScheduledAt always rolls forward from the anchor date, not
"now" — this is what makes "skip the next run" land exactly one cycle
later than originally planned instead of resetting the clock.
EOF
)"
```

---

### Task 5: Orchestration + Cron route

**Files:**
- Create: `src/lib/brand-profile.ts`, `src/lib/run-schedule.ts`, `src/app/api/cron/scheduler/route.ts`, `vercel.ts`
- Test: `tests/lib/brand-profile.test.ts`, `tests/lib/run-schedule.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `getPendingChangeItems`, `claimBatchAndCreateUpdate` (Task 2), `generateUpdateDraft` (Task 3), `shouldTriggerRun`, `advanceNextScheduledAt` (Task 4).
- Produces: `getOrCreateBrandProfile(tenantId, database?)`, `runBatchForRepo(repoId, tenantId, pending, database?)`, `runSchedulerTick(now, database?)` — Task 6's manual-run route calls `runBatchForRepo` directly.

- [ ] **Step 1: Write the failing test for `getOrCreateBrandProfile`**

Create `tests/lib/brand-profile.test.ts`:
```typescript
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, brandProfiles } from "../../src/db/schema";
import { getOrCreateBrandProfile } from "../../src/lib/brand-profile";

describe("getOrCreateBrandProfile", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, "Brand Profile Test Tenant"));
  });

  it("creates a default profile on first call and returns the same one after", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "Brand Profile Test Tenant" }).returning();

    const first = await getOrCreateBrandProfile(tenant.id);
    expect(first.tenantId).toBe(tenant.id);
    expect(first.doList).toEqual([]);

    const second = await getOrCreateBrandProfile(tenant.id);
    expect(second.id).toBe(first.id);

    const rows = await db.select().from(brandProfiles).where(eq(brandProfiles.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run tests/lib/brand-profile.test.ts
```
Expected: FAIL — `Cannot find module '../../src/lib/brand-profile'`.

- [ ] **Step 3: Implement it**

Create `src/lib/brand-profile.ts`:
```typescript
import { eq } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { brandProfiles } from "../db/schema";

export async function getOrCreateBrandProfile(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<typeof brandProfiles.$inferSelect> {
  const existing = await database.select().from(brandProfiles).where(eq(brandProfiles.tenantId, tenantId)).limit(1);
  if (existing.length > 0) return existing[0];

  const [created] = await database.insert(brandProfiles).values({ tenantId }).returning();
  return created;
}
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
npx vitest run tests/lib/brand-profile.test.ts
```
Expected: `Tests  1 passed (1)`.

- [ ] **Step 5: Write the failing test for `runBatchForRepo`**

Create `tests/lib/run-schedule.test.ts`:
```typescript
import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

import { generateObject } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, repos, changeItems, updates } from "../../src/db/schema";
import { runBatchForRepo } from "../../src/lib/run-schedule";
import { getPendingChangeItems } from "../../src/lib/change-item-batch";

describe("runBatchForRepo", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, "Run Batch Test Tenant"));
    vi.mocked(generateObject).mockReset();
  });

  it("creates an Update from the pending batch and marks the items batched", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "Run Batch Test Tenant" }).returning();
    const [repo] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/x", githubInstallationId: "1", defaultBranch: "main" })
      .returning();
    await db.insert(changeItems).values({
      tenantId: tenant.id,
      repoId: repo.id,
      sourceType: "pr",
      status: "pending",
      prNumber: 1,
      prTitle: "Add dark mode",
    });

    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "Dark mode", body: "You can now enable dark mode.", category: "new" },
    } as never);

    const pending = await getPendingChangeItems(repo.id);
    await runBatchForRepo(repo.id, tenant.id, pending);

    const createdUpdates = await db.select().from(updates).where(eq(updates.repoId, repo.id));
    expect(createdUpdates).toHaveLength(1);
    expect(createdUpdates[0].title).toBe("Dark mode");

    const remainingPending = await getPendingChangeItems(repo.id);
    expect(remainingPending).toHaveLength(0);
  });

  it("does nothing when there are no pending items", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "Run Batch Test Tenant" }).returning();
    const [repo] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/x", githubInstallationId: "1", defaultBranch: "main" })
      .returning();

    await runBatchForRepo(repo.id, tenant.id, []);

    expect(generateObject).not.toHaveBeenCalled();
    const createdUpdates = await db.select().from(updates).where(eq(updates.repoId, repo.id));
    expect(createdUpdates).toHaveLength(0);
  });

  it("leaves items pending (no Update) when generation fails twice", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "Run Batch Test Tenant" }).returning();
    const [repo] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/x", githubInstallationId: "1", defaultBranch: "main" })
      .returning();
    await db.insert(changeItems).values({
      tenantId: tenant.id,
      repoId: repo.id,
      sourceType: "pr",
      status: "pending",
      prNumber: 1,
      prTitle: "Flaky",
    });

    vi.mocked(generateObject).mockRejectedValue(new Error("model unavailable"));

    const pending = await getPendingChangeItems(repo.id);
    await runBatchForRepo(repo.id, tenant.id, pending);

    expect(generateObject).toHaveBeenCalledTimes(2); // one retry
    const stillPending = await getPendingChangeItems(repo.id);
    expect(stillPending).toHaveLength(1);
  });
});
```

- [ ] **Step 6: Run it and confirm it fails**

```bash
npx vitest run tests/lib/run-schedule.test.ts
```
Expected: FAIL — `Cannot find module '../../src/lib/run-schedule'`.

- [ ] **Step 7: Implement `runBatchForRepo` and `runSchedulerTick`**

Create `src/lib/run-schedule.ts`:
```typescript
import { eq } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { scheduleConfigs } from "../db/schema";
import { getPendingChangeItems, claimBatchAndCreateUpdate } from "./change-item-batch";
import { generateUpdateDraft } from "./generation";
import { getOrCreateBrandProfile } from "./brand-profile";
import { shouldTriggerRun, advanceNextScheduledAt, type Cadence } from "./scheduler-decision";

type ChangeItemRow = Awaited<ReturnType<typeof getPendingChangeItems>>[number];

export async function runBatchForRepo(
  repoId: string,
  tenantId: string,
  pending: ChangeItemRow[],
  database: typeof defaultDb = defaultDb
): Promise<void> {
  if (pending.length === 0) return;

  const brandProfile = await getOrCreateBrandProfile(tenantId, database);

  let draft;
  try {
    draft = await generateUpdateDraft(pending, brandProfile);
  } catch {
    try {
      draft = await generateUpdateDraft(pending, brandProfile);
    } catch {
      // Both attempts failed. Leave the batch's items pending — they roll into
      // the next scheduled/threshold/manual run automatically (see Plan's
      // Global Constraints re: deferred failure surfacing).
      return;
    }
  }

  await claimBatchAndCreateUpdate(
    { tenantId, repoId, changeItemIds: pending.map((p) => p.id), draft },
    database
  );
}

export async function runSchedulerTick(now: Date, database: typeof defaultDb = defaultDb): Promise<void> {
  const configs = await database.select().from(scheduleConfigs);

  for (const config of configs) {
    const pending = await getPendingChangeItems(config.repoId, database);

    const reason = shouldTriggerRun(
      {
        cadence: config.cadence,
        nextScheduledAt: config.nextScheduledAt,
        threshold: config.threshold,
        pendingCount: pending.length,
      },
      now
    );

    if (!reason) continue;

    await runBatchForRepo(config.repoId, config.tenantId, pending, database);

    const updateFields: Partial<typeof scheduleConfigs.$inferInsert> = { lastRunAt: now };
    if (reason === "cadence" && config.cadence !== "none" && config.nextScheduledAt) {
      updateFields.nextScheduledAt = advanceNextScheduledAt(
        config.nextScheduledAt,
        config.cadence as Exclude<Cadence, "none">
      );
    }
    await database.update(scheduleConfigs).set(updateFields).where(eq(scheduleConfigs.id, config.id));
  }
}
```

- [ ] **Step 8: Run it and confirm it passes**

```bash
npx vitest run tests/lib/run-schedule.test.ts
```
Expected: `Tests  3 passed (3)`.

- [ ] **Step 9: Add env vars**

Append to `.env.example`:
```bash
# Generation (AI SDK routes through the Vercel AI Gateway when this is set)
AI_GATEWAY_API_KEY=
GENERATION_MODEL=anthropic/claude-sonnet-4-5

# Cron
CRON_SECRET=
```

- [ ] **Step 10: Wire the cron route**

Create `src/app/api/cron/scheduler/route.ts`:
```typescript
import { NextRequest, NextResponse } from "next/server";
import { runSchedulerTick } from "@/lib/run-schedule";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  await runSchedulerTick(new Date());

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 11: Configure Vercel Cron**

Create `vercel.ts`:
```typescript
import { type VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  crons: [{ path: "/api/cron/scheduler", schedule: "0 * * * *" }],
};
```

- [ ] **Step 12: Verify the app still builds**

```bash
npm run build
```
Expected: `✓ Compiled successfully`, now including `/api/cron/scheduler`.

- [ ] **Step 13: Run the full automated test suite**

```bash
npx vitest run
```
Expected: all tests pass.

- [ ] **Step 14: Commit**

```bash
git add src/lib/brand-profile.ts src/lib/run-schedule.ts src/app/api/cron vercel.ts tests/lib .env.example package.json package-lock.json
git commit -m "$(cat <<'EOF'
Wire the scheduler tick, generation orchestration, and Vercel Cron

Hourly cron hits /api/cron/scheduler (CRON_SECRET-gated), which asks
the pure decision layer whether each repo is due, then hands pending
ChangeItems to the generation worker.
EOF
)"
```

---

### Task 6: Manual "Run now" + post-run schedule choice

**Files:**
- Create: `src/app/api/repos/[repoId]/run-now/route.ts`, `src/app/api/repos/[repoId]/schedule-choice/route.ts`

**Interfaces:**
- Consumes: `requireSession` (Plan 1), `runBatchForRepo` (Task 5), `advanceNextScheduledAt` (Task 4).
- Produces: `POST /api/repos/:repoId/run-now`, `POST /api/repos/:repoId/schedule-choice` — Plan 4's Pending view calls both.

- [ ] **Step 1: Implement the run-now route**

Create `src/app/api/repos/[repoId]/run-now/route.ts`:
```typescript
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { repos, scheduleConfigs } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { getPendingChangeItems } from "@/lib/change-item-batch";
import { runBatchForRepo } from "@/lib/run-schedule";

export async function POST(request: NextRequest, { params }: { params: Promise<{ repoId: string }> }) {
  const session = await requireSession();
  const { repoId } = await params;

  const [repo] = await db.select().from(repos).where(eq(repos.id, repoId)).limit(1);
  if (!repo || repo.tenantId !== session.user.tenantId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const pending = await getPendingChangeItems(repoId);
  if (pending.length === 0) {
    return NextResponse.json({ error: "nothing pending" }, { status: 400 });
  }

  await runBatchForRepo(repoId, repo.tenantId, pending);
  await db.update(scheduleConfigs).set({ lastRunAt: new Date() }).where(eq(scheduleConfigs.repoId, repoId));

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Implement the schedule-choice route**

Create `src/app/api/repos/[repoId]/schedule-choice/route.ts`:
```typescript
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { repos, scheduleConfigs } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { advanceNextScheduledAt, type Cadence } from "@/lib/scheduler-decision";

export async function POST(request: NextRequest, { params }: { params: Promise<{ repoId: string }> }) {
  const session = await requireSession();
  const { repoId } = await params;
  const body = (await request.json()) as { choice: "keep" | "skip" };

  const [repo] = await db.select().from(repos).where(eq(repos.id, repoId)).limit(1);
  if (!repo || repo.tenantId !== session.user.tenantId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (body.choice === "skip") {
    const [config] = await db.select().from(scheduleConfigs).where(eq(scheduleConfigs.repoId, repoId)).limit(1);
    if (config && config.cadence !== "none" && config.nextScheduledAt) {
      await db
        .update(scheduleConfigs)
        .set({
          nextScheduledAt: advanceNextScheduledAt(
            config.nextScheduledAt,
            config.cadence as Exclude<Cadence, "none">
          ),
        })
        .where(eq(scheduleConfigs.id, config.id));
    }
  }

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Verify the app still builds**

```bash
npm run build
```
Expected: `✓ Compiled successfully`, now including `/api/repos/[repoId]/run-now` and `/api/repos/[repoId]/schedule-choice`.

- [ ] **Step 4: Manually verify end to end**

This exercises real AI generation and needs `AI_GATEWAY_API_KEY` (or direct model provider credentials) set in `.env.local`.

1. Ensure a `Repo` exists (from Plan 2's manual verification) with at least one `pending` `ChangeItem`. If needed, insert one directly:
   ```bash
   docker exec product-announcer-postgres psql -U postgres -d product_announcer -c "select id, github_repo_full_name from repos;"
   ```
2. `npm run dev`. Sign in, then call the run-now route (there's no UI yet — Plan 4 builds it):
   ```bash
   curl -X POST http://localhost:3000/api/repos/<repo-id>/run-now -H "Cookie: <copy your session cookie from the browser dev tools after signing in>"
   ```
   Expected: `{"ok":true}`.
3. Check the result:
   ```bash
   docker exec product-announcer-postgres psql -U postgres -d product_announcer -c "select title, body, category, status from updates order by created_at desc limit 1;"
   ```
   Expected: a real, on-brand-voice draft title/body, `status = 'draft'`.
4. Call the schedule-choice route with `{"choice": "skip"}` and confirm `schedule_configs.next_scheduled_at` advanced by exactly one cadence interval from its prior value (not from "now").

- [ ] **Step 5: Commit**

```bash
git add src/app/api/repos
git commit -m "$(cat <<'EOF'
Add manual run-now and post-run schedule keep/skip routes
EOF
)"
```

---

## What's next

This plan ends with: a working, fully automated (and manually-triggerable) pipeline from pending `ChangeItem`s to AI-drafted `Update`s in the tenant's brand voice. Plan 4 (Dashboard) builds the UI on top of all of this — onboarding, the Pending view (next run, drop items, Run now), the Drafts queue (edit, preview, approve), History, and Settings.
