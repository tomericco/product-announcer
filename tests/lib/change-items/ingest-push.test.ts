import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, repos, changeItems } from "../../../src/db/schema";
import { ingestPush } from "../../../src/lib/change-items/ingest-push";
import type { EnrichChangeItem } from "../../../src/lib/ai/enrich-change-item";

const fakeEnrich: EnrichChangeItem = async (input) => ({
  userFacing: input.commitMessage !== "tweak logging",
  impactSummary: input.commitMessage !== "tweak logging" ? "user benefit" : null,
  suggestedCategory: input.commitMessage !== "tweak logging" ? "fixed" : null,
  confidence: 0.6,
});

describe("ingestPush", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, "Push Ingest Test Tenant"));
  });

  it("creates one commit-sourced ChangeItem per commit, with diff attached", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "Push Ingest Test Tenant" }).returning();
    const [repo] = await db
      .insert(repos)
      .values({
        tenantId: tenant.id,
        githubRepoFullName: "acme/no-prs",
        githubInstallationId: "90002",
        watchedBranch: "main",
        sourceTypes: ["commit"],
      })
      .returning();

    const getCommitDiff = vi.fn().mockResolvedValue("diff --git a/x b/x\n+added a line");

    await ingestPush(
      {
        installationId: "90002",
        repoFullName: "acme/no-prs",
        ref: "refs/heads/main",
        commits: [
          { id: "abc123", message: "fix export timeout", url: "https://github.com/acme/no-prs/commit/abc123", timestamp: "2026-07-01T00:00:00Z" },
          { id: "def456", message: "tweak logging", url: "https://github.com/acme/no-prs/commit/def456", timestamp: "2026-07-01T00:05:00Z" },
        ],
      },
      getCommitDiff,
      fakeEnrich
    );

    const items = await db.select().from(changeItems).where(eq(changeItems.repoId, repo.id));
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.commitSha).sort()).toEqual(["abc123", "def456"]);
    expect(items[0]).toMatchObject({ sourceType: "commit", status: "pending" });
    expect(items[0].diff).toContain("added a line");
    expect(getCommitDiff).toHaveBeenCalledTimes(2);

    const fix = items.find((i) => i.commitSha === "abc123")!;
    const log = items.find((i) => i.commitSha === "def456")!;
    expect(fix.userFacing).toBe(true);
    expect(fix.impactSummary).toBe("user benefit");
    expect(fix.suggestedCategory).toBe("fixed");
    expect(fix.enrichmentConfidence).toBeCloseTo(0.6);
    expect(log.userFacing).toBe(false);
  });

  it("is idempotent: ingesting the same push twice does not double the commit count", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "Push Ingest Test Tenant" }).returning();
    const [repo] = await db
      .insert(repos)
      .values({
        tenantId: tenant.id,
        githubRepoFullName: "acme/no-prs",
        githubInstallationId: "90002",
        watchedBranch: "main",
        sourceTypes: ["commit"],
      })
      .returning();

    const getCommitDiff = vi.fn().mockResolvedValue("diff --git a/x b/x\n+added a line");

    const input = {
      installationId: "90002",
      repoFullName: "acme/no-prs",
      ref: "refs/heads/main",
      commits: [
        { id: "abc123", message: "fix export timeout", url: "https://github.com/acme/no-prs/commit/abc123", timestamp: "2026-07-01T00:00:00Z" },
        { id: "def456", message: "tweak logging", url: "https://github.com/acme/no-prs/commit/def456", timestamp: "2026-07-01T00:05:00Z" },
      ],
    };

    await ingestPush(input, getCommitDiff, fakeEnrich);
    await ingestPush(input, getCommitDiff, fakeEnrich);

    const items = await db.select().from(changeItems).where(eq(changeItems.repoId, repo.id));
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.commitSha).sort()).toEqual(["abc123", "def456"]);
  });

  it("ignores pushes to a branch other than the watched one", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "Push Ingest Test Tenant" }).returning();
    const [repo] = await db
      .insert(repos)
      .values({
        tenantId: tenant.id,
        githubRepoFullName: "acme/no-prs",
        githubInstallationId: "90002",
        watchedBranch: "main",
        sourceTypes: ["commit"],
      })
      .returning();

    const getCommitDiff = vi.fn();

    await ingestPush(
      {
        installationId: "90002",
        repoFullName: "acme/no-prs",
        ref: "refs/heads/feature-branch",
        commits: [{ id: "abc123", message: "wip", url: "https://x", timestamp: "2026-07-01T00:00:00Z" }],
      },
      getCommitDiff,
      fakeEnrich
    );

    const items = await db.select().from(changeItems).where(eq(changeItems.repoId, repo.id));
    expect(items).toHaveLength(0);
    expect(getCommitDiff).not.toHaveBeenCalled();
  });

  it("does nothing for a repo whose sourceTypes doesn't include 'commit'", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "Push Ingest Test Tenant" }).returning();
    await db.insert(repos).values({
      tenantId: tenant.id,
      githubRepoFullName: "acme/pr-only",
      githubInstallationId: "90002",
      watchedBranch: "main",
      sourceTypes: ["pr"],
    });

    const getCommitDiff = vi.fn();

    await ingestPush(
      {
        installationId: "90002",
        repoFullName: "acme/pr-only",
        ref: "refs/heads/main",
        commits: [{ id: "abc123", message: "wip", url: "https://x", timestamp: "2026-07-01T00:00:00Z" }],
      },
      getCommitDiff,
      fakeEnrich
    );

    expect(getCommitDiff).not.toHaveBeenCalled();
  });
});
