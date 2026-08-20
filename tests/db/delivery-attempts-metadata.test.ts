import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, contentPieces, deliveryAttempts } from "../../src/db/schema";

const TENANT = "Delivery Attempts Metadata Schema Test Tenant";

async function seedPiece() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  const [piece] = await db
    .insert(contentPieces)
    .values({ tenantId: tenant.id, title: "T", body: "B" })
    .returning();
  return piece;
}

describe("delivery_attempts.metadata", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("defaults to null and round-trips a linkedin image urn", async () => {
    const piece = await seedPiece();
    const [row] = await db
      .insert(deliveryAttempts)
      .values({ contentPieceId: piece.id, destination: "linkedin" })
      .returning();
    expect(row.metadata).toBeNull();

    const [updated] = await db
      .update(deliveryAttempts)
      .set({ metadata: { linkedinImageUrn: "urn:li:image:abc" } })
      .where(eq(deliveryAttempts.id, row.id))
      .returning();
    expect(updated.metadata).toEqual({ linkedinImageUrn: "urn:li:image:abc" });
  });
});
