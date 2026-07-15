# Workspace-Level Batching + Unified Pending + Searchable Branch Picker (Phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move batching and scheduling from per-repo to **per-workspace** — all pending `ChangeItem`s across a tenant's repos batch into one cross-repo draft on one workspace schedule — rebuild the Pending page as a single unified list, and replace the free-text branch input with a shadcn **Combobox** populated from the repo's real branches.

**Architecture:** The tenant becomes the batching unit. `updates.repoId` becomes nullable (a draft spans repos; sources are recoverable via `sourceItems → changeItems.repoId`). `scheduleConfigs` becomes one row per tenant. The batch collector, generation worker, and scheduler tick all key off `tenantId`. The Pending page lists every pending item across repos, labeled by source repo. The branch picker becomes a small Client Component (`RepoRow`) with a shadcn Combobox that writes the chosen branch into a hidden `repo-N-branch` input, so `parseRepoSelections` is unchanged; the add-repos action server-validates each branch against the repo's real branch list.

**Tech Stack:** Drizzle ORM + drizzle-kit, AI SDK `generateObject`, shadcn `command`/`popover` (Combobox), `octokit` (paginated `listBranches`), Vitest.

## Global Constraints

- **Builds on Phase 1** (`2026-07-15-06-shadcn-adoption.md`) — shadcn (the **Base UI flavor**: `@base-ui/react` + `cmdk`) is installed and every page is on shadcn components. Base UI has **no `asChild`** — use the **`render` prop** (e.g. `<PopoverTrigger render={<Button … />}>children</PopoverTrigger>`, `<Button render={<Link href="/x" />}>Label</Button>`). Base UI `Select` submits via `name`. These forms are verified to compile; transcribe them as written.
- **One draft per batch, spanning all repos.** A scheduled or manual run produces exactly one `Update` per batch; `updates.repoId` is left `null`.
- **Transactional claim unchanged in spirit:** items move `pending → batched` only inside the transaction that creates their `Update`; only items still pending at claim time are included; `sourceItems` = the ids actually claimed.
- **One `scheduleConfig` per tenant** (`tenantId` unique). Threshold counts **total** pending across the workspace. `nextScheduledAt` advances only on a successful cadence fire, from its current value (unchanged rule).
- **Delivery/failure rules unchanged:** double-failed generation leaves items pending; no per-repo drafts anymore.
- **Branch picker keeps the `repo-N-*` form convention** — `parseRepoSelections` (indexed `repo-N-fullName` / `repo-N-selected` / `repo-N-branch`) is NOT changed; the Combobox feeds a hidden `repo-N-branch` input.
- **Tenant scoping** is re-derived from `requireSession()` on every page/action and every query/mutation is scoped to it.
- **Local dev DB:** Docker Postgres `product-announcer-postgres` on host port **5434**; `.env.local` `DATABASE_URL` → 5434. Must be running for tests/migrations.
- TypeScript strict; `tsc --noEmit`, `npm run build`, and the full `vitest` suite must be green after each task.

---

### Task 1: Schema — `updates.repoId` nullable, `scheduleConfigs` one-per-tenant

**Files:**
- Modify: `src/db/schema.ts`
- Test: `tests/db/scheduler-generation-schema.test.ts` (add a case)

**Interfaces:**
- Produces: `updates.repoId` now nullable; `scheduleConfigs` with a unique `tenantId` and no `repoId` column.

- [ ] **Step 1: Make `updates.repoId` nullable**

In `src/db/schema.ts`, change the `updates` table's `repoId` from:
```typescript
  repoId: uuid("repo_id")
    .notNull()
    .references(() => repos.id, { onDelete: "cascade" }),
```
to:
```typescript
  repoId: uuid("repo_id").references(() => repos.id, { onDelete: "cascade" }),
```

- [ ] **Step 2: Make `scheduleConfigs` one-per-tenant**

In `src/db/schema.ts`, replace the `scheduleConfigs` table with (drop `repoId`, add `.unique()` to `tenantId`):
```typescript
export const scheduleConfigs = pgTable("schedule_configs", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: uuid("tenant_id")
    .notNull()
    .unique()
    .references(() => tenants.id, { onDelete: "cascade" }),
  cadence: cadenceEnum("cadence").notNull().default("weekly"),
  threshold: integer("threshold"),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  nextScheduledAt: timestamp("next_scheduled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 3: Clear stale per-repo schedule rows (dev only), then generate + apply the migration**

Existing `schedule_configs` rows are per-repo (possibly several per tenant) and would violate the new unique constraint. Dev data is disposable — truncate first:
```bash
docker exec product-announcer-postgres psql -U postgres -d product_announcer -c "TRUNCATE schedule_configs;"
npm run db:generate
```
Open the generated `src/db/migrations/000X_*.sql` and confirm it is incremental: `ALTER TABLE "updates" ALTER COLUMN "repo_id" DROP NOT NULL;`, `ALTER TABLE "schedule_configs" DROP COLUMN "repo_id";`, and an `ADD CONSTRAINT ... UNIQUE("tenant_id")` on `schedule_configs`. It must NOT drop/recreate `updates` or any other table. Then:
```bash
npm run db:migrate
```
Expected: no errors.

- [ ] **Step 4: Extend the schema round-trip test**

In `tests/db/scheduler-generation-schema.test.ts`, add this test inside the existing `describe` block (it proves a null-repo update and a one-per-tenant schedule config both persist):
```typescript
  it("allows a cross-repo update (null repoId) and one schedule config per tenant", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "Scheduler Schema Test Tenant" }).returning();

    const [update] = await db
      .insert(updates)
      .values({ tenantId: tenant.id, title: "T", body: "B", category: "new", sourceItems: [] })
      .returning();
    expect(update.repoId).toBeNull();

    const [config] = await db
      .insert(scheduleConfigs)
      .values({ tenantId: tenant.id, cadence: "weekly" })
      .returning();
    expect(config.tenantId).toBe(tenant.id);
  });
```
Add `scheduleConfigs` to the file's imports from `../../src/db/schema` if not already present.

- [ ] **Step 5: Run the test**

```bash
npx vitest run tests/db/scheduler-generation-schema.test.ts
```
Expected: all tests in the file pass.

- [ ] **Step 6: Commit**

```bash
git add src/db tests/db
git commit -m "$(cat <<'EOF'
Make updates.repoId nullable and schedule_configs one-per-tenant

A draft can now span repos (repoId null; sources via sourceItems), and a
workspace has exactly one schedule config (tenantId unique, repoId
dropped). Dev schedule_configs truncated before the migration since the
old per-repo rows would violate the new unique constraint.
EOF
)"
```

---

### Task 2: Batch collector — tenant-level pending + claim

**Files:**
- Modify: `src/lib/change-item-batch.ts`
- Test: `tests/lib/change-item-batch.test.ts`

**Interfaces:**
- Produces: `getPendingChangeItems(tenantId, database?)` (all pending across the tenant's repos) and `claimBatchAndCreateUpdate({ tenantId, changeItemIds, draft }, database?)` (no `repoId`; creates an Update with `repoId` null).

- [ ] **Step 1: Update the tests to the tenant-level signatures**

Replace `tests/lib/change-item-batch.test.ts` with (seeds two repos under one tenant to prove cross-repo collection; drops `repoId` from the claim input):
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
    const [repoA] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/a", githubInstallationId: "1", watchedBranch: "main" })
      .returning();
    const [repoB] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/b", githubInstallationId: "1", watchedBranch: "main" })
      .returning();
    return { tenant, repoA, repoB };
  }

  it("getPendingChangeItems returns pending items across all of the tenant's repos", async () => {
    const { tenant, repoA, repoB } = await seed();
    await db.insert(changeItems).values([
      { tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "a" },
      { tenantId: tenant.id, repoId: repoB.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "b" },
      { tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "excluded", prNumber: 2, prTitle: "x" },
    ]);

    const pending = await getPendingChangeItems(tenant.id);
    expect(pending).toHaveLength(2);
    expect(pending.map((p) => p.prTitle).sort()).toEqual(["a", "b"]);
  });

  it("claimBatchAndCreateUpdate creates one cross-repo Update (repoId null) and marks items batched", async () => {
    const { tenant, repoA, repoB } = await seed();
    const inserted = await db
      .insert(changeItems)
      .values([
        { tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "a" },
        { tenantId: tenant.id, repoId: repoB.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "b" },
      ])
      .returning();

    const update = await claimBatchAndCreateUpdate({
      tenantId: tenant.id,
      changeItemIds: inserted.map((i) => i.id),
      draft: { title: "T", body: "B", category: "new" },
    });

    expect(update).not.toBeNull();
    expect(update!.repoId).toBeNull();
    expect(update!.sourceItems.sort()).toEqual(inserted.map((i) => i.id).sort());

    const reloaded = await db.select().from(changeItems).where(eq(changeItems.tenantId, tenant.id));
    expect(reloaded.every((r) => r.status === "batched" && r.updateId === update!.id)).toBe(true);
  });

  it("only claims items still pending (race simulation)", async () => {
    const { tenant, repoA } = await seed();
    const [stillPending, alreadyBatched] = await db
      .insert(changeItems)
      .values([
        { tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "a" },
        { tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "batched", prNumber: 2, prTitle: "b" },
      ])
      .returning();

    const update = await claimBatchAndCreateUpdate({
      tenantId: tenant.id,
      changeItemIds: [stillPending.id, alreadyBatched.id],
      draft: { title: "T", body: "B", category: "new" },
    });

    expect(update!.sourceItems).toEqual([stillPending.id]);
  });

  it("returns null and creates no Update when none of the ids are still pending", async () => {
    const { tenant, repoA } = await seed();
    const [item] = await db
      .insert(changeItems)
      .values({ tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "batched", prNumber: 1, prTitle: "a" })
      .returning();

    const update = await claimBatchAndCreateUpdate({
      tenantId: tenant.id,
      changeItemIds: [item.id],
      draft: { title: "T", body: "B", category: "new" },
    });

    expect(update).toBeNull();
    const allUpdates = await db.select().from(updates).where(eq(updates.tenantId, tenant.id));
    expect(allUpdates).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
npx vitest run tests/lib/change-item-batch.test.ts
```
Expected: FAIL (the current code still takes `repoId`).

- [ ] **Step 3: Implement the tenant-level batch collector**

Replace `src/lib/change-item-batch.ts`:
```typescript
import { and, eq, inArray } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { changeItems, updates } from "../db/schema";

type ChangeItemRow = typeof changeItems.$inferSelect;
type UpdateRow = typeof updates.$inferSelect;

export async function getPendingChangeItems(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<ChangeItemRow[]> {
  return database
    .select()
    .from(changeItems)
    .where(and(eq(changeItems.tenantId, tenantId), eq(changeItems.status, "pending")))
    .orderBy(changeItems.createdAt);
}

export type DraftInput = { title: string; body: string; category: "new" | "improved" | "fixed" };

export async function claimBatchAndCreateUpdate(
  input: { tenantId: string; changeItemIds: string[]; draft: DraftInput },
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

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
npx vitest run tests/lib/change-item-batch.test.ts
```
Expected: `Tests 4 passed (4)`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/change-item-batch.ts tests/lib/change-item-batch.test.ts
git commit -m "Collect pending change items by tenant; claim into one cross-repo Update"
```

---

### Task 3: Generation — tag each item with its source repo

**Files:**
- Modify: `src/lib/generation.ts`
- Test: `tests/lib/generation.test.ts`

**Interfaces:**
- Consumes: `getPendingChangeItems` rows (Task 2).
- Produces: `serializeBatchForPrompt(items, reposById, maxChars?)` and `generateUpdateDraft(items, brandProfile, reposById)`, where `reposById: Map<string, string>` maps `repoId → githubRepoFullName`.

- [ ] **Step 1: Update the generation tests**

Replace `tests/lib/generation.test.ts` with (the fake item now carries `repoId`; the batch is serialized with a repo-name map and the prompt must include the repo tag):
```typescript
import { describe, it, expect, vi } from "vitest";
import { serializeBatchForPrompt } from "../../src/lib/generation";

type FakeChangeItem = {
  id: string;
  repoId: string;
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
    repoId: "repo_web",
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
    repoId: "repo_api",
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

const REPOS = new Map([
  ["repo_web", "acme/web"],
  ["repo_api", "acme/api"],
]);

describe("serializeBatchForPrompt", () => {
  it("prefixes each item with its source repo", () => {
    const result = serializeBatchForPrompt([prItem(), commitItem()] as never, REPOS);

    expect(result).toContain('1. [acme/web · PR #1] "Add dark mode" — Adds a toggle.');
    expect(result).toContain('2. [acme/api · commit abcdef1] "fix export timeout" — diff --git a/x b/x\n+fix');
  });

  it("drops diffs starting with the largest when the batch exceeds maxChars, keeping every item", () => {
    const bigDiff = "x".repeat(1000);
    const smallDiff = "y".repeat(10);
    const items = [
      commitItem({ id: "big", repoId: "repo_api", commitSha: "1111111111111", commitMessage: "big change", diff: bigDiff }),
      commitItem({ id: "small", repoId: "repo_api", commitSha: "2222222222222", commitMessage: "small change", diff: smallDiff }),
    ];

    const result = serializeBatchForPrompt(items as never, REPOS, 120);

    expect(result).not.toContain(bigDiff);
    expect(result).toContain("big change");
    expect(result).toContain("small change");
  });
});

vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

import { generateObject } from "ai";
import { generateUpdateDraft } from "../../src/lib/generation";

describe("generateUpdateDraft", () => {
  it("passes the repo-tagged batch and brand profile into the prompt, and returns the object", async () => {
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

    const draft = await generateUpdateDraft(items, brandProfile, REPOS);

    expect(draft).toEqual({ title: "Faster search", body: "We rebuilt search.", category: "improved" });

    const callArgs = vi.mocked(generateObject).mock.calls[0][0];
    expect(callArgs.system).toContain("Industry: B2B SaaS.");
    expect(callArgs.prompt).toContain("acme/web");
    expect(callArgs.prompt).toContain("Add dark mode");
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
npx vitest run tests/lib/generation.test.ts
```
Expected: FAIL (current `serializeBatchForPrompt`/`generateUpdateDraft` don't take a repo map).

- [ ] **Step 3: Implement the repo-tagging**

In `src/lib/generation.ts`, replace `formatChangeItem`, `serializeBatchForPrompt`, and `generateUpdateDraft` with:
```typescript
function formatChangeItem(
  item: ChangeItemRow,
  index: number,
  includeDiff: boolean,
  reposById: Map<string, string>
): string {
  const repo = reposById.get(item.repoId) ?? "unknown";
  if (item.sourceType === "pr") {
    return `${index + 1}. [${repo} · PR #${item.prNumber}] "${item.prTitle}" — ${item.prDescription ?? ""}`;
  }
  const shortSha = item.commitSha?.slice(0, 7) ?? "unknown";
  const diffPart = includeDiff && item.diff ? ` — ${item.diff}` : "";
  return `${index + 1}. [${repo} · commit ${shortSha}] "${item.commitMessage}"${diffPart}`;
}

export function serializeBatchForPrompt(
  items: ChangeItemRow[],
  reposById: Map<string, string>,
  maxChars = DEFAULT_MAX_PROMPT_CHARS
): string {
  const includeDiffFlags = items.map(() => true);

  const render = () => items.map((item, i) => formatChangeItem(item, i, includeDiffFlags[i], reposById)).join("\n");

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

export async function generateUpdateDraft(
  items: ChangeItemRow[],
  brandProfile: BrandProfileRow,
  reposById: Map<string, string>
): Promise<UpdateDraft> {
  const batchText = serializeBatchForPrompt(items, reposById);

  const result = await generateObject({
    model: process.env.GENERATION_MODEL ?? "anthropic/claude-sonnet-4-5",
    schema: UpdateDraftSchema,
    system: buildSystemPrompt(brandProfile),
    prompt: `Here are the changes to summarize into one product update:\n\n${batchText}`,
  });

  return result.object;
}
```
(`buildSystemPrompt`, `UpdateDraftSchema`, the imports, and `DEFAULT_MAX_PROMPT_CHARS` are unchanged.)

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
npx vitest run tests/lib/generation.test.ts
```
Expected: `Tests 3 passed (3)`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/generation.ts tests/lib/generation.test.ts
git commit -m "Tag each change item with its source repo in the generation prompt"
```

---

### Task 4: Orchestration & scheduler — workspace-level

**Files:**
- Modify: `src/lib/run-schedule.ts`, `src/app/api/cron/scheduler/route.ts`
- Delete: `src/app/api/repos/[repoId]/run-now/route.ts`, `src/app/api/repos/[repoId]/schedule-choice/route.ts` (superseded by the dashboard's workspace-level Server Actions; nothing else consumes them)
- Test: `tests/lib/run-schedule.test.ts`

**Interfaces:**
- Consumes: `getPendingChangeItems(tenantId)`, `claimBatchAndCreateUpdate({tenantId,…})` (Task 2), `generateUpdateDraft(items, brandProfile, reposById)` (Task 3).
- Produces: `runBatchForWorkspace(tenantId, pending, database?): Promise<boolean>`, `runSchedulerTick(now, database?)` (iterates one config per tenant), `applyPostRunScheduleChoice(tenantId, choice, database?)`.

- [ ] **Step 1: Update the run-schedule tests**

Replace `tests/lib/run-schedule.test.ts` with:
```typescript
import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

import { generateObject } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, repos, changeItems, updates, scheduleConfigs } from "../../src/db/schema";
import { runBatchForWorkspace, runSchedulerTick, applyPostRunScheduleChoice } from "../../src/lib/run-schedule";
import { getPendingChangeItems } from "../../src/lib/change-item-batch";
import { advanceNextScheduledAt } from "../../src/lib/scheduler-decision";

const TENANT = "Run Batch Test Tenant";

describe("run-schedule (workspace-level)", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
    vi.mocked(generateObject).mockReset();
  });

  async function seed() {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [repoA] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/a", githubInstallationId: "1", watchedBranch: "main" })
      .returning();
    const [repoB] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/b", githubInstallationId: "1", watchedBranch: "main" })
      .returning();
    return { tenant, repoA, repoB };
  }

  it("runBatchForWorkspace makes one cross-repo Update from all pending and marks them batched", async () => {
    const { tenant, repoA, repoB } = await seed();
    await db.insert(changeItems).values([
      { tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "a" },
      { tenantId: tenant.id, repoId: repoB.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "b" },
    ]);
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "Combined", body: "Two repos.", category: "new" },
    } as never);

    const pending = await getPendingChangeItems(tenant.id);
    const created = await runBatchForWorkspace(tenant.id, pending);

    expect(created).toBe(true);
    const createdUpdates = await db.select().from(updates).where(eq(updates.tenantId, tenant.id));
    expect(createdUpdates).toHaveLength(1);
    expect(createdUpdates[0].repoId).toBeNull();
    expect(await getPendingChangeItems(tenant.id)).toHaveLength(0);
  });

  it("runBatchForWorkspace does nothing on empty pending", async () => {
    const { tenant } = await seed();
    const created = await runBatchForWorkspace(tenant.id, []);
    expect(created).toBe(false);
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("leaves items pending when generation fails twice", async () => {
    const { tenant, repoA } = await seed();
    await db.insert(changeItems).values({
      tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "flaky",
    });
    vi.mocked(generateObject).mockRejectedValue(new Error("model unavailable"));

    const pending = await getPendingChangeItems(tenant.id);
    const created = await runBatchForWorkspace(tenant.id, pending);

    expect(created).toBe(false);
    expect(generateObject).toHaveBeenCalledTimes(2);
    expect(await getPendingChangeItems(tenant.id)).toHaveLength(1);
  });

  it("runSchedulerTick fires the workspace config, creates one Update, advances nextScheduledAt on cadence", async () => {
    const { tenant, repoA } = await seed();
    await db.insert(changeItems).values({
      tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "a",
    });
    const past = new Date("2026-07-01T00:00:00Z");
    await db.insert(scheduleConfigs).values({ tenantId: tenant.id, cadence: "weekly", threshold: null, nextScheduledAt: past });
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "T", body: "B", category: "new" },
    } as never);

    await runSchedulerTick(new Date("2026-07-14T00:00:00Z"));

    expect(await db.select().from(updates).where(eq(updates.tenantId, tenant.id))).toHaveLength(1);
    const [config] = await db.select().from(scheduleConfigs).where(eq(scheduleConfigs.tenantId, tenant.id));
    expect(config.nextScheduledAt).toEqual(advanceNextScheduledAt(past, "weekly"));
  });

  it("runSchedulerTick does NOT advance nextScheduledAt on a threshold-reason fire", async () => {
    const { tenant, repoA } = await seed();
    await db.insert(changeItems).values({
      tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "a",
    });
    const future = new Date("2026-08-01T00:00:00Z");
    await db.insert(scheduleConfigs).values({ tenantId: tenant.id, cadence: "weekly", threshold: 1, nextScheduledAt: future });
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "T", body: "B", category: "new" },
    } as never);

    await runSchedulerTick(new Date("2026-07-14T00:00:00Z"));

    expect(await db.select().from(updates).where(eq(updates.tenantId, tenant.id))).toHaveLength(1);
    const [config] = await db.select().from(scheduleConfigs).where(eq(scheduleConfigs.tenantId, tenant.id));
    expect(config.nextScheduledAt).toEqual(future);
  });

  it("applyPostRunScheduleChoice('skip') advances the workspace schedule from its current value", async () => {
    const { tenant } = await seed();
    const anchor = new Date("2026-07-10T00:00:00Z");
    await db.insert(scheduleConfigs).values({ tenantId: tenant.id, cadence: "weekly", nextScheduledAt: anchor });

    await applyPostRunScheduleChoice(tenant.id, "skip");

    const [config] = await db.select().from(scheduleConfigs).where(eq(scheduleConfigs.tenantId, tenant.id));
    expect(config.nextScheduledAt).toEqual(advanceNextScheduledAt(anchor, "weekly"));
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
npx vitest run tests/lib/run-schedule.test.ts
```
Expected: FAIL (`runBatchForWorkspace` doesn't exist; signatures differ).

- [ ] **Step 3: Implement the workspace-level orchestration**

Replace `src/lib/run-schedule.ts`:
```typescript
import { eq } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { repos, scheduleConfigs } from "../db/schema";
import { getPendingChangeItems, claimBatchAndCreateUpdate } from "./change-item-batch";
import { generateUpdateDraft } from "./generation";
import { getOrCreateBrandProfile } from "./brand-profile";
import { shouldTriggerRun, advanceNextScheduledAt, type Cadence } from "./scheduler-decision";

type ChangeItemRow = Awaited<ReturnType<typeof getPendingChangeItems>>[number];

async function reposByIdForTenant(
  tenantId: string,
  database: typeof defaultDb
): Promise<Map<string, string>> {
  const rows = await database.select().from(repos).where(eq(repos.tenantId, tenantId));
  return new Map(rows.map((r) => [r.id, r.githubRepoFullName]));
}

export async function runBatchForWorkspace(
  tenantId: string,
  pending: ChangeItemRow[],
  database: typeof defaultDb = defaultDb
): Promise<boolean> {
  if (pending.length === 0) return false;

  const brandProfile = await getOrCreateBrandProfile(tenantId, database);
  const reposById = await reposByIdForTenant(tenantId, database);

  let draft;
  try {
    draft = await generateUpdateDraft(pending, brandProfile, reposById);
  } catch {
    try {
      draft = await generateUpdateDraft(pending, brandProfile, reposById);
    } catch {
      // Both attempts failed. Leave the batch's items pending — they roll into
      // the next scheduled/threshold/manual run automatically.
      return false;
    }
  }

  const update = await claimBatchAndCreateUpdate(
    { tenantId, changeItemIds: pending.map((p) => p.id), draft },
    database
  );

  return update !== null;
}

export async function runSchedulerTick(now: Date, database: typeof defaultDb = defaultDb): Promise<void> {
  const configs = await database.select().from(scheduleConfigs);

  for (const config of configs) {
    try {
      const pending = await getPendingChangeItems(config.tenantId, database);

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

      const created = await runBatchForWorkspace(config.tenantId, pending, database);

      const updateFields: Partial<typeof scheduleConfigs.$inferInsert> = { lastRunAt: now };
      if (created && reason === "cadence" && config.cadence !== "none" && config.nextScheduledAt) {
        updateFields.nextScheduledAt = advanceNextScheduledAt(
          config.nextScheduledAt,
          config.cadence as Exclude<Cadence, "none">
        );
      }
      await database.update(scheduleConfigs).set(updateFields).where(eq(scheduleConfigs.id, config.id));
    } catch (error) {
      // One tenant's failure must not starve the others in this tick.
      console.error(`Scheduler tick failed for tenant ${config.tenantId}:`, error);
    }
  }
}

export async function applyPostRunScheduleChoice(
  tenantId: string,
  choice: "keep" | "skip",
  database: typeof defaultDb = defaultDb
): Promise<void> {
  if (choice !== "skip") return;

  const [config] = await database.select().from(scheduleConfigs).where(eq(scheduleConfigs.tenantId, tenantId)).limit(1);
  if (config && config.cadence !== "none" && config.nextScheduledAt) {
    await database
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
```

- [ ] **Step 4: Delete the superseded per-repo API routes**

```bash
git rm "src/app/api/repos/[repoId]/run-now/route.ts" "src/app/api/repos/[repoId]/schedule-choice/route.ts"
```
(The dashboard drives run-now / keep-skip via `pending/actions.ts` — rewritten in Task 5 — so these session-gated API routes have no remaining consumer.)

- [ ] **Step 5: Confirm the cron route still compiles unchanged**

`src/app/api/cron/scheduler/route.ts` calls `runSchedulerTick(new Date())` and `retryFailedWebhookDeliveries()` — no signature change, so it needs no edit. (Leave it as-is.)

- [ ] **Step 6: Run the tests and confirm they pass**

```bash
npx vitest run tests/lib/run-schedule.test.ts
```
Expected: `Tests 6 passed (6)`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/run-schedule.ts tests/lib/run-schedule.test.ts "src/app/api/repos"
git commit -m "$(cat <<'EOF'
Move orchestration + scheduler to workspace level

runBatchForWorkspace batches all of a tenant's pending items into one
cross-repo draft; runSchedulerTick iterates one config per tenant;
applyPostRunScheduleChoice is tenant-scoped. Removes the now-unused
per-repo run-now / schedule-choice API routes (the dashboard uses
Server Actions).
EOF
)"
```

---

### Task 5: Unified Pending page + workspace-level actions

**Files:**
- Modify: `src/app/(dashboard)/pending/page.tsx`, `src/app/(dashboard)/pending/actions.ts`, `src/app/(dashboard)/pending/schedule-choice/page.tsx`

**Interfaces:**
- Consumes: `getPendingChangeItems(tenantId)`, `runBatchForWorkspace`, `applyPostRunScheduleChoice(tenantId, …)`.

- [ ] **Step 1: Rewrite the Pending actions (workspace-level)**

Replace `src/app/(dashboard)/pending/actions.ts`:
```typescript
"use server";

import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { changeItems, scheduleConfigs } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { getPendingChangeItems } from "@/lib/change-item-batch";
import { runBatchForWorkspace, applyPostRunScheduleChoice } from "@/lib/run-schedule";

export async function dropChangeItem(formData: FormData) {
  const session = await requireSession();
  const changeItemId = formData.get("changeItemId") as string;

  // Scope the mutation to the change item AND the caller's tenant so a caller
  // can only ever exclude their own rows.
  await db
    .update(changeItems)
    .set({ status: "excluded", excludedAt: new Date(), excludedBy: session.user.id })
    .where(and(eq(changeItems.id, changeItemId), eq(changeItems.tenantId, session.user.tenantId)));

  revalidatePath("/pending");
}

export async function runNow() {
  const session = await requireSession();

  const pending = await getPendingChangeItems(session.user.tenantId);
  if (pending.length === 0) {
    revalidatePath("/pending");
    return;
  }

  await runBatchForWorkspace(session.user.tenantId, pending);
  await db
    .update(scheduleConfigs)
    .set({ lastRunAt: new Date() })
    .where(eq(scheduleConfigs.tenantId, session.user.tenantId));

  redirect("/pending/schedule-choice");
}

export async function chooseSchedule(formData: FormData) {
  const session = await requireSession();
  const choice = formData.get("choice") as "keep" | "skip";

  await applyPostRunScheduleChoice(session.user.tenantId, choice);

  redirect("/pending");
}
```
Note: `dropChangeItem` no longer needs a `repoId` field, and `runNow`/`chooseSchedule` take no `repoId` — they act on the whole workspace.

- [ ] **Step 2: Rewrite the unified Pending page**

Replace `src/app/(dashboard)/pending/page.tsx` (one list across repos, each row labeled by source repo; workspace next-run + total pending vs threshold; single Run now):
```tsx
import { eq } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import { repos, scheduleConfigs } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { getPendingChangeItems } from "@/lib/change-item-batch";
import { dropChangeItem, runNow } from "./actions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

export default async function PendingPage() {
  const session = await requireSession();

  const tenantRepos = await db.select().from(repos).where(eq(repos.tenantId, session.user.tenantId));

  if (tenantRepos.length === 0) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold">No repos connected yet</h1>
        <p className="text-sm text-muted-foreground">
          Onboarding was skipped without connecting a repo. Add one from{" "}
          <Link href="/settings" className="font-medium underline">
            Settings
          </Link>{" "}
          to start collecting changes.
        </p>
      </div>
    );
  }

  const repoNameById = new Map(tenantRepos.map((r) => [r.id, r.githubRepoFullName]));
  const [config] = await db
    .select()
    .from(scheduleConfigs)
    .where(eq(scheduleConfigs.tenantId, session.user.tenantId));
  const pending = await getPendingChangeItems(session.user.tenantId);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Pending changes</h1>
        <p className="text-sm text-muted-foreground">
          Next scheduled update:{" "}
          {config?.nextScheduledAt ? config.nextScheduledAt.toLocaleString() : "not scheduled"}
          {" · "}
          {pending.length} pending{config?.threshold ? ` / ${config.threshold} threshold` : ""}
        </p>
      </div>

      <form action={runNow}>
        <Button type="submit" disabled={pending.length === 0}>
          Run now ({pending.length} pending)
        </Button>
      </form>

      <div className="space-y-2">
        {pending.map((item) => (
          <Card key={item.id}>
            <CardContent className="flex items-center justify-between gap-4 py-3">
              <div className="flex items-center gap-3">
                <Badge variant="outline">{repoNameById.get(item.repoId) ?? "unknown"}</Badge>
                <span>{item.sourceType === "pr" ? item.prTitle : item.commitMessage}</span>
              </div>
              <form action={dropChangeItem}>
                <input type="hidden" name="changeItemId" value={item.id} />
                <Button type="submit" variant="ghost" size="sm" className="text-muted-foreground">
                  Drop
                </Button>
              </form>
            </CardContent>
          </Card>
        ))}
        {pending.length === 0 && <p className="text-sm text-muted-foreground">Nothing pending.</p>}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Rewrite the schedule-choice page (no repoId)**

Replace `src/app/(dashboard)/pending/schedule-choice/page.tsx`:
```tsx
import { chooseSchedule } from "../actions";
import { Button } from "@/components/ui/button";

export default function ScheduleChoicePage() {
  return (
    <div className="max-w-md space-y-4">
      <h1 className="text-xl font-semibold">Update generated</h1>
      <p className="text-sm text-muted-foreground">
        Keep the next scheduled update as planned, or skip it since you just ran one manually?
      </p>
      <div className="flex gap-3">
        <form action={chooseSchedule}>
          <input type="hidden" name="choice" value="keep" />
          <Button type="submit" variant="outline">
            Keep next scheduled update
          </Button>
        </form>
        <form action={chooseSchedule}>
          <input type="hidden" name="choice" value="skip" />
          <Button type="submit" variant="outline">
            Skip it
          </Button>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Verify build + full suite**

```bash
npx tsc --noEmit && npm run build && npx vitest run
```
Expected: clean; `✓ Compiled successfully` (no more `/api/repos/...` routes; `/pending` + `/pending/schedule-choice` present); full suite green.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/pending"
git commit -m "$(cat <<'EOF'
Unify the Pending page across repos with a single workspace Run now

One list of all pending items labeled by source repo; workspace-level
next-run + total-pending-vs-threshold header; a single Run now that
batches the whole workspace, then the workspace keep/skip choice.
EOF
)"
```

---

### Task 6: `listRepoBranches` (paginated)

**Files:**
- Modify: `src/lib/github.ts`
- Test: `tests/lib/github.test.ts`

**Interfaces:**
- Produces: `listRepoBranches(installationId: string, repoFullName: string): Promise<string[]>` — every branch name for the repo (paginated).

- [ ] **Step 1: Add a pagination test**

Append to `tests/lib/github.test.ts` (mocks the installation Octokit's `paginate` to prove all pages are flattened to names):
```typescript
import { vi } from "vitest";
import { listRepoBranches, getGithubApp } from "../../src/lib/github";

describe("listRepoBranches", () => {
  it("returns every branch name via pagination", async () => {
    const fakeOctokit = {
      paginate: vi.fn().mockResolvedValue([{ name: "main" }, { name: "develop" }, { name: "release/1.0" }]),
      rest: { repos: { listBranches: "LIST_BRANCHES_ENDPOINT" } },
    };
    const spy = vi
      .spyOn(getGithubApp(), "getInstallationOctokit")
      .mockResolvedValue(fakeOctokit as never);

    const branches = await listRepoBranches("42", "acme/web");

    expect(branches).toEqual(["main", "develop", "release/1.0"]);
    expect(fakeOctokit.paginate).toHaveBeenCalledWith("LIST_BRANCHES_ENDPOINT", {
      owner: "acme",
      repo: "web",
      per_page: 100,
    });
    spy.mockRestore();
  });
});
```
(This mocks around the real GitHub call, so it needs no credentials.)

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run tests/lib/github.test.ts
```
Expected: FAIL — `listRepoBranches` is not exported.

- [ ] **Step 3: Implement `listRepoBranches`**

Add to `src/lib/github.ts` (after `listAccessibleRepos`):
```typescript
export async function listRepoBranches(installationId: string, repoFullName: string): Promise<string[]> {
  const [owner, repo] = repoFullName.split("/");
  const installationOctokit = await getGithubApp().getInstallationOctokit(Number(installationId));
  const branches = await installationOctokit.paginate(installationOctokit.rest.repos.listBranches, {
    owner,
    repo,
    per_page: 100,
  });
  return branches.map((b) => b.name);
}
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
npx vitest run tests/lib/github.test.ts
```
Expected: all tests in the file pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/github.ts tests/lib/github.test.ts
git commit -m "Add paginated listRepoBranches for the branch picker"
```

---

### Task 7: shadcn Combobox branch picker + single workspace schedule

**Files:**
- Create: `src/app/(dashboard)/settings/repo-row.tsx` (Client Component, shared by onboarding + settings)
- Modify: `src/app/onboarding/page.tsx`, `src/app/onboarding/actions.ts`, `src/app/(dashboard)/settings/page.tsx`, `src/app/(dashboard)/settings/actions.ts`

**Interfaces:**
- Consumes: `listRepoBranches` (Task 6), `parseRepoSelections` (unchanged), shadcn `Command`/`Popover`/`Button`.
- Produces: `RepoRow` — a client row rendering a checkbox (`repo-N-selected`), the repo name, a hidden `repo-N-fullName`, and a searchable branch Combobox that writes a hidden `repo-N-branch`.

- [ ] **Step 1: Build the `RepoRow` client component**

Create `src/app/(dashboard)/settings/repo-row.tsx`:
```tsx
"use client";

import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function RepoRow({
  index,
  fullName,
  branches,
  defaultBranch,
  defaultChecked,
}: {
  index: number;
  fullName: string;
  branches: string[];
  defaultBranch: string;
  defaultChecked: boolean;
}) {
  const [branch, setBranch] = useState(defaultBranch);
  const [open, setOpen] = useState(false);

  return (
    <div className="flex items-center gap-3">
      <input type="hidden" name={`repo-${index}-fullName`} value={fullName} />
      <input type="hidden" name={`repo-${index}-branch`} value={branch} />
      <label className="flex flex-1 items-center gap-2 text-sm">
        <input
          type="checkbox"
          name={`repo-${index}-selected`}
          defaultChecked={defaultChecked}
          className="size-4 rounded border-input"
        />
        {fullName}
      </label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<Button type="button" variant="outline" role="combobox" className="w-44 justify-between font-normal" />}>
          <span className="truncate">{branch || "Select branch"}</span>
          <ChevronsUpDown className="size-4 opacity-50" />
        </PopoverTrigger>
        <PopoverContent className="w-56 p-0">
          <Command>
            <CommandInput placeholder="Search branches…" />
            <CommandList>
              <CommandEmpty>No branch found.</CommandEmpty>
              <CommandGroup>
                {branches.map((b) => (
                  <CommandItem
                    key={b}
                    value={b}
                    onSelect={(value) => {
                      setBranch(value);
                      setOpen(false);
                    }}
                  >
                    <Check className={cn("mr-2 size-4", branch === b ? "opacity-100" : "opacity-0")} />
                    {b}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
```
The hidden `repo-${index}-branch` mirrors the selected branch, so `parseRepoSelections` reads it exactly as before.

- [ ] **Step 2: Server-validate branches in the add-repos actions**

Add a shared validation helper to `src/app/onboarding/actions.ts` and use it. Replace `addOnboardingRepos` in `src/app/onboarding/actions.ts` with (drops selections whose branch isn't a real branch of the repo), and add the `listRepoBranches` import:
```typescript
import { listRepoBranches } from "@/lib/github";
```
```typescript
export async function addOnboardingRepos(formData: FormData) {
  const session = await requireSession();
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, session.user.tenantId)).limit(1);
  if (!tenant?.githubInstallationId) {
    throw new Error("GitHub is not connected for this tenant yet");
  }

  const selections = parseRepoSelections(formData);
  const validated: typeof selections = [];
  for (const selection of selections) {
    const branches = await listRepoBranches(tenant.githubInstallationId, selection.fullName);
    if (branches.includes(selection.branch)) validated.push(selection);
  }
  if (validated.length > 0) {
    await addSelectedRepos(session.user.tenantId, tenant.githubInstallationId, validated);
  }

  redirect("/onboarding");
}
```
Apply the identical validation to `addSettingsRepos` in `src/app/(dashboard)/settings/actions.ts` (add the `import { listRepoBranches } from "@/lib/github";` import and the same `validated` loop before `addSelectedRepos`; keep its two `revalidatePath` calls).

- [ ] **Step 3: Collapse onboarding + settings to a single workspace schedule**

In `src/app/onboarding/actions.ts`, replace `saveOnboardingSchedule` (write ONE workspace config instead of one per repo):
```typescript
export async function saveOnboardingSchedule(formData: FormData) {
  const session = await requireSession();
  const cadence = formData.get("cadence") as Cadence;
  const thresholdRaw = formData.get("threshold");
  const threshold = thresholdRaw ? Number(thresholdRaw) : null;
  const nextScheduledAt = cadence === "none" ? null : advanceNextScheduledAt(new Date(), cadence);

  await db
    .insert(scheduleConfigs)
    .values({ tenantId: session.user.tenantId, cadence, threshold, nextScheduledAt })
    .onConflictDoUpdate({
      target: scheduleConfigs.tenantId,
      set: { cadence, threshold, nextScheduledAt },
    });

  await markOnboardingComplete(session.user.tenantId);
  redirect("/pending");
}
```
(The `repos` import in this file is now unused by this function; leave other functions untouched. If `repos` becomes entirely unused in the file, remove it from the import to keep `tsc` clean.)

In `src/app/(dashboard)/settings/actions.ts`, replace `saveRepoSchedule` with a workspace-level `saveWorkspaceSchedule` (upsert the one config; reset the anchor only when cadence changed):
```typescript
export async function saveWorkspaceSchedule(formData: FormData) {
  const session = await requireSession();
  const cadence = formData.get("cadence") as Cadence;
  const thresholdRaw = formData.get("threshold");
  const threshold = thresholdRaw ? Number(thresholdRaw) : null;

  const [existing] = await db
    .select()
    .from(scheduleConfigs)
    .where(eq(scheduleConfigs.tenantId, session.user.tenantId))
    .limit(1);
  const freshAnchor = cadence === "none" ? null : advanceNextScheduledAt(new Date(), cadence);

  if (existing) {
    await db
      .update(scheduleConfigs)
      .set({
        cadence,
        threshold,
        nextScheduledAt: cadence === existing.cadence ? existing.nextScheduledAt : freshAnchor,
      })
      .where(eq(scheduleConfigs.id, existing.id));
  } else {
    await db
      .insert(scheduleConfigs)
      .values({ tenantId: session.user.tenantId, cadence, threshold, nextScheduledAt: freshAnchor });
  }

  revalidatePath("/settings");
  revalidatePath("/pending");
}
```
Remove the now-unused `repos` import from `settings/actions.ts` only if nothing else in the file uses it (`addSettingsRepos` does not; `saveRepoSchedule` is being replaced — check the final file and drop unused imports so `tsc` stays clean).

- [ ] **Step 4: Wire `RepoRow` and the single schedule into the onboarding page**

In `src/app/onboarding/page.tsx`: import `RepoRow` and `listRepoBranches`, fetch branches per accessible repo, render `RepoRow` in the repo-picker form, and replace the per-repo schedule section with one workspace schedule form. Change the accessible-repos block to also load branches:
```tsx
import { getGithubApp, listAccessibleRepos, listRepoBranches } from "@/lib/github";
import { RepoRow } from "@/app/(dashboard)/settings/repo-row";
```
```tsx
  const accessibleRepos = tenant?.githubInstallationId ? await listAccessibleRepos(tenant.githubInstallationId) : [];
  const branchesByFullName = new Map<string, string[]>();
  if (tenant?.githubInstallationId) {
    for (const r of accessibleRepos) {
      branchesByFullName.set(r.fullName, await listRepoBranches(tenant.githubInstallationId, r.fullName));
    }
  }
```
Replace the repo checkbox+input rows inside the `addOnboardingRepos` form with:
```tsx
              {accessibleRepos.map((repo, i) => (
                <RepoRow
                  key={repo.fullName}
                  index={i}
                  fullName={repo.fullName}
                  branches={branchesByFullName.get(repo.fullName) ?? []}
                  defaultBranch={repo.defaultBranch}
                  defaultChecked={watchedFullNames.has(repo.fullName)}
                />
              ))}
```
Replace the schedule section's `<form action={saveOnboardingSchedule}>` heading/wrapping so it renders once (it already posts to the workspace-level `saveOnboardingSchedule`; only the copy "Set your workspace schedule" changes — the cadence Select + threshold Input from Phase 1 stay).

- [ ] **Step 5: Wire `RepoRow` and the single schedule into Settings**

In `src/app/(dashboard)/settings/page.tsx`: import `RepoRow`, `listRepoBranches`, and `saveWorkspaceSchedule` (replacing `saveRepoSchedule`); fetch branches per accessible repo; render `RepoRow` in the repo form; replace the "Schedule per repo" section with one "Workspace schedule" form.
```tsx
import { getGithubApp, listAccessibleRepos, listRepoBranches } from "@/lib/github";
import { saveWorkspaceName, saveBrandProfile, saveWorkspaceSchedule, addSettingsRepos } from "./actions";
import { RepoRow } from "./repo-row";
```
Load the one workspace config and branches:
```tsx
  const [workspaceSchedule] = await db
    .select()
    .from(scheduleConfigs)
    .where(eq(scheduleConfigs.tenantId, session.user.tenantId));
  const branchesByFullName = new Map<string, string[]>();
  if (tenant?.githubInstallationId) {
    for (const r of accessibleRepos) {
      branchesByFullName.set(r.fullName, await listRepoBranches(tenant.githubInstallationId, r.fullName));
    }
  }
```
Replace the repo checkbox+input rows in the `addSettingsRepos` form with `RepoRow` (same props as onboarding, using `watchedBranchByFullName.get(repo.fullName) ?? repo.defaultBranch` as `defaultBranch` and `watchedBranchByFullName.has(repo.fullName)` as `defaultChecked`). Replace the whole "Schedule per repo" `<Card>` with one workspace-schedule card:
```tsx
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Workspace schedule</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={saveWorkspaceSchedule} className="space-y-4">
            <div className="space-y-2">
              <Label>Cadence</Label>
              <Select name="cadence" defaultValue={workspaceSchedule?.cadence ?? "weekly"}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="biweekly">Every 2 weeks</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="none">No fixed cadence</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="threshold">Threshold</Label>
              <Input id="threshold" type="number" name="threshold" min={1} defaultValue={workspaceSchedule?.threshold ?? 5} />
            </div>
            <Button type="submit" variant="outline">
              Save
            </Button>
          </form>
        </CardContent>
      </Card>
```
Remove the now-unused `tenantSchedules` query and any leftover per-repo schedule mapping.

- [ ] **Step 6: Verify build + full suite**

```bash
npx tsc --noEmit && npm run build && npx vitest run
```
Expected: clean; `✓ Compiled successfully`; full suite green.

- [ ] **Step 7: Manual E2E (operator — needs GitHub App + AI key + tunnel)**

Connect two repos, accumulate pending items in both, confirm `/pending` shows one unified list with repo `Badge`s; the branch Combobox in Settings lists real branches and filters as you type; saving a branch persists it; Run now creates one cross-repo draft in Drafts; keep/skip adjusts the single workspace schedule.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(dashboard)/settings" "src/app/onboarding"
git commit -m "$(cat <<'EOF'
Add shadcn Combobox branch picker and a single workspace schedule

Branch selection is a searchable shadcn Combobox fed by listRepoBranches,
writing a hidden repo-N-branch input (parseRepoSelections unchanged); the
add-repos actions server-validate each branch against the repo's real
branches. Onboarding and Settings now write one workspace schedule config
instead of one per repo.
EOF
)"
```

---

## What's next

This completes the two enhancement phases: the whole app is on shadcn/ui (Phase 1), and batching/scheduling are workspace-level with a unified Pending list and a searchable, validated branch picker (Phase 2). No further plans are queued; future work (brand accent/identity, dark mode, real integrations) remains deferred per the design spec's Non-goals.
