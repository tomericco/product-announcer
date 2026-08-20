import { eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { contentImages } from "@/db/schema";
import type { ContentType } from "@/lib/ai/compose-prompt";
import { getOrCreateCompanyProfile } from "@/lib/workspace/company-profile";
import { compileStyleBlock, isVisualIdentityReady } from "@/lib/images/visual-identity";
import { resolveImagePolicy } from "@/lib/images/policy";
import { renderImage as defaultRenderImage } from "@/lib/ai/images";
import { imageModelId, IMAGE_MODEL_DEFAULT } from "@/lib/ai/image-model";
import { compressPng as defaultCompressPng } from "@/lib/images/compress";
// `slugForImage`, NOT `slugify`: publishing/slug.ts allows 200 characters (it
// builds public CMS slugs), while a Blob pathname wants the 40-char image slug
// every other image caller uses. Sharing one slug function across the image
// feature is what keeps pathnames consistent and readable.
import { imagePathname, ownedBrandReferenceImages, slugForImage, uploadPng as defaultUploadPng } from "@/lib/images/blob";
import { createImage, addRender, markImageFailed, listImages, deleteImage } from "@/lib/images/store";
import { planIllustrations as defaultPlanIllustrations, type IllustrationPlan } from "@/lib/images/plan";
import { spliceImageAfterHeading } from "@/lib/images/splice";

// `typeof defaultDb`, not the looser `DbClient` (publishing/destinations/types):
// `getOrCreateCompanyProfile` requires the concrete `db` shape (it carries
// `$client: Pool`), and the real caller — `generateDraftForPiece` in
// src/lib/briefs/draft.ts — already types its own `database` param the same
// way. A `DbClient`-typed value cannot be narrowed back to this at the
// `getOrCreateCompanyProfile` call site, so this is the type that compiles for
// every consumer, not just this file's own store.ts calls.
type Database = typeof defaultDb;

/**
 * Stage 2 of the illustration agent (spec §4): given a finished draft, plan
 * the images, create their rows, render the cover first, then every body
 * image in parallel (each with the fresh cover as a style reference when
 * `pinStyleToCover` is on), compress → Blob → `addRender`, and splice each
 * body image's `![alt](url)` directly after its anchor H2.
 *
 * Runs ONLY from `generateDraftForPiece`. Never on agent edits, extract or
 * catch-up. The caller owns the body write; this returns the spliced body.
 *
 * Failure semantics (spec §4):
 *   - each render is retried once, silently;
 *   - a still-failed body image is omitted from the markdown but its row stays
 *     with `status: "failed"` + concept + anchor, so the draft page can offer
 *     Retry (Task 7) and nothing is silently lost;
 *   - a failed cover leaves the draft coverless; the row stays for Plan 3's
 *     Add-cover menu to pre-fill from;
 *   - anything thrown out of the plan call propagates — `generateDraftForPiece`
 *     turns it into a `generationError` warning, never a failed draft.
 */

export type IllustrateSkipReason = "no_visual_identity" | "policy_off";

export type IllustrateResult = { body: string; failures: number; skipped?: IllustrateSkipReason };

export type IllustrateDeps = {
  planIllustrations?: typeof defaultPlanIllustrations;
  renderImage?: typeof defaultRenderImage;
  uploadPng?: typeof defaultUploadPng;
  compressPng?: typeof defaultCompressPng;
  /**
   * Forwarded to `deleteImage` when clearing leftovers from an aborted run.
   * Present so a test never reaches @vercel/blob's `del()` — `deleteImage`'s
   * own default does, and a leftover row with a render would fire it.
   */
  deleteBlobs?: (pathnames: string[]) => Promise<void>;
};

// Both multiples of 16 (gpt-image-2 requires it) — see prompt.ts's
// IMAGE_SIZES doc comment for why these aren't the nominal 1200x630/1200x900.
export const COVER_SIZE = "1200x624" as const;
export const BODY_SIZE = "1200x896" as const;
export const COVER_MAX_WIDTH = 1200;
export const BODY_MAX_WIDTH = 1200;

async function renderWithOneRetry(
  render: typeof defaultRenderImage,
  args: Parameters<typeof defaultRenderImage>[0]
): Promise<Buffer> {
  try {
    return await render(args);
  } catch {
    return await render(args);
  }
}

export async function illustratePiece(
  args: {
    tenantId: string;
    contentPieceId: string;
    title: string;
    body: string;
    contentType: ContentType;
    database?: Database;
  },
  deps: IllustrateDeps = {}
): Promise<IllustrateResult> {
  const database = args.database ?? defaultDb;
  const plan = deps.planIllustrations ?? defaultPlanIllustrations;
  const render = deps.renderImage ?? defaultRenderImage;
  const upload = deps.uploadPng ?? defaultUploadPng;
  const compress = deps.compressPng ?? defaultCompressPng;

  // Leftovers from an earlier aborted/failed run of THIS generation (the piece
  // is still "brief", so no human has placed images yet). Runs FIRST — before
  // the visual-identity/policy checks below and before the plan call — so it
  // still runs on every early-return path: a visual identity that stopped
  // being ready, a policy that turned images off, or a plan that legitimately
  // comes back empty (the system prompt explicitly encourages this) all used
  // to skip this block entirely when it ran after those checks, leaving
  // leftover rows behind — including an orphan `ready` cover a later run
  // would publish, and `failed` rows whose concepts reference a document body
  // that may no longer exist. The cover's partial unique index would also
  // reject a new cover row on the next real run. `deleteImage` removes the
  // blobs too. Uploads are left alone on principle. Depends only on
  // `tenantId`/`contentPieceId`, both known up front — nothing below this
  // block feeds it.
  const existing = await listImages(args.tenantId, { contentPieceId: args.contentPieceId }, database);
  for (const image of existing) {
    if (image.sourceKind !== "generated") continue;
    if (image.role !== "cover" && image.role !== "body") continue;
    // The deps object is forwarded so tests never reach @vercel/blob. Passing
    // `{}` when no dep is injected keeps `deleteImage`'s own default.
    await deleteImage(args.tenantId, image.id, database, deps.deleteBlobs ? { deleteBlobs: deps.deleteBlobs } : {});
  }

  // One fetch for both brand inputs (spec §6: policy is read with the rest of
  // the profile). No confirmed visual identity → no images: the draft page
  // nudges toward setup instead of generating something off-brand.
  const profile = await getOrCreateCompanyProfile(args.tenantId, database);
  const vi = profile.visualIdentity;
  if (!isVisualIdentityReady(vi) || vi === null) {
    return { body: args.body, failures: 0, skipped: "no_visual_identity" };
  }

  const policy = resolveImagePolicy(profile.imagePolicy, args.contentType);
  if (!policy.cover && policy.bodyCap === 0) {
    return { body: args.body, failures: 0, skipped: "policy_off" };
  }

  const styleBlock = compileStyleBlock(vi);
  const model = imageModelId(process.env.IMAGE_MODEL ?? IMAGE_MODEL_DEFAULT);

  const illustrationPlan: IllustrationPlan = await plan(
    {
      tenantId: args.tenantId,
      title: args.title,
      body: args.body,
      wantCover: policy.cover,
      bodyCap: policy.bodyCap,
      styleBlock,
      allowText: vi.allowTextInImages,
      database,
    },
    {}
  );
  if (illustrationPlan.cover === null && illustrationPlan.body.length === 0) {
    return { body: args.body, failures: 0 };
  }

  // Finding 6: array membership in `styleReferenceImages` is not proof of
  // ownership (see `ownedBrandReferenceImages`'s doc comment) — filter to
  // this tenant's own brand assets before any of it reaches a render call.
  const brandReferences: (string | Buffer)[] = ownedBrandReferenceImages(args.tenantId, vi.styleReferenceImages);
  let failures = 0;

  // ---- Cover: first, alone. Its bytes feed the body renders below. ----
  let coverPng: Buffer | null = null;
  if (illustrationPlan.cover) {
    const cover = illustrationPlan.cover;
    const row = await createImage(
      {
        tenantId: args.tenantId,
        contentPieceId: args.contentPieceId,
        role: "cover",
        concept: cover.concept,
        altText: cover.altText,
        sourceKind: "generated",
        status: "pending",
      },
      database
    );
    try {
      const raw = await renderWithOneRetry(render, {
        tenantId: args.tenantId,
        prompt: cover.prompt,
        size: COVER_SIZE,
        referenceImages: brandReferences,
        // Covers are generated wide, never cropped (product owner decision 1,
        // 2026-08-19). `renderImage` sends the size AND the aspect ratio, and
        // re-asks once if what comes back is off 1.91:1 by more than 2%. The
        // guard lives there, in the one render seam, so this call site and
        // Plan 3's `renderAndStore` cannot drift. `compressPng` below still
        // only resizes by width — nothing anywhere crops.
        enforceAspect: true,
        database,
      });
      const { png, width, height } = await compress(raw, COVER_MAX_WIDTH);
      const { url, pathname } = await upload(
        imagePathname({ tenantId: args.tenantId, contentPieceId: args.contentPieceId, role: "cover", slug: slugForImage(args.title) }),
        png
      );
      await addRender(
        { imageId: row.id, prompt: cover.prompt, blobUrl: url, blobPathname: pathname, width, height, bytes: png.byteLength, model },
        database
      );
      coverPng = png;
    } catch (e) {
      console.error(`[images/illustrate] cover render failed for piece ${args.contentPieceId}:`, e);
      await markImageFailed(row.id, database);
      failures += 1;
    }
  }

  // ---- Body: rows first (so the anchor is stored even if the render fails), then all renders in parallel. ----
  const bodyReferences: (string | Buffer)[] =
    vi.pinStyleToCover && coverPng ? [...brandReferences, coverPng] : brandReferences;

  const bodyRows = [];
  for (const entry of illustrationPlan.body) {
    const row = await createImage(
      {
        tenantId: args.tenantId,
        contentPieceId: args.contentPieceId,
        role: "body",
        concept: entry.concept,
        altText: entry.altText,
        sourceKind: "generated",
        status: "pending",
      },
      database
    );
    await database.update(contentImages).set({ anchorHeading: entry.anchorHeading }).where(eq(contentImages.id, row.id));
    bodyRows.push({ row, entry });
  }

  const placed = await Promise.all(
    bodyRows.map(async ({ row, entry }) => {
      try {
        const raw = await renderWithOneRetry(render, {
          tenantId: args.tenantId,
          prompt: entry.prompt,
          size: BODY_SIZE,
          referenceImages: bodyReferences,
          database,
        });
        const { png, width, height } = await compress(raw, BODY_MAX_WIDTH);
        const { url, pathname } = await upload(
          imagePathname({ tenantId: args.tenantId, contentPieceId: args.contentPieceId, role: "body", slug: slugForImage(entry.anchorHeading) }),
          png
        );
        await addRender(
          { imageId: row.id, prompt: entry.prompt, blobUrl: url, blobPathname: pathname, width, height, bytes: png.byteLength, model },
          database
        );
        return { anchorHeading: entry.anchorHeading, markdown: `![${entry.altText}](${url})` };
      } catch (e) {
        console.error(`[images/illustrate] body render failed for piece ${args.contentPieceId} (${entry.anchorHeading}):`, e);
        await markImageFailed(row.id, database);
        return null;
      }
    })
  );

  // Splice sequentially, in plan order, on the caller's body. Each splice
  // touches only its own heading, so order does not change the result.
  let body = args.body;
  for (const item of placed) {
    if (item === null) {
      failures += 1;
      continue;
    }
    body = spliceImageAfterHeading(body, item.anchorHeading, item.markdown);
  }

  return { body, failures };
}
