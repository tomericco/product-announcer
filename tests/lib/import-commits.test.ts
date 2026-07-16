import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, repos, changeItems } from "../../src/db/schema";
import { importSelectedCommits } from "../../src/lib/import-commits";

const NAME = "Import Commits Test Tenant";

describe("importSelectedCommits", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, NAME));
  });

  async function seedRepo(sourceTypes: string[]) {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();
    const [repo] = await db
      .insert(repos)
      .values({
        tenantId: tenant.id,
        githubRepoFullName: "acme/import",
        githubInstallationId: "70001",
        watchedBranch: "main",
        sourceTypes,
      })
      .returning();
    return { tenant, repo };
  }

  it("imports selected commits as pending commit change items, fetching each diff", async () => {
    const { tenant, repo } = await seedRepo(["pr"]); // pr-only: manual import ignores the gate
    const getCommitDiff = vi.fn().mockResolvedValue("diff --git a/x b/x\n+added a line");

    const result = await importSelectedCommits(
      {
        tenantId: tenant.id,
        selections: [
          { repoId: repo.id, sha: "aaa111", message: "fix timeout", url: "https://x/aaa111", committedAt: "2026-07-01T00:00:00Z" },
          { repoId: repo.id, sha: "bbb222", message: "tweak logs", url: "https://x/bbb222", committedAt: "2026-07-02T00:00:00Z" },
        ],
      },
      getCommitDiff
    );

    expect(result.importedCount).toBe(2);
    const items = await db.select().from(changeItems).where(eq(changeItems.repoId, repo.id));
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.commitSha).sort()).toEqual(["aaa111", "bbb222"]);
    expect(items[0]).toMatchObject({ sourceType: "commit", status: "pending" });
    expect(items.every((i) => i.diff?.includes("added a line"))).toBe(true);
    expect(getCommitDiff).toHaveBeenCalledTimes(2);
  });

  it("is idempotent: re-importing an already-imported commit inserts nothing", async () => {
    const { tenant, repo } = await seedRepo(["commit"]);
    const getCommitDiff = vi.fn().mockResolvedValue("diff");
    const selections = [
      { repoId: repo.id, sha: "aaa111", message: "fix", url: "https://x/aaa111", committedAt: "2026-07-01T00:00:00Z" },
    ];

    const first = await importSelectedCommits({ tenantId: tenant.id, selections }, getCommitDiff);
    const second = await importSelectedCommits({ tenantId: tenant.id, selections }, getCommitDiff);

    expect(first.importedCount).toBe(1);
    expect(second.importedCount).toBe(0);
    const items = await db.select().from(changeItems).where(eq(changeItems.repoId, repo.id));
    expect(items).toHaveLength(1);
  });

  it("skips repos that don't belong to the tenant (IDOR guard)", async () => {
    const { repo } = await seedRepo(["pr"]);
    const [otherTenant] = await db.insert(tenants).values({ name: NAME }).returning();
    const getCommitDiff = vi.fn().mockResolvedValue("diff");

    const result = await importSelectedCommits(
      {
        tenantId: otherTenant.id,
        selections: [
          { repoId: repo.id, sha: "aaa111", message: "fix", url: "https://x/aaa111", committedAt: null },
        ],
      },
      getCommitDiff
    );

    expect(result.importedCount).toBe(0);
    expect(getCommitDiff).not.toHaveBeenCalled();
    const items = await db.select().from(changeItems).where(eq(changeItems.repoId, repo.id));
    expect(items).toHaveLength(0);
  });
});
