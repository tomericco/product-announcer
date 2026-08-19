import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, contentPieces, contentImages } from "../../src/db/schema";

const TENANT = "Content Images Anchor Test Tenant";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
});

describe("contentImages.anchorHeading", () => {
  it("is null by default and round-trips a heading text", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [piece] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, title: "T", body: "B", type: "blog_post" })
      .returning();
    const [image] = await db
      .insert(contentImages)
      .values({
        tenantId: tenant.id,
        contentPieceId: piece.id,
        role: "body",
        concept: "gears",
        altText: "Gears turning",
        sourceKind: "generated",
        status: "pending",
      })
      .returning();
    expect(image.anchorHeading).toBeNull();

    const [updated] = await db
      .update(contentImages)
      .set({ anchorHeading: "First Section" })
      .where(eq(contentImages.id, image.id))
      .returning();
    expect(updated.anchorHeading).toBe("First Section");
  });
});
