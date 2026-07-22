import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, repos, releases, deliveryAttempts } from "../../src/db/schema";

describe("publish/integrations schema", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, "Publish Schema Test Tenant"));
  });

  it("links a DeliveryAttempt to a Release", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "Publish Schema Test Tenant" }).returning();
    const [repo] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/x", githubInstallationId: "1", watchedBranch: "main" })
      .returning();
    const [release] = await db
      .insert(releases)
      .values({ tenantId: tenant.id, repoId: repo.id, title: "T", body: "B", sourceItems: [] })
      .returning();

    const [delivery] = await db
      .insert(deliveryAttempts)
      .values({ releaseId: release.id, destination: "webhook" })
      .returning();

    expect(delivery.releaseId).toBe(release.id);
    expect(delivery.status).toBe("pending");
    expect(delivery.attempts).toBe(0);
  });

  it("rejects a second delivery attempt for the same release+destination pair", async () => {
    // Backstops the reuse path in dispatchAllDestinations: a select-then-insert
    // race could otherwise create two rows for the same release+destination, and
    // a later dispatch would pick an arbitrary one via `limit 1` with no order.
    const [tenant] = await db.insert(tenants).values({ name: "Publish Schema Test Tenant" }).returning();
    const [repo] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/x", githubInstallationId: "1", watchedBranch: "main" })
      .returning();
    const [release] = await db
      .insert(releases)
      .values({ tenantId: tenant.id, repoId: repo.id, title: "T", body: "B", sourceItems: [] })
      .returning();

    await db.insert(deliveryAttempts).values({ releaseId: release.id, destination: "webhook" });

    await expect(
      db.insert(deliveryAttempts).values({ releaseId: release.id, destination: "webhook" })
    ).rejects.toThrow();
  });
});
