import { db } from "@/db";
import type { ImageRender, ImageRole } from "@/db/schema";
import type { DbClient } from "@/lib/publishing/destinations/types";
import { renderImage as defaultRenderImage } from "@/lib/ai/images";
import { IMAGE_MODEL_DEFAULT, imageModelId } from "@/lib/ai/image-model";
import { compressPng as defaultCompressPng } from "@/lib/images/compress";
import { imagePathname, uploadPng as defaultUploadPng } from "@/lib/images/blob";
import { addRender } from "@/lib/images/store";

/**
 * The one path every editor / cover / library render takes after a row
 * exists: model → compress (spec §7, mandatory before put()) → Blob →
 * `addRender` (which makes it current and prunes history). Plan 2's
 * `illustratePiece` inlines the same sequence for the agent; this is the
 * shared version for user-initiated renders. Deps are injectable so the
 * node tests never touch the model or Blob.
 */
export type GenerateDeps = {
  renderImage?: typeof defaultRenderImage;
  compressPng?: typeof defaultCompressPng;
  uploadPng?: typeof defaultUploadPng;
};

/** Both cover (1200x624) and body (1200x896) masters are 1200 px wide (spec §7). */
export const RENDER_MAX_WIDTH = 1200;

export async function storeRenderBytes(
  a: {
    tenantId: string;
    imageId: string;
    contentPieceId: string | null;
    role: ImageRole;
    slug: string;
    /** Bytes in any sharp-readable format; compressed to PNG here. */
    png: Buffer;
    prompt: string;
    model: string;
    database?: DbClient;
  },
  deps: GenerateDeps = {}
): Promise<ImageRender> {
  const compress = deps.compressPng ?? defaultCompressPng;
  const upload = deps.uploadPng ?? defaultUploadPng;
  const database = a.database ?? db;

  const { png, width, height } = await compress(a.png, RENDER_MAX_WIDTH);
  const { url, pathname } = await upload(
    imagePathname({ tenantId: a.tenantId, contentPieceId: a.contentPieceId, role: a.role, slug: a.slug }),
    png
  );
  return addRender(
    { imageId: a.imageId, prompt: a.prompt, blobUrl: url, blobPathname: pathname, width, height, bytes: png.byteLength, model: a.model },
    database
  );
}

export async function renderAndStore(
  a: {
    tenantId: string;
    imageId: string;
    contentPieceId: string | null;
    role: ImageRole;
    slug: string;
    /** What the model receives: the full prompt, or the instruction when `editOf` is set. */
    prompt: string;
    size: "1200x624" | "1200x896";
    referenceImages?: (string | Buffer)[];
    editOf?: string | Buffer;
    /** What the render row records; defaults to `prompt`. Edits store the history line. */
    storedPrompt?: string;
    database?: DbClient;
  },
  deps: GenerateDeps = {}
): Promise<ImageRender> {
  const render = deps.renderImage ?? defaultRenderImage;
  const raw = await render({
    tenantId: a.tenantId,
    prompt: a.prompt,
    size: a.size,
    referenceImages: a.referenceImages,
    editOf: a.editOf,
    // Covers are generated at 1200x624 natively and never cropped (product
    // owner decision 1, 2026-08-19). Derived from the role HERE rather than
    // passed by each caller, so every cover path in this plan — generate,
    // regenerate, edit, prompt — is guarded by construction, and Plan 2's
    // agent path sets the same flag at its own cover render.
    enforceAspect: a.role === "cover",
    database: a.database,
  });
  return storeRenderBytes(
    {
      tenantId: a.tenantId,
      imageId: a.imageId,
      contentPieceId: a.contentPieceId,
      role: a.role,
      slug: a.slug,
      png: raw,
      prompt: a.storedPrompt ?? a.prompt,
      model: imageModelId(process.env.IMAGE_MODEL ?? IMAGE_MODEL_DEFAULT),
      database: a.database,
    },
    deps
  );
}

/** The body line for an image (spec §3: images join the markdown by blob URL). */
export function markdownImage(alt: string, url: string): string {
  return `![${alt.replace(/[[\]]/g, "").trim()}](${url})`;
}
