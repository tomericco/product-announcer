import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, contentPieces, atomicUpdates } from "../../src/db/schema";

const TENANT = "Content Pieces Schema Test Tenant";

describe("content_pieces schema", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("defaults type to product_update and status to draft", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [piece] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, title: "T", body: "B" })
      .returning();
    expect(piece.type).toBe("product_update");
    expect(piece.status).toBe("draft");
  });

  it("accepts the new content types and lifecycle statuses", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [piece] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, title: "T", body: "B", type: "blog_post", status: "scheduled" })
      .returning();
    expect(piece.type).toBe("blog_post");
    expect(piece.status).toBe("scheduled");
  });

  it("allows a cross-repo content piece (null repoId)", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [piece] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, title: "T", body: "B" })
      .returning();
    expect(piece.repoId).toBeNull();
  });

  it("defaults composedAt to now and leaves bodyEditedAt and scheduledFor null", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [piece] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, title: "T", body: "B" })
      .returning();
    expect(piece.composedAt).not.toBeNull();
    expect(piece.bodyEditedAt).toBeNull();
    expect(piece.scheduledFor).toBeNull();
  });

  it("links an atomic update to a content piece and nulls the FK on delete", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [piece] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, title: "T", body: "B" })
      .returning();
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "A", summary: "S", contentPieceId: piece.id })
      .returning();
    expect(atomic.contentPieceId).toBe(piece.id);

    await db.delete(contentPieces).where(eq(contentPieces.id, piece.id));
    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomic.id));
    expect(after.contentPieceId).toBeNull();
  });
});
