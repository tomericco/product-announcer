import { put, del } from "@vercel/blob";
import type { ImageRole } from "@/db/schema";
import { MAX_DELIVERABLE_BYTES } from "@/lib/images/compress";

const MAX_SLUG = 40;

/** A filesystem-safe slug for a pathname; never empty. */
export function slugForImage(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, "");
  return slug || "image";
}

/**
 * `tenants/{tenantId}/content/{contentPieceId ?? "library"}/{role}-{slug}.png`
 * (spec §7): tenant prefix for accounting; `put()` adds the random suffix that
 * makes it immutable and unguessable.
 */
export function imagePathname(a: { tenantId: string; contentPieceId: string | null; role: ImageRole; slug: string }): string {
  return `tenants/${a.tenantId}/content/${a.contentPieceId ?? "library"}/${a.role}-${a.slug}.png`;
}

/**
 * `tenants/{tenantId}/brand/{slug}.png` — style reference images and any other
 * brand INPUT. Deliberately outside the `content/` tree: these are not content
 * output, they have no `content_images` row and no piece, and putting them in
 * `content/library/` would make them show up as library images that cannot be
 * regenerated (product owner decision 3, 2026-08-19).
 */
export function brandAssetPathname(a: { tenantId: string; slug: string }): string {
  return `tenants/${a.tenantId}/brand/${a.slug}.png`;
}

/** What may be uploaded, in bytes and mime types. Shared with Plan 3's editor
 * uploads — one definition, re-exported there. The 10 MB is the INPUT cap; the
 * stored PNG is capped separately at `MAX_IMAGE_BYTES` by `compressPng`. */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const UPLOAD_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export function validateUploadFile(file: { type: string; size: number }): { ok: true } | { ok: false; error: string } {
  if (!(UPLOAD_MIME_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, error: "Only PNG, JPEG or WebP images can be uploaded." };
  }
  if (file.size > UPLOAD_MAX_BYTES) {
    return { ok: false, error: "Images must be 10 MB or smaller." };
  }
  return { ok: true };
}

/**
 * The pathname a stored blob URL corresponds to. `del()` accepts either, but
 * `deleteBlobs` takes pathnames, and the visual identity card stores reference
 * images as URLs only (no row carries their pathname), so removal needs this.
 */
export function blobPathnameFromUrl(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\/+/, "");
  } catch {
    return url;
  }
}

/**
 * Uploads one already-compressed PNG. Public — these are marketing images
 * that go public at publish anyway; the random suffix is the access control
 * for unpublished drafts. Never overwrites: regeneration writes a new blob.
 *
 * The `MAX_DELIVERABLE_BYTES` (4 MB) check below is a sanity backstop, not a
 * re-check of `compressPng`'s own ceiling: `compressPng` targets
 * `MAX_IMAGE_BYTES` (1 MB) but its bounded loop can legitimately land slightly
 * over that in its warn-not-throw path (already reviewed and accepted) — this
 * must not reject that. It exists only to catch a caller that skipped
 * compression entirely and handed this raw, multi-MB bytes by mistake.
 */
export async function uploadPng(pathname: string, png: Buffer): Promise<{ url: string; pathname: string }> {
  if (png.byteLength > MAX_DELIVERABLE_BYTES) {
    throw new Error(
      `uploadPng: ${png.byteLength} bytes exceeds the ${MAX_DELIVERABLE_BYTES}-byte ceiling — did this skip compressPng?`
    );
  }
  const blob = await put(pathname, png, { access: "public", addRandomSuffix: true, contentType: "image/png" });
  return { url: blob.url, pathname: blob.pathname };
}

/**
 * Deletes blobs by pathname. Swallows errors: deletion is cleanup after a
 * render was pruned or an image row removed, and the row change must not be
 * undone by a Blob hiccup. Never uses `list()` (an advanced op on Hobby).
 */
export async function deleteBlobs(pathnames: string[]): Promise<void> {
  if (pathnames.length === 0) return;
  try {
    await del(pathnames);
  } catch (error) {
    console.error("Failed to delete blobs:", pathnames, error);
  }
}
