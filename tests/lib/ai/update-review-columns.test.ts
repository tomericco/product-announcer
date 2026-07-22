import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, releases } from "../../../src/db/schema";

const NAME = "Review Columns Test Tenant";

describe("releases review columns", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, NAME));
  });

  it("defaults review columns and round-trips a review outcome", async () => {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();

    const [defaulted] = await db
      .insert(releases)
      .values({ tenantId: tenant.id, title: "t", body: "b", sourceItems: [] })
      .returning();
    expect(defaulted.reviewStatus).toBeNull();
    expect(defaulted.reviewIssues).toEqual([]);
    expect(defaulted.reviewedAt).toBeNull();

    const [reviewed] = await db
      .insert(releases)
      .values({
        tenantId: tenant.id, title: "t2", body: "b2", sourceItems: [],
        reviewStatus: "failed", reviewIssues: ["too salesy", "wrong tone"], reviewedAt: new Date(),
      })
      .returning();
    expect(reviewed.reviewStatus).toBe("failed");
    expect(reviewed.reviewIssues).toEqual(["too salesy", "wrong tone"]);
    expect(reviewed.reviewedAt).toBeInstanceOf(Date);
  });
});
