"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { contentPieces, type ImageRole, type ImageSourceKind } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { getOrCreateCompanyProfile } from "@/lib/workspace/company-profile";
import { compileStyleBlock, isVisualIdentityReady } from "@/lib/images/visual-identity";
import { buildImagePrompt } from "@/lib/images/prompt";
import { renderAndStore } from "@/lib/images/generate";
import { ownedBrandReferenceImages } from "@/lib/images/blob";
import { createImage, deleteImage, getImage, listLibraryImages } from "@/lib/images/store";
import { altFromConcept, imageSlug, isCoverShaped, sizeForRole, stripImageFromMarkdown } from "@/lib/images/actions-support";

const NO_IDENTITY = "Set up your visual identity in Company settings before generating images.";

/**
 * Library delete (spec §5b): the row, its renders' blobs, AND the piece's
 * markdown line(s) for any of its render URLs — so a draft never keeps a
 * dead image. `deleteImage` refuses for a published piece (Webflow hotlinks)
 * and the UI shows why; the body is only touched once the delete is allowed.
 * The cover pointer needs no extra work: the cover IS the row being deleted.
 */
export async function deleteLibraryImage(imageId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const image = await getImage(tenantId, imageId);
  if (!image) return { ok: false, reason: "not_found" };

  const result = await deleteImage(tenantId, imageId);
  if (!result.ok) return result;

  if (image.contentPieceId && image.renders.length > 0) {
    const [piece] = await db
      .select({ body: contentPieces.body })
      .from(contentPieces)
      .where(eq(contentPieces.id, image.contentPieceId));
    if (piece) {
      const next = stripImageFromMarkdown(piece.body, image.renders.map((r) => r.blobUrl));
      // The dead reference still has to go, or the piece renders a 404 image.
      // But NOTHING here stamps `bodyEditedAt`: this is a cleanup write, not
      // an authored edit, and stamping it would retire that piece's Generate
      // button for good over one deleted image — `bodyEditedAt` only guards
      // eligibility for (re)generation (`queueGeneration`'s `status =
      // 'brief'` check), which a "draft"-status piece was never eligible for
      // anyway. `editedBy` is left alone for the same reason.
      //
      // A "draft"-status piece IS now library-reachable (product owner
      // decision, 2026-08-20) and CAN be open in someone's editor right now
      // — unlike generation, hand-editing has no lock. If they save before
      // this write lands, their save (a full-body overwrite) wins and
      // silently re-introduces the dead reference; if this write lands
      // first, `revalidatePath` below refreshes a server-rendered view of
      // that route but not an already-mounted client editor session. This
      // is the accepted trade-off ("deleting it from the library removes it
      // from the draft — that's ok"), not an oversight.
      if (next !== piece.body) {
        await db.update(contentPieces).set({ body: next }).where(eq(contentPieces.id, image.contentPieceId));
      }
    }
    revalidatePath(`/drafts/${image.contentPieceId}`);
  }
  revalidatePath("/images");
  revalidatePath("/board");
  return { ok: true };
}

/** "Generate new" in the library (spec §5b): a standalone role:"library" row, body-sized. */
export async function generateLibraryImage(a: {
  prompt: string;
  concept: string;
}): Promise<{ ok: true; imageId: string; url: string } | { ok: false; error: string }> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const concept = (a.concept || a.prompt).trim();
  if (!concept) return { ok: false, error: "Describe what the image should show." };

  const profile = await getOrCreateCompanyProfile(tenantId);
  const vi = profile.visualIdentity;
  if (!vi || !isVisualIdentityReady(vi)) return { ok: false, error: NO_IDENTITY };

  const image = await createImage({ tenantId, contentPieceId: null, role: "library", concept, altText: altFromConcept(concept), sourceKind: "generated" });
  try {
    const render = await renderAndStore({
      tenantId,
      imageId: image.id,
      contentPieceId: null,
      role: "library",
      slug: imageSlug(concept),
      prompt: buildImagePrompt({ styleBlock: compileStyleBlock(vi), concept, role: "body", allowText: vi.allowTextInImages }),
      size: sizeForRole("library"),
      // Finding C1 (mirrors image-actions.ts's `bodyReferences`/Finding 6 and
      // illustrate.ts:158-160): array membership in `styleReferenceImages` is
      // not proof of ownership — `parseVisualIdentity`'s `BLOB_URL_SCHEMA`
      // only restricts the URL's host, not the tenant path. Filter before any
      // of it reaches a render call.
      referenceImages: ownedBrandReferenceImages(tenantId, vi.styleReferenceImages),
    });
    revalidatePath("/images");
    return { ok: true, imageId: image.id, url: render.blobUrl };
  } catch (error) {
    await deleteImage(tenantId, image.id);
    return { ok: false, error: error instanceof Error ? error.message : "Something went wrong" };
  }
}

export type PickerImage = {
  imageId: string;
  url: string;
  concept: string;
  altText: string;
  role: ImageRole;
  sourceKind: ImageSourceKind;
  pieceTitle: string | null;
};

/**
 * What "From library" lists (spec §5b): every LIBRARY image with a current
 * render, newest first. `listLibraryImages`, not `listImages` — an image
 * belonging to a piece someone is still drafting is not offered for reuse
 * anywhere (product owner decision 4); it is reachable in that draft's own
 * editor, which is where its owner is.
 *
 * `role: "cover"` narrows to renders that are already cover-shaped (spec
 * §5b open question, resolved as option (a): the cover picker never offers
 * a body-shaped render, since reuse pastes the existing blob with no new
 * render — a mismatched shape would ship distorted/cropped into LinkedIn
 * and OG, which product owner decision 1 forbids doing ourselves).
 */
export async function listImagesForPicker(opts: { role?: "cover" } = {}): Promise<PickerImage[]> {
  const session = await requireSession();
  const rows = await listLibraryImages(session.user.tenantId);
  const withRender = rows.filter((r) => r.current !== null);
  const shaped = opts.role === "cover" ? withRender.filter((r) => isCoverShaped(r.current!.width, r.current!.height)) : withRender;
  return shaped.map((r) => ({
    imageId: r.id,
    url: r.current!.blobUrl,
    concept: r.concept,
    altText: r.altText,
    role: r.role as ImageRole,
    sourceKind: r.sourceKind as ImageSourceKind,
    pieceTitle: r.pieceTitle,
  }));
}
