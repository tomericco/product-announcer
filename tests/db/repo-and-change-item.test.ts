import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, repos, changeItems } from "../../src/db/schema";

describe("repos and change_items", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, "Ingestion Test Tenant"));
  });

  it("creates a repo and a change item scoped to it", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "Ingestion Test Tenant" }).returning();

    const [repo] = await db
      .insert(repos)
      .values({
        tenantId: tenant.id,
        githubRepoFullName: "acme/widgets",
        githubInstallationId: "12345",
        watchedBranch: "main",
        sourceTypes: ["pr", "commit"],
      })
      .returning();

    expect(repo.sourceTypes).toEqual(["pr", "commit"]);

    const [item] = await db
      .insert(changeItems)
      .values({
        tenantId: tenant.id,
        repoId: repo.id,
        sourceType: "pr",
        prNumber: 42,
        prTitle: "Add dark mode",
        prUrl: "https://github.com/acme/widgets/pull/42",
        mergedAt: new Date(),
      })
      .returning();

    const found = await db.select().from(changeItems).where(eq(changeItems.id, item.id));
    expect(found).toHaveLength(1);
    expect(found[0].status).toBe("pending");
    expect(found[0].prTitle).toBe("Add dark mode");
  });
});
