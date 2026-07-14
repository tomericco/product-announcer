import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, repos, changeItems, updates } from "../../src/db/schema";

describe("scheduler/generation schema", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, "Scheduler Schema Test Tenant"));
  });

  it("links a ChangeItem to a real Update via the now-present FK", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "Scheduler Schema Test Tenant" }).returning();
    const [repo] = await db
      .insert(repos)
      .values({
        tenantId: tenant.id,
        githubRepoFullName: "acme/widgets",
        githubInstallationId: "1",
        watchedBranch: "main",
      })
      .returning();

    const [update] = await db
      .insert(updates)
      .values({
        tenantId: tenant.id,
        repoId: repo.id,
        title: "Test update",
        body: "Body",
        category: "improved",
        sourceItems: [],
      })
      .returning();

    const [item] = await db
      .insert(changeItems)
      .values({
        tenantId: tenant.id,
        repoId: repo.id,
        sourceType: "pr",
        status: "batched",
        updateId: update.id,
        prNumber: 1,
        prTitle: "x",
      })
      .returning();

    expect(item.updateId).toBe(update.id);
  });
});
