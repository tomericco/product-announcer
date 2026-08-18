import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, contentPieces, channelVariants } from "../../src/db/schema";

const TENANT = "Channel Variants Schema Test Tenant";

async function seedPiece() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  const [piece] = await db
    .insert(contentPieces)
    .values({ tenantId: tenant.id, title: "T", body: "B" })
    .returning();
  return piece;
}

describe("channel_variants schema", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("stores one body per piece and channel, with editedAt null by default", async () => {
    const piece = await seedPiece();
    const [variant] = await db
      .insert(channelVariants)
      .values({ contentPieceId: piece.id, channel: "linkedin", body: "post copy" })
      .returning();
    expect(variant.body).toBe("post copy");
    expect(variant.editedAt).toBeNull();
  });

  it("rejects a second variant for the same piece and channel", async () => {
    const piece = await seedPiece();
    await db.insert(channelVariants).values({ contentPieceId: piece.id, channel: "linkedin", body: "one" });
    await expect(
      db.insert(channelVariants).values({ contentPieceId: piece.id, channel: "linkedin", body: "two" })
    ).rejects.toThrow();
  });

  it("cascades when the content piece is deleted", async () => {
    const piece = await seedPiece();
    await db.insert(channelVariants).values({ contentPieceId: piece.id, channel: "linkedin", body: "copy" });
    await db.delete(contentPieces).where(eq(contentPieces.id, piece.id));
    const rows = await db.select().from(channelVariants).where(eq(channelVariants.contentPieceId, piece.id));
    expect(rows).toHaveLength(0);
  });
});
