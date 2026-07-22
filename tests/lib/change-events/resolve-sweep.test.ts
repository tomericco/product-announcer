import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, repos, changeEvents, atomicUpdates } from "../../../src/db/schema";
import { sweepUnresolvedEvents } from "../../../src/lib/change-events/resolve-sweep";

const TENANT = "Resolve Sweep Test Tenant";

async function seedTenantWithRepo() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  const [repo] = await db
    .insert(repos)
    .values({
      tenantId: tenant.id,
      githubRepoFullName: "acme/widgets",
      githubInstallationId: "1",
      watchedBranch: "main",
    })
    .returning();
  return { tenant, repo };
}

async function seedEvent(
  tenantId: string,
  repoId: string,
  externalId: string,
  overrides: Partial<typeof changeEvents.$inferInsert> = {}
) {
  const [row] = await db
    .insert(changeEvents)
    .values({
      tenantId,
      repoId,
      type: "commit",
      provider: "github",
      externalId,
      commitSha: externalId,
      commitMessage: `commit ${externalId}`,
      status: "pending",
      ...overrides,
    })
    .returning();
  return row;
}

describe("sweepUnresolvedEvents", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("re-resolves an orphaned unresolved event but skips assigned, non-user-facing, and filtered events", async () => {
    const { tenant, repo } = await seedTenantWithRepo();

    const orphan = await seedEvent(tenant.id, repo.id, "sha-orphan", { userFacing: true });
    const assigned = await seedEvent(tenant.id, repo.id, "sha-assigned", { userFacing: true });
    const nonUserFacing = await seedEvent(tenant.id, repo.id, "sha-non-user-facing", { userFacing: false });
    const filtered = await seedEvent(tenant.id, repo.id, "sha-filtered", {
      userFacing: true,
      filterReason: "chore_prefix",
    });

    // `assigned` needs a real atomicUpdateId to exclude on. Insert one directly.
    const [atomicUpdate] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Existing", summary: "S" })
      .returning();
    await db.update(changeEvents).set({ atomicUpdateId: atomicUpdate.id }).where(eq(changeEvents.id, assigned.id));

    const resolvePending = vi.fn().mockResolvedValue(undefined);

    await sweepUnresolvedEvents({ database: db, resolvePending });

    // Tests run concurrently against a shared database (see
    // run-schedule.test.ts's `runSchedulerTick` tests for the same pattern),
    // so other tenants may also appear in `resolvePending`'s calls. Scope the
    // assertion to this test's own tenant: exactly the orphan's id, proving
    // the assigned, non-user-facing, and filtered siblings were excluded.
    const ourCall = resolvePending.mock.calls.find((c) => c[0] === tenant.id);
    expect(ourCall?.[1]).toEqual([orphan.id]);

    void nonUserFacing;
    void filtered;
  });

  it("isolates per-tenant failures so one tenant's error doesn't starve the sweep", async () => {
    const { tenant: tenantA, repo: repoA } = await seedTenantWithRepo();
    const orphanA = await seedEvent(tenantA.id, repoA.id, "sha-a", { userFacing: true });

    const TENANT_B = "Resolve Sweep Test Tenant B";
    const [tenantB] = await db.insert(tenants).values({ name: TENANT_B }).returning();
    const [repoB] = await db
      .insert(repos)
      .values({
        tenantId: tenantB.id,
        githubRepoFullName: "acme/gadgets",
        githubInstallationId: "2",
        watchedBranch: "main",
      })
      .returning();
    const orphanB = await seedEvent(tenantB.id, repoB.id, "sha-b", { userFacing: true });

    const resolvePending = vi.fn(async (tenantId: string, ids: string[]) => {
      void ids;
      if (tenantId === tenantA.id) throw new Error("boom");
    });

    await sweepUnresolvedEvents({ database: db, resolvePending });

    // Scoped to our two tenants only (see the comment in the previous test):
    // other tenants may also appear in `resolvePending`'s calls under
    // concurrent test execution. What matters here is that tenant A's
    // rejection didn't prevent tenant B from being swept.
    const aCall = resolvePending.mock.calls.find((c) => c[0] === tenantA.id);
    const bCall = resolvePending.mock.calls.find((c) => c[0] === tenantB.id);
    expect(aCall?.[1]).toEqual([orphanA.id]);
    expect(bCall?.[1]).toEqual([orphanB.id]);

    await db.delete(tenants).where(eq(tenants.name, TENANT_B));
  });
});
