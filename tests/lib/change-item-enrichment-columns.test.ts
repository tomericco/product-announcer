import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, repos, changeItems } from "../../src/db/schema";

const NAME = "Enrichment Columns Test Tenant";

describe("change_items enrichment columns", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, NAME));
  });

  it("persists and reads back enrichment fields, defaulting them to null", async () => {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();
    const [repo] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/e", githubInstallationId: "1", watchedBranch: "main" })
      .returning();

    const [defaulted] = await db
      .insert(changeItems)
      .values({ tenantId: tenant.id, repoId: repo.id, sourceType: "pr", prNumber: 1, prTitle: "a" })
      .returning();
    expect(defaulted.userFacing).toBeNull();
    expect(defaulted.impactSummary).toBeNull();
    expect(defaulted.suggestedCategory).toBeNull();
    expect(defaulted.enrichmentConfidence).toBeNull();
    expect(defaulted.enrichedAt).toBeNull();

    const [enriched] = await db
      .insert(changeItems)
      .values({
        tenantId: tenant.id,
        repoId: repo.id,
        sourceType: "pr",
        prNumber: 2,
        prTitle: "b",
        userFacing: true,
        impactSummary: "Faster search",
        suggestedCategory: "improved",
        enrichmentConfidence: 0.9,
        enrichedAt: new Date(),
      })
      .returning();
    expect(enriched.userFacing).toBe(true);
    expect(enriched.impactSummary).toBe("Faster search");
    expect(enriched.suggestedCategory).toBe("improved");
    expect(enriched.enrichmentConfidence).toBeCloseTo(0.9);
    expect(enriched.enrichedAt).toBeInstanceOf(Date);
  });
});
