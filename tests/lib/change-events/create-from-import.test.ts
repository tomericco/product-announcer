import { describe, it, expect, afterEach, vi } from "vitest";

// Structural backstop: the real auto-resolver + summary regen make live
// Anthropic calls. This core deliberately SKIPS the resolver and injects
// `createFromEvents` (whose refresh we mock), so nothing should reach Anthropic
// — but mock the module regardless in case a path falls through.
vi.mock("../../../src/lib/change-events/pipeline", () => ({ resolvePendingEvents: vi.fn() }));

import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, repos, changeEvents, atomicUpdates } from "../../../src/db/schema";
import {
  createAtomicUpdateFromImportedCommits,
  createAtomicUpdateFromImportedPullRequests,
  createAtomicUpdateFromImportedTasks,
  addImportedCommitsToAtomicUpdate,
  addImportedPullRequestsToAtomicUpdate,
  addImportedTasksToAtomicUpdate,
} from "../../../src/lib/change-events/create-from-import";
import { createAtomicUpdateFromEvents } from "../../../src/lib/change-events/create-from-events";
import { addEventsToExistingAtomicUpdate } from "../../../src/lib/change-events/add-events-to-atomic-update";
import type { EnrichChangeItem } from "../../../src/lib/ai/enrich-change-item";

const NAME = "Create From Import Test Tenant";

describe("createAtomicUpdateFromImportedCommits", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, NAME));
  });

  async function seedRepo() {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();
    const [repo] = await db
      .insert(repos)
      .values({
        tenantId: tenant.id,
        githubRepoFullName: "acme/cfi",
        githubInstallationId: "80001",
        watchedBranch: "main",
        sourceTypes: ["commit"],
      })
      .returning();
    return { tenant, repo };
  }

  // Real grouping (createAtomicUpdateFromEvents) against the test DB, but with
  // the LLM summary refresh mocked out.
  const groupWithMockedRefresh: typeof createAtomicUpdateFromEvents = (input) =>
    createAtomicUpdateFromEvents(input, { database: db, refresh: vi.fn() });

  it("imports the selected commits and groups them all into ONE new atomic update", async () => {
    const { tenant, repo } = await seedRepo();
    const getCommitDiff = vi.fn().mockResolvedValue("diff");
    const enrich: EnrichChangeItem = async () => ({
      userFacing: true,
      impactSummary: "does a thing",
      suggestedCategory: "new",
      confidence: 0.9,
    });

    const result = await createAtomicUpdateFromImportedCommits(
      {
        tenantId: tenant.id,
        userId: "u1",
        selections: [
          { repoId: repo.id, sha: "aaa", message: "A", url: "uA", committedAt: null },
          { repoId: repo.id, sha: "bbb", message: "B", url: "uB", committedAt: null },
        ],
      },
      { getCommitDiff, enrich, createFromEvents: groupWithMockedRefresh }
    );

    expect(result.ok).toBe(true);

    const events = await db
      .select()
      .from(changeEvents)
      .where(and(eq(changeEvents.tenantId, tenant.id), eq(changeEvents.type, "commit")));
    expect(events).toHaveLength(2);
    // Both attached to the SAME (single) new atomic update — not auto-clustered
    // into separate ones (the resolver was skipped).
    const auIds = new Set(events.map((e) => e.atomicUpdateId));
    expect(auIds.size).toBe(1);
    expect([...auIds][0]).not.toBeNull();
  });

  it("groups non-user-facing events too (all selected, not just resolvable)", async () => {
    const { tenant, repo } = await seedRepo();
    const getCommitDiff = vi.fn().mockResolvedValue("diff");
    // Everything enriches as NOT user-facing — the auto-resolver would skip
    // these, but an explicit manual grouping must still include them.
    const enrich: EnrichChangeItem = async () => ({
      userFacing: false,
      impactSummary: null,
      suggestedCategory: null,
      confidence: 0.1,
    });

    const result = await createAtomicUpdateFromImportedCommits(
      {
        tenantId: tenant.id,
        userId: "u1",
        selections: [{ repoId: repo.id, sha: "ccc", message: "C", url: "uC", committedAt: null }],
      },
      { getCommitDiff, enrich, createFromEvents: groupWithMockedRefresh }
    );

    expect(result.ok).toBe(true);
    const [event] = await db
      .select()
      .from(changeEvents)
      .where(and(eq(changeEvents.tenantId, tenant.id), eq(changeEvents.commitSha, "ccc")));
    expect(event.atomicUpdateId).not.toBeNull();
  });

  it("imports the selected pull requests and groups them into ONE new atomic update", async () => {
    const { tenant, repo } = await seedRepo();
    const enrich: EnrichChangeItem = async () => ({
      userFacing: true,
      impactSummary: "does a thing",
      suggestedCategory: "new",
      confidence: 0.9,
    });

    const result = await createAtomicUpdateFromImportedPullRequests(
      {
        tenantId: tenant.id,
        userId: "u1",
        selections: [
          { repoId: repo.id, number: 1, title: "A", body: "a", url: "uA", mergedAt: "2026-07-01T00:00:00Z" },
          { repoId: repo.id, number: 2, title: "B", body: "b", url: "uB", mergedAt: "2026-07-02T00:00:00Z" },
        ],
      },
      { enrich, createFromEvents: groupWithMockedRefresh }
    );

    expect(result.ok).toBe(true);
    const events = await db
      .select()
      .from(changeEvents)
      .where(and(eq(changeEvents.tenantId, tenant.id), eq(changeEvents.type, "pull_request")));
    expect(events).toHaveLength(2);
    const auIds = new Set(events.map((e) => e.atomicUpdateId));
    expect(auIds.size).toBe(1);
    expect([...auIds][0]).not.toBeNull();
  });

  // Notion tasks aren't repo-scoped, so this needs a tenant but no repo.
  it("imports the selected Notion tasks and groups them into ONE new atomic update", async () => {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();
    const enrich: EnrichChangeItem = async () => ({
      userFacing: true,
      impactSummary: "does a thing",
      suggestedCategory: "new",
      confidence: 0.9,
    });

    const result = await createAtomicUpdateFromImportedTasks(
      {
        tenantId: tenant.id,
        userId: "u1",
        selections: [
          { pageId: "page-a", title: "A", url: "uA", completedAt: "2026-07-01T00:00:00Z" },
          { pageId: "page-b", title: "B", url: "uB", completedAt: "2026-07-02T00:00:00Z" },
        ],
      },
      async () => "task body",
      { enrich, createFromEvents: groupWithMockedRefresh }
    );

    expect(result.ok).toBe(true);
    const events = await db
      .select()
      .from(changeEvents)
      .where(and(eq(changeEvents.tenantId, tenant.id), eq(changeEvents.type, "task")));
    expect(events).toHaveLength(2);
    const auIds = new Set(events.map((e) => e.atomicUpdateId));
    expect(auIds.size).toBe(1);
    expect([...auIds][0]).not.toBeNull();
  });

  // The whole point of the flow: without NO_RESOLVE the auto-resolver would
  // scatter freshly imported tasks across generated updates instead of leaving
  // them for createAtomicUpdateFromEvents to fold into one.
  it("does not run the auto-resolver on imported tasks", async () => {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();
    const { resolvePendingEvents } = await import("../../../src/lib/change-events/pipeline");
    vi.mocked(resolvePendingEvents).mockClear();

    await createAtomicUpdateFromImportedTasks(
      {
        tenantId: tenant.id,
        userId: "u1",
        selections: [{ pageId: "page-c", title: "C", url: "uC", completedAt: null }],
      },
      async () => "body",
      {
        enrich: async () => ({
          userFacing: true,
          impactSummary: "x",
          suggestedCategory: "new",
          confidence: 0.9,
        }),
        createFromEvents: groupWithMockedRefresh,
      }
    );

    expect(vi.mocked(resolvePendingEvents)).not.toHaveBeenCalled();
  });
});

describe("addImportedCommitsToAtomicUpdate / …PullRequests…", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, NAME));
  });

  async function seedRepoAndUpdate() {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();
    const [repo] = await db
      .insert(repos)
      .values({
        tenantId: tenant.id,
        githubRepoFullName: "acme/cfi2",
        githubInstallationId: "80002",
        watchedBranch: "main",
        sourceTypes: ["commit"],
      })
      .returning();
    const [au] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Existing", summary: "S", status: "open" })
      .returning();
    return { tenant, repo, au };
  }

  // Real add (addEventsToExistingAtomicUpdate) against the test DB, LLM regen mocked.
  const addWithMockedRefresh: typeof addEventsToExistingAtomicUpdate = (input) =>
    addEventsToExistingAtomicUpdate(input, { database: db, refresh: vi.fn() });

  it("imports the selected commits and attaches them to the existing atomic update", async () => {
    const { tenant, repo, au } = await seedRepoAndUpdate();
    const getCommitDiff = vi.fn().mockResolvedValue("diff");
    const enrich: EnrichChangeItem = async () => ({
      userFacing: true,
      impactSummary: "x",
      suggestedCategory: "new",
      confidence: 0.9,
    });

    const result = await addImportedCommitsToAtomicUpdate(
      {
        tenantId: tenant.id,
        userId: "u1",
        atomicUpdateId: au.id,
        selections: [
          { repoId: repo.id, sha: "a1", message: "A", url: "uA", committedAt: null },
          { repoId: repo.id, sha: "b1", message: "B", url: "uB", committedAt: null },
        ],
      },
      { getCommitDiff, enrich, addEvents: addWithMockedRefresh }
    );

    expect(result.ok).toBe(true);
    const events = await db.select().from(changeEvents).where(eq(changeEvents.atomicUpdateId, au.id));
    expect(events.map((e) => e.commitSha).sort()).toEqual(["a1", "b1"]);
  });

  it("imports the selected PRs and attaches them to the existing atomic update", async () => {
    const { tenant, repo, au } = await seedRepoAndUpdate();
    const enrich: EnrichChangeItem = async () => ({
      userFacing: true,
      impactSummary: "x",
      suggestedCategory: "new",
      confidence: 0.9,
    });

    const result = await addImportedPullRequestsToAtomicUpdate(
      {
        tenantId: tenant.id,
        userId: "u1",
        atomicUpdateId: au.id,
        selections: [{ repoId: repo.id, number: 5, title: "P", body: "p", url: "uP", mergedAt: "2026-07-01T00:00:00Z" }],
      },
      { enrich, addEvents: addWithMockedRefresh }
    );

    expect(result.ok).toBe(true);
    const events = await db.select().from(changeEvents).where(eq(changeEvents.atomicUpdateId, au.id));
    expect(events.map((e) => e.prNumber)).toEqual([5]);
  });

  // Tasks aren't repo-scoped, so this seeds only a tenant and an update.
  it("imports the selected Notion tasks and attaches them to the existing atomic update", async () => {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();
    const [au] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Existing", summary: "S", status: "open" })
      .returning();
    const enrich: EnrichChangeItem = async () => ({
      userFacing: true,
      impactSummary: "x",
      suggestedCategory: "new",
      confidence: 0.9,
    });

    const result = await addImportedTasksToAtomicUpdate(
      {
        tenantId: tenant.id,
        userId: "u1",
        atomicUpdateId: au.id,
        selections: [
          { pageId: "page-x", title: "X", url: "uX", completedAt: "2026-07-01T00:00:00Z" },
          { pageId: "page-y", title: "Y", url: "uY", completedAt: null },
        ],
      },
      async () => "task body",
      { enrich, addEvents: addWithMockedRefresh }
    );

    expect(result.ok).toBe(true);
    const events = await db.select().from(changeEvents).where(eq(changeEvents.atomicUpdateId, au.id));
    expect(events.map((e) => e.externalId).sort()).toEqual(["page-x", "page-y"]);
  });
});
