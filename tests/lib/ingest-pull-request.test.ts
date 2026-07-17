import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, repos, changeItems } from "../../src/db/schema";
import { ingestMergedPullRequest } from "../../src/lib/ingest-pull-request";
import type { EnrichChangeItem } from "../../src/lib/ai/enrich-change-item";

const fakeEnrich: EnrichChangeItem = async (input) => ({
  userFacing: true,
  impactSummary: `impact for ${input.prTitle}`,
  suggestedCategory: "new",
  confidence: 0.85,
});

describe("ingestMergedPullRequest", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, "PR Ingest Test Tenant"));
  });

  it("creates a pending, pr-sourced ChangeItem carrying enrichment when merged into the watched branch", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "PR Ingest Test Tenant" }).returning();
    const [repo] = await db
      .insert(repos)
      .values({
        tenantId: tenant.id,
        githubRepoFullName: "acme/widgets",
        githubInstallationId: "90001",
        watchedBranch: "main",
        sourceTypes: ["pr"],
      })
      .returning();

    await ingestMergedPullRequest(
      {
        installationId: "90001",
        repoFullName: "acme/widgets",
        baseBranch: "main",
        prNumber: 7,
        prTitle: "Add dark mode",
        prDescription: "Adds a dark mode toggle to settings.",
        prUrl: "https://github.com/acme/widgets/pull/7",
        mergedAt: new Date("2026-07-01T00:00:00Z"),
      },
      fakeEnrich
    );

    const items = await db.select().from(changeItems).where(eq(changeItems.repoId, repo.id));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sourceType: "pr",
      status: "pending",
      prNumber: 7,
      prTitle: "Add dark mode",
    });
    expect(items[0].userFacing).toBe(true);
    expect(items[0].impactSummary).toBe("impact for Add dark mode");
    expect(items[0].suggestedCategory).toBe("new");
    expect(items[0].enrichmentConfidence).toBeCloseTo(0.85);
    expect(items[0].enrichedAt).toBeInstanceOf(Date);
  });

  it("ignores a PR merged into a branch other than the watched one", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "PR Ingest Test Tenant" }).returning();
    const [repo] = await db
      .insert(repos)
      .values({
        tenantId: tenant.id,
        githubRepoFullName: "acme/widgets",
        githubInstallationId: "90001",
        watchedBranch: "main",
        sourceTypes: ["pr"],
      })
      .returning();

    await ingestMergedPullRequest(
      {
        installationId: "90001",
        repoFullName: "acme/widgets",
        baseBranch: "release-1.0",
        prNumber: 9,
        prTitle: "Backport fix",
        prDescription: "",
        prUrl: "https://github.com/acme/widgets/pull/9",
        mergedAt: new Date(),
      },
      fakeEnrich
    );

    const items = await db.select().from(changeItems).where(eq(changeItems.repoId, repo.id));
    expect(items).toHaveLength(0);
  });

  it("does nothing for a repo whose sourceTypes doesn't include 'pr'", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "PR Ingest Test Tenant" }).returning();
    const [repo] = await db
      .insert(repos)
      .values({
        tenantId: tenant.id,
        githubRepoFullName: "acme/commit-only",
        githubInstallationId: "90001",
        watchedBranch: "main",
        sourceTypes: ["commit"],
      })
      .returning();

    await ingestMergedPullRequest(
      {
        installationId: "90001",
        repoFullName: "acme/commit-only",
        baseBranch: "main",
        prNumber: 1,
        prTitle: "Should be ignored",
        prDescription: "",
        prUrl: "https://github.com/acme/commit-only/pull/1",
        mergedAt: new Date(),
      },
      fakeEnrich
    );

    const items = await db.select().from(changeItems).where(eq(changeItems.repoId, repo.id));
    expect(items).toHaveLength(0);
  });

  it("is idempotent: ingesting the same merged PR twice creates only one ChangeItem", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "PR Ingest Test Tenant" }).returning();
    const [repo] = await db
      .insert(repos)
      .values({
        tenantId: tenant.id,
        githubRepoFullName: "acme/widgets",
        githubInstallationId: "90001",
        watchedBranch: "main",
        sourceTypes: ["pr"],
      })
      .returning();

    const input = {
      installationId: "90001",
      repoFullName: "acme/widgets",
      baseBranch: "main",
      prNumber: 42,
      prTitle: "Add dark mode",
      prDescription: "Adds a dark mode toggle to settings.",
      prUrl: "https://github.com/acme/widgets/pull/42",
      mergedAt: new Date("2026-07-01T00:00:00Z"),
    };

    await ingestMergedPullRequest(input, fakeEnrich);
    await ingestMergedPullRequest(input, fakeEnrich);

    const items = await db.select().from(changeItems).where(eq(changeItems.repoId, repo.id));
    expect(items).toHaveLength(1);
  });

  it("does nothing when no matching repo is found", async () => {
    await expect(
      ingestMergedPullRequest(
        {
          installationId: "does-not-exist",
          repoFullName: "nobody/nothing",
          baseBranch: "main",
          prNumber: 1,
          prTitle: "Orphan",
          prDescription: "",
          prUrl: "https://github.com/nobody/nothing/pull/1",
          mergedAt: new Date(),
        },
        fakeEnrich
      )
    ).resolves.not.toThrow();
  });
});
