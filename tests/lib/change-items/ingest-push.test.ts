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
