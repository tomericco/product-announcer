import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, repos, changeEvents } from "../../../src/db/schema";
import { ingestPush } from "../../../src/lib/change-events/ingest-push";
import type { PushCommit } from "../../../src/lib/integrations/github/github";
import type { EnrichChangeItem } from "../../../src/lib/ai/enrich-change-item";

const NAME = "Push Ingest Test Tenant";

function commit(over: Partial<PushCommit> = {}): PushCommit {
  return { sha: "s1", message: "m", url: "https://x/s1", committedAt: "2026-07-01T00:00:00Z", parents: ["p1"], ...over };
}

const enrichAllFacing: EnrichChangeItem = async () => ({ userFacing: true, impactSummary: "does a thing", suggestedCategory: "improved", confidence: 0.9 });
const noPulls = async () => [] as Array<{ number: number; merged: boolean; baseRef: string }>;

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

  const PUSHED_AT = new Date("2026-03-04T10:00:00Z");
  const baseInput = { installationId: "90", repoFullName: "acme/x", ref: "refs/heads/main", before: "b0", after: "b1", pushedAt: PUSHED_AT, payloadCommits: [] };

  it("enriches a substantive direct commit as pending", async () => {
    const { tenant } = await seed();
    await ingestPush(baseInput, {
      listPushCommits: async () => [commit({ sha: "feat1", parents: ["p1"] })],
      getCommitPulls: noPulls,
      getCommitDiff: async () => "diff --git a/x b/x\n+real change",
      enrich: enrichAllFacing,
      resolvePending: vi.fn(),
    });
    const [row] = await db.select().from(changeEvents).where(eq(changeEvents.tenantId, tenant.id));
    expect(row).toMatchObject({ status: "pending", filterReason: null, commitSha: "feat1", userFacing: true, suggestedCategory: "improved" });
  });

  it("ignores a non-PR merge commit without fetching a diff or enriching", async () => {
    const { tenant } = await seed();
    let diffCalls = 0;
    await ingestPush(baseInput, {
      listPushCommits: async () => [commit({ sha: "merge1", parents: ["p1", "p2"] })],
      getCommitPulls: noPulls,
      getCommitDiff: async () => { diffCalls++; return "x"; },
      enrich: enrichAllFacing,
      resolvePending: vi.fn(),
    });
    const [row] = await db.select().from(changeEvents).where(eq(changeEvents.tenantId, tenant.id));
    expect(row).toMatchObject({ status: "ignored", filterReason: "merge_commit", commitSha: "merge1", userFacing: null });
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
      resolvePending: vi.fn(),
    });
    const [row] = await db.select().from(changeEvents).where(eq(changeEvents.tenantId, tenant.id));
    expect(row).toMatchObject({ status: "ignored", filterReason: "empty_diff", commitSha: "empty1" });
    expect(enrichCalls).toBe(0);
  });

  it("drops a commit associated with a merged PR (including a merge commit)", async () => {
    const { tenant } = await seed();
    await ingestPush(baseInput, {
      listPushCommits: async () => [commit({ sha: "prmerge", parents: ["p1", "p2"] }), commit({ sha: "prsquash", parents: ["p1"] })],
      getCommitPulls: async () => [{ number: 42, merged: true, baseRef: "main" }],
      getCommitDiff: async () => "diff",
      enrich: enrichAllFacing,
      resolvePending: vi.fn(),
    });
    const rows = await db.select().from(changeEvents).where(eq(changeEvents.tenantId, tenant.id));
    expect(rows).toHaveLength(0);
  });

  it("does not drop a commit whose merged PR targeted a non-watched base branch (branch promotion)", async () => {
    const { tenant } = await seed();
    await ingestPush(baseInput, {
      listPushCommits: async () => [commit({ sha: "promoted1", parents: ["p1"] })],
      getCommitPulls: async () => [{ number: 99, merged: true, baseRef: "develop" }],
      getCommitDiff: async () => "diff --git a/x b/x\n+real change",
      enrich: enrichAllFacing,
      resolvePending: vi.fn(),
    });
    const rows = await db.select().from(changeEvents).where(eq(changeEvents.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "pending", filterReason: null, commitSha: "promoted1", userFacing: true });
  });

  it("ignores pushes to a non-watched branch", async () => {
    const { tenant } = await seed();
    let listed = false;
    await ingestPush({ ...baseInput, ref: "refs/heads/feature" }, {
      listPushCommits: async () => { listed = true; return []; },
      getCommitPulls: noPulls, getCommitDiff: async () => "x", enrich: enrichAllFacing,
      resolvePending: vi.fn(),
    });
    expect(listed).toBe(false);
    expect(await db.select().from(changeEvents).where(eq(changeEvents.tenantId, tenant.id))).toHaveLength(0);
  });

  it("isolates a per-commit failure: the other commit in the batch still ingests", async () => {
    const { tenant } = await seed();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await ingestPush(baseInput, {
      listPushCommits: async () => [
        commit({ sha: "bad1", parents: ["p1"] }),
        commit({ sha: "good1", parents: ["p1"] }),
      ],
      getCommitPulls: noPulls,
      getCommitDiff: async (installationId, repoFullName, sha) => {
        if (sha === "bad1") throw new Error("transient GitHub API failure");
        return "diff --git a/x b/x\n+real change";
      },
      enrich: enrichAllFacing,
      resolvePending: vi.fn(),
    });
    const rows = await db.select().from(changeEvents).where(eq(changeEvents.tenantId, tenant.id));
    expect(rows.map((r) => r.commitSha)).toEqual(["good1"]);
    expect(rows[0]).toMatchObject({ status: "pending", filterReason: null, userFacing: true });
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0][0]).toMatch(/bad1/);
    errorSpy.mockRestore();
  });

  it("records the push time as releasedAt, distinct from the commit's author date", async () => {
    const { tenant } = await seed();
    await ingestPush(baseInput, {
      // Authored well before it was pushed — the two timestamps must not collapse.
      listPushCommits: async () => [commit({ sha: "late1", parents: ["p1"], committedAt: "2026-02-01T00:00:00Z" })],
      getCommitPulls: noPulls,
      getCommitDiff: async () => "diff --git a/x b/x\n+real change",
      enrich: enrichAllFacing,
      resolvePending: vi.fn(),
    });

    const [row] = await db.select().from(changeEvents).where(eq(changeEvents.tenantId, tenant.id));
    expect(row.releasedAt).toEqual(PUSHED_AT);
    expect(row.committedAt).toEqual(new Date("2026-02-01T00:00:00Z"));
    expect(row.releasedAt!.getTime()).toBeGreaterThan(row.committedAt!.getTime());
  });

  it("records releasedAt on ignored commits too, not just pending ones", async () => {
    const { tenant } = await seed();
    await ingestPush(baseInput, {
      listPushCommits: async () => [
        commit({ sha: "merge2", parents: ["p1", "p2"] }),
        commit({ sha: "empty2", parents: ["p1"] }),
      ],
      getCommitPulls: noPulls,
      getCommitDiff: async () => "   ",
      enrich: enrichAllFacing,
      resolvePending: vi.fn(),
    });

    const rows = await db.select().from(changeEvents).where(eq(changeEvents.tenantId, tenant.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.releasedAt?.getTime() === PUSHED_AT.getTime())).toBe(true);
  });

  it("is idempotent on re-delivery (onConflictDoNothing)", async () => {
    const { tenant } = await seed();
    const deps = { listPushCommits: async () => [commit({ sha: "dup1" })], getCommitPulls: noPulls, getCommitDiff: async () => "real", enrich: enrichAllFacing, resolvePending: vi.fn() };
    await ingestPush(baseInput, deps);
    await ingestPush(baseInput, deps);
    expect(await db.select().from(changeEvents).where(eq(changeEvents.tenantId, tenant.id))).toHaveLength(1);
  });

  it("stores type, provider and externalId on ingested commits", async () => {
    const { repo } = await seed();
    await ingestPush(baseInput, {
      listPushCommits: async () => [commit({ sha: "sha-typed", message: "feat: add export" })],
      getCommitPulls: noPulls,
      getCommitDiff: async () => "diff --git a/src/a.ts b/src/a.ts\n+x\n",
      enrich: enrichAllFacing,
      resolvePending: vi.fn(),
    });

    const [row] = await db.select().from(changeEvents).where(eq(changeEvents.commitSha, "sha-typed"));
    expect(row.type).toBe("commit");
    expect(row.provider).toBe("github");
    expect(row.externalId).toBe("sha-typed");
    expect(row.repoId).toBe(repo.id);
  });

  it("drops a chore-prefixed commit with a filter reason and does not enrich it", async () => {
    await seed();
    const enrich = vi.fn();
    await ingestPush(baseInput, {
      listPushCommits: async () => [commit({ sha: "sha-chore", message: "chore: tidy" })],
      getCommitPulls: noPulls,
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
    await seed();
    const resolvePending = vi.fn();
    await ingestPush(baseInput, {
      listPushCommits: async () => [commit({ sha: "sha-r1", message: "feat: a" }), commit({ sha: "sha-r2", message: "feat: b" })],
      getCommitPulls: noPulls,
      getCommitDiff: async () => "diff --git a/src/a.ts b/src/a.ts\n+x\n",
      enrich: enrichAllFacing,
      resolvePending,
    });

    expect(resolvePending).toHaveBeenCalledTimes(1);
    expect(resolvePending.mock.calls[0][1]).toHaveLength(2);
  });
});
