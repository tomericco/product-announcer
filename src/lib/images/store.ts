import { and, asc, desc, eq, inArray, isNull, ne, notInArray, or, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
  contentImages,
  contentPieces,
  imageRenders,
  type ContentImage,
  type ImageRender,
  type ImageRole,
  type ImageSourceKind,
  type ImageStatus,
} from "@/db/schema";
import type { DbClient } from "@/lib/publishing/destinations/types";
import { deleteBlobs as defaultDeleteBlobs } from "@/lib/images/blob";

/** Renders kept per image (spec §3). Oldest are pruned, blobs deleted (spec §7). */
export const MAX_RENDER_HISTORY = 5;

export type StoreDeps = { deleteBlobs?: (pathnames: string[]) => Promise<void> };

export async function createImage(
  a: {
    tenantId: string;
    contentPieceId: string | null;
    role: ImageRole;
    concept: string;
    altText: string;
    sourceKind: ImageSourceKind;
    status?: ImageStatus;
  },
  database: DbClient = db
): Promise<ContentImage> {
  const [row] = await database
    .insert(contentImages)
    .values({
      tenantId: a.tenantId,
      contentPieceId: a.contentPieceId,
      role: a.role,
      concept: a.concept,
      altText: a.altText,
      sourceKind: a.sourceKind,
      status: a.status ?? "pending",
    })
    .returning();
  return row;
}

async function pieceIsPublished(contentPieceId: string | null, database: DbClient): Promise<boolean> {
  if (!contentPieceId) return false;
  const [piece] = await database
    .select({ publishedAt: contentPieces.publishedAt })
    .from(contentPieces)
    .where(eq(contentPieces.id, contentPieceId))
    .limit(1);
  return piece?.publishedAt != null;
}

/**
 * Records a render, makes it current, marks the image ready, and prunes
 * history beyond MAX_RENDER_HISTORY (oldest first), deleting the pruned blobs.
 * Pruning is skipped ENTIRELY when the image's piece has been published:
 * Webflow hotlinks body images (spec §8), so a blob a published page might
 * still point at is never deleted — rows are kept too, so history and blobs
 * stay in step.
 */
export async function addRender(
  a: {
    imageId: string;
    prompt: string;
    blobUrl: string;
    blobPathname: string;
    width: number;
    height: number;
    bytes: number;
    model: string;
  },
  database: DbClient = db,
  deps: StoreDeps = {}
): Promise<ImageRender> {
  const deleteBlobs = deps.deleteBlobs ?? defaultDeleteBlobs;

  const [render] = await database.insert(imageRenders).values(a).returning();
  const [image] = await database
    .update(contentImages)
    .set({ currentRenderId: render.id, status: "ready", updatedAt: new Date() })
    .where(eq(contentImages.id, a.imageId))
    .returning();

  if (await pieceIsPublished(image.contentPieceId, database)) return render;

  const history = await database
    .select({ id: imageRenders.id, blobPathname: imageRenders.blobPathname })
    .from(imageRenders)
    .where(and(eq(imageRenders.imageId, a.imageId), ne(imageRenders.id, render.id)))
    .orderBy(asc(imageRenders.createdAt), asc(imageRenders.id));
  // `history` excludes the render just added, so keep MAX - 1 of the rest.
  const excess = history.length - (MAX_RENDER_HISTORY - 1);
  if (excess > 0) {
    const pruned = history.slice(0, excess);
    await database.delete(imageRenders).where(
      inArray(
        imageRenders.id,
        pruned.map((r) => r.id)
      )
    );
    await deleteBlobs(pruned.map((r) => r.blobPathname));
  }
  return render;
}

export async function setCurrentRender(imageId: string, renderId: string, database: DbClient = db): Promise<void> {
  await database
    .update(contentImages)
    .set({ currentRenderId: renderId, status: "ready", updatedAt: new Date() })
    .where(eq(contentImages.id, imageId));
}

export async function markImageFailed(imageId: string, database: DbClient = db): Promise<void> {
  await database.update(contentImages).set({ status: "failed", updatedAt: new Date() }).where(eq(contentImages.id, imageId));
}

export async function getImage(
  tenantId: string,
  imageId: string,
  database: DbClient = db
): Promise<(ContentImage & { renders: ImageRender[]; current: ImageRender | null }) | null> {
  const [image] = await database
    .select()
    .from(contentImages)
    .where(and(eq(contentImages.tenantId, tenantId), eq(contentImages.id, imageId)))
    .limit(1);
  if (!image) return null;
  const renders = await database
    .select()
    .from(imageRenders)
    .where(eq(imageRenders.imageId, image.id))
    .orderBy(desc(imageRenders.createdAt), desc(imageRenders.id));
  const current = renders.find((r) => r.id === image.currentRenderId) ?? null;
  return { ...image, renders, current };
}

export async function getCoverImage(
  tenantId: string,
  contentPieceId: string,
  database: DbClient = db
): Promise<(ContentImage & { current: ImageRender | null }) | null> {
  const [row] = await database
    .select({ image: contentImages, current: imageRenders })
    .from(contentImages)
    .leftJoin(imageRenders, eq(imageRenders.id, contentImages.currentRenderId))
    .where(
      and(eq(contentImages.tenantId, tenantId), eq(contentImages.contentPieceId, contentPieceId), eq(contentImages.role, "cover"))
    )
    .limit(1);
  if (!row) return null;
  return { ...row.image, current: row.current };
}

export type ImageFilter = { contentPieceId?: string; role?: ImageRole; sourceKind?: ImageSourceKind };

async function selectImages(
  tenantId: string,
  filter: ImageFilter,
  database: DbClient,
  extra: (SQL | undefined)[] = []
): Promise<(ContentImage & { current: ImageRender | null; pieceTitle: string | null })[]> {
  const conditions: (SQL | undefined)[] = [eq(contentImages.tenantId, tenantId)];
  if (filter.contentPieceId) conditions.push(eq(contentImages.contentPieceId, filter.contentPieceId));
  if (filter.role) conditions.push(eq(contentImages.role, filter.role));
  if (filter.sourceKind) conditions.push(eq(contentImages.sourceKind, filter.sourceKind));
  conditions.push(...extra);

  const rows = await database
    .select({ image: contentImages, current: imageRenders, pieceTitle: contentPieces.title })
    .from(contentImages)
    .leftJoin(imageRenders, eq(imageRenders.id, contentImages.currentRenderId))
    .leftJoin(contentPieces, eq(contentPieces.id, contentImages.contentPieceId))
    .where(and(...conditions))
    .orderBy(desc(contentImages.createdAt), desc(contentImages.id));
  return rows.map((r) => ({ ...r.image, current: r.current, pieceTitle: r.pieceTitle ?? null }));
}

/**
 * Every image for the tenant. This is the EDITOR's view — a draft's own images
 * are visible while the draft is being written, which is the whole point of
 * the per-piece listing. The library uses `listLibraryImages` instead.
 */
export async function listImages(
  tenantId: string,
  filter: ImageFilter = {},
  database: DbClient = db
): Promise<(ContentImage & { current: ImageRender | null; pieceTitle: string | null })[]> {
  return selectImages(tenantId, filter, database);
}

/**
 * The piece statuses whose images are NOT in the library yet: a piece still
 * being briefed or drafted is in flight, and its images belong to the person
 * writing it (spec §5b, product owner decision 4, 2026-08-19). `contentPieces`
 * has exactly six statuses (`src/db/schema.ts:89-97`) — the other four
 * (review, scheduled, published, archived) are "completed" for this purpose.
 */
export const LIBRARY_HIDDEN_PIECE_STATUSES = ["brief", "draft"] as const;

/**
 * What the /images library and the "From library" picker list: standalone
 * `role: "library"` images (which have no piece and are always shown) plus the
 * images of pieces that are past drafting. Keeping in-flight drafts out is what
 * makes the library safe — deleting a library image can never mutate a body
 * someone is writing, so no library action ever has to stamp `bodyEditedAt`
 * and freeze that draft's regeneration.
 */
export async function listLibraryImages(
  tenantId: string,
  filter: ImageFilter = {},
  database: DbClient = db
): Promise<(ContentImage & { current: ImageRender | null; pieceTitle: string | null })[]> {
  return selectImages(tenantId, filter, database, [
    or(
      isNull(contentImages.contentPieceId),
      notInArray(contentPieces.status, [...LIBRARY_HIDDEN_PIECE_STATUSES])
    ),
  ]);
}

/**
 * Deletes an image, its renders (cascade) and their blobs. Refuses when the
 * piece is published — Webflow hotlinks these (spec §5b, §8) — so the library
 * can explain rather than fail silently.
 */
export async function deleteImage(
  tenantId: string,
  imageId: string,
  database: DbClient = db,
  deps: StoreDeps = {}
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "published" }> {
  const deleteBlobs = deps.deleteBlobs ?? defaultDeleteBlobs;
  const image = await getImage(tenantId, imageId, database);
  if (!image) return { ok: false, reason: "not_found" };
  if (await pieceIsPublished(image.contentPieceId, database)) return { ok: false, reason: "published" };

  await database.delete(contentImages).where(and(eq(contentImages.tenantId, tenantId), eq(contentImages.id, imageId)));
  // Oldest first, matching insertion order — cosmetic, but stable for logs.
  await deleteBlobs([...image.renders].reverse().map((r) => r.blobPathname));
  return { ok: true };
}

/** The editor maps an `<img src>` back to its row (spec §3: body images join by blob URL). */
export async function findImageByRenderUrl(
  tenantId: string,
  url: string,
  database: DbClient = db
): Promise<{ image: ContentImage; render: ImageRender } | null> {
  const [row] = await database
    .select({ image: contentImages, render: imageRenders })
    .from(imageRenders)
    .innerJoin(contentImages, eq(contentImages.id, imageRenders.imageId))
    .where(and(eq(contentImages.tenantId, tenantId), eq(imageRenders.blobUrl, url)))
    .limit(1);
  return row ?? null;
}
