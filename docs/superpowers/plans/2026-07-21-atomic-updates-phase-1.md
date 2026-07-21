# Atomic Updates — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce the atomic-update layer — a three-tier ingestion pipeline that clusters commits and PRs into atomic updates instead of treating each one as an independent change item.

**Architecture:** Raw source signals land in `change_events` (renamed from `change_items`). A deterministic filter drops obvious noise with no model call, a Haiku classifier decides `userFacing`, and a batched Sonnet resolver assigns each surviving event to an open `atomic_update` or creates a new one. Resolution is serialized per tenant by a Postgres advisory lock.

**Tech Stack:** Next.js 16 (App Router), Drizzle ORM + Postgres, Vercel AI SDK v7 (`generateObject`) with `@ai-sdk/anthropic`, Vitest.

## Global Constraints

- **The database has no production data.** Existing rows are disposable. Schema changes drop and recreate rather than backfill, and required columns are `NOT NULL` rather than nullable-with-fallback.
- **Rename `change_items` → `change_events` and drop `sourceType` in favor of `type`.** Both are done in Task 1 and every consumer is updated in the same task.
- **Do NOT rename `updates` → `releases` in this phase.** That rename drags in `dispatch.ts`, `delivery_attempts`, Webflow publishing, and the drafts UI — none of which phase 1 touches. It belongs to phase 2.
- **No historical backfill.** Never run the resolver over pre-existing rows.
- **Model resolution goes through `src/lib/ai/model.ts`** (`resolveModel` / `modelId`). Never construct a provider client directly.
- **Every LLM call records usage** via `recordLlmUsage` from `src/lib/ai/llm-usage.ts`.
- **New model env vars:** `RESOLVER_MODEL` (default `anthropic/claude-sonnet-4-5`), `SUMMARY_MODEL` (default `anthropic/claude-haiku-4-5`).
- **Resolver batch cap:** 25 events per LLM call; chunk sequentially beyond that.
- **This version of Next.js differs from training data.** Per `AGENTS.md`, read `node_modules/next/dist/docs/` before writing any App Router code (Task 8 only).
- DB tests run against the separate test database — run `npm run db:migrate:test` after any migration before running them.

---

### Task 1: Schema — rename to `change_events`, add `atomic_updates`

**Files:**
- Modify: `src/db/schema.ts`
- Delete: `src/db/migrations/` contents (see Step 3)
- Create: `src/db/migrations/0000_init.sql` (regenerated)
- Test: `tests/db/atomic-updates-schema.test.ts`
- Test: `tests/db/repo-and-change-item.test.ts` (existing — update)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `atomicUpdates` table export
  - `changeEvents` table export (replaces `changeItems`), with `type`, `provider`, `externalId` all `NOT NULL`, plus `externalUrl`, `atomicUpdateId`, `filterReason`
  - Enums `changeEventTypeEnum`, `changeEventProviderEnum`, `atomicUpdateStatusEnum`, `filterReasonEnum`
  - `sourceTypeEnum` and `changeItems` are **removed**

**Context:** `externalId` is the cross-provider idempotency key. Commit SHAs are globally unique, but PR numbers collide across repos, so PR ids are namespaced by repo full name: `acme/widgets#42`. The unique index is `(tenantId, provider, externalId)`.

Because the database has no data worth keeping, this task squashes the migration history rather than adding migration 0023 on top of a table that is about to be renamed. `type`, `provider`, and `externalId` are `NOT NULL` — there are no legacy rows to accommodate, and making them required removes a `?? "commit"` fallback from every consumer.

- [ ] **Step 1: Write the failing schema test**

Create `tests/db/atomic-updates-schema.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, repos, changeEvents, atomicUpdates } from "../../src/db/schema";

const TENANT = "Atomic Updates Schema Test Tenant";

describe("atomic_updates schema", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("links change events to an atomic update and defaults status to open", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [repo] = await db
      .insert(repos)
      .values({
        tenantId: tenant.id,
        githubRepoFullName: "acme/widgets",
        githubInstallationId: "1",
        watchedBranch: "main",
      })
      .returning();

    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "CSV export", summary: "Export reports as CSV." })
      .returning();

    expect(atomic.status).toBe("open");
    expect(atomic.releaseId).toBeNull();
    expect(atomic.summaryEditedAt).toBeNull();

    const [event] = await db
      .insert(changeEvents)
      .values({
        tenantId: tenant.id,
        repoId: repo.id,
        type: "commit",
        provider: "github",
        externalId: "abc123",
        commitSha: "abc123",
        atomicUpdateId: atomic.id,
      })
      .returning();

    expect(event.atomicUpdateId).toBe(atomic.id);
    expect(event.provider).toBe("github");
  });

  it("rejects a duplicate (tenant, provider, externalId)", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [repo] = await db
      .insert(repos)
      .values({
        tenantId: tenant.id,
        githubRepoFullName: "acme/widgets",
        githubInstallationId: "1",
        watchedBranch: "main",
      })
      .returning();

    const values = {
      tenantId: tenant.id,
      repoId: repo.id,
      type: "commit" as const,
      provider: "github" as const,
      externalId: "dup-sha",
      commitSha: "dup-sha",
    };

    await db.insert(changeEvents).values(values);
    await expect(db.insert(changeEvents).values(values)).rejects.toThrow();
  });

  it("requires type, provider and externalId", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [repo] = await db
      .insert(repos)
      .values({
        tenantId: tenant.id,
        githubRepoFullName: "acme/widgets",
        githubInstallationId: "1",
        watchedBranch: "main",
      })
      .returning();

    // @ts-expect-error omitting required columns must not typecheck
    await expect(db.insert(changeEvents).values({ tenantId: tenant.id, repoId: repo.id })).rejects.toThrow();
  });

  it("nulls atomic_update_id when the atomic update is deleted", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [repo] = await db
      .insert(repos)
      .values({
        tenantId: tenant.id,
        githubRepoFullName: "acme/widgets",
        githubInstallationId: "1",
        watchedBranch: "main",
      })
      .returning();
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "T", summary: "S" })
      .returning();
    const [event] = await db
      .insert(changeEvents)
      .values({
        tenantId: tenant.id,
        repoId: repo.id,
        type: "commit",
        provider: "github",
        externalId: "orphan-sha",
        commitSha: "orphan-sha",
        atomicUpdateId: atomic.id,
      })
      .returning();

    await db.delete(atomicUpdates).where(eq(atomicUpdates.id, atomic.id));

    const [found] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    expect(found.atomicUpdateId).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/db/atomic-updates-schema.test.ts`
Expected: FAIL — `atomicUpdates` and `changeEvents` are not exported from `src/db/schema.ts`.

- [ ] **Step 3: Add the enums and table to the schema**

In `src/db/schema.ts`, **delete** the `sourceTypeEnum` declaration (line 47) and
add after the remaining enum block:

```ts
export const changeEventTypeEnum = pgEnum("change_event_type", ["commit", "pull_request", "task"]);
export const changeEventProviderEnum = pgEnum("change_event_provider", ["github", "notion"]);
export const atomicUpdateStatusEnum = pgEnum("atomic_update_status", ["open", "released"]);
// Why tier 1 dropped an event. Null means it was not dropped deterministically.
export const filterReasonEnum = pgEnum("filter_reason", [
  "merge_commit",
  "empty_diff",
  "lockfile_only",
  "test_only",
  "chore_prefix",
  "empty_task",
]);
```

Add the `atomicUpdates` table immediately after the change-events table:

```ts
export const atomicUpdates = pgTable("atomic_updates", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  // Set when this atomic update joins a release draft. At most one release ever,
  // so "which release is this shipping in" always has a single answer.
  releaseId: uuid("release_id").references(() => updates.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  category: updateCategoryEnum("category"),
  status: atomicUpdateStatusEnum("status").notNull().default("open"),
  // Non-null freezes regeneration: once a human edits the summary, attaching a
  // new change event must not overwrite their words.
  summaryEditedAt: timestamp("summary_edited_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Now rename the `changeItems` table. Replace the entire `changeItems` declaration
(lines 67–113) with:

```ts
export const changeEvents = pgTable(
  "change_events",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    type: changeEventTypeEnum("type").notNull(),
    provider: changeEventProviderEnum("provider").notNull(),
    // Idempotency key, namespaced per provider. Commits use the SHA; PRs use
    // `owner/repo#number` because PR numbers collide across repos.
    externalId: text("external_id").notNull(),
    externalUrl: text("external_url"),
    atomicUpdateId: uuid("atomic_update_id").references(() => atomicUpdates.id, { onDelete: "set null" }),
    status: changeItemStatusEnum("status").notNull().default("pending"),
    // Why tier 1 dropped this event. Null means it survived the filter.
    filterReason: filterReasonEnum("filter_reason"),
    updateId: uuid("update_id").references(() => updates.id),
    excludedAt: timestamp("excluded_at", { withTimezone: true }),
    excludedBy: uuid("excluded_by").references(() => users.id),
    // pr-sourced fields
    prNumber: integer("pr_number"),
    prTitle: text("pr_title"),
    prDescription: text("pr_description"),
    prUrl: text("pr_url"),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    // commit-sourced fields
    commitSha: text("commit_sha"),
    commitMessage: text("commit_message"),
    diff: text("diff"),
    commitUrl: text("commit_url"),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    // When the commit reached the watched branch, as distinct from when it was
    // authored (`committedAt`) — a commit can be written days before it lands.
    // Only the push webhook knows this: GitHub's list-commits API carries no
    // branch-landing time, so backfilled/imported commits leave it null rather
    // than pretending the author date is a release.
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // tier 2 classifier output, null until classified
    userFacing: boolean("user_facing"),
    impactSummary: text("impact_summary"),
    suggestedCategory: updateCategoryEnum("suggested_category"),
    enrichmentConfidence: real("enrichment_confidence"),
    enrichedAt: timestamp("enriched_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("change_events_repo_pr_unique").on(table.repoId, table.prNumber),
    uniqueIndex("change_events_repo_commit_unique").on(table.repoId, table.commitSha),
    uniqueIndex("change_events_tenant_provider_external_unique").on(
      table.tenantId,
      table.provider,
      table.externalId
    ),
  ]
);
```

Note what changed from the old `changeItems`: `sourceType` and `ignoredReason`
are gone (replaced by `type` and `filterReason`), and the three new columns are
`NOT NULL`. Everything else carries over unchanged.

Also delete the now-unused `ignoredReasonEnum` (line 49).

**Note:** `changeEvents` references `atomicUpdates` and `updates`, both declared later in the file. Drizzle's `() =>` thunks make forward references safe — do not reorder the file.

- [ ] **Step 4: Squash the migration history and reset both databases**

There is no data to preserve, so regenerate from scratch rather than stacking a
rename onto 23 migrations describing a table that no longer exists.

```bash
rm -rf src/db/migrations
psql "$DATABASE_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
psql "$TEST_DATABASE_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
npm run db:generate
```

`TEST_DATABASE_URL` is whatever `drizzle.config.test.ts` reads — check that file
for the exact env var name before running the second `psql`.

**This is destructive and intentional.** If either database turns out to hold
data you care about, stop and say so rather than proceeding.

Expected: a single `src/db/migrations/0000_*.sql` describing the whole schema.

- [ ] **Step 5: Apply to both databases**

Run: `npm run db:migrate && npm run db:migrate:test`
Expected: both report migration 0000 applied.

- [ ] **Step 6: Re-seed the system catalogs**

`system_personas` and `system_update_examples` are seeded, not user data, and the
schema drop removed them. Find the seed script with
`grep -rn "systemPersonas" src/ scripts/ --include=*.ts -l` and re-run it.

Verify: `psql "$DATABASE_URL" -c "SELECT count(*) FROM system_personas;"` returns
a non-zero count. Generation quality depends on these rows.

- [ ] **Step 7: Update the existing change-item schema test**

`tests/db/repo-and-change-item.test.ts` imports `changeItems` and sets
`sourceType`. Update it: rename the import to `changeEvents`, replace
`sourceType: "pr"` with `type: "pull_request"`, and add
`provider: "github", externalId: "acme/widgets#42"` to the insert.

- [ ] **Step 8: Run both schema tests**

Run: `npx vitest run tests/db/`
Expected: PASS, including the 4 new tests.

- [ ] **Step 9: Update every remaining `changeItems` reference**

Run: `grep -rln "changeItems\|sourceType" src/ tests/`

For each file, rename the import and usages to `changeEvents`, and replace
`sourceType` with `type` — mapping the value `"pr"` to `"pull_request"` and
`"commit"` to `"commit"`. Tasks 5–8 assume this rename is already done.

In `src/lib/ai/enrich-change-item.ts`, change `EnrichmentInput.sourceType` from
`"pr" | "commit"` to `type: "pull_request" | "commit"` and update the ternary in
`buildEnrichmentPrompt` plus its tests — leaving `"pr"` in one module while the
database says `"pull_request"` is exactly the inconsistency this task exists to
remove.

- [ ] **Step 10: Verify nothing else broke**

Run: `npm run typecheck && npm run lint && npx vitest run`
Expected: typecheck clean, full suite green. Any remaining reference to
`changeItems` or `sourceType` fails the typecheck — that is the intended safety
net for this rename.

- [ ] **Step 11: Commit**

```bash
git add -A src/db src/lib tests
git commit -m "feat: rename change_items to change_events and add atomic_updates"
```

---

### Task 2: Deterministic filter (tier 1)

**Files:**
- Create: `src/lib/change-events/filter.ts`
- Test: `tests/lib/change-events/filter.test.ts`

**Interfaces:**
- Consumes: `filterReasonEnum` values from Task 1
- Produces:
  - `filesInDiff(diff: string): string[]`
  - `type FilterVerdict = { drop: true; reason: FilterReason } | { drop: false }`
  - `type FilterReason = "merge_commit" | "empty_diff" | "lockfile_only" | "test_only" | "chore_prefix" | "empty_task"`
  - `filterCommit(input: { message: string; diff: string; parentCount: number }): FilterVerdict`
  - `filterPullRequest(input: { title: string }): FilterVerdict`
  - `filterTask(input: { title: string; description: string | null }): FilterVerdict`

**Context:** Pure functions, no I/O, no model call. This is the cheapest tier and runs before anything else. Rules are per source type but share one return shape.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/change-events/filter.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { filesInDiff, filterCommit, filterPullRequest, filterTask } from "../../../src/lib/change-events/filter";

const diffFor = (...files: string[]) =>
  files.map((f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n+x\n`).join("");

describe("filesInDiff", () => {
  it("extracts paths from diff headers", () => {
    expect(filesInDiff(diffFor("src/a.ts", "src/b.ts"))).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("returns an empty array for an empty diff", () => {
    expect(filesInDiff("")).toEqual([]);
  });
});

describe("filterCommit", () => {
  it("drops merge commits", () => {
    expect(filterCommit({ message: "Merge pull request #1", diff: diffFor("src/a.ts"), parentCount: 2 })).toEqual({
      drop: true,
      reason: "merge_commit",
    });
  });

  it("drops empty diffs", () => {
    expect(filterCommit({ message: "chore", diff: "   ", parentCount: 1 })).toEqual({
      drop: true,
      reason: "empty_diff",
    });
  });

  it("drops lockfile-only changes", () => {
    expect(filterCommit({ message: "bump deps", diff: diffFor("pnpm-lock.yaml"), parentCount: 1 })).toEqual({
      drop: true,
      reason: "lockfile_only",
    });
  });

  it("drops test-only changes", () => {
    const diff = diffFor("tests/lib/a.test.ts", "src/b.spec.ts");
    expect(filterCommit({ message: "add coverage", diff, parentCount: 1 })).toEqual({
      drop: true,
      reason: "test_only",
    });
  });

  it("keeps a commit touching both tests and source", () => {
    const diff = diffFor("tests/a.test.ts", "src/feature.ts");
    expect(filterCommit({ message: "add feature", diff, parentCount: 1 })).toEqual({ drop: false });
  });

  it("drops chore/docs/ci conventional prefixes", () => {
    for (const message of ["chore: tidy", "docs(readme): fix typo", "ci: bump runner"]) {
      expect(filterCommit({ message, diff: diffFor("src/a.ts"), parentCount: 1 })).toEqual({
        drop: true,
        reason: "chore_prefix",
      });
    }
  });

  it("keeps feat and fix prefixes", () => {
    expect(filterCommit({ message: "feat: add export", diff: diffFor("src/a.ts"), parentCount: 1 })).toEqual({
      drop: false,
    });
    expect(filterCommit({ message: "fix: timeout", diff: diffFor("src/a.ts"), parentCount: 1 })).toEqual({
      drop: false,
    });
  });

  it("does not treat a bare word starting with chore as a prefix", () => {
    expect(filterCommit({ message: "choreography tweaks", diff: diffFor("src/a.ts"), parentCount: 1 })).toEqual({
      drop: false,
    });
  });
});

describe("filterPullRequest", () => {
  it("drops chore-prefixed PR titles", () => {
    expect(filterPullRequest({ title: "chore: bump deps" })).toEqual({ drop: true, reason: "chore_prefix" });
  });

  it("keeps a normal PR title", () => {
    expect(filterPullRequest({ title: "Add CSV export" })).toEqual({ drop: false });
  });
});

describe("filterTask", () => {
  it("drops a task with an empty title", () => {
    expect(filterTask({ title: "  ", description: "something" })).toEqual({ drop: true, reason: "empty_task" });
  });

  it("drops a task with no description", () => {
    expect(filterTask({ title: "Ship export", description: null })).toEqual({ drop: true, reason: "empty_task" });
  });

  it("keeps a described task", () => {
    expect(filterTask({ title: "Ship export", description: "Adds CSV export." })).toEqual({ drop: false });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lib/change-events/filter.test.ts`
Expected: FAIL — cannot resolve `src/lib/change-events/filter`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/change-events/filter.ts`:

```ts
export type FilterReason =
  | "merge_commit"
  | "empty_diff"
  | "lockfile_only"
  | "test_only"
  | "chore_prefix"
  | "empty_task";

export type FilterVerdict = { drop: true; reason: FilterReason } | { drop: false };

const KEEP: FilterVerdict = { drop: false };

// Conventional-commit types that never produce user-facing news. The colon or
// scope-paren is required, so "choreography" is not a chore commit.
const NOISE_PREFIX = /^(chore|docs|ci|build|style|test|refactor)(\([^)]*\))?!?:/i;

const LOCKFILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
  "go.sum",
  "composer.lock",
]);

const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$/i;

/** Extracts changed file paths from a unified diff's `diff --git` headers. */
export function filesInDiff(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split("\n")) {
    const match = /^diff --git a\/(.+?) b\//.exec(line);
    if (match) files.push(match[1]);
  }
  return files;
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function filterCommit(input: { message: string; diff: string; parentCount: number }): FilterVerdict {
  if (input.parentCount >= 2) return { drop: true, reason: "merge_commit" };
  if (input.diff.trim() === "") return { drop: true, reason: "empty_diff" };
  if (NOISE_PREFIX.test(input.message.trim())) return { drop: true, reason: "chore_prefix" };

  const files = filesInDiff(input.diff);
  if (files.length > 0) {
    if (files.every((f) => LOCKFILES.has(basename(f)))) return { drop: true, reason: "lockfile_only" };
    if (files.every((f) => TEST_PATH.test(f))) return { drop: true, reason: "test_only" };
  }

  return KEEP;
}

export function filterPullRequest(input: { title: string }): FilterVerdict {
  if (NOISE_PREFIX.test(input.title.trim())) return { drop: true, reason: "chore_prefix" };
  return KEEP;
}

export function filterTask(input: { title: string; description: string | null }): FilterVerdict {
  if (input.title.trim() === "") return { drop: true, reason: "empty_task" };
  if ((input.description ?? "").trim() === "") return { drop: true, reason: "empty_task" };
  return KEEP;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/lib/change-events/filter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/change-events/filter.ts tests/lib/change-events/filter.test.ts
git commit -m "feat: add deterministic change event filter"
```

---

### Task 3: Resolver LLM call (tier 3)

**Files:**
- Create: `src/lib/ai/resolve-atomic-updates.ts`
- Test: `tests/lib/ai/resolve-atomic-updates.test.ts`

**Interfaces:**
- Consumes: `resolveModel`, `modelId` from `src/lib/ai/model.ts`; `recordLlmUsage` from `src/lib/ai/llm-usage.ts`
- Produces:
  - `type ResolverEvent = { id: string; type: "commit" | "pull_request" | "task"; title: string; summary: string | null; repoName: string | null }`
  - `type OpenAtomicUpdate = { id: string; title: string; summary: string }`
  - `type ResolutionAction = { eventId: string; action: "assign"; atomicUpdateId: string } | { eventId: string; action: "create"; title: string; summary: string; category: "new" | "improved" | "fixed" }`
  - `buildResolverPrompt(events: ResolverEvent[], open: OpenAtomicUpdate[]): string`
  - `resolveAtomicUpdates(input: { tenantId: string; events: ResolverEvent[]; open: OpenAtomicUpdate[] }): Promise<ResolutionAction[]>`
  - `const RESOLVER_BATCH_SIZE = 25`

**Context:** One call per arrival batch, not per event — commits in one push are the likeliest to belong together, and the model must see them together to group them. Unlike `enrichChangeItem`, this does NOT fail open: on error it returns `[]` and the caller leaves events unassigned, which is a recoverable state.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/ai/resolve-atomic-updates.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("../../../src/lib/ai/llm-usage", () => ({ recordLlmUsage: vi.fn() }));

import { generateObject } from "ai";
import { recordLlmUsage } from "../../../src/lib/ai/llm-usage";
import {
  buildResolverPrompt,
  resolveAtomicUpdates,
  RESOLVER_BATCH_SIZE,
} from "../../../src/lib/ai/resolve-atomic-updates";

const EVENTS = [
  { id: "e1", type: "commit" as const, title: "add csv export", summary: "Adds CSV export.", repoName: "acme/api" },
];
const OPEN = [{ id: "a1", title: "CSV export", summary: "Export reports as CSV." }];

describe("buildResolverPrompt", () => {
  it("includes every event and every open atomic update", () => {
    const prompt = buildResolverPrompt(EVENTS, OPEN);
    expect(prompt).toContain("e1");
    expect(prompt).toContain("add csv export");
    expect(prompt).toContain("a1");
    expect(prompt).toContain("CSV export");
  });

  it("states explicitly when there are no open atomic updates", () => {
    expect(buildResolverPrompt(EVENTS, [])).toContain("(none)");
  });
});

describe("resolveAtomicUpdates", () => {
  afterEach(() => {
    vi.mocked(generateObject).mockReset();
    vi.mocked(recordLlmUsage).mockReset();
  });

  it("returns the model's plan and records usage", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { actions: [{ eventId: "e1", action: "assign", atomicUpdateId: "a1" }] },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    } as never);

    const result = await resolveAtomicUpdates({ tenantId: "t1", events: EVENTS, open: OPEN });

    expect(result).toEqual([{ eventId: "e1", action: "assign", atomicUpdateId: "a1" }]);
    expect(recordLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "t1", operation: "resolution" })
    );
  });

  it("drops an assign action pointing at an unknown atomic update", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { actions: [{ eventId: "e1", action: "assign", atomicUpdateId: "hallucinated" }] },
      usage: {},
    } as never);

    expect(await resolveAtomicUpdates({ tenantId: "t1", events: EVENTS, open: OPEN })).toEqual([]);
  });

  it("drops an action for an event that was not in the batch", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { actions: [{ eventId: "not-sent", action: "assign", atomicUpdateId: "a1" }] },
      usage: {},
    } as never);

    expect(await resolveAtomicUpdates({ tenantId: "t1", events: EVENTS, open: OPEN })).toEqual([]);
  });

  it("returns an empty plan on model error rather than throwing", async () => {
    vi.mocked(generateObject).mockRejectedValue(new Error("boom"));
    expect(await resolveAtomicUpdates({ tenantId: "t1", events: EVENTS, open: OPEN })).toEqual([]);
  });

  it("returns an empty plan without calling the model when there are no events", async () => {
    expect(await resolveAtomicUpdates({ tenantId: "t1", events: [], open: OPEN })).toEqual([]);
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("caps the batch size at 25", () => {
    expect(RESOLVER_BATCH_SIZE).toBe(25);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lib/ai/resolve-atomic-updates.test.ts`
Expected: FAIL — cannot resolve `src/lib/ai/resolve-atomic-updates`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/ai/resolve-atomic-updates.ts`:

```ts
import { generateObject } from "ai";
import { z } from "zod";
import { resolveModel, modelId } from "./model";
import { recordLlmUsage } from "./llm-usage";

export const RESOLVER_BATCH_SIZE = 25;

export type ResolverEvent = {
  id: string;
  type: "commit" | "pull_request" | "task";
  title: string;
  summary: string | null;
  repoName: string | null;
};

export type OpenAtomicUpdate = { id: string; title: string; summary: string };

export type ResolutionAction =
  | { eventId: string; action: "assign"; atomicUpdateId: string }
  | {
      eventId: string;
      action: "create";
      title: string;
      summary: string;
      category: "new" | "improved" | "fixed";
    };

const ActionSchema = z.discriminatedUnion("action", [
  z.object({ eventId: z.string(), action: z.literal("assign"), atomicUpdateId: z.string() }),
  z.object({
    eventId: z.string(),
    action: z.literal("create"),
    title: z.string(),
    summary: z.string(),
    category: z.enum(["new", "improved", "fixed"]),
  }),
]);

export const ResolutionSchema = z.object({ actions: z.array(ActionSchema) });

const RESOLVER_SYSTEM = [
  "You group code changes into atomic updates for a user-facing product changelog.",
  "An atomic update is ONE meaningful change a user would care about — a feature, or a fix.",
  "Several commits, a pull request, and a task can all describe the same atomic update.",
  "For each event, either assign it to an existing open atomic update if it describes the same change,",
  "or create a new atomic update if it does not.",
  "Prefer assigning over creating: a follow-up fix to work already in progress belongs to that atomic update.",
  "Several events in this batch may describe the same new change. In that case give every one of them",
  "a create action carrying the SAME title and summary — they will be merged into a single atomic update.",
  "Return exactly one action per event. Use only atomicUpdateId values from the provided list.",
  "Write title as a short noun phrase and summary as one plain sentence describing the user-visible benefit.",
].join(" ");

export function buildResolverPrompt(events: ResolverEvent[], open: OpenAtomicUpdate[]): string {
  const openBlock =
    open.length === 0
      ? "(none)"
      : open.map((a) => `- id: ${a.id}\n  title: ${a.title}\n  summary: ${a.summary}`).join("\n");

  const eventBlock = events
    .map((e) => {
      const where = e.repoName ? ` in ${e.repoName}` : "";
      const summary = e.summary ? `\n  summary: ${e.summary}` : "";
      return `- id: ${e.id}\n  type: ${e.type}${where ? `\n  repo:${where}` : ""}\n  title: ${e.title}${summary}`;
    })
    .join("\n");

  return `Open atomic updates:\n${openBlock}\n\nNew events to resolve:\n${eventBlock}`;
}

export async function resolveAtomicUpdates(input: {
  tenantId: string;
  events: ResolverEvent[];
  open: OpenAtomicUpdate[];
}): Promise<ResolutionAction[]> {
  if (input.events.length === 0) return [];

  try {
    const spec = process.env.RESOLVER_MODEL ?? "anthropic/claude-sonnet-4-5";
    const { object, usage } = await generateObject({
      model: resolveModel(spec),
      schema: ResolutionSchema,
      system: RESOLVER_SYSTEM,
      prompt: buildResolverPrompt(input.events, input.open),
    });

    await recordLlmUsage({
      tenantId: input.tenantId,
      operation: "resolution",
      model: modelId(spec),
      usage,
    });

    const eventIds = new Set(input.events.map((e) => e.id));
    const openIds = new Set(input.open.map((a) => a.id));

    // Guard against hallucinated ids: an action naming an event we did not send,
    // or an atomic update that does not exist, would corrupt the apply step.
    return object.actions.filter((a) => {
      if (!eventIds.has(a.eventId)) return false;
      if (a.action === "assign") return openIds.has(a.atomicUpdateId);
      return true;
    });
  } catch (error) {
    // Do NOT fail open. An empty plan leaves the events unassigned, which is a
    // visible, recoverable state; a fabricated plan is not.
    console.error("[resolve-atomic-updates] resolution failed:", error);
    return [];
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/lib/ai/resolve-atomic-updates.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/resolve-atomic-updates.ts tests/lib/ai/resolve-atomic-updates.test.ts
git commit -m "feat: add batched atomic update resolver"
```

---

### Task 4: Apply the resolution plan under a per-tenant lock

**Files:**
- Create: `src/lib/change-events/apply-resolution.ts`
- Test: `tests/lib/change-events/apply-resolution.test.ts`

**Interfaces:**
- Consumes: `ResolutionAction` from Task 3; `atomicUpdates`, `changeEvents` from Task 1
- Produces:
  - `withTenantLock<T>(database, tenantId, fn: (tx) => Promise<T>): Promise<T>`
  - `loadOpenAtomicUpdates(database, tenantId): Promise<OpenAtomicUpdate[]>`
  - `applyResolution(database, tenantId, actions: ResolutionAction[]): Promise<void>`

**Context:** `pg_advisory_xact_lock` is held for the whole transaction and released automatically on commit or rollback. Keying on `hashtext(tenantId)` serializes resolution per tenant while leaving other tenants unblocked. This mirrors the lock-across-work pattern in `src/lib/publishing/dispatch.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/change-events/apply-resolution.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, repos, changeEvents, atomicUpdates, updates } from "../../../src/db/schema";
import {
  applyResolution,
  loadOpenAtomicUpdates,
  withTenantLock,
} from "../../../src/lib/change-events/apply-resolution";

const TENANT = "Apply Resolution Test Tenant";

async function seed() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  const [repo] = await db
    .insert(repos)
    .values({
      tenantId: tenant.id,
      githubRepoFullName: "acme/widgets",
      githubInstallationId: "1",
      watchedBranch: "main",
    })
    .returning();
  return { tenant, repo };
}

async function insertEvent(tenantId: string, repoId: string, sha: string) {
  const [row] = await db
    .insert(changeEvents)
    .values({
      tenantId,
      repoId,
      type: "commit",
      provider: "github",
      externalId: sha,
      commitSha: sha,
      commitMessage: sha,
    })
    .returning();
  return row;
}

describe("apply-resolution", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("creates an atomic update and attaches the event", async () => {
    const { tenant, repo } = await seed();
    const event = await insertEvent(tenant.id, repo.id, "sha-create");

    await applyResolution(db, tenant.id, [
      { eventId: event.id, action: "create", title: "CSV export", summary: "Export as CSV.", category: "new" },
    ]);

    const [updated] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    expect(updated.atomicUpdateId).not.toBeNull();

    const [atomic] = await db
      .select()
      .from(atomicUpdates)
      .where(eq(atomicUpdates.id, updated.atomicUpdateId!));
    expect(atomic.title).toBe("CSV export");
    expect(atomic.category).toBe("new");
    expect(atomic.status).toBe("open");
  });

  it("merges same-title create actions into one atomic update", async () => {
    const { tenant, repo } = await seed();
    const first = await insertEvent(tenant.id, repo.id, "sha-merge-1");
    const second = await insertEvent(tenant.id, repo.id, "sha-merge-2");

    await applyResolution(db, tenant.id, [
      { eventId: first.id, action: "create", title: "CSV export", summary: "Export as CSV.", category: "new" },
      { eventId: second.id, action: "create", title: "CSV Export", summary: "Export as CSV.", category: "new" },
    ]);

    const rows = await db.select().from(atomicUpdates).where(eq(atomicUpdates.tenantId, tenant.id));
    expect(rows).toHaveLength(1);

    const [a] = await db.select().from(changeEvents).where(eq(changeEvents.id, first.id));
    const [b] = await db.select().from(changeEvents).where(eq(changeEvents.id, second.id));
    expect(a.atomicUpdateId).toBe(b.atomicUpdateId);
  });

  it("assigns an event to an existing atomic update", async () => {
    const { tenant, repo } = await seed();
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "CSV export", summary: "Export as CSV." })
      .returning();
    const event = await insertEvent(tenant.id, repo.id, "sha-assign");

    await applyResolution(db, tenant.id, [
      { eventId: event.id, action: "assign", atomicUpdateId: atomic.id },
    ]);

    const [updated] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    expect(updated.atomicUpdateId).toBe(atomic.id);
  });

  it("ignores an empty plan", async () => {
    const { tenant, repo } = await seed();
    const event = await insertEvent(tenant.id, repo.id, "sha-noop");

    await applyResolution(db, tenant.id, []);

    const [updated] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    expect(updated.atomicUpdateId).toBeNull();
  });

  it("never assigns an event belonging to another tenant", async () => {
    const { tenant, repo } = await seed();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [otherRepo] = await db
      .insert(repos)
      .values({
        tenantId: other.id,
        githubRepoFullName: "acme/other",
        githubInstallationId: "2",
        watchedBranch: "main",
      })
      .returning();
    const foreign = await insertEvent(other.id, otherRepo.id, "sha-foreign");

    await applyResolution(db, tenant.id, [
      { eventId: foreign.id, action: "create", title: "X", summary: "Y", category: "new" },
    ]);

    const [updated] = await db.select().from(changeEvents).where(eq(changeEvents.id, foreign.id));
    expect(updated.atomicUpdateId).toBeNull();
  });

  it("loadOpenAtomicUpdates returns only open ones for the tenant", async () => {
    const { tenant } = await seed();
    await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "Open one", summary: "S" });
    await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Shipped one", summary: "S", status: "released" });

    const open = await loadOpenAtomicUpdates(db, tenant.id);
    expect(open).toHaveLength(1);
    expect(open[0].title).toBe("Open one");
  });

  it("loadOpenAtomicUpdates includes ones already in a draft release", async () => {
    const { tenant } = await seed();
    const [release] = await db
      .insert(updates)
      .values({ tenantId: tenant.id, title: "Draft", body: "B", sourceItems: [] })
      .returning();
    await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "In a draft", summary: "S", releaseId: release.id });

    const open = await loadOpenAtomicUpdates(db, tenant.id);
    expect(open.map((a) => a.title)).toContain("In a draft");
  });

  it("serializes concurrent lock holders for the same tenant", async () => {
    const { tenant } = await seed();
    const order: string[] = [];

    await Promise.all([
      withTenantLock(db, tenant.id, async () => {
        order.push("a-start");
        await new Promise((r) => setTimeout(r, 50));
        order.push("a-end");
      }),
      withTenantLock(db, tenant.id, async () => {
        order.push("b-start");
        order.push("b-end");
      }),
    ]);

    // Whoever went first must have finished before the other started.
    expect(order[1]).toBe(order[0].replace("start", "end"));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lib/change-events/apply-resolution.test.ts`
Expected: FAIL — cannot resolve `src/lib/change-events/apply-resolution`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/change-events/apply-resolution.ts`:

```ts
import { and, eq, isNull, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { atomicUpdates, changeEvents } from "@/db/schema";
import type { OpenAtomicUpdate, ResolutionAction } from "@/lib/ai/resolve-atomic-updates";

type Database = typeof defaultDb;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Runs `fn` inside a transaction holding a per-tenant advisory lock, so two
 * concurrent pushes for the same tenant cannot both decide "no matching atomic
 * update exists" and create duplicates. The lock releases on commit or rollback.
 */
export async function withTenantLock<T>(
  database: Database,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenantId})::bigint)`);
    return fn(tx);
  });
}

/**
 * The resolver's candidate set: atomic updates not yet shipped. An atomic update
 * sitting in an unpublished draft release is still open — nothing has been
 * communicated to users yet, so new evidence still belongs to it.
 */
export async function loadOpenAtomicUpdates(
  database: Database | Tx,
  tenantId: string
): Promise<OpenAtomicUpdate[]> {
  const rows = await database
    .select({ id: atomicUpdates.id, title: atomicUpdates.title, summary: atomicUpdates.summary })
    .from(atomicUpdates)
    .where(and(eq(atomicUpdates.tenantId, tenantId), eq(atomicUpdates.status, "open")));
  return rows;
}

/** Applies a resolver plan in one transaction. A partial plan is never written. */
export async function applyResolution(
  database: Database,
  tenantId: string,
  actions: ResolutionAction[]
): Promise<void> {
  if (actions.length === 0) return;

  await database.transaction(async (tx) => {
    // Two events describing the same new change both arrive as `create` actions
    // with an identical title. Creating a row per action would split one change
    // across two atomic updates, so the first create wins and the rest reuse it.
    const createdByTitle = new Map<string, string>();

    for (const action of actions) {
      let atomicUpdateId: string;

      if (action.action === "create") {
        const key = action.title.trim().toLowerCase();
        const existing = createdByTitle.get(key);

        if (existing) {
          atomicUpdateId = existing;
        } else {
          const [created] = await tx
            .insert(atomicUpdates)
            .values({
              tenantId,
              title: action.title,
              summary: action.summary,
              category: action.category,
            })
            .returning({ id: atomicUpdates.id });
          atomicUpdateId = created.id;
          createdByTitle.set(key, atomicUpdateId);
        }
      } else {
        atomicUpdateId = action.atomicUpdateId;
      }

      // Tenant-scoped and unassigned-only: the resolver's plan is model output,
      // so it must not be able to reach another tenant's rows or clobber an
      // assignment made while it was thinking.
      await tx
        .update(changeEvents)
        .set({ atomicUpdateId })
        .where(
          and(
            eq(changeEvents.id, action.eventId),
            eq(changeEvents.tenantId, tenantId),
            isNull(changeEvents.atomicUpdateId)
          )
        );
    }
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/lib/change-events/apply-resolution.test.ts`
Expected: PASS, 8 tests.

**If the lock test is flaky:** the two `withTenantLock` calls share one `Pool`. Confirm `src/db/index.ts` has a pool size above 1; if it is 1, the test deadlocks rather than serializing, and the pool size — not the lock — is the bug.

- [ ] **Step 5: Commit**

```bash
git add src/lib/change-events/apply-resolution.ts tests/lib/change-events/apply-resolution.test.ts
git commit -m "feat: apply resolution plans under a per-tenant advisory lock"
```

---

### Task 5: Summary regeneration on attach, frozen by manual edit

**Files:**
- Create: `src/lib/ai/regenerate-atomic-summary.ts`
- Test: `tests/lib/ai/regenerate-atomic-summary.test.ts`

**Interfaces:**
- Consumes: `resolveModel`, `modelId`, `recordLlmUsage`
- Produces:
  - `type AtomicEvidence = { type: "commit" | "pull_request" | "task"; title: string; summary: string | null }`
  - `regenerateAtomicSummary(input: { tenantId: string; current: { title: string; summary: string }; evidence: AtomicEvidence[] }): Promise<{ title: string; summary: string } | null>`
  - `refreshAtomicUpdates(database, tenantId, atomicUpdateIds: string[]): Promise<void>`

**Context:** Regeneration keeps the curation list honest as evidence accumulates. A non-null `summaryEditedAt` freezes it — never overwrite words a human wrote. Returns `null` on model error so the caller leaves the existing summary alone.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/ai/regenerate-atomic-summary.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("../../../src/lib/ai/llm-usage", () => ({ recordLlmUsage: vi.fn() }));

import { generateObject } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, atomicUpdates } from "../../../src/db/schema";
import {
  regenerateAtomicSummary,
  refreshAtomicUpdates,
} from "../../../src/lib/ai/regenerate-atomic-summary";

const TENANT = "Regenerate Summary Test Tenant";

describe("regenerateAtomicSummary", () => {
  afterEach(() => vi.mocked(generateObject).mockReset());

  it("returns the regenerated title and summary", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "CSV export", summary: "Export reports as CSV, now with headers." },
      usage: {},
    } as never);

    const result = await regenerateAtomicSummary({
      tenantId: "t1",
      current: { title: "CSV export", summary: "Export reports as CSV." },
      evidence: [{ type: "commit", title: "add headers to csv", summary: "Adds a header row." }],
    });

    expect(result).toEqual({ title: "CSV export", summary: "Export reports as CSV, now with headers." });
  });

  it("returns null on model error", async () => {
    vi.mocked(generateObject).mockRejectedValue(new Error("boom"));

    const result = await regenerateAtomicSummary({
      tenantId: "t1",
      current: { title: "T", summary: "S" },
      evidence: [{ type: "commit", title: "x", summary: null }],
    });

    expect(result).toBeNull();
  });
});

describe("refreshAtomicUpdates", () => {
  afterEach(async () => {
    vi.mocked(generateObject).mockReset();
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("rewrites an unedited summary", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Old", summary: "Old summary." })
      .returning();

    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "New", summary: "New summary." },
      usage: {},
    } as never);

    await refreshAtomicUpdates(db, tenant.id, [atomic.id]);

    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomic.id));
    expect(after.title).toBe("New");
    expect(after.summary).toBe("New summary.");
  });

  it("leaves a manually edited summary untouched and does not call the model", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({
        tenantId: tenant.id,
        title: "Hand written",
        summary: "Hand written summary.",
        summaryEditedAt: new Date(),
      })
      .returning();

    await refreshAtomicUpdates(db, tenant.id, [atomic.id]);

    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomic.id));
    expect(after.summary).toBe("Hand written summary.");
    expect(generateObject).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lib/ai/regenerate-atomic-summary.test.ts`
Expected: FAIL — cannot resolve `src/lib/ai/regenerate-atomic-summary`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/ai/regenerate-atomic-summary.ts`:

```ts
import { generateObject } from "ai";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { atomicUpdates, changeEvents } from "@/db/schema";
import { resolveModel, modelId } from "./model";
import { recordLlmUsage } from "./llm-usage";

type Database = typeof defaultDb;

export type AtomicEvidence = {
  type: "commit" | "pull_request" | "task";
  title: string;
  summary: string | null;
};

export const AtomicSummarySchema = z.object({
  title: z.string(),
  summary: z.string(),
});

const SUMMARY_SYSTEM = [
  "You maintain the one-line description of an atomic update in a product changelog.",
  "You are given the current title and summary plus every change event that now backs it.",
  "Rewrite them so they describe the whole set accurately.",
  "Keep the title a short noun phrase and the summary a single plain sentence about the user-visible benefit.",
  "Stay close to the current wording when it is still accurate — this is an update, not a rewrite.",
].join(" ");

export async function regenerateAtomicSummary(input: {
  tenantId: string;
  current: { title: string; summary: string };
  evidence: AtomicEvidence[];
}): Promise<{ title: string; summary: string } | null> {
  try {
    const spec = process.env.SUMMARY_MODEL ?? "anthropic/claude-haiku-4-5";
    const evidenceBlock = input.evidence
      .map((e) => `- [${e.type}] ${e.title}${e.summary ? ` — ${e.summary}` : ""}`)
      .join("\n");

    const { object, usage } = await generateObject({
      model: resolveModel(spec),
      schema: AtomicSummarySchema,
      system: SUMMARY_SYSTEM,
      prompt: `Current title: ${input.current.title}\nCurrent summary: ${input.current.summary}\n\nChange events:\n${evidenceBlock}`,
    });

    await recordLlmUsage({
      tenantId: input.tenantId,
      operation: "atomic_summary",
      model: modelId(spec),
      usage,
    });

    return { title: object.title.trim(), summary: object.summary.trim() };
  } catch (error) {
    // Keep the existing summary rather than blanking it on a transient error.
    console.error("[regenerate-atomic-summary] regeneration failed:", error);
    return null;
  }
}

/** Regenerates each atomic update whose summary has not been hand-edited. */
export async function refreshAtomicUpdates(
  database: Database,
  tenantId: string,
  atomicUpdateIds: string[]
): Promise<void> {
  for (const id of new Set(atomicUpdateIds)) {
    const [atomic] = await database
      .select()
      .from(atomicUpdates)
      .where(
        and(
          eq(atomicUpdates.id, id),
          eq(atomicUpdates.tenantId, tenantId),
          isNull(atomicUpdates.summaryEditedAt)
        )
      )
      .limit(1);
    if (!atomic) continue;

    const evidenceRows = await database
      .select({
        type: changeEvents.type,
        prTitle: changeEvents.prTitle,
        commitMessage: changeEvents.commitMessage,
        impactSummary: changeEvents.impactSummary,
      })
      .from(changeEvents)
      .where(eq(changeEvents.atomicUpdateId, id));

    const evidence: AtomicEvidence[] = evidenceRows.map((r) => ({
      type: r.type,
      title: r.prTitle ?? r.commitMessage ?? "",
      summary: r.impactSummary,
    }));
    if (evidence.length === 0) continue;

    const next = await regenerateAtomicSummary({
      tenantId,
      current: { title: atomic.title, summary: atomic.summary },
      evidence,
    });
    if (!next) continue;

    await database
      .update(atomicUpdates)
      .set({ title: next.title, summary: next.summary, updatedAt: new Date() })
      // Re-check the freeze: a user may have edited while the model was running.
      .where(and(eq(atomicUpdates.id, id), isNull(atomicUpdates.summaryEditedAt)));
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/lib/ai/regenerate-atomic-summary.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/regenerate-atomic-summary.ts tests/lib/ai/regenerate-atomic-summary.test.ts
git commit -m "feat: regenerate atomic update summaries, frozen on manual edit"
```

---

### Task 6: Pipeline orchestrator

**Files:**
- Create: `src/lib/change-events/pipeline.ts`
- Test: `tests/lib/change-events/pipeline.test.ts`

**Interfaces:**
- Consumes: `resolveAtomicUpdates`, `RESOLVER_BATCH_SIZE` (Task 3); `withTenantLock`, `loadOpenAtomicUpdates`, `applyResolution` (Task 4); `refreshAtomicUpdates` (Task 5)
- Produces: `resolvePendingEvents(tenantId: string, eventIds: string[], deps?: PipelineDeps): Promise<void>`

**Context:** Tier 3 only. Tiers 1 and 2 already ran per-event during ingestion; this takes the surviving `userFacing` event ids and resolves them as one batch. Chunks at `RESOLVER_BATCH_SIZE`, and each chunk is resolved and applied under the tenant lock before the next chunk loads its candidate set — so events in chunk 2 can attach to atomic updates chunk 1 just created.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/change-events/pipeline.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, repos, changeEvents, atomicUpdates } from "../../../src/db/schema";
import { resolvePendingEvents } from "../../../src/lib/change-events/pipeline";

const TENANT = "Pipeline Test Tenant";

async function seed(count: number) {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  const [repo] = await db
    .insert(repos)
    .values({
      tenantId: tenant.id,
      githubRepoFullName: "acme/widgets",
      githubInstallationId: "1",
      watchedBranch: "main",
    })
    .returning();

  const events = [];
  for (let i = 0; i < count; i++) {
    const [row] = await db
      .insert(changeEvents)
      .values({
        tenantId: tenant.id,
        repoId: repo.id,
        type: "commit",
        provider: "github",
        externalId: `sha-${i}`,
        commitSha: `sha-${i}`,
        commitMessage: `commit ${i}`,
        userFacing: true,
        impactSummary: `Does thing ${i}.`,
      })
      .returning();
    events.push(row);
  }
  return { tenant, events };
}

describe("resolvePendingEvents", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("creates an atomic update from the resolver plan", async () => {
    const { tenant, events } = await seed(1);
    const resolve = vi.fn().mockResolvedValue([
      { eventId: events[0].id, action: "create", title: "Thing", summary: "Does a thing.", category: "new" },
    ]);

    await resolvePendingEvents(tenant.id, [events[0].id], { resolve, refresh: vi.fn() });

    const [updated] = await db.select().from(changeEvents).where(eq(changeEvents.id, events[0].id));
    expect(updated.atomicUpdateId).not.toBeNull();
  });

  it("chunks batches larger than the resolver cap", async () => {
    const { tenant, events } = await seed(30);
    const resolve = vi.fn().mockResolvedValue([]);

    await resolvePendingEvents(
      tenant.id,
      events.map((e) => e.id),
      { resolve, refresh: vi.fn() }
    );

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve.mock.calls[0][0].events).toHaveLength(25);
    expect(resolve.mock.calls[1][0].events).toHaveLength(5);
  });

  it("refreshes only atomic updates that received an assignment", async () => {
    const { tenant, events } = await seed(1);
    const [existing] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Existing", summary: "S" })
      .returning();
    const refresh = vi.fn();
    const resolve = vi
      .fn()
      .mockResolvedValue([{ eventId: events[0].id, action: "assign", atomicUpdateId: existing.id }]);

    await resolvePendingEvents(tenant.id, [events[0].id], { resolve, refresh });

    expect(refresh).toHaveBeenCalledWith(expect.anything(), tenant.id, [existing.id]);
  });

  it("does nothing when given no event ids", async () => {
    const { tenant } = await seed(0);
    const resolve = vi.fn();

    await resolvePendingEvents(tenant.id, [], { resolve, refresh: vi.fn() });

    expect(resolve).not.toHaveBeenCalled();
  });

  it("skips events that are already assigned", async () => {
    const { tenant, events } = await seed(1);
    const [existing] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Existing", summary: "S" })
      .returning();
    await db
      .update(changeEvents)
      .set({ atomicUpdateId: existing.id })
      .where(eq(changeEvents.id, events[0].id));

    const resolve = vi.fn().mockResolvedValue([]);
    await resolvePendingEvents(tenant.id, [events[0].id], { resolve, refresh: vi.fn() });

    expect(resolve).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lib/change-events/pipeline.test.ts`
Expected: FAIL — cannot resolve `src/lib/change-events/pipeline`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/change-events/pipeline.ts`:

```ts
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { changeEvents, repos } from "@/db/schema";
import {
  resolveAtomicUpdates,
  RESOLVER_BATCH_SIZE,
  type ResolverEvent,
} from "@/lib/ai/resolve-atomic-updates";
import { refreshAtomicUpdates } from "@/lib/ai/regenerate-atomic-summary";
import { applyResolution, loadOpenAtomicUpdates, withTenantLock } from "./apply-resolution";

export type PipelineDeps = {
  resolve?: typeof resolveAtomicUpdates;
  refresh?: typeof refreshAtomicUpdates;
  database?: typeof defaultDb;
};

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Tier 3. Takes the ids of freshly ingested, user-facing change events and
 * resolves them into atomic updates as one batch per chunk.
 *
 * Chunks are resolved sequentially, each reloading the open set, so an event in
 * chunk 2 can attach to an atomic update chunk 1 just created.
 */
export async function resolvePendingEvents(
  tenantId: string,
  eventIds: string[],
  deps: PipelineDeps = {}
): Promise<void> {
  const database = deps.database ?? defaultDb;
  const resolve = deps.resolve ?? resolveAtomicUpdates;
  const refresh = deps.refresh ?? refreshAtomicUpdates;
  if (eventIds.length === 0) return;

  const rows = await database
    .select({
      id: changeEvents.id,
      type: changeEvents.type,
      prTitle: changeEvents.prTitle,
      commitMessage: changeEvents.commitMessage,
      impactSummary: changeEvents.impactSummary,
      repoName: repos.githubRepoFullName,
    })
    .from(changeEvents)
    .leftJoin(repos, eq(changeEvents.repoId, repos.id))
    .where(
      and(
        inArray(changeEvents.id, eventIds),
        eq(changeEvents.tenantId, tenantId),
        eq(changeEvents.userFacing, true),
        isNull(changeEvents.atomicUpdateId)
      )
    );
  if (rows.length === 0) return;

  const events: ResolverEvent[] = rows.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.prTitle ?? r.commitMessage ?? "",
    summary: r.impactSummary,
    repoName: r.repoName,
  }));

  const touched = new Set<string>();

  for (const batch of chunk(events, RESOLVER_BATCH_SIZE)) {
    // The lock spans loading the candidate set and applying the plan, so a
    // concurrent push cannot create a duplicate atomic update in between.
    const actions = await withTenantLock(database, tenantId, async (tx) => {
      const open = await loadOpenAtomicUpdates(tx, tenantId);
      return resolve({ tenantId, events: batch, open });
    });

    await applyResolution(database, tenantId, actions);

    for (const action of actions) {
      if (action.action === "assign") touched.add(action.atomicUpdateId);
    }
  }

  // Only assignments change an existing atomic update's meaning. A freshly
  // created one was written from its evidence a moment ago.
  if (touched.size > 0) await refresh(database, tenantId, [...touched]);
}
```

**Note on the lock:** `resolve` (an LLM call) runs inside the lock. That is deliberate — the whole point is that no other push may decide "no match exists" while this one is thinking. It does mean a tenant's pushes serialize behind a Sonnet call, which is acceptable because ingestion is deferred behind `after()` and never blocks a webhook response.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/lib/change-events/pipeline.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/change-events/pipeline.ts tests/lib/change-events/pipeline.test.ts
git commit -m "feat: add change event resolution pipeline"
```

---

### Task 7: Wire the pipeline into push and PR ingestion

**Files:**
- Modify: `src/lib/change-events/ingest-push.ts`
- Modify: `src/lib/change-events/ingest-pull-request.ts`
- Test: `tests/lib/change-events/ingest-push.test.ts` (existing — extend)

**Interfaces:**
- Consumes: `filterCommit`, `filterPullRequest` (Task 2); `resolvePendingEvents` (Task 6)
- Produces: no new exports; `ingestPush` and `ingestPullRequest` now populate `type`/`provider`/`externalId`/`externalUrl`/`filterReason` and call `resolvePendingEvents` once at the end

**Context:** Tier 1 replaces the ad-hoc merge-commit and empty-diff checks already in `ingestPush` — the same two rules, plus four more, now in one tested function. Tier 2 (`enrichChangeItem`) is unchanged. Tier 3 runs once after the concurrent per-commit work completes.

- [ ] **Step 1: Move the ingestion modules into `change-events/`**

Tasks 2–6 created `src/lib/change-events/`. Leaving the ingestion modules in a
parallel `change-items/` directory would leave two directories for one concept.

```bash
git mv src/lib/change-items/* src/lib/change-events/
rmdir src/lib/change-items
git mv tests/lib/change-items/* tests/lib/change-events/
rmdir tests/lib/change-items
```

Then fix every import of the moved modules:

```bash
grep -rln "change-items" src/ tests/
```

Replace `@/lib/change-items/` with `@/lib/change-events/` in each, and update the
relative import paths inside the moved test files — they gained no directory
depth, so those should still resolve, but run the check below rather than
assuming.

Run: `npm run typecheck && npx vitest run tests/lib/change-events/`
Expected: typecheck clean, existing ingestion tests still PASS. Read
`ingest-push.test.ts` now to learn its fixture and dependency-injection style —
the new assertions must follow it.

- [ ] **Step 2: Write the failing test**

Append to `tests/lib/change-events/ingest-push.test.ts`, inside the existing top-level `describe`:

```ts
  it("stores type, provider and externalId on ingested commits", async () => {
    const { repo } = await seedRepo();
    await ingestPush(pushInput({ payloadCommits: [payloadCommit("sha-typed", "feat: add export")] }), {
      ...baseDeps,
      listPushCommits: async () => [pushCommit("sha-typed", "feat: add export")],
      getCommitDiff: async () => "diff --git a/src/a.ts b/src/a.ts\n+x\n",
      resolvePending: vi.fn(),
    });

    const [row] = await db.select().from(changeEvents).where(eq(changeEvents.commitSha, "sha-typed"));
    expect(row.type).toBe("commit");
    expect(row.provider).toBe("github");
    expect(row.externalId).toBe("sha-typed");
    expect(row.repoId).toBe(repo.id);
  });

  it("drops a chore-prefixed commit with a filter reason and does not enrich it", async () => {
    await seedRepo();
    const enrich = vi.fn();
    await ingestPush(pushInput({ payloadCommits: [payloadCommit("sha-chore", "chore: tidy")] }), {
      ...baseDeps,
      listPushCommits: async () => [pushCommit("sha-chore", "chore: tidy")],
      getCommitDiff: async () => "diff --git a/src/a.ts b/src/a.ts\n+x\n",
      enrich,
      resolvePending: vi.fn(),
    });

    const [row] = await db.select().from(changeEvents).where(eq(changeEvents.commitSha, "sha-chore"));
    expect(row.filterReason).toBe("chore_prefix");
    expect(row.status).toBe("ignored");
    expect(enrich).not.toHaveBeenCalled();
  });

  it("resolves user-facing commits once, after all commits are ingested", async () => {
    await seedRepo();
    const resolvePending = vi.fn();
    await ingestPush(
      pushInput({
        payloadCommits: [payloadCommit("sha-r1", "feat: a"), payloadCommit("sha-r2", "feat: b")],
      }),
      {
        ...baseDeps,
        listPushCommits: async () => [pushCommit("sha-r1", "feat: a"), pushCommit("sha-r2", "feat: b")],
        getCommitDiff: async () => "diff --git a/src/a.ts b/src/a.ts\n+x\n",
        enrich: async () => ({ userFacing: true, impactSummary: "Does a thing.", suggestedCategory: "new", confidence: 0.9 }),
        resolvePending,
      }
    );

    expect(resolvePending).toHaveBeenCalledTimes(1);
    expect(resolvePending.mock.calls[0][1]).toHaveLength(2);
  });
```

If `seedRepo`, `pushInput`, `payloadCommit`, `pushCommit`, or `baseDeps` do not exist in the file under those names, use whatever equivalents it already defines — do not introduce a second fixture style.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/lib/change-events/ingest-push.test.ts`
Expected: FAIL — `resolvePending` is not a recognized dep, and `type`/`provider`/`filterReason` are null.

- [ ] **Step 4: Rewrite `ingest-push.ts`**

Replace the contents of `src/lib/change-events/ingest-push.ts` with:

```ts
import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { repos, changeEvents } from "@/db/schema";
import {
  truncateDiff,
  getCommitDiff,
  listPushCommits,
  getCommitPulls,
  type PushCommit,
} from "@/lib/integrations/github/github";
import { mapWithConcurrency } from "@/lib/concurrency";
import { enrichChangeItem, type EnrichChangeItem, type EnrichmentResult } from "@/lib/ai/enrich-change-item";
import { filterCommit, type FilterReason } from "@/lib/change-events/filter";
import { resolvePendingEvents } from "@/lib/change-events/pipeline";

const ENRICH_CONCURRENCY = 5;

export type PushInput = {
  installationId: string;
  repoFullName: string;
  ref: string;
  before: string;
  after: string;
  /**
   * When this push landed on the branch. Captured at the webhook route, not
   * here — ingestion is deferred behind enrichment and would read late.
   */
  pushedAt: Date;
  payloadCommits: Array<{ id: string; message: string; url: string; timestamp: string }>;
};

export type IngestPushDeps = {
  listPushCommits?: typeof listPushCommits;
  getCommitPulls?: typeof getCommitPulls;
  getCommitDiff?: typeof getCommitDiff;
  enrich?: EnrichChangeItem;
  resolvePending?: typeof resolvePendingEvents;
  database?: typeof defaultDb;
};

type RepoRow = typeof repos.$inferSelect;

async function insertCommit(
  database: typeof defaultDb,
  repo: RepoRow,
  commit: PushCommit,
  opts: {
    status: "pending" | "ignored";
    filterReason: FilterReason | null;
    diff: string | null;
    enrichment: EnrichmentResult | null;
    releasedAt: Date;
  }
): Promise<string | null> {
  const [row] = await database
    .insert(changeEvents)
    .values({
      tenantId: repo.tenantId,
      repoId: repo.id,
      type: "commit",
      provider: "github",
      externalId: commit.sha,
      externalUrl: commit.url,
      status: opts.status,
      filterReason: opts.filterReason,
      commitSha: commit.sha,
      commitMessage: commit.message,
      commitUrl: commit.url,
      committedAt: commit.committedAt ? new Date(commit.committedAt) : null,
      releasedAt: opts.releasedAt,
      diff: opts.diff,
      userFacing: opts.enrichment?.userFacing ?? null,
      impactSummary: opts.enrichment?.impactSummary ?? null,
      suggestedCategory: opts.enrichment?.suggestedCategory ?? null,
      enrichmentConfidence: opts.enrichment?.confidence ?? null,
      enrichedAt: opts.enrichment ? new Date() : null,
    })
    .onConflictDoNothing()
    .returning({ id: changeEvents.id });

  return row?.id ?? null;
}

export async function ingestPush(input: PushInput, deps: IngestPushDeps = {}): Promise<void> {
  const listCommits = deps.listPushCommits ?? listPushCommits;
  const commitPulls = deps.getCommitPulls ?? getCommitPulls;
  const commitDiff = deps.getCommitDiff ?? getCommitDiff;
  const enrich = deps.enrich ?? enrichChangeItem;
  const resolvePending = deps.resolvePending ?? resolvePendingEvents;
  const database = deps.database ?? defaultDb;

  const [repo] = await database
    .select()
    .from(repos)
    .where(and(eq(repos.githubInstallationId, input.installationId), eq(repos.githubRepoFullName, input.repoFullName)))
    .limit(1);
  if (!repo) return;
  if (input.ref !== `refs/heads/${repo.watchedBranch}`) return;

  const commits = await listCommits(input.installationId, input.repoFullName, {
    before: input.before,
    after: input.after,
    payloadCommits: input.payloadCommits,
  });

  // Tiers 1 and 2 run per commit, in parallel. Only tier 3 needs the batch.
  const resolvable = await mapWithConcurrency(commits, ENRICH_CONCURRENCY, async (commit) => {
    try {
      // Belongs to a PR merged into the watched branch → drop (the PR is its own
      // rich item). A PR merged into a different branch (e.g. GitFlow promotion
      // commits whose PR targeted `develop`, later fast-forwarded/merged onto
      // `main`) must NOT be dropped here — it has no corresponding PR item on the
      // watched branch, so it falls through to classification like a direct commit.
      const pulls = await commitPulls(input.installationId, input.repoFullName, commit.sha);
      if (pulls.some((p) => p.merged && p.baseRef === repo.watchedBranch)) return null;

      // A merge commit has no diff to fetch, so decide on parent count first and
      // avoid the API call entirely.
      const preDiff = filterCommit({ message: commit.message, diff: "x", parentCount: commit.parents.length });
      if (preDiff.drop && preDiff.reason === "merge_commit") {
        await insertCommit(database, repo, commit, {
          status: "ignored",
          filterReason: "merge_commit",
          diff: null,
          enrichment: null,
          releasedAt: input.pushedAt,
        });
        return null;
      }

      // Tier 1 proper, now with the diff in hand.
      const diff = truncateDiff(await commitDiff(input.installationId, input.repoFullName, commit.sha));
      const verdict = filterCommit({
        message: commit.message,
        diff,
        parentCount: commit.parents.length,
      });
      if (verdict.drop) {
        await insertCommit(database, repo, commit, {
          status: "ignored",
          filterReason: verdict.reason,
          diff,
          enrichment: null,
          releasedAt: input.pushedAt,
        });
        return null;
      }

      // Tier 2.
      const enrichment = await enrich({
        tenantId: repo.tenantId,
        type: "commit",
        repoName: input.repoFullName,
        commitMessage: commit.message,
        diff,
      });
      const id = await insertCommit(database, repo, commit, {
        status: "pending",
        filterReason: null,
        diff,
        enrichment,
        releasedAt: input.pushedAt,
      });

      return enrichment.userFacing ? id : null;
    } catch (error) {
      // One bad commit (flaky API call, transient error) must not abort the whole
      // push via `Promise.all` inside `mapWithConcurrency` and abandon the
      // untouched tail — log and move on, the rest of the push still ingests.
      console.error(`[ingest-push] failed commit ${commit.sha} in ${input.repoFullName}:`, error);
      return null;
    }
  });

  // Tier 3: one batch for the whole push, so commits that belong together are
  // grouped in a single decision rather than one at a time.
  const eventIds = resolvable.filter((id): id is string => id !== null);
  if (eventIds.length > 0) await resolvePending(repo.tenantId, eventIds);
}
```

- [ ] **Step 5: Run the push tests**

Run: `npx vitest run tests/lib/change-events/ingest-push.test.ts`
Expected: PASS, including the three new tests.

- [ ] **Step 6: Rewrite `ingest-pull-request.ts`**

Note the signature change: this function took positional `enrich` and `database`
arguments. It now takes a deps object, matching `ingestPush`. Update the one
caller in `src/app/api/webhooks/github/route.ts` accordingly — find it with
`grep -rn "ingestMergedPullRequest" src/`.

Replace the contents of `src/lib/change-events/ingest-pull-request.ts` with:

```ts
import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { repos, changeEvents } from "@/db/schema";
import { enrichChangeItem, type EnrichChangeItem } from "@/lib/ai/enrich-change-item";
import { filterPullRequest } from "@/lib/change-events/filter";
import { resolvePendingEvents } from "@/lib/change-events/pipeline";

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

export type IngestPullRequestDeps = {
  enrich?: EnrichChangeItem;
  resolvePending?: typeof resolvePendingEvents;
  database?: typeof defaultDb;
};

export async function ingestMergedPullRequest(
  input: MergedPullRequestInput,
  deps: IngestPullRequestDeps = {}
): Promise<void> {
  const enrich = deps.enrich ?? enrichChangeItem;
  const resolvePending = deps.resolvePending ?? resolvePendingEvents;
  const database = deps.database ?? defaultDb;

  const [repo] = await database
    .select()
    .from(repos)
    .where(
      and(eq(repos.githubInstallationId, input.installationId), eq(repos.githubRepoFullName, input.repoFullName))
    )
    .limit(1);

  if (!repo) return;
  if (input.baseBranch !== repo.watchedBranch) return;

  // PR numbers collide across repos, so the id is namespaced by repo full name.
  // This format must match the Task 1 migration backfill exactly.
  const externalId = `${input.repoFullName}#${input.prNumber}`;

  const base = {
    tenantId: repo.tenantId,
    repoId: repo.id,
    type: "pull_request" as const,
    provider: "github" as const,
    externalId,
    externalUrl: input.prUrl,
    prNumber: input.prNumber,
    prTitle: input.prTitle,
    prDescription: input.prDescription,
    prUrl: input.prUrl,
    mergedAt: input.mergedAt,
  };

  // Tier 1.
  const verdict = filterPullRequest({ title: input.prTitle });
  if (verdict.drop) {
    await database
      .insert(changeEvents)
      .values({ ...base, status: "ignored", filterReason: verdict.reason })
      .onConflictDoNothing();
    return;
  }

  // Tier 2.
  const enrichment = await enrich({
    tenantId: repo.tenantId,
    type: "pull_request",
    repoName: input.repoFullName,
    prTitle: input.prTitle,
    prDescription: input.prDescription,
  });

  const [row] = await database
    .insert(changeEvents)
    .values({
      ...base,
      userFacing: enrichment.userFacing,
      impactSummary: enrichment.impactSummary,
      suggestedCategory: enrichment.suggestedCategory,
      enrichmentConfidence: enrichment.confidence,
      enrichedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: changeEvents.id });

  // Tier 3. `row` is undefined when the conflict clause swallowed a duplicate
  // delivery, in which case the PR was already resolved on the first attempt.
  if (row && enrichment.userFacing) {
    await resolvePending(repo.tenantId, [row.id]);
  }
}
```

- [ ] **Step 7: Update the existing PR ingestion tests for the new signature**

Run: `npx vitest run tests/lib/change-events/ingest-pull-request.test.ts`
Expected: FAIL — the tests pass `enrich` and `database` positionally.

Change each call from `ingestMergedPullRequest(input, enrichFn, db)` to
`ingestMergedPullRequest(input, { enrich: enrichFn, database: db, resolvePending: vi.fn() })`.
Add `import { vi } from "vitest"` if it is not already imported.

Then append this test inside the existing `describe`:

```ts
  it("drops a chore-prefixed PR without enriching or resolving", async () => {
    const { repo } = await seedRepo();
    const enrich = vi.fn();
    const resolvePending = vi.fn();

    await ingestMergedPullRequest(
      { ...prInput(), prNumber: 99, prTitle: "chore: bump deps" },
      { enrich, resolvePending, database: db }
    );

    const [row] = await db.select().from(changeEvents).where(eq(changeEvents.prNumber, 99));
    expect(row.filterReason).toBe("chore_prefix");
    expect(row.status).toBe("ignored");
    expect(row.externalId).toBe(`${repo.githubRepoFullName}#99`);
    expect(enrich).not.toHaveBeenCalled();
    expect(resolvePending).not.toHaveBeenCalled();
  });
```

If `seedRepo` or `prInput` do not exist under those names, use the fixtures the
file already defines — do not introduce a second fixture style.

Run: `npx vitest run tests/lib/change-events/ingest-pull-request.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the full suite**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean, all tests green.

- [ ] **Step 9: Commit**

```bash
git add -A src/lib/change-events tests/lib/change-events
git commit -m "feat: route push and PR ingestion through the three-tier pipeline"
```

---

### Task 8: Atomic updates list page

**Files:**
- Create: `src/app/(dashboard)/atomic-updates/page.tsx`
- Create: `src/app/(dashboard)/atomic-updates/actions.ts`
- Modify: `src/app/(dashboard)/nav-links.tsx`
- Test: `tests/app/atomic-updates-actions.test.ts`

**Interfaces:**
- Consumes: `atomicUpdates`, `changeEvents` (Task 1); `requireSession` from `src/lib/workspace/session.ts`
- Produces: `listAtomicUpdates(): Promise<AtomicUpdateRow[]>`, `editAtomicUpdate(id: string, patch: { title: string; summary: string }): Promise<void>`

**Context:** The minimum surface that makes phase 1 inspectable — without it there is no way to judge whether the resolver clusters well. Editing sets `summaryEditedAt`, which is what freezes regeneration.

**Before writing any App Router code, read `node_modules/next/dist/docs/` per `AGENTS.md`.** This Next.js version differs from training data. Follow the conventions in `src/app/(dashboard)/drafts/` for page and action structure rather than generic App Router patterns.

- [ ] **Step 1: Write the failing test**

Create `tests/app/atomic-updates-actions.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, atomicUpdates } from "../../src/db/schema";

const TENANT = "Atomic Updates Actions Test Tenant";
let currentTenantId = "";

vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ tenantId: currentTenantId, userId: null })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { editAtomicUpdate, listAtomicUpdates } from "../../src/app/(dashboard)/atomic-updates/actions";

describe("atomic update actions", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("lists only open atomic updates for the tenant", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;
    await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "Open", summary: "S" });
    await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Shipped", summary: "S", status: "released" });

    const rows = await listAtomicUpdates();
    expect(rows.map((r) => r.title)).toEqual(["Open"]);
  });

  it("sets summaryEditedAt when edited, freezing regeneration", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = tenant.id;
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Before", summary: "Before summary." })
      .returning();

    await editAtomicUpdate(atomic.id, { title: "After", summary: "After summary." });

    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomic.id));
    expect(after.title).toBe("After");
    expect(after.summaryEditedAt).not.toBeNull();
  });

  it("refuses to edit another tenant's atomic update", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [foreign] = await db
      .insert(atomicUpdates)
      .values({ tenantId: other.id, title: "Foreign", summary: "S" })
      .returning();
    currentTenantId = tenant.id;

    await editAtomicUpdate(foreign.id, { title: "Hacked", summary: "Hacked." });

    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, foreign.id));
    expect(after.title).toBe("Foreign");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/app/atomic-updates-actions.test.ts`
Expected: FAIL — cannot resolve the actions module.

- [ ] **Step 3: Write the actions**

Create `src/app/(dashboard)/atomic-updates/actions.ts`:

```ts
"use server";

import { and, desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { atomicUpdates, changeEvents } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";

export type AtomicUpdateRow = {
  id: string;
  title: string;
  summary: string;
  category: "new" | "improved" | "fixed" | null;
  eventCount: number;
  summaryEditedAt: Date | null;
  updatedAt: Date;
};

export async function listAtomicUpdates(): Promise<AtomicUpdateRow[]> {
  const { tenantId } = await requireSession();

  return db
    .select({
      id: atomicUpdates.id,
      title: atomicUpdates.title,
      summary: atomicUpdates.summary,
      category: atomicUpdates.category,
      eventCount: sql<number>`count(${changeEvents.id})::int`,
      summaryEditedAt: atomicUpdates.summaryEditedAt,
      updatedAt: atomicUpdates.updatedAt,
    })
    .from(atomicUpdates)
    .leftJoin(changeEvents, eq(changeEvents.atomicUpdateId, atomicUpdates.id))
    .where(and(eq(atomicUpdates.tenantId, tenantId), eq(atomicUpdates.status, "open")))
    .groupBy(atomicUpdates.id)
    .orderBy(desc(atomicUpdates.updatedAt));
}

export async function editAtomicUpdate(
  id: string,
  patch: { title: string; summary: string }
): Promise<void> {
  const { tenantId } = await requireSession();

  // Tenant scoping is enforced per-query in this codebase, not by RLS — the
  // where clause is the security boundary.
  await db
    .update(atomicUpdates)
    .set({
      title: patch.title,
      summary: patch.summary,
      // Freezes automatic regeneration: from here on, only the user rewrites this.
      summaryEditedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(atomicUpdates.id, id), eq(atomicUpdates.tenantId, tenantId)));

  revalidatePath("/atomic-updates");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/app/atomic-updates-actions.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Build the page**

Read `src/app/(dashboard)/drafts/page.tsx` first to confirm the page-shell
conventions (heading markup, container classes, empty-state phrasing) and match
them. Create `src/app/(dashboard)/atomic-updates/page.tsx`:

```tsx
import { Badge } from "@/components/ui/badge";
import { listAtomicUpdates } from "./actions";
import { AtomicUpdateCard } from "./atomic-update-card";

export default async function AtomicUpdatesPage() {
  const rows = await listAtomicUpdates();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Atomic updates</h1>
        <p className="text-muted-foreground text-sm">
          Each one is a single user-facing change, gathered from the commits, pull requests, and tasks
          behind it.
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No atomic updates yet — they appear here as commits and pull requests are ingested.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <li key={row.id}>
              <AtomicUpdateCard row={row} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const CATEGORY_LABEL: Record<string, string> = {
  new: "New",
  improved: "Improved",
  fixed: "Fixed",
};

export function CategoryBadge({ category }: { category: string | null }) {
  if (!category) return null;
  return <Badge variant="secondary">{CATEGORY_LABEL[category] ?? category}</Badge>;
}
```

Create `src/app/(dashboard)/atomic-updates/atomic-update-card.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { editAtomicUpdate, type AtomicUpdateRow } from "./actions";
import { CategoryBadge } from "./page";

export function AtomicUpdateCard({ row }: { row: AtomicUpdateRow }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(row.title);
  const [summary, setSummary] = useState(row.summary);
  const [pending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      await editAtomicUpdate(row.id, { title, summary });
      setEditing(false);
      toast.success("Atomic update saved");
    });
  }

  return (
    <div className="rounded-lg border p-4">
      {editing ? (
        <div className="flex flex-col gap-3">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
          <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} aria-label="Summary" />
          <div className="flex gap-2">
            <Button onClick={save} disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setTitle(row.title);
                setSummary(row.summary);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h2 className="font-medium">{row.title}</h2>
            <CategoryBadge category={row.category} />
          </div>
          <p className="text-muted-foreground text-sm">{row.summary}</p>
          <div className="text-muted-foreground flex items-center gap-3 text-xs">
            <span>
              {row.eventCount} {row.eventCount === 1 ? "change" : "changes"}
            </span>
            {/* Signals to the user why this one stopped auto-updating. */}
            {row.summaryEditedAt && <span>Edited</span>}
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
```

If `src/components/ui/` has no `textarea` or `badge`, add them with
`npx shadcn@latest add textarea badge` rather than hand-rolling them.

- [ ] **Step 6: Add the nav link**

In `src/app/(dashboard)/nav-links.tsx`, change the `NAV` array to:

```tsx
const NAV = [
  { href: "/pending", label: "Pending" },
  { href: "/atomic-updates", label: "Atomic updates" },
  { href: "/drafts", label: "Drafts" },
  { href: "/history", label: "History" },
  { href: "/integrations", label: "Integrations" },
];
```

- [ ] **Step 7: Verify the app builds and renders**

Run: `npm run build`
Expected: build succeeds with no type errors.

Then run `npm run dev`, sign in, and confirm `/atomic-updates` renders the empty state and appears in the nav.

- [ ] **Step 8: Run the full suite**

Run: `npm run typecheck && npm run lint && npx vitest run`
Expected: all clean.

- [ ] **Step 9: Commit**

```bash
git add src/app/\(dashboard\)/atomic-updates src/app/\(dashboard\)/nav-links.tsx tests/app/atomic-updates-actions.test.ts src/components/ui
git commit -m "feat: add atomic updates list page"
```

---

## Verification

After all tasks, confirm phase 1 end to end:

- [ ] `npm run typecheck && npm run lint && npx vitest run` all clean
- [ ] Push two related commits to a watched branch on a test repo (e.g. `feat: add CSV export` then `fix: CSV export header row`), and confirm they land on **one** atomic update, not two
- [ ] Push a `chore:` commit and confirm it is stored with `filter_reason = 'chore_prefix'`, never reaches the classifier, and creates no atomic update
- [ ] Edit an atomic update's summary in the UI, push another related commit, and confirm the summary is **not** overwritten
- [ ] Confirm `llm_usage` has rows with `operation` in (`enrichment`, `resolution`, `atomic_summary`)
- [ ] Confirm `grep -rn "changeItems\|sourceType\|change-items" src/ tests/` returns nothing
- [ ] Confirm the existing drafts flow still works end to end — generate a draft from pending items and publish it. Task 1 renamed a table the scheduler and drafts pages read from, and phase 1 has no other coverage of that path.

## Deferred to phase 2

- Renaming `updates` → `releases` (deliberately not done in phase 1: it drags in `dispatch.ts`, `delivery_attempts`, Webflow publishing, and the drafts UI, none of which phase 1 otherwise touches)
- Repointing generation at atomic updates
- Catch-up affordance and merge-regenerate
- Removing `autoPublish`
- Marking atomic updates `released` on publish (nothing sets `status = 'released'` in phase 1 — `loadOpenAtomicUpdates` is correct today because no code writes that value yet)
