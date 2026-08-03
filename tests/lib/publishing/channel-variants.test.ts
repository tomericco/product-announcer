import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, contentPieces } from "../../../src/db/schema";
import { readVariant, writeVariant } from "../../../src/lib/publishing/channel-variants";

const TENANT = "Channel Variants Helper Test Tenant";

async function seedPiece() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  const [piece] = await db
    .insert(contentPieces)
    .values({ tenantId: tenant.id, title: "T", body: "B" })
    .returning();
  return piece;
}

describe("channel variant helpers", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("returns null when no variant exists", async () => {
    const piece = await seedPiece();
    expect(await readVariant(db, piece.id, "linkedin")).toBeNull();
  });

  it("writes then reads a variant", async () => {
    const piece = await seedPiece();
    await writeVariant(db, piece.id, "linkedin", "generated copy");
    const variant = await readVariant(db, piece.id, "linkedin");
    expect(variant?.body).toBe("generated copy");
    expect(variant?.editedAt).toBeNull();
  });

  it("overwrites on a second write instead of inserting a duplicate", async () => {
    const piece = await seedPiece();
    await writeVariant(db, piece.id, "linkedin", "first");
    await writeVariant(db, piece.id, "linkedin", "second");
    expect((await readVariant(db, piece.id, "linkedin"))?.body).toBe("second");
  });

  it("stamps editedAt when the write is a hand edit", async () => {
    const piece = await seedPiece();
    await writeVariant(db, piece.id, "linkedin", "typed by a human", { edited: true });
    expect((await readVariant(db, piece.id, "linkedin"))?.editedAt).not.toBeNull();
  });
});
