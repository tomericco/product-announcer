import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, contentPieces, contentImages, imageRenders } from "../../../src/db/schema";
import { loadCoverImagePayload } from "../../../src/lib/publishing/cover-image";

const TENANT = "Cover Image Payload Test Tenant";
const OTHER = "Cover Image Payload Other Tenant";

async function seedPiece() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  const [piece] = await db
    .insert(contentPieces)
    .values({ tenantId: tenant.id, title: "T", body: "B", type: "blog_post" })
    .returning();
  return { tenant, piece };
}

// Inserts the rows Plan 1's addRender() would leave behind for a ready cover,
// without going through renderImage/uploadPng: a content_images row whose
// currentRenderId points at one image_renders row.
async function seedCover(tenantId: string, contentPieceId: string, status: "ready" | "pending" | "failed" = "ready") {
  const [image] = await db
    .insert(contentImages)
    .values({
      tenantId,
      contentPieceId,
      role: "cover",
      concept: "a lighthouse beam sweeping over a data grid",
      altText: "Lighthouse beam over a grid of glowing tiles",
      sourceKind: "generated",
      status,
    })
    .returning();
  const [render] = await db
    .insert(imageRenders)
    .values({
      imageId: image.id,
      prompt: "p",
      blobUrl: "https://blob.example/tenants/t/content/p/cover-x-abc.png",
      blobPathname: "tenants/t/content/p/cover-x-abc.png",
      width: 1200,
      height: 630,
      bytes: 123456,
      model: "openai/gpt-image-2",
    })
    .returning();
  await db.update(contentImages).set({ currentRenderId: render.id }).where(eq(contentImages.id, image.id));
  return { image, render };
}

describe("loadCoverImagePayload", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
    await db.delete(tenants).where(eq(tenants.name, OTHER));
  });

  it("returns url/alt/width/height for a ready cover with a current render", async () => {
    const { tenant, piece } = await seedPiece();
    await seedCover(tenant.id, piece.id);

    const cover = await loadCoverImagePayload(tenant.id, piece.id, db);

    expect(cover).toEqual({
      url: "https://blob.example/tenants/t/content/p/cover-x-abc.png",
      alt: "Lighthouse beam over a grid of glowing tiles",
      width: 1200,
      height: 630,
    });
  });

  it("returns null when the piece has no cover row", async () => {
    const { tenant, piece } = await seedPiece();
    expect(await loadCoverImagePayload(tenant.id, piece.id, db)).toBeNull();
  });

  it("returns null when the cover is not ready (failed render), even if a render row exists", async () => {
    const { tenant, piece } = await seedPiece();
    await seedCover(tenant.id, piece.id, "failed");
    expect(await loadCoverImagePayload(tenant.id, piece.id, db)).toBeNull();
  });

  it("returns null for a cover that is `ready` but has no current render (a half-written row)", async () => {
    // `status` and `currentRenderId` are two columns kept in step by store.ts,
    // not one fact. A crash between `addRender`'s insert and its update, or a
    // hand-edited row, leaves a ready cover with a null pointer — and
    // `cover.current!.blobUrl` would throw inside the publish path, turning a
    // cosmetic problem into a failed delivery.
    const { tenant, piece } = await seedPiece();
    await db
      .insert(contentImages)
      .values({
        tenantId: tenant.id,
        contentPieceId: piece.id,
        role: "cover",
        concept: "c",
        altText: "a",
        sourceKind: "generated",
        status: "ready",
      })
      .returning();
    expect(await loadCoverImagePayload(tenant.id, piece.id, db)).toBeNull();
  });

  it("passes an EMPTY alt through rather than inventing one", async () => {
    // Uploaded covers get `altText: ""` (spec §2: decorative → empty alt,
    // Plan 3's uploadImageFile). All three destinations must receive "" and
    // decide for themselves — see the LinkedIn note in Task 7.
    const { tenant, piece } = await seedPiece();
    const [image] = await db
      .insert(contentImages)
      .values({ tenantId: tenant.id, contentPieceId: piece.id, role: "cover", concept: "c", altText: "", sourceKind: "uploaded", status: "ready" })
      .returning();
    const [render] = await db
      .insert(imageRenders)
      .values({ imageId: image.id, prompt: "", blobUrl: "https://blob.example/u.png", blobPathname: "p/u.png", width: 1200, height: 630, bytes: 1, model: "upload" })
      .returning();
    await db.update(contentImages).set({ currentRenderId: render.id }).where(eq(contentImages.id, image.id));

    expect(await loadCoverImagePayload(tenant.id, piece.id, db)).toEqual({
      url: "https://blob.example/u.png",
      alt: "",
      width: 1200,
      height: 630,
    });
  });

  it("reports the render's ACTUAL dimensions, not the requested 1200x630", async () => {
    // Covers are generated wide and NEVER cropped (product owner decision 1,
    // 2026-08-19): `renderImage` restates the size + aspect ratio and re-asks
    // once, and `compressPng` only ever resizes by width. If a provider still
    // returns a square, that square is stored with its true dimensions rather
    // than cut — so whatever is on the row is exactly what receivers get. Pin
    // that: a reader of the webhook payload must never be told 1200x630 about
    // a 1024x1024 file.
    const { tenant, piece } = await seedPiece();
    const [image] = await db
      .insert(contentImages)
      .values({ tenantId: tenant.id, contentPieceId: piece.id, role: "cover", concept: "c", altText: "a", sourceKind: "generated", status: "ready" })
      .returning();
    const [render] = await db
      .insert(imageRenders)
      .values({ imageId: image.id, prompt: "p", blobUrl: "https://blob.example/sq.png", blobPathname: "p/sq.png", width: 1024, height: 1024, bytes: 1, model: "m" })
      .returning();
    await db.update(contentImages).set({ currentRenderId: render.id }).where(eq(contentImages.id, image.id));

    expect(await loadCoverImagePayload(tenant.id, piece.id, db)).toMatchObject({ width: 1024, height: 1024 });
  });

  it("refuses another tenant's cover", async () => {
    const { tenant, piece } = await seedPiece();
    await seedCover(tenant.id, piece.id);
    const [other] = await db.insert(tenants).values({ name: OTHER }).returning();
    expect(await loadCoverImagePayload(other.id, piece.id, db)).toBeNull();
  });
});
