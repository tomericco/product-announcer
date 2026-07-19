# Webhook Commit Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest merged PRs and pushed commits for every watched repo; classify each pushed commit (PR-associated → drop, merge/empty → ignored+shown, else → enrich); process pushes after the response and enumerate all commits via the compare API.

**Architecture:** New GitHub client fns (`listPushCommits` with parents + `getCommitPulls`) feed a refactored, injectable `ingestPush` that classifies and stores commits. The webhook route acks fast and processes pushes in `after()`. A new `ignored` change-item status + `ignored_reason` surfaces filtered commits (dimmed, labeled) in the Pending list.

**Tech Stack:** Next.js App Router, Drizzle + Postgres, octokit, `ai` v7, Vitest.

## Global Constraints

- **This is NOT stock Next.js** — per `AGENTS.md`; verify `after` from `next/server` exists in this repo's Next before relying on it (read `node_modules/next/dist/docs/` / the package). Approved fallback if absent: persist-and-cron (out of scope for this plan — stop and flag).
- **Classification precedence:** (1) belongs to a **merged** PR → drop; (2) merge commit (`parents.length >= 2`, non-PR) → ignored `merge_commit`; (3) empty diff → ignored `empty_diff`; (4) else → enrich → pending. `onConflictDoNothing` on `(repoId, commitSha)` guards re-delivery.
- **Always ingest both** — remove the `sourceTypes` gates; leave the `source_types` column vestigial.
- **Concurrency cap 5**; **250-commit cap** per push with a logged truncation breadcrumb.
- New lib code under the reorg'd paths: `src/lib/integrations/github/`, `src/lib/change-items/`. Tests mirror under `tests/lib/...`.
- Test: `npm test` / `npm test -- <name>`; type-check `npx tsc --noEmit`. Migrations: `npm run db:generate` then `npm run db:migrate`.

---

### Task 1: `ignored` status + `ignored_reason` + migration

**Files:**
- Modify: `src/db/schema.ts` (enum + column)
- Create: `src/db/migrations/0014_*.sql` (generated)
- Test: `tests/lib/change-items/ignored-commit-columns.test.ts`

**Interfaces:**
- Produces: `change_item_status` enum value `"ignored"`; `ignoredReasonEnum` (`ignored_reason`: `merge_commit` / `empty_diff`); `changeItems.ignoredReason` (nullable). Consumed by Tasks 3, 5.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/change-items/ignored-commit-columns.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, repos, changeItems } from "../../../src/db/schema";

const NAME = "Ignored Columns Test Tenant";

describe("ignored change-item columns", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, NAME));
  });

  it("stores an ignored commit with a reason", async () => {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();
    const [repo] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/x", githubInstallationId: "1", watchedBranch: "main" })
      .returning();

    const [row] = await db
      .insert(changeItems)
      .values({
        tenantId: tenant.id, repoId: repo.id, sourceType: "commit",
        status: "ignored", ignoredReason: "merge_commit",
        commitSha: "abc123", commitMessage: "Merge branch 'x'",
      })
      .returning();

    expect(row.status).toBe("ignored");
    expect(row.ignoredReason).toBe("merge_commit");

    const [defaulted] = await db
      .insert(changeItems)
      .values({ tenantId: tenant.id, repoId: repo.id, sourceType: "commit", commitSha: "def456", commitMessage: "x" })
      .returning();
    expect(defaulted.status).toBe("pending");
    expect(defaulted.ignoredReason).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ignored-commit-columns`
Expected: FAIL — `invalid input value for enum change_item_status: "ignored"` / `column "ignored_reason" does not exist`.

- [ ] **Step 3: Update the schema**

In `src/db/schema.ts`, change the `changeItemStatusEnum` (line 48) to add `"ignored"`:

```ts
export const changeItemStatusEnum = pgEnum("change_item_status", ["pending", "batched", "excluded", "ignored"]);
```

Add a new enum near it:

```ts
export const ignoredReasonEnum = pgEnum("ignored_reason", ["merge_commit", "empty_diff"]);
```

Inside the `changeItems` table, after the `status` column, add:

```ts
    ignoredReason: ignoredReasonEnum("ignored_reason"),
```

- [ ] **Step 4: Generate and apply the migration**

Run: `npm run db:generate` (expect `CREATE TYPE "ignored_reason"`, `ALTER TYPE "change_item_status" ADD VALUE 'ignored'`, and `ALTER TABLE "change_items" ADD COLUMN "ignored_reason"`).

Run: `npm run db:migrate`.

**Gotcha:** Postgres cannot use a newly-added enum value in the same transaction that adds it. This migration only *adds* the value and column (doesn't use `'ignored'`), so it applies fine on PG12+. If `db:migrate` errors about `ALTER TYPE ... ADD VALUE` in a transaction, split the `ADD VALUE` into its own migration file ahead of the column add. Do not proceed with a red migration.

- [ ] **Step 5: Run test to verify it passes, then the full suite**

Run: `npm test -- ignored-commit-columns` → PASS.
Run: `npm test` → all green.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/migrations tests/lib/change-items/ignored-commit-columns.test.ts
git commit -m "feat: add ignored status and reason to change_items"
```

---

### Task 2: GitHub client — `listPushCommits`, `getCommitPulls`, `capPushCommits`

**Files:**
- Modify: `src/lib/integrations/github/github.ts`
- Test: `tests/lib/integrations/github/github.test.ts` (add cases)

**Interfaces:**
- Produces:
  - `type PushCommit = { sha: string; message: string; url: string; committedAt: string | null; parents: string[] }`
  - `listPushCommits(installationId, repoFullName, range: { before, after, payloadCommits }): Promise<PushCommit[]>`
  - `getCommitPulls(installationId, repoFullName, sha): Promise<Array<{ number: number; merged: boolean }>>`
  - `capPushCommits<T>(commits: T[], cap: number, ctx: { repoFullName; before; after }): T[]`

- [ ] **Step 1: Write the failing test**

Add to `tests/lib/integrations/github/github.test.ts` (uses the existing octokit-mock pattern — `vi.spyOn(getGithubApp(), "getInstallationOctokit")`):

```ts
import { listPushCommits, getCommitPulls, capPushCommits } from "../../../../src/lib/integrations/github/github";

describe("capPushCommits", () => {
  it("returns the list unchanged at or under the cap", () => {
    const items = [1, 2, 3];
    expect(capPushCommits(items, 3, { repoFullName: "acme/x", before: "a", after: "b" })).toBe(items);
  });

  it("truncates over the cap and logs a breadcrumb", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const items = Array.from({ length: 5 }, (_, i) => i);
    const result = capPushCommits(items, 2, { repoFullName: "acme/x", before: "a", after: "b" });
    expect(result).toHaveLength(2);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("listPushCommits", () => {
  it("falls back to payload commits (no parents) for a new-branch push", async () => {
    const result = await listPushCommits("1", "acme/x", {
      before: "0000000000000000000000000000000000000000",
      after: "aaa",
      payloadCommits: [{ id: "aaa", message: "first", url: "https://x/aaa", timestamp: "2026-07-01T00:00:00Z" }],
    });
    expect(result).toEqual([{ sha: "aaa", message: "first", url: "https://x/aaa", committedAt: "2026-07-01T00:00:00Z", parents: [] }]);
  });

  it("enumerates the compare range with parents", async () => {
    const fakeOctokit = {
      paginate: vi.fn().mockResolvedValue([
        { sha: "c1", html_url: "https://x/c1", commit: { message: "feat", author: { date: "2026-07-01T00:00:00Z" } }, parents: [{ sha: "p1" }] },
        { sha: "m1", html_url: "https://x/m1", commit: { message: "Merge", author: { date: "2026-07-02T00:00:00Z" } }, parents: [{ sha: "p1" }, { sha: "p2" }] },
      ]),
      rest: { repos: { compareCommitsWithBasehead: "COMPARE_ENDPOINT" } },
    };
    const spy = vi.spyOn(getGithubApp(), "getInstallationOctokit").mockResolvedValue(fakeOctokit as never);

    const result = await listPushCommits("1", "acme/x", { before: "b0", after: "b1", payloadCommits: [] });

    expect(result.map((c) => ({ sha: c.sha, parents: c.parents }))).toEqual([
      { sha: "c1", parents: ["p1"] },
      { sha: "m1", parents: ["p1", "p2"] },
    ]);
    spy.mockRestore();
  });
});

describe("getCommitPulls", () => {
  it("maps associated PRs to merged flags", async () => {
    const fakeOctokit = {
      rest: { repos: { listPullRequestsAssociatedWithCommit: vi.fn().mockResolvedValue({ data: [
        { number: 7, merged_at: "2026-07-01T00:00:00Z" },
        { number: 8, merged_at: null },
      ] }) } },
    };
    const spy = vi.spyOn(getGithubApp(), "getInstallationOctokit").mockResolvedValue(fakeOctokit as never);

    const result = await getCommitPulls("1", "acme/x", "c1");

    expect(result).toEqual([{ number: 7, merged: true }, { number: 8, merged: false }]);
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- integrations/github`
Expected: FAIL — the three functions are not exported.

- [ ] **Step 3: Implement the functions**

Append to `src/lib/integrations/github/github.ts`:

```ts
const ZERO_SHA_RE = /^0+$/;
const MAX_PUSH_COMMITS = 250;

export type PushCommit = {
  sha: string;
  message: string;
  url: string;
  committedAt: string | null;
  parents: string[];
};

// Caps the per-push commit list, logging a breadcrumb when it truncates so the
// dropped range is discoverable (recoverable via manual import).
export function capPushCommits<T>(
  commits: T[],
  cap: number,
  ctx: { repoFullName: string; before: string; after: string }
): T[] {
  if (commits.length <= cap) return commits;
  console.warn(
    `[ingest-push] truncated push for ${ctx.repoFullName} ${ctx.before}...${ctx.after}: ` +
      `${commits.length} commits, processing first ${cap}, skipping ${commits.length - cap}`
  );
  return commits.slice(0, cap);
}

export async function listPushCommits(
  installationId: string,
  repoFullName: string,
  range: {
    before: string;
    after: string;
    payloadCommits: Array<{ id: string; message: string; url: string; timestamp: string }>;
  }
): Promise<PushCommit[]> {
  // New-branch push: no base commit to compare against — fall back to the payload
  // commits (which carry no parent info, so none are classified as merge commits).
  if (!range.before || ZERO_SHA_RE.test(range.before)) {
    return range.payloadCommits.map((c) => ({
      sha: c.id,
      message: c.message,
      url: c.url,
      committedAt: c.timestamp,
      parents: [],
    }));
  }

  const [owner, repo] = repoFullName.split("/");
  const installationOctokit = await getGithubApp().getInstallationOctokit(Number(installationId));

  const commits = await installationOctokit.paginate(
    installationOctokit.rest.repos.compareCommitsWithBasehead,
    { owner, repo, basehead: `${range.before}...${range.after}`, per_page: 100 },
    (response) => response.data.commits
  );

  const mapped: PushCommit[] = commits.map((c) => ({
    sha: c.sha,
    message: c.commit.message,
    url: c.html_url,
    committedAt: c.commit.author?.date ?? c.commit.committer?.date ?? null,
    parents: (c.parents ?? []).map((p) => p.sha),
  }));

  return capPushCommits(mapped, MAX_PUSH_COMMITS, { repoFullName, before: range.before, after: range.after });
}

export async function getCommitPulls(
  installationId: string,
  repoFullName: string,
  sha: string
): Promise<Array<{ number: number; merged: boolean }>> {
  const [owner, repo] = repoFullName.split("/");
  const installationOctokit = await getGithubApp().getInstallationOctokit(Number(installationId));
  const { data } = await installationOctokit.rest.repos.listPullRequestsAssociatedWithCommit({
    owner,
    repo,
    commit_sha: sha,
  });
  return data.map((pr) => ({ number: pr.number, merged: pr.merged_at != null }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- integrations/github` → PASS. (If octokit's `paginate` typing rejects the map-callback form, use `installationOctokit.paginate(rest.repos.compareCommitsWithBasehead, {...})` and read `.commits` off each page — verify against the installed octokit version.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/integrations/github/github.ts tests/lib/integrations/github/github.test.ts
git commit -m "feat: add listPushCommits and getCommitPulls github helpers"
```

---

### Task 3: Refactor `ingestPush` to classify commits

**Files:**
- Modify: `src/lib/change-items/ingest-push.ts` (full rewrite)
- Modify: `src/app/api/webhooks/github/route.ts` (adapt the push call to the new signature — still inline; `after()` comes in Task 4)
- Test: `tests/lib/change-items/ingest-push.test.ts` (full rewrite)

**Interfaces:**
- Consumes: `listPushCommits`/`getCommitPulls`/`getCommitDiff`/`PushCommit` (Task 2), `ignored` status + `ignoredReason` (Task 1), `enrichChangeItem` (A), `mapWithConcurrency`.
- Produces: `ingestPush(input: PushInput, deps?: IngestPushDeps): Promise<void>` where `PushInput = { installationId, repoFullName, ref, before, after, payloadCommits }` and `IngestPushDeps` injects `{ listPushCommits, getCommitPulls, getCommitDiff, enrich, database }`.

- [ ] **Step 1: Rewrite the test**

Replace `tests/lib/change-items/ingest-push.test.ts` with (real DB for inserts; all GitHub/enrich deps injected):

```ts
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, repos, changeItems } from "../../../src/db/schema";
import { ingestPush } from "../../../src/lib/change-items/ingest-push";
import type { PushCommit } from "../../../src/lib/integrations/github/github";
import type { EnrichChangeItem } from "../../../src/lib/ai/enrich-change-item";

const NAME = "Push Ingest Test Tenant";

function commit(over: Partial<PushCommit> = {}): PushCommit {
  return { sha: "s1", message: "m", url: "https://x/s1", committedAt: "2026-07-01T00:00:00Z", parents: ["p1"], ...over };
}

const enrichAllFacing: EnrichChangeItem = async () => ({ userFacing: true, impactSummary: "does a thing", suggestedCategory: "improved", confidence: 0.9 });
const noPulls = async () => [] as Array<{ number: number; merged: boolean }>;

describe("ingestPush classification", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, NAME));
  });

  async function seed() {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();
    const [repo] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/x", githubInstallationId: "90", watchedBranch: "main", sourceTypes: ["pr"] })
      .returning();
    return { tenant, repo };
  }

  const baseInput = { installationId: "90", repoFullName: "acme/x", ref: "refs/heads/main", before: "b0", after: "b1", payloadCommits: [] };

  it("enriches a substantive direct commit as pending", async () => {
    const { tenant } = await seed();
    await ingestPush(baseInput, {
      listPushCommits: async () => [commit({ sha: "feat1", parents: ["p1"] })],
      getCommitPulls: noPulls,
      getCommitDiff: async () => "diff --git a/x b/x\n+real change",
      enrich: enrichAllFacing,
    });
    const [row] = await db.select().from(changeItems).where(eq(changeItems.tenantId, tenant.id));
    expect(row).toMatchObject({ status: "pending", ignoredReason: null, commitSha: "feat1", userFacing: true, suggestedCategory: "improved" });
  });

  it("ignores a non-PR merge commit without fetching a diff or enriching", async () => {
    const { tenant } = await seed();
    let diffCalls = 0;
    await ingestPush(baseInput, {
      listPushCommits: async () => [commit({ sha: "merge1", parents: ["p1", "p2"] })],
      getCommitPulls: noPulls,
      getCommitDiff: async () => { diffCalls++; return "x"; },
      enrich: enrichAllFacing,
    });
    const [row] = await db.select().from(changeItems).where(eq(changeItems.tenantId, tenant.id));
    expect(row).toMatchObject({ status: "ignored", ignoredReason: "merge_commit", commitSha: "merge1", userFacing: null });
    expect(diffCalls).toBe(0);
  });

  it("ignores an empty-diff commit without enriching", async () => {
    const { tenant } = await seed();
    let enrichCalls = 0;
    await ingestPush(baseInput, {
      listPushCommits: async () => [commit({ sha: "empty1", parents: ["p1"] })],
      getCommitPulls: noPulls,
      getCommitDiff: async () => "   ",
      enrich: async (x) => { enrichCalls++; return enrichAllFacing(x); },
    });
    const [row] = await db.select().from(changeItems).where(eq(changeItems.tenantId, tenant.id));
    expect(row).toMatchObject({ status: "ignored", ignoredReason: "empty_diff", commitSha: "empty1" });
    expect(enrichCalls).toBe(0);
  });

  it("drops a commit associated with a merged PR (including a merge commit)", async () => {
    const { tenant } = await seed();
    await ingestPush(baseInput, {
      listPushCommits: async () => [commit({ sha: "prmerge", parents: ["p1", "p2"] }), commit({ sha: "prsquash", parents: ["p1"] })],
      getCommitPulls: async () => [{ number: 42, merged: true }],
      getCommitDiff: async () => "diff",
      enrich: enrichAllFacing,
    });
    const rows = await db.select().from(changeItems).where(eq(changeItems.tenantId, tenant.id));
    expect(rows).toHaveLength(0);
  });

  it("ignores pushes to a non-watched branch", async () => {
    const { tenant } = await seed();
    let listed = false;
    await ingestPush({ ...baseInput, ref: "refs/heads/feature" }, {
      listPushCommits: async () => { listed = true; return []; },
      getCommitPulls: noPulls, getCommitDiff: async () => "x", enrich: enrichAllFacing,
    });
    expect(listed).toBe(false);
    expect(await db.select().from(changeItems).where(eq(changeItems.tenantId, tenant.id))).toHaveLength(0);
  });

  it("is idempotent on re-delivery (onConflictDoNothing)", async () => {
    const { tenant } = await seed();
    const deps = { listPushCommits: async () => [commit({ sha: "dup1" })], getCommitPulls: noPulls, getCommitDiff: async () => "real", enrich: enrichAllFacing };
    await ingestPush(baseInput, deps);
    await ingestPush(baseInput, deps);
    expect(await db.select().from(changeItems).where(eq(changeItems.tenantId, tenant.id))).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- change-items/ingest-push`
Expected: FAIL — the new `ingestPush(input, deps)` signature/classification doesn't exist yet.

- [ ] **Step 3: Rewrite `ingest-push.ts`**

Replace the contents of `src/lib/change-items/ingest-push.ts` with:

```ts
import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { repos, changeItems } from "@/db/schema";
import {
  truncateDiff,
  getCommitDiff,
  listPushCommits,
  getCommitPulls,
  type PushCommit,
} from "@/lib/integrations/github/github";
import { mapWithConcurrency } from "@/lib/concurrency";
import { enrichChangeItem, type EnrichChangeItem, type EnrichmentResult } from "@/lib/ai/enrich-change-item";

const ENRICH_CONCURRENCY = 5;

export type PushInput = {
  installationId: string;
  repoFullName: string;
  ref: string;
  before: string;
  after: string;
  payloadCommits: Array<{ id: string; message: string; url: string; timestamp: string }>;
};

export type IngestPushDeps = {
  listPushCommits?: typeof listPushCommits;
  getCommitPulls?: typeof getCommitPulls;
  getCommitDiff?: typeof getCommitDiff;
  enrich?: EnrichChangeItem;
  database?: typeof defaultDb;
};

type RepoRow = typeof repos.$inferSelect;

async function insertCommit(
  database: typeof defaultDb,
  repo: RepoRow,
  commit: PushCommit,
  opts: {
    status: "pending" | "ignored";
    ignoredReason: "merge_commit" | "empty_diff" | null;
    diff: string | null;
    enrichment: EnrichmentResult | null;
  }
): Promise<void> {
  await database
    .insert(changeItems)
    .values({
      tenantId: repo.tenantId,
      repoId: repo.id,
      sourceType: "commit",
      status: opts.status,
      ignoredReason: opts.ignoredReason,
      commitSha: commit.sha,
      commitMessage: commit.message,
      commitUrl: commit.url,
      committedAt: commit.committedAt ? new Date(commit.committedAt) : null,
      diff: opts.diff,
      userFacing: opts.enrichment?.userFacing ?? null,
      impactSummary: opts.enrichment?.impactSummary ?? null,
      suggestedCategory: opts.enrichment?.suggestedCategory ?? null,
      enrichmentConfidence: opts.enrichment?.confidence ?? null,
      enrichedAt: opts.enrichment ? new Date() : null,
    })
    .onConflictDoNothing();
}

export async function ingestPush(input: PushInput, deps: IngestPushDeps = {}): Promise<void> {
  const listCommits = deps.listPushCommits ?? listPushCommits;
  const commitPulls = deps.getCommitPulls ?? getCommitPulls;
  const commitDiff = deps.getCommitDiff ?? getCommitDiff;
  const enrich = deps.enrich ?? enrichChangeItem;
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

  await mapWithConcurrency(commits, ENRICH_CONCURRENCY, async (commit) => {
    // 1. Belongs to a merged PR → drop (the PR is its own rich item).
    const pulls = await commitPulls(input.installationId, input.repoFullName, commit.sha);
    if (pulls.some((p) => p.merged)) return;

    // 2. Merge commit with no associated PR → ignored (no diff, no enrichment).
    if (commit.parents.length >= 2) {
      await insertCommit(database, repo, commit, { status: "ignored", ignoredReason: "merge_commit", diff: null, enrichment: null });
      return;
    }

    // 3. Empty diff → ignored (no enrichment).
    const diff = truncateDiff(await commitDiff(input.installationId, input.repoFullName, commit.sha));
    if (diff.trim() === "") {
      await insertCommit(database, repo, commit, { status: "ignored", ignoredReason: "empty_diff", diff, enrichment: null });
      return;
    }

    // 4. Substantive → enrich + pending.
    const enrichment = await enrich({ sourceType: "commit", repoName: input.repoFullName, commitMessage: commit.message, diff });
    await insertCommit(database, repo, commit, { status: "pending", ignoredReason: null, diff, enrichment });
  });
}
```

- [ ] **Step 4: Adapt the route's push call to the new signature (still inline)**

In `src/app/api/webhooks/github/route.ts`, replace the `if (event === "push") { … }` block with:

```ts
    if (event === "push") {
      await ingestPush({
        installationId: String(payload.installation.id),
        repoFullName: payload.repository.full_name,
        ref: payload.ref,
        before: payload.before,
        after: payload.after,
        payloadCommits: payload.commits.map((c: { id: string; message: string; url: string; timestamp: string }) => ({
          id: c.id,
          message: c.message,
          url: c.url,
          timestamp: c.timestamp,
        })),
      });
    }
```

(The old `getCommitDiff` callback import in the route is no longer used by the push path — remove it if nothing else uses it; the PR path doesn't.)

- [ ] **Step 5: Run tests + type-check**

Run: `npm test -- change-items/ingest-push` → PASS.
Run: `npx tsc --noEmit` → no errors.
Run: `npm test` → all green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/change-items/ingest-push.ts "src/app/api/webhooks/github/route.ts" tests/lib/change-items/ingest-push.test.ts
git commit -m "feat: classify pushed commits (drop PR, ignore merge/empty, enrich rest)"
```

---

### Task 4: Route ack-fast via `after()` + remove PR `sourceTypes` gate

**Files:**
- Modify: `src/app/api/webhooks/github/route.ts`
- Modify: `src/lib/change-items/ingest-pull-request.ts` (drop the gate)
- Test: `tests/lib/change-items/ingest-pull-request.test.ts` (update)

- [ ] **Step 1: Verify `after` exists, then ack-fast the push path**

Confirm `after` is exported from `next/server` in this repo's Next (grep `node_modules/next/dist/…` or the package types). If it is **not** available, STOP and flag (fallback = persist-and-cron, out of scope).

In `src/app/api/webhooks/github/route.ts`, add the import and wrap the push processing so it runs after the response:

```ts
import { after } from "next/server";
```

Replace the `if (event === "push") { await ingestPush({...}); }` block (from Task 3) with a scheduled version that builds the input, then defers the work:

```ts
    if (event === "push") {
      const pushInput = {
        installationId: String(payload.installation.id),
        repoFullName: payload.repository.full_name,
        ref: payload.ref,
        before: payload.before,
        after: payload.after,
        payloadCommits: payload.commits.map((c: { id: string; message: string; url: string; timestamp: string }) => ({
          id: c.id, message: c.message, url: c.url, timestamp: c.timestamp,
        })),
      };
      after(async () => {
        try {
          await ingestPush(pushInput);
        } catch (error) {
          console.error("Deferred push ingestion failed:", error);
        }
      });
    }
```

(The route still returns `{ ok: true }` immediately. The PR path stays inline inside the existing try/catch — it's bounded.)

- [ ] **Step 2: Remove the PR `sourceTypes` gate**

In `src/lib/change-items/ingest-pull-request.ts`, change the guard so it no longer requires `"pr"` in `sourceTypes`:

```ts
  if (!repo) return;
  if (input.baseBranch !== repo.watchedBranch) return;
```

(Remove the `!repo.sourceTypes.includes("pr")` clause; keep the `!repo` and branch checks.)

- [ ] **Step 3: Update the PR-ingest test**

In `tests/lib/change-items/ingest-pull-request.test.ts`, the test asserting a `sourceTypes: ["commit"]` (pr-excluded) repo ingests **nothing** is now obsolete — a merged PR is ingested regardless of `sourceTypes`. Replace that test's expectation: seed the repo with `sourceTypes: ["commit"]`, ingest a merged PR, and assert **one** pr-sourced change item **is** created. Keep the other tests.

- [ ] **Step 4: Run tests + type-check**

Run: `npm test -- change-items/ingest-pull-request` → PASS.
Run: `npx tsc --noEmit` → no errors.
Run: `npm test` → all green.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/webhooks/github/route.ts" src/lib/change-items/ingest-pull-request.ts tests/lib/change-items/ingest-pull-request.test.ts
git commit -m "feat: ack push webhooks fast and always ingest merged PRs"
```

---

### Task 5: Show ignored commits in the Pending tracked list

**Files:**
- Modify: `src/lib/change-items/change-item-batch.ts` (add `getTrackedChangeItems`)
- Modify: `src/lib/change-items/change-item-display.ts` (add `ignoredReasonLabel`)
- Modify: `src/app/(dashboard)/pending/page.tsx` (use the tracked query; render ignored rows)
- Test: `tests/lib/change-items/change-item-batch.test.ts` + `tests/lib/change-items/change-item-display.test.ts` (add cases)

**Interfaces:**
- Consumes: `ignored` status + `ignoredReason` (Task 1).
- Produces: `getTrackedChangeItems(tenantId, database?)` (status in `pending`/`ignored`); `ignoredReasonLabel(reason): string | null`.

- [ ] **Step 1: Write the failing tests**

In `tests/lib/change-items/change-item-batch.test.ts`, add `getTrackedChangeItems` to the import and add:

```ts
  it("getTrackedChangeItems returns pending and ignored items, excluding batched/excluded", async () => {
    const { tenant, repoA } = await seed();
    await db.insert(changeItems).values([
      { tenantId: tenant.id, repoId: repoA.id, sourceType: "commit", status: "pending", commitSha: "p1", commitMessage: "p" },
      { tenantId: tenant.id, repoId: repoA.id, sourceType: "commit", status: "ignored", ignoredReason: "merge_commit", commitSha: "i1", commitMessage: "m" },
      { tenantId: tenant.id, repoId: repoA.id, sourceType: "commit", status: "excluded", commitSha: "x1", commitMessage: "x" },
    ]);
    const tracked = await getTrackedChangeItems(tenant.id);
    expect(tracked.map((t) => t.commitSha).sort()).toEqual(["i1", "p1"]);
    // generation still excludes ignored:
    const batchable = await getBatchableChangeItems(tenant.id);
    expect(batchable.map((b) => b.commitSha)).toEqual(["p1"]);
  });
```

Create `tests/lib/change-items/change-item-display.test.ts` additions (or new block) for the label:

```ts
import { ignoredReasonLabel } from "../../../src/lib/change-items/change-item-display";

describe("ignoredReasonLabel", () => {
  it("labels the ignore reasons", () => {
    expect(ignoredReasonLabel("merge_commit")).toBe("merge commit");
    expect(ignoredReasonLabel("empty_diff")).toBe("empty diff");
    expect(ignoredReasonLabel(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- change-item-batch change-item-display`
Expected: FAIL — `getTrackedChangeItems` / `ignoredReasonLabel` not exported.

- [ ] **Step 3: Add `getTrackedChangeItems`**

In `src/lib/change-items/change-item-batch.ts`, ensure `inArray` is imported from `drizzle-orm`, then add:

```ts
/**
 * The tracked-list query for the Pending page: pending items (actionable) plus
 * ignored ones (merge/empty commits, shown dimmed for transparency). Excludes
 * batched/excluded. Generation uses getBatchableChangeItems, which is pending-only.
 */
export async function getTrackedChangeItems(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<ChangeItemRow[]> {
  return database
    .select()
    .from(changeItems)
    .where(and(eq(changeItems.tenantId, tenantId), inArray(changeItems.status, ["pending", "ignored"])))
    .orderBy(changeItems.createdAt);
}
```

- [ ] **Step 4: Add the label helper**

Append to `src/lib/change-items/change-item-display.ts`:

```ts
export function ignoredReasonLabel(reason: "merge_commit" | "empty_diff" | null): string | null {
  switch (reason) {
    case "merge_commit":
      return "merge commit";
    case "empty_diff":
      return "empty diff";
    default:
      return null;
  }
}
```

- [ ] **Step 5: Render ignored rows on the Pending page**

In `src/app/(dashboard)/pending/page.tsx`:

- Switch the list query: import and call `getTrackedChangeItems` instead of `getPendingChangeItems` for the page's `pending` variable (rename it `tracked` if you like). Import `ignoredReasonLabel`.
- The header count "N changes waiting to be announced" should count only actionable rows: `tracked.filter((t) => t.status === "pending").length` (ignored aren't waiting to be announced).
- In the row map, add `const isIgnored = item.status === "ignored";`. Dim ignored rows (`opacity-60`), and in the Change cell render an ignored badge instead of the facing badges:

```tsx
                    {isIgnored ? (
                      <Badge variant="outline" className="mt-1 text-muted-foreground">
                        Ignored · {ignoredReasonLabel(item.ignoredReason)}
                      </Badge>
                    ) : facingState === "non-facing" ? (
                      <Badge variant="outline" className="mt-1 text-muted-foreground">Not user-facing</Badge>
                    ) : facingState === "low-confidence" ? (
                      <Badge variant="outline" className="mt-1 text-muted-foreground">Low confidence</Badge>
                    ) : null}
```

- In the actions cell, render no Include/Drop buttons for ignored rows (they're informational): wrap the existing action `<div>` in `{!isIgnored && ( … )}`.
- The empty-state guard stays `if (tracked.length === 0)` — a repo with only ignored commits still shows the table (with the ignored rows), which is the intended transparency.

- [ ] **Step 6: Type-check + full suite**

Run: `npx tsc --noEmit` → no errors.
Run: `npm test` → all green.

- [ ] **Step 7: Manually verify (per the `verify` skill)**

Behind OAuth: seed a repo with a `pending` commit, an `ignored/merge_commit`, and an `ignored/empty_diff`; open `/pending` — the ignored rows show dimmed with "Ignored · merge commit" / "Ignored · empty diff", no action buttons, and the header counts only the pending one. If not drivable, note manual verification pending.

- [ ] **Step 8: Commit**

```bash
git add src/lib/change-items/change-item-batch.ts src/lib/change-items/change-item-display.ts "src/app/(dashboard)/pending/page.tsx" tests/lib/change-items/change-item-batch.test.ts tests/lib/change-items/change-item-display.test.ts
git commit -m "feat: show ignored commits in the pending tracked list"
```

---

## Self-Review

**Spec coverage:**
- §1 always-ingest-both (remove gates) → ingest-push rewrite drops its gate (Task 3); PR gate removed (Task 4). ✓
- §2 ack-fast + `after()` → Task 4. ✓
- §3 full enumeration (compare API + parents, 250 cap + log, new-branch fallback) → `listPushCommits`/`capPushCommits` (Task 2). ✓
- §4 classification precedence (PR-drop → merge → empty → enrich) → `ingestPush` (Task 3), test-covered. ✓
- §5 data model (`ignored` status + `ignored_reason`) → Task 1. ✓
- §6 tracked-list UI (dimmed ignored rows + label, excluded from generation, not force-includable) → Task 5. ✓
- §7 injectable `ingestPush` + client fns → Tasks 2, 3. ✓
- §8 testing → each task. ✓
- Scope: `source_types` left vestigial; no queue infra; PR-associated dropped not shown. ✓

**Placeholder scan:** No TBD/TODO. Complete code for schema, client fns, `ingestPush`, and tests; precise edits for route + Pending page. The two verification-dependent bits (`after` existence, octokit `paginate` compare shape) are called out with explicit checks, not left vague. ✓

**Type consistency:** `PushCommit` (Task 2) is imported by `ingestPush` and its test (Task 3). `IngestPushDeps` fns default to the real Task-2 exports. `ignoredReason` values `merge_commit`/`empty_diff` are consistent across schema (Task 1), `ingestPush` inserts (Task 3), `ignoredReasonLabel` (Task 5), and tests. The route builds `PushInput` matching the Task-3 signature. `getTrackedChangeItems` returns `ChangeItemRow[]` like the sibling queries. ✓

**Ordering:** 1 (schema) → 2 (client) → 3 (ingestPush + route signature) → 4 (route `after` + PR gate) → 5 (UI). Task 3 needs 1+2; Task 4 needs 3; Task 5 needs 1. Each task leaves `tsc` + tests green.
