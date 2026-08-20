import { put, del, get } from "@vercel/blob";
import type { ImageRole } from "@/db/schema";
import { MAX_DELIVERABLE_BYTES } from "@/lib/images/compress";

// Brand assets (style reference images) live in a SEPARATE, private Blob
// store from content images — they're inputs the LLM reads, never things a
// blog reader, Webflow, LinkedIn, or a webhook subscriber fetches directly,
// so unlike content they don't need a bare-fetchable URL. Its own token: the
// default `BLOB_READ_WRITE_TOKEN` (used implicitly by every `put`/`del` call
// below that doesn't pass `token`) stays pointed at the public content store,
// so none of that existing code needs to change.
const BRAND_ASSETS_TOKEN = process.env.BRAND_ASSETS_BLOB_READ_WRITE_TOKEN;
const PRIVATE_BLOB_HOST = /\.private\.blob\.vercel-storage\.com$/;

/** Whether a URL points at the private brand-assets store (vs. the public
 * content store, or anything else) — the signal `toBytes` (src/lib/ai/images.ts)
 * needs to pick an authenticated read over a bare fetch. */
export function isBrandAssetUrl(url: string): boolean {
  try {
    return PRIVATE_BLOB_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

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

// Extension -> the format it implies, for files whose reported `type` this
// app doesn't recognize. Some tools/OSes still emit the legacy `image/x-png`
// for PNGs, or report "" when the system has no MIME association registered
// — the bytes are still a real image, only the browser's guess at its own
// `type` field was wrong. Safe to trust the extension here because it is
// only a fast-fail UX gate: `compressPng`'s `sharp(...).metadata()` call is
// what actually verifies the bytes downstream, regardless of either signal.
const UPLOAD_EXTENSIONS: Record<string, true> = { png: true, jpg: true, jpeg: true, webp: true };

export function validateUploadFile(file: { type: string; size: number; name?: string }): { ok: true } | { ok: false; error: string } {
  const extension = file.name?.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  const recognized =
    (UPLOAD_MIME_TYPES as readonly string[]).includes(file.type) || (extension !== undefined && UPLOAD_EXTENSIONS[extension]);
  if (!recognized) {
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
 * Filters `urls` down to the ones genuinely owned by `tenantId`: their blob
 * pathname must start with `tenants/{tenantId}/brand/`, the shape
 * `brandAssetPathname` produces. Mirrors `removeStyleReference`'s ownership
 * check (company/actions.ts) — "array membership alone is not proof of
 * ownership" applies just as much at the point a reference is READ (fetched
 * as render bytes) as at the point one is removed. `saveVisualIdentity`
 * validates `styleReferenceImages` only against the shared Blob store's host,
 * not any particular tenant's path, so a tenant could otherwise persist a
 * foreign tenant's public blob URL into their own array and have it fetched
 * into a render call. Anything that doesn't match is silently dropped, not
 * errored — this is a defensive filter at the point of use, not a place to
 * surface a user-facing failure.
 */
export function ownedBrandReferenceImages(tenantId: string, urls: readonly string[]): string[] {
  const prefix = `tenants/${tenantId}/brand/`;
  return urls.filter((url) => blobPathnameFromUrl(url).startsWith(prefix));
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

/**
 * Uploads one already-compressed PNG to the PRIVATE brand-assets store.
 * `access: "private"` — a style reference image is never delivered to a
 * reader, Webflow, LinkedIn, or a webhook subscriber, so unlike `uploadPng`'s
 * content it has no reason to be bare-fetchable. Dashboard previews and the
 * illustration agent's own reads (`readBrandAsset`, `toBytes` in
 * `src/lib/ai/images.ts`) both go through the token, not the URL alone.
 */
export async function uploadBrandAsset(pathname: string, png: Buffer): Promise<{ url: string; pathname: string }> {
  if (png.byteLength > MAX_DELIVERABLE_BYTES) {
    throw new Error(
      `uploadBrandAsset: ${png.byteLength} bytes exceeds the ${MAX_DELIVERABLE_BYTES}-byte ceiling — did this skip compressPng?`
    );
  }
  const blob = await put(pathname, png, { access: "private", addRandomSuffix: true, contentType: "image/png", token: BRAND_ASSETS_TOKEN });
  return { url: blob.url, pathname: blob.pathname };
}

/** `deleteBlobs`'s counterpart for the private store — same swallow-and-log
 * shape, different token. */
export async function deleteBrandAssets(pathnames: string[]): Promise<void> {
  if (pathnames.length === 0) return;
  try {
    await del(pathnames, { token: BRAND_ASSETS_TOKEN });
  } catch (error) {
    console.error("Failed to delete brand assets:", pathnames, error);
  }
}

/**
 * Reads one brand asset's bytes through the token — the only way to read a
 * private blob, whether the caller is our own dashboard (a proxy route, since
 * the browser has no token) or the illustration agent (`toBytes`). Returns
 * null for a 404/deleted blob rather than throwing, mirroring `get`'s own
 * null-on-not-found contract.
 */
export async function readBrandAsset(urlOrPathname: string): Promise<{ bytes: Buffer; contentType: string | null } | null> {
  const result = await get(urlOrPathname, { access: "private", token: BRAND_ASSETS_TOKEN });
  if (!result || !result.stream) return null;
  const bytes = Buffer.from(await new Response(result.stream).arrayBuffer());
  return { bytes, contentType: result.blob.contentType };
}
