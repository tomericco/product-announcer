import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, repos, changeItems } from "../../../src/db/schema";

const NAME = "Ignored Columns Test Tenant";

describe("ignored change-item columns", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, NAME));
  });

  it("stores an ignored commit with a reason", async () => {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();
    const [repo] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/x", githubInstallationId: "1", watchedBranch: "main" })
      .returning();

    const [row] = await db
      .insert(changeItems)
      .values({
        tenantId: tenant.id, repoId: repo.id, sourceType: "commit",
        status: "ignored", ignoredReason: "merge_commit",
        commitSha: "abc123", commitMessage: "Merge branch 'x'",
      })
      .returning();

    expect(row.status).toBe("ignored");
    expect(row.ignoredReason).toBe("merge_commit");

    const [defaulted] = await db
      .insert(changeItems)
      .values({ tenantId: tenant.id, repoId: repo.id, sourceType: "commit", commitSha: "def456", commitMessage: "x" })
      .returning();
    expect(defaulted.status).toBe("pending");
    expect(defaulted.ignoredReason).toBeNull();
  });
});
