import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, briefs, briefRuns, contentPieces } from "../../../src/db/schema";

const TENANT = "Brief Runs Test Tenant";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
});

async function seedTenant() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  return tenant;
}

describe("briefRuns", () => {
  it("records a run that produced nothing and explains why", async () => {
    const tenant = await seedTenant();
    await db.insert(briefRuns).values({
      tenantId: tenant.id,
      assessment: "A quiet week — only maintenance work shipped.",
      briefsCreated: 0,
      briefsExtended: 0,
    });

    const [row] = await db.select().from(briefRuns).where(eq(briefRuns.tenantId, tenant.id));
    // The whole point of the table: a zero-brief run still carries a reason.
    expect(row.briefsCreated).toBe(0);
    expect(row.assessment).toContain("quiet week");
    expect(row.error).toBeNull();
    expect(row.ranAt).toBeInstanceOf(Date);
  });

  it("records a failed run with its error and no assessment", async () => {
    const tenant = await seedTenant();
    await db.insert(briefRuns).values({ tenantId: tenant.id, error: "model timeout" });

    const [row] = await db.select().from(briefRuns).where(eq(briefRuns.tenantId, tenant.id));
    expect(row.error).toBe("model timeout");
    expect(row.assessment).toBeNull();
  });

  it("drops a tenant's runs when the tenant is deleted", async () => {
    const tenant = await seedTenant();
    await db.insert(briefRuns).values({ tenantId: tenant.id });
    await db.delete(tenants).where(eq(tenants.id, tenant.id));

    const rows = await db.select().from(briefRuns).where(eq(briefRuns.tenantId, tenant.id));
    expect(rows).toHaveLength(0);
  });
});

describe("briefs.contentPieceId", () => {
  it("nulls the link when the content piece is deleted, keeping the brief", async () => {
    const tenant = await seedTenant();
    const [piece] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, type: "blog_post", title: "P", body: "b" })
      .returning();
    const [brief] = await db
      .insert(briefs)
      .values({
        tenantId: tenant.id,
        origin: "agent",
        contentType: "blog_post",
        title: "T",
        angle: "A",
        whyNow: "W",
        suggestedChannel: "blog",
        score: 0.8,
        status: "accepted",
        contentPieceId: piece.id,
        lastEvidenceAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning();

    await db.delete(contentPieces).where(eq(contentPieces.id, piece.id));

    // SET NULL, not cascade: the brief is the durable record that a human
    // accepted something. Deleting the draft must not erase that decision.
    const [after] = await db.select().from(briefs).where(eq(briefs.id, brief.id));
    expect(after).toBeDefined();
    expect(after.contentPieceId).toBeNull();
    expect(after.status).toBe("accepted");
  });
});
