import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { contentImages, contentPieces, imageRenders } from "../../../src/db/schema";
import { seedTenant, dropTenant } from "../../helpers/fixtures";
import {
  MAX_RENDER_HISTORY,
  createImage,
  addRender,
  setCurrentRender,
  markImageFailed,
  getImage,
  getCoverImage,
  listImages,
  listLibraryImages,
  deleteImage,
  findImageByRenderUrl,
} from "../../../src/lib/images/store";

const TENANT = "Image Store Test Tenant";
const OTHER = "Image Store Other Tenant";

afterEach(async () => {
  await dropTenant(TENANT);
  await dropTenant(OTHER);
});

async function seedPiece(tenantId: string, title = "Piece") {
  const [piece] = await db.insert(contentPieces).values({ tenantId, title, body: "B", type: "blog_post" }).returning();
  return piece;
}

function renderArgs(imageId: string, n: number) {
  return { imageId, prompt: `p${n}`, blobUrl: `https://blob/r${n}.png`, blobPathname: `tenants/t/r${n}.png`, width: 1200, height: 630, bytes: 100, model: "gpt-image-2" };
}

describe("createImage / addRender / getImage", () => {
  it("creates a pending image, then a render makes it ready and current", async () => {
    const tenant = await seedTenant(TENANT);
    const piece = await seedPiece(tenant.id);
    const image = await createImage({ tenantId: tenant.id, contentPieceId: piece.id, role: "cover", concept: "c", altText: "a", sourceKind: "generated" });
    expect(image.status).toBe("pending");
    expect(image.currentRenderId).toBeNull();

    const render = await addRender(renderArgs(image.id, 1));
    const loaded = await getImage(tenant.id, image.id);
    expect(loaded?.status).toBe("ready");
    expect(loaded?.currentRenderId).toBe(render.id);
    expect(loaded?.current?.id).toBe(render.id);
    expect(loaded?.renders).toHaveLength(1);
  });

  it("refuses another tenant's image", async () => {
    const tenant = await seedTenant(TENANT);
    const other = await seedTenant(OTHER);
    const image = await createImage({ tenantId: tenant.id, contentPieceId: null, role: "library", concept: "c", altText: "a", sourceKind: "uploaded", status: "ready" });
    expect(await getImage(other.id, image.id)).toBeNull();
  });
});

describe("addRender pruning", () => {
  it("keeps only the newest MAX_RENDER_HISTORY renders and deletes pruned blobs", async () => {
    const tenant = await seedTenant(TENANT);
    const piece = await seedPiece(tenant.id);
    const image = await createImage({ tenantId: tenant.id, contentPieceId: piece.id, role: "body", concept: "c", altText: "a", sourceKind: "generated" });
    const deleteBlobs = vi.fn<(pathnames: string[]) => Promise<void>>(async () => {});

    for (let n = 1; n <= MAX_RENDER_HISTORY + 2; n++) {
      await addRender(renderArgs(image.id, n), db, { deleteBlobs });
    }

    const loaded = await getImage(tenant.id, image.id);
    expect(loaded?.renders).toHaveLength(MAX_RENDER_HISTORY);
    expect(loaded?.renders.map((r) => r.prompt)).toEqual(["p7", "p6", "p5", "p4", "p3"]);
    expect(loaded?.current?.prompt).toBe("p7");
    const deleted = deleteBlobs.mock.calls.flatMap((c) => c[0]);
    expect(deleted.sort()).toEqual(["tenants/t/r1.png", "tenants/t/r2.png"]);
  });

  it("keeps exactly MAX_RENDER_HISTORY at the boundary and prunes nothing before it", async () => {
    const tenant = await seedTenant(TENANT);
    const image = await createImage({ tenantId: tenant.id, contentPieceId: null, role: "library", concept: "c", altText: "a", sourceKind: "generated" });
    const deleteBlobs = vi.fn(async () => {});

    for (let n = 1; n <= MAX_RENDER_HISTORY; n++) await addRender(renderArgs(image.id, n), db, { deleteBlobs });
    expect((await getImage(tenant.id, image.id))?.renders).toHaveLength(MAX_RENDER_HISTORY);
    expect(deleteBlobs).not.toHaveBeenCalled();

    // The 6th is the first that prunes, and it prunes exactly one.
    await addRender(renderArgs(image.id, MAX_RENDER_HISTORY + 1), db, { deleteBlobs });
    expect((await getImage(tenant.id, image.id))?.renders).toHaveLength(MAX_RENDER_HISTORY);
    expect(deleteBlobs).toHaveBeenCalledTimes(1);
    expect(deleteBlobs).toHaveBeenCalledWith(["tenants/t/r1.png"]);
  });

  it("never leaves currentRenderId dangling when the RESTORED render is the one pruned", async () => {
    // Restore the oldest version, then regenerate. The oldest is both "current"
    // and the prune candidate; addRender must repoint `current` at the new
    // render BEFORE pruning, or the image is left pointing at a deleted row.
    const tenant = await seedTenant(TENANT);
    const image = await createImage({ tenantId: tenant.id, contentPieceId: null, role: "library", concept: "c", altText: "a", sourceKind: "generated" });
    const deleteBlobs = vi.fn(async () => {});
    const first = await addRender(renderArgs(image.id, 1), db, { deleteBlobs });
    for (let n = 2; n <= MAX_RENDER_HISTORY; n++) await addRender(renderArgs(image.id, n), db, { deleteBlobs });
    await setCurrentRender(image.id, first.id);
    expect((await getImage(tenant.id, image.id))?.current?.id).toBe(first.id);

    const fresh = await addRender(renderArgs(image.id, MAX_RENDER_HISTORY + 1), db, { deleteBlobs });

    const loaded = await getImage(tenant.id, image.id);
    expect(loaded?.currentRenderId).toBe(fresh.id);
    expect(loaded?.current).not.toBeNull();
    expect(loaded?.renders.some((r) => r.id === first.id)).toBe(false);
    expect(deleteBlobs).toHaveBeenCalledWith(["tenants/t/r1.png"]);
  });

  it("skips pruning entirely for a published piece", async () => {
    const tenant = await seedTenant(TENANT);
    const piece = await seedPiece(tenant.id);
    await db.update(contentPieces).set({ publishedAt: new Date() }).where(eq(contentPieces.id, piece.id));
    const image = await createImage({ tenantId: tenant.id, contentPieceId: piece.id, role: "body", concept: "c", altText: "a", sourceKind: "generated" });
    const deleteBlobs = vi.fn(async () => {});

    for (let n = 1; n <= MAX_RENDER_HISTORY + 2; n++) {
      await addRender(renderArgs(image.id, n), db, { deleteBlobs });
    }

    const rows = await db.select().from(imageRenders).where(eq(imageRenders.imageId, image.id));
    expect(rows).toHaveLength(MAX_RENDER_HISTORY + 2);
    expect(deleteBlobs).not.toHaveBeenCalled();
  });
});

describe("setCurrentRender / markImageFailed", () => {
  it("restores an older render as current", async () => {
    const tenant = await seedTenant(TENANT);
    const image = await createImage({ tenantId: tenant.id, contentPieceId: null, role: "library", concept: "c", altText: "a", sourceKind: "generated" });
    const first = await addRender(renderArgs(image.id, 1));
    await addRender(renderArgs(image.id, 2));
    await setCurrentRender(image.id, first.id);
    expect((await getImage(tenant.id, image.id))?.current?.id).toBe(first.id);
  });

  it("marks failed", async () => {
    const tenant = await seedTenant(TENANT);
    const image = await createImage({ tenantId: tenant.id, contentPieceId: null, role: "library", concept: "c", altText: "a", sourceKind: "generated" });
    await markImageFailed(image.id);
    expect((await getImage(tenant.id, image.id))?.status).toBe("failed");
  });
});

describe("getCoverImage / listImages / findImageByRenderUrl", () => {
  it("finds the cover with its current render, and lists with filters and piece titles", async () => {
    const tenant = await seedTenant(TENANT);
    const piece = await seedPiece(tenant.id, "Launch post");
    const cover = await createImage({ tenantId: tenant.id, contentPieceId: piece.id, role: "cover", concept: "c", altText: "a", sourceKind: "generated" });
    const coverRender = await addRender(renderArgs(cover.id, 1));
    const body = await createImage({ tenantId: tenant.id, contentPieceId: piece.id, role: "body", concept: "b", altText: "a", sourceKind: "uploaded", status: "ready" });
    await createImage({ tenantId: tenant.id, contentPieceId: null, role: "library", concept: "l", altText: "a", sourceKind: "generated", status: "ready" });

    const found = await getCoverImage(tenant.id, piece.id);
    expect(found?.id).toBe(cover.id);
    expect(found?.current?.blobUrl).toBe("https://blob/r1.png");

    const all = await listImages(tenant.id);
    expect(all).toHaveLength(3);
    expect(all.find((i) => i.id === cover.id)?.pieceTitle).toBe("Launch post");
    expect(all.find((i) => i.id === cover.id)?.current?.id).toBe(coverRender.id);
    expect(all.find((i) => i.role === "library")?.pieceTitle).toBeNull();

    expect((await listImages(tenant.id, { contentPieceId: piece.id })).map((i) => i.id).sort()).toEqual([cover.id, body.id].sort());
    expect((await listImages(tenant.id, { role: "cover" })).map((i) => i.id)).toEqual([cover.id]);
    expect((await listImages(tenant.id, { sourceKind: "uploaded" })).map((i) => i.id)).toEqual([body.id]);

    const byUrl = await findImageByRenderUrl(tenant.id, "https://blob/r1.png");
    expect(byUrl?.image.id).toBe(cover.id);
    expect(byUrl?.render.id).toBe(coverRender.id);
    expect(await findImageByRenderUrl(tenant.id, "https://blob/nope.png")).toBeNull();
  });

  it("never resolves another tenant's render URL (the editor's src -> row lookup is the leak risk)", async () => {
    // `lookupImageBySrc` (Plan 3) passes an arbitrary client-supplied URL here.
    // Without the tenant predicate, pasting a competitor's blob URL into the
    // editor would return their prompt and full render history.
    const tenant = await seedTenant(TENANT);
    const other = await seedTenant(OTHER);
    const mine = await createImage({ tenantId: tenant.id, contentPieceId: null, role: "library", concept: "c", altText: "a", sourceKind: "generated" });
    await addRender(renderArgs(mine.id, 1));

    expect(await findImageByRenderUrl(other.id, "https://blob/r1.png")).toBeNull();
    expect((await findImageByRenderUrl(tenant.id, "https://blob/r1.png"))?.image.id).toBe(mine.id);
  });

  it("scopes getCoverImage and listImages to the tenant", async () => {
    const tenant = await seedTenant(TENANT);
    const other = await seedTenant(OTHER);
    const piece = await seedPiece(tenant.id);
    await createImage({ tenantId: tenant.id, contentPieceId: piece.id, role: "cover", concept: "c", altText: "a", sourceKind: "generated", status: "ready" });

    expect(await getCoverImage(other.id, piece.id)).toBeNull();
    expect(await listImages(other.id)).toHaveLength(0);
    expect(await listImages(other.id, { contentPieceId: piece.id })).toHaveLength(0);
  });
});

describe("listLibraryImages", () => {
  // Product owner decision 4 (2026-08-19): an image enters the library only
  // once its piece is past drafting. That is what makes deleting from the
  // library safe — it can never rewrite a body someone is still writing.
  async function seedImageOnPieceWithStatus(tenantId: string, status: (typeof STATUSES)[number]) {
    const [piece] = await db
      .insert(contentPieces)
      .values({ tenantId, title: `Piece ${status}`, body: "B", type: "blog_post", status })
      .returning();
    const image = await createImage({ tenantId, contentPieceId: piece.id, role: "body", concept: status, altText: "a", sourceKind: "generated" });
    await addRender({ ...renderArgs(image.id, 1), blobUrl: `https://blob/${status}.png`, blobPathname: `tenants/t/${status}.png` });
    return image;
  }

  const STATUSES = ["brief", "draft", "review", "scheduled", "published", "archived"] as const;

  it("excludes images of pieces still in brief or draft, and includes every later status", async () => {
    const tenant = await seedTenant(TENANT);
    const byStatus = new Map<string, string>();
    for (const status of STATUSES) {
      byStatus.set(status, (await seedImageOnPieceWithStatus(tenant.id, status)).id);
    }

    const concepts = (await listLibraryImages(tenant.id)).map((i) => i.concept).sort();
    expect(concepts).toEqual(["archived", "published", "review", "scheduled"]);

    // The editor's own listing is untouched — a draft's images stay reachable
    // where they are being written.
    expect(await listImages(tenant.id)).toHaveLength(STATUSES.length);
    expect(byStatus.size).toBe(STATUSES.length);
  });

  it("always includes a standalone library image, which has no piece to be in progress", async () => {
    const tenant = await seedTenant(TENANT);
    const standalone = await createImage({ tenantId: tenant.id, contentPieceId: null, role: "library", concept: "compass", altText: "a", sourceKind: "generated" });
    await addRender(renderArgs(standalone.id, 1));
    await seedImageOnPieceWithStatus(tenant.id, "draft");

    expect((await listLibraryImages(tenant.id)).map((i) => i.id)).toEqual([standalone.id]);
  });

  it("applies the same filters and tenant scope as listImages", async () => {
    const tenant = await seedTenant(TENANT);
    const other = await seedTenant(OTHER);
    const published = await seedImageOnPieceWithStatus(tenant.id, "published");

    expect((await listLibraryImages(tenant.id, { role: "body" })).map((i) => i.id)).toEqual([published.id]);
    expect(await listLibraryImages(tenant.id, { role: "cover" })).toHaveLength(0);
    expect(await listLibraryImages(other.id)).toHaveLength(0);
  });
});

describe("deleteImage", () => {
  it("deletes rows and blobs for an unpublished piece", async () => {
    const tenant = await seedTenant(TENANT);
    const piece = await seedPiece(tenant.id);
    const image = await createImage({ tenantId: tenant.id, contentPieceId: piece.id, role: "body", concept: "c", altText: "a", sourceKind: "generated" });
    await addRender(renderArgs(image.id, 1));
    await addRender(renderArgs(image.id, 2));
    const deleteBlobs = vi.fn(async () => {});

    expect(await deleteImage(tenant.id, image.id, db, { deleteBlobs })).toEqual({ ok: true });
    expect(await db.select().from(contentImages).where(eq(contentImages.id, image.id))).toHaveLength(0);
    expect(deleteBlobs).toHaveBeenCalledWith(["tenants/t/r1.png", "tenants/t/r2.png"]);
  });

  it("refuses when the piece is published, and reports not_found across tenants", async () => {
    const tenant = await seedTenant(TENANT);
    const other = await seedTenant(OTHER);
    const piece = await seedPiece(tenant.id);
    await db.update(contentPieces).set({ publishedAt: new Date() }).where(eq(contentPieces.id, piece.id));
    const image = await createImage({ tenantId: tenant.id, contentPieceId: piece.id, role: "cover", concept: "c", altText: "a", sourceKind: "generated" });
    const deleteBlobs = vi.fn(async () => {});

    expect(await deleteImage(tenant.id, image.id, db, { deleteBlobs })).toEqual({ ok: false, reason: "published" });
    expect(await deleteImage(other.id, image.id, db, { deleteBlobs })).toEqual({ ok: false, reason: "not_found" });
    expect(deleteBlobs).not.toHaveBeenCalled();
  });
});
