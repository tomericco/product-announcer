import { describe, it, expect, afterEach } from "vitest";
import { db } from "../../../src/db";
import { getCoverImage, getCoverImagesForPieces } from "../../../src/lib/images/store";
import { dropTenant, seedContentImage, seedContentPiece, seedTenant } from "../../helpers/fixtures";

// Unique to this file — there is no truncation between tests, only
// dropTenant's cascade (tests/helpers/fixtures.ts:5-10).
const TENANT = "Board Cover Batch Test Tenant";
const OTHER_TENANT = "Board Cover Batch Other Test Tenant";

afterEach(async () => {
  await dropTenant(TENANT);
  await dropTenant(OTHER_TENANT);
});

describe("getCoverImagesForPieces", () => {
  it("returns one entry per piece that has a cover with a current render", async () => {
    const tenant = await seedTenant(TENANT);
    const a = await seedContentPiece(tenant.id, { title: "A" });
    const b = await seedContentPiece(tenant.id, { title: "B" });
    const bare = await seedContentPiece(tenant.id, { title: "Bare" });
    const coverA = await seedContentImage({
      tenantId: tenant.id,
      contentPieceId: a.id,
      role: "cover",
      overrides: { altText: "Lighthouse beam over a grid of tiles" },
    });
    const coverB = await seedContentImage({ tenantId: tenant.id, contentPieceId: b.id, role: "cover" });

    const covers = await getCoverImagesForPieces(tenant.id, [a.id, b.id, bare.id], db);
    expect(covers.get(a.id)).toEqual({ url: coverA.render!.blobUrl, alt: "Lighthouse beam over a grid of tiles" });
    expect(covers.get(b.id)).toEqual({ url: coverB.render!.blobUrl, alt: coverB.image.altText });
    // A piece with no cover row is ABSENT, not present-and-null: the board
    // turns a miss into `cover: null` itself.
    expect(covers.has(bare.id)).toBe(false);
  });

  it("skips a cover row whose generation never produced a render", async () => {
    const tenant = await seedTenant(TENANT);
    const piece = await seedContentPiece(tenant.id);
    // Exactly the failed-agent-cover state Task 9's `coverPromptSeed` reads:
    // the row exists, `currentRenderId` is null. There is nothing to draw.
    await seedContentImage({ tenantId: tenant.id, contentPieceId: piece.id, role: "cover", withRender: false });

    expect(await getCoverImagesForPieces(tenant.id, [piece.id], db)).toEqual(new Map());
  });

  it("ignores body and library images", async () => {
    const tenant = await seedTenant(TENANT);
    const piece = await seedContentPiece(tenant.id);
    await seedContentImage({ tenantId: tenant.id, contentPieceId: piece.id, role: "body" });
    await seedContentImage({ tenantId: tenant.id, contentPieceId: null, role: "library" });

    expect(await getCoverImagesForPieces(tenant.id, [piece.id], db)).toEqual(new Map());
  });

  it("is scoped to the tenant and short-circuits an empty id list", async () => {
    const mine = await seedTenant(TENANT);
    const other = await seedTenant(OTHER_TENANT);
    const theirs = await seedContentPiece(other.id, { title: "Theirs" });
    await seedContentImage({ tenantId: other.id, contentPieceId: theirs.id, role: "cover" });

    // The id is real, the tenant is not the owner — the row must not leak.
    expect(await getCoverImagesForPieces(mine.id, [theirs.id], db)).toEqual(new Map());
    expect(await getCoverImagesForPieces(mine.id, [], db)).toEqual(new Map());
  });

  it("agrees with getCoverImage — one rule for what a piece's cover is, not two", async () => {
    const tenant = await seedTenant(TENANT);
    const piece = await seedContentPiece(tenant.id);
    await seedContentImage({ tenantId: tenant.id, contentPieceId: piece.id, role: "cover" });

    const single = await getCoverImage(tenant.id, piece.id, db);
    const batched = await getCoverImagesForPieces(tenant.id, [piece.id], db);
    expect(batched.get(piece.id)).toEqual({ url: single!.current!.blobUrl, alt: single!.altText });
  });
});
