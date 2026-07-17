import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, repos } from "../../../src/db/schema";
import { addSelectedRepos } from "../../../src/lib/workspace/repo-sync";

describe("addSelectedRepos", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, "Repo Sync Test Tenant"));
  });

  it("creates a Repo row per selected repo, with the chosen branch and default sourceTypes", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "Repo Sync Test Tenant" }).returning();

    await addSelectedRepos(tenant.id, "999", [
      { fullName: "acme/widgets", branch: "main" },
      { fullName: "acme/gadgets", branch: "develop" },
    ]);

    const rows = await db.select().from(repos).where(eq(repos.tenantId, tenant.id));
    expect(rows).toHaveLength(2);
    const widgets = rows.find((r) => r.githubRepoFullName === "acme/widgets");
    expect(widgets?.watchedBranch).toBe("main");
    expect(widgets?.githubInstallationId).toBe("999");
    expect(widgets?.sourceTypes).toEqual(["pr"]);
    const gadgets = rows.find((r) => r.githubRepoFullName === "acme/gadgets");
    expect(gadgets?.watchedBranch).toBe("develop");
  });

  it("is idempotent — re-selecting the same repo updates its branch instead of duplicating it", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "Repo Sync Test Tenant" }).returning();

    await addSelectedRepos(tenant.id, "999", [{ fullName: "acme/widgets", branch: "main" }]);
    await addSelectedRepos(tenant.id, "999", [{ fullName: "acme/widgets", branch: "release" }]);

    const rows = await db.select().from(repos).where(eq(repos.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].watchedBranch).toBe("release");
  });
});
