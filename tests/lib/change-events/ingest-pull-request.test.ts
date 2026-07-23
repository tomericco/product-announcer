import { describe, it, expect, afterEach, vi } from "vitest";

// Structural backstop: resolvePendingEvents makes real Sonnet/Haiku calls to
// Anthropic. Any test in this file that omits the `resolvePending` dep must
// never fall through to the live implementation, so the module is mocked
// here regardless of what individual tests pass.
vi.mock("../../../src/lib/change-events/pipeline", () => ({ resolvePendingEvents: vi.fn() }));

import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, repos, changeEvents } from "../../../src/db/schema";
import { ingestMergedPullRequest } from "../../../src/lib/change-events/ingest-pull-request";
import type { EnrichChangeItem } from "../../../src/lib/ai/enrich-change-item";

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
      { enrich: fakeEnrich, resolvePending: vi.fn() }
    );

    const items = await db.select().from(changeEvents).where(eq(changeEvents.repoId, repo.id));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "pull_request",
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
      { enrich: fakeEnrich, resolvePending: vi.fn() }
    );

    const items = await db.select().from(changeEvents).where(eq(changeEvents.repoId, repo.id));
    expect(items).toHaveLength(0);
  });

  it("ingests a merged PR regardless of the repo's sourceTypes", async () => {
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
        prTitle: "Should still be ingested",
        prDescription: "",
        prUrl: "https://github.com/acme/commit-only/pull/1",
        mergedAt: new Date(),
      },
      { enrich: fakeEnrich, resolvePending: vi.fn() }
    );

    const items = await db.select().from(changeEvents).where(eq(changeEvents.repoId, repo.id));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "pull_request",
      prNumber: 1,
      prTitle: "Should still be ingested",
    });
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

    await ingestMergedPullRequest(input, { enrich: fakeEnrich, resolvePending: vi.fn() });
    await ingestMergedPullRequest(input, { enrich: fakeEnrich, resolvePending: vi.fn() });

    const items = await db.select().from(changeEvents).where(eq(changeEvents.repoId, repo.id));
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
        { enrich: fakeEnrich, resolvePending: vi.fn() }
      )
    ).resolves.not.toThrow();
  });

  it("drops a chore-prefixed PR without enriching or resolving", async () => {
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

    const enrich = vi.fn();
    const resolvePending = vi.fn();

    await ingestMergedPullRequest(
      {
        installationId: "90001",
        repoFullName: "acme/widgets",
        baseBranch: "main",
        prNumber: 99,
        prTitle: "chore: bump deps",
        prDescription: "",
        prUrl: "https://github.com/acme/widgets/pull/99",
        mergedAt: new Date(),
      },
      { enrich, resolvePending, database: db }
    );

    const [row] = await db.select().from(changeEvents).where(eq(changeEvents.prNumber, 99));
    expect(row.filterReason).toBe("chore_prefix");
    expect(row.status).toBe("ignored");
    expect(row.externalId).toBe(`${repo.githubRepoFullName}#99`);
    expect(enrich).not.toHaveBeenCalled();
    expect(resolvePending).not.toHaveBeenCalled();
  });
});
