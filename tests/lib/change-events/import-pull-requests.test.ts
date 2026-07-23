import { describe, it, expect, afterEach, vi } from "vitest";

// Structural backstop: resolvePendingEvents makes real Sonnet/Haiku calls to
// Anthropic. Any test in this file that omits the `resolvePending` dep must
// never fall through to the live implementation, so the module is mocked
// here regardless of what individual tests pass.
vi.mock("../../../src/lib/change-events/pipeline", () => ({ resolvePendingEvents: vi.fn() }));

import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, repos, changeEvents } from "../../../src/db/schema";
import { importSelectedPullRequests } from "../../../src/lib/change-events/import-pull-requests";

const NAME = "Import PRs Test Tenant";

describe("importSelectedPullRequests", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, NAME));
  });

  async function seed() {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();
    const [repo] = await db
      .insert(repos)
      .values({
        tenantId: tenant.id,
        githubRepoFullName: "acme/x",
        githubInstallationId: "70002",
        watchedBranch: "main",
        sourceTypes: ["pr"],
      })
      .returning();
    return { tenant, repo };
  }

  it("imports a merged PR as a pull_request change event with owner/repo#number external id", async () => {
    const { tenant, repo } = await seed();
    const enrich = vi
      .fn()
      .mockResolvedValue({ userFacing: true, impactSummary: "Adds X", suggestedCategory: "new", confidence: 0.9 });

    const result = await importSelectedPullRequests(
      {
        tenantId: tenant.id,
        selections: [
          {
            repoId: repo.id,
            number: 42,
            title: "Add X",
            body: "Does X",
            url: "https://github.com/acme/x/pull/42",
            mergedAt: "2026-07-01T00:00:00Z",
          },
        ],
      },
      { enrich, resolvePending: vi.fn() }
    );

    expect(result.importedCount).toBe(1);
    const [row] = await db
      .select()
      .from(changeEvents)
      .where(and(eq(changeEvents.repoId, repo.id), eq(changeEvents.prNumber, 42)));
    expect(row.type).toBe("pull_request");
    expect(row.provider).toBe("github");
    expect(row.externalId).toBe("acme/x#42");
    expect(row.prTitle).toBe("Add X");
    expect(row.prUrl).toBe("https://github.com/acme/x/pull/42");
    expect(row.mergedAt).not.toBeNull();
    expect(enrich).toHaveBeenCalledWith(
      expect.objectContaining({ type: "pull_request", prTitle: "Add X", prDescription: "Does X" })
    );
  });

  it("is idempotent: re-importing the same merged PR does not duplicate", async () => {
    const { tenant, repo } = await seed();
    const enrich = vi
      .fn()
      .mockResolvedValue({ userFacing: false, impactSummary: null, suggestedCategory: null, confidence: 0.1 });
    const sel = {
      repoId: repo.id,
      number: 7,
      title: "T",
      body: null,
      url: "https://github.com/acme/x/pull/7",
      mergedAt: "2026-07-01T00:00:00Z",
    };
    await importSelectedPullRequests({ tenantId: tenant.id, selections: [sel] }, { enrich, resolvePending: vi.fn() });
    await importSelectedPullRequests({ tenantId: tenant.id, selections: [sel] }, { enrich, resolvePending: vi.fn() });
    const rows = await db
      .select()
      .from(changeEvents)
      .where(and(eq(changeEvents.repoId, repo.id), eq(changeEvents.prNumber, 7)));
    expect(rows).toHaveLength(1);
  });

  it("skips repos that don't belong to the tenant (IDOR guard)", async () => {
    const { repo } = await seed();
    const [otherTenant] = await db.insert(tenants).values({ name: NAME }).returning();
    const enrich = vi.fn();

    const result = await importSelectedPullRequests(
      {
        tenantId: otherTenant.id,
        selections: [
          { repoId: repo.id, number: 1, title: "T", body: null, url: "https://x/1", mergedAt: null },
        ],
      },
      { enrich, resolvePending: vi.fn() }
    );

    expect(result.importedCount).toBe(0);
    expect(enrich).not.toHaveBeenCalled();
  });

  it("resolves the user-facing PRs it imports, once, with the tenant id", async () => {
    const { tenant, repo } = await seed();
    const enrich = vi
      .fn()
      .mockResolvedValue({ userFacing: true, impactSummary: "Adds Y", suggestedCategory: "new", confidence: 0.8 });
    const resolvePending = vi.fn();

    await importSelectedPullRequests(
      {
        tenantId: tenant.id,
        selections: [
          {
            repoId: repo.id,
            number: 99,
            title: "Add Y",
            body: "Does Y",
            url: "https://github.com/acme/x/pull/99",
            mergedAt: "2026-07-01T00:00:00Z",
          },
        ],
      },
      { enrich, resolvePending }
    );

    expect(resolvePending).toHaveBeenCalledTimes(1);
    const [calledTenantId] = resolvePending.mock.calls[0];
    expect(calledTenantId).toBe(tenant.id);
  });
});
