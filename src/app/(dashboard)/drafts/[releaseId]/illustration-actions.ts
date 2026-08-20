"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { contentImages, contentPieces } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { assertDraftEditable } from "@/lib/draft-editable";
import { getOrCreateCompanyProfile } from "@/lib/workspace/company-profile";
import { compileStyleBlock, isVisualIdentityReady } from "@/lib/images/visual-identity";
import { buildImagePrompt } from "@/lib/images/prompt";
import { getImage, getCoverImage, addRender, markImageFailed, listImages, deleteImage } from "@/lib/images/store";
import { renderImage } from "@/lib/ai/images";
import { imageModelId, IMAGE_MODEL_DEFAULT } from "@/lib/ai/image-model";
import { compressPng } from "@/lib/images/compress";
import { imagePathname, ownedBrandReferenceImages, slugForImage, uploadPng } from "@/lib/images/blob";
import { spliceImageAfterHeading } from "@/lib/images/splice";

/**
 * Retry for an illustration the agent could not render (spec §4 failure
 * handling). Re-renders from the row's stored CONCEPT with the CURRENT style
 * block — the concept is what survived, the prompt is rebuilt the same way the
 * agent built it — uploads, records the render, and for a body image splices
 * `![alt](url)` after the row's stored anchor heading.
 *
 * Writes the body directly, with the same tenant guard as `loadOwnedDraft`,
 * and does NOT stamp `bodyEditedAt`/`editedBy`: an agent placing its own image
 * is not a hand edit, and stamping it would freeze regeneration
 * (`generateDraftForPiece` refuses a hand-edited body). Same rule
 * `linkedin-actions.ts` follows for generated copy.
 *
 * Returns a result object rather than throwing, like Plan 3's image actions:
 * the button toasts the message.
 */
export async function retryFailedIllustration(input: {
  contentPieceId: string;
  imageId: string;
}): Promise<{ ok: true; placed: boolean; url: string } | { ok: false; error: string }> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;

  const [piece] = await db
    .select()
    .from(contentPieces)
    .where(and(eq(contentPieces.id, input.contentPieceId), eq(contentPieces.tenantId, tenantId)));
  if (!piece) return { ok: false, error: "Draft not found." };
  try {
    assertDraftEditable(piece);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  // Tenant-scoped by `getImage`; the piece check closes the "my image, but
  // named against a different piece id" hole.
  const image = await getImage(tenantId, input.imageId);
  if (!image || image.contentPieceId !== piece.id) return { ok: false, error: "Image not found." };
  if (image.status !== "failed") return { ok: false, error: "This image doesn't need a retry." };
  if (image.role !== "body" && image.role !== "cover") return { ok: false, error: "Only generated cover and body images can be retried here." };
  // Same class of gap as `failed-illustrations-notice.tsx`'s own filter and
  // `illustratePiece`'s leftover cleanup: `role` alone doesn't prove this row
  // is an AI render. Once Plan 3 adds editor uploads, an uploaded image can
  // also be `role: "body"|"cover"` — without this a client could hand this
  // action an uploaded image's id and get an AI render (built from
  // `image.concept`, which for an upload is just the filename) attached to
  // it, flipping it to `ready` and splicing it into the body.
  if (image.sourceKind !== "generated") return { ok: false, error: "Only generated cover and body images can be retried here." };

  const profile = await getOrCreateCompanyProfile(tenantId);
  const vi = profile.visualIdentity;
  if (!isVisualIdentityReady(vi) || vi === null) {
    return { ok: false, error: "Set up your visual identity in Company settings before generating images." };
  }

  const prompt = buildImagePrompt({
    styleBlock: compileStyleBlock(vi),
    concept: image.concept,
    role: image.role,
    allowText: vi.allowTextInImages,
  });
  // Multiples of 16 (gpt-image-2 requires it) — see prompt.ts's IMAGE_SIZES
  // doc comment for why these aren't the nominal 1200x630/1200x900.
  const size = image.role === "cover" ? "1200x624" : "1200x896";
  const model = imageModelId(process.env.IMAGE_MODEL ?? IMAGE_MODEL_DEFAULT);

  // Same reference set the agent used (`illustratePiece`): brand references,
  // plus the piece's ready cover for a BODY image when `pinStyleToCover` is on.
  // Without this a retried body image is styled off the brand references alone
  // and visibly differs from its siblings — the exact whole-post consistency
  // the setting exists to buy. `ownedBrandReferenceImages` is Finding 6's
  // tenant-prefix filter — array membership in `styleReferenceImages` alone
  // is not proof of ownership, mirroring `removeStyleReference`'s check.
  const referenceImages: (string | Buffer)[] = ownedBrandReferenceImages(tenantId, vi.styleReferenceImages);
  if (image.role === "body" && vi.pinStyleToCover) {
    const cover = await getCoverImage(tenantId, piece.id);
    if (cover?.current) referenceImages.push(cover.current.blobUrl);
  }

  // A retried COVER goes through the same aspect guard as a generated one
  // (product owner decision 1): size + aspect ratio stated, one measured
  // re-ask, never a crop.
  const enforceAspect = image.role === "cover";

  // Finding 4: claim the row before rendering. A conditional UPDATE that only
  // succeeds while the row is still `failed` — the same "transition is the
  // race winner, the loser rolls back" shape `acceptBrief` and
  // `queueGeneration` (briefs/actions.ts, briefs/draft.ts) use elsewhere in
  // this codebase. Without this, two concurrent retries of the same image
  // (two tabs) both pass the checks above, both render, both bill, and both
  // splice — duplicating the image under the same heading; the client's
  // `disabled={isPending}` only guards a single tab. The loser gets a clean
  // refusal instead of rendering at all. Placed right before the render
  // attempt (not earlier) so any failure between here and the render/upload
  // catch below still lands on a row this action itself can put back to
  // `failed` — never a permanently stuck `pending`.
  const claimed = await db
    .update(contentImages)
    .set({ status: "pending", updatedAt: new Date() })
    .where(and(eq(contentImages.id, image.id), eq(contentImages.tenantId, tenantId), eq(contentImages.status, "failed")))
    .returning({ id: contentImages.id });
  if (claimed.length === 0) {
    return { ok: false, error: "This image is already being retried." };
  }

  let url: string;
  try {
    let raw: Buffer;
    try {
      raw = await renderImage({ tenantId, prompt, size, referenceImages, enforceAspect });
    } catch {
      raw = await renderImage({ tenantId, prompt, size, referenceImages, enforceAspect });
    }
    const { png, width, height } = await compressPng(raw, 1200);
    const uploaded = await uploadPng(
      imagePathname({
        tenantId,
        contentPieceId: piece.id,
        role: image.role,
        slug: slugForImage(image.role === "cover" ? piece.title : (image.anchorHeading ?? image.concept)),
      }),
      png
    );
    await addRender({
      imageId: image.id,
      prompt,
      blobUrl: uploaded.url,
      blobPathname: uploaded.pathname,
      width,
      height,
      bytes: png.byteLength,
      model,
    });
    url = uploaded.url;
  } catch (e) {
    // Puts the claim back: a failed render must not leave the row stuck at
    // `pending` forever — the notice filters on `status === "failed"`, and a
    // `pending` row with no render in flight would vanish from it for good.
    await markImageFailed(image.id);
    return { ok: false, error: `The image could not be generated: ${e instanceof Error ? e.message : String(e)}` };
  }

  let placed = true;
  if (image.role === "body") {
    const markdown = `![${image.altText}](${url})`;
    const anchor = image.anchorHeading ?? "";
    const next = anchor ? spliceImageAfterHeading(piece.body, anchor, markdown) : piece.body;
    placed = next !== piece.body;
    if (placed) {
      // Finding 3: optimistic write guard. `piece.body` is the snapshot read
      // at the top of this action, before the 10-30s render — a concurrent
      // Save landing during that window must not be silently reverted by a
      // write built from the stale snapshot. The predicate below only
      // succeeds if the body is still exactly what was read; a lost race
      // affects zero rows.
      const written = await db
        .update(contentPieces)
        .set({ body: next })
        .where(
          and(eq(contentPieces.id, piece.id), eq(contentPieces.tenantId, tenantId), eq(contentPieces.body, piece.body))
        )
        .returning({ id: contentPieces.id });
      if (written.length === 0) {
        // The render itself succeeded and `addRender` above already marked
        // the row `ready` — that is not rolled back, matching how the
        // anchor-not-found case just above treats a successful render as
        // never wasted. Only the splice into the body lost the race, so only
        // that is reported as failed.
        revalidatePath(`/drafts/${piece.id}`);
        return {
          ok: false,
          error: "The image was generated, but the draft changed while retrying so it couldn't be added. Check the image library, or retry again.",
        };
      }
    }
  }

  revalidatePath(`/drafts/${piece.id}`);
  return { ok: true, placed, url };
}

/**
 * Dismisses the failed-images notice (spec §4 calls it dismissible): deletes
 * the piece's still-failed GENERATED rows. Explicit dismissal is not a silent
 * loss of the concept — the user chose to drop them — and deleting the rows
 * keeps the library free of dead "failed" cards. Uploads and ready images are
 * untouched.
 */
export async function dismissFailedIllustrations(input: {
  contentPieceId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const [piece] = await db
    .select()
    .from(contentPieces)
    .where(and(eq(contentPieces.id, input.contentPieceId), eq(contentPieces.tenantId, tenantId)));
  if (!piece) return { ok: false, error: "Draft not found." };

  const images = await listImages(tenantId, { contentPieceId: piece.id });
  for (const image of images) {
    if (image.status !== "failed" || image.sourceKind !== "generated") continue;
    await deleteImage(tenantId, image.id);
  }
  revalidatePath(`/drafts/${piece.id}`);
  return { ok: true };
}
