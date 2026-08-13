import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, contentPieces } from "../../../src/db/schema";
import { readGenerationProgress } from "../../../src/lib/content/generation-progress";
import { seedTenant, dropTenant } from "../../helpers/fixtures";

const TENANT = "Generation Progress Test Tenant";

afterEach(async () => {
  await dropTenant(TENANT);
});

async function seedPiece(tenantId: string, overrides: Partial<typeof contentPieces.$inferInsert> = {}) {
  const [piece] = await db
    .insert(contentPieces)
    .values({ tenantId, type: "blog_post", title: "T", body: "B", status: "brief", ...overrides })
    .returning();
  return piece;
}

describe("readGenerationProgress", () => {
  it("returns the current step and terminal state", async () => {
    const tenant = await seedTenant(TENANT);
    const piece = await seedPiece(tenant.id);
    await db
      .update(contentPieces)
      .set({ generationStep: "reviewing" })
      .where(eq(contentPieces.id, piece.id));

    const progress = await readGenerationProgress(tenant.id, piece.id, db);
    expect(progress).toEqual({
      generationStep: "reviewing",
      generatedAt: null,
      generationError: null,
      status: "brief",
    });
  });

  it("refuses a piece belonging to another tenant", async () => {
    const mine = await seedTenant(TENANT);
    const [stranger] = await db.insert(tenants).values({ name: TENANT }).returning();
    const piece = await seedPiece(mine.id);

    // Asserted by id: a query missing the tenant filter would still find this.
    expect(await readGenerationProgress(stranger.id, piece.id, db)).toBeNull();
  });

  it("returns null for a piece that does not exist", async () => {
    const tenant = await seedTenant(TENANT);
    expect(
      await readGenerationProgress(tenant.id, "00000000-0000-0000-0000-000000000000", db)
    ).toBeNull();
  });
});
