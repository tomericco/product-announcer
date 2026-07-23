import { describe, it, expect, afterEach, vi } from "vitest";

// Structural backstop: the real auto-resolver + summary regen make live
// Anthropic calls. This core deliberately SKIPS the resolver and injects
// `createFromEvents` (whose refresh we mock), so nothing should reach Anthropic
// — but mock the module regardless in case a path falls through.
vi.mock("../../../src/lib/change-events/pipeline", () => ({ resolvePendingEvents: vi.fn() }));

import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, repos, changeEvents } from "../../../src/db/schema";
import { createAtomicUpdateFromImportedCommits } from "../../../src/lib/change-events/create-from-import";
import { createAtomicUpdateFromEvents } from "../../../src/lib/change-events/create-from-events";
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
});
