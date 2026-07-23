import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, repos, changeEvents, atomicUpdates } from "../../src/db/schema";

const TENANT = "Atomic Updates Schema Test Tenant";

describe("atomic_updates schema", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("links change events to an atomic update and defaults status to open", async () => {
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

    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "CSV export", summary: "Export reports as CSV." })
      .returning();

    expect(atomic.status).toBe("open");
    expect(atomic.releaseId).toBeNull();
    expect(atomic.summaryEditedAt).toBeNull();

    const [event] = await db
      .insert(changeEvents)
      .values({
        tenantId: tenant.id,
        repoId: repo.id,
        type: "commit",
        provider: "github",
        externalId: "abc123",
        commitSha: "abc123",
        atomicUpdateId: atomic.id,
      })
      .returning();

    expect(event.atomicUpdateId).toBe(atomic.id);
    expect(event.provider).toBe("github");
  });

  it("rejects a duplicate (tenant, provider, externalId)", async () => {
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

    const values = {
      tenantId: tenant.id,
      repoId: repo.id,
      type: "commit" as const,
      provider: "github" as const,
      externalId: "dup-sha",
      commitSha: "dup-sha",
    };

    await db.insert(changeEvents).values(values);
    await expect(db.insert(changeEvents).values(values)).rejects.toThrow();
  });

  it("requires type, provider and externalId", async () => {
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

    // @ts-expect-error omitting required columns must not typecheck
    await expect(db.insert(changeEvents).values({ tenantId: tenant.id, repoId: repo.id })).rejects.toThrow();
  });

  it("nulls atomic_update_id when the atomic update is deleted", async () => {
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
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "T", summary: "S" })
      .returning();
    const [event] = await db
      .insert(changeEvents)
      .values({
        tenantId: tenant.id,
        repoId: repo.id,
        type: "commit",
        provider: "github",
        externalId: "orphan-sha",
        commitSha: "orphan-sha",
        atomicUpdateId: atomic.id,
      })
      .returning();

    await db.delete(atomicUpdates).where(eq(atomicUpdates.id, atomic.id));

    const [found] = await db.select().from(changeEvents).where(eq(changeEvents.id, event.id));
    expect(found.atomicUpdateId).toBeNull();
  });
});
