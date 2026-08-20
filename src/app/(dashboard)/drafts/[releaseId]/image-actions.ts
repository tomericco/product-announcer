"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { contentImages, contentPieces, type ImageRole, type ImageSourceKind, type VisualIdentity } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { assertDraftEditable } from "@/lib/draft-editable";
import { getOrCreateCompanyProfile } from "@/lib/workspace/company-profile";
import { compileStyleBlock, isVisualIdentityReady } from "@/lib/images/visual-identity";
import { buildImagePrompt } from "@/lib/images/prompt";
import { suggestImageConcept } from "@/lib/images/suggest";
import { markdownImage, renderAndStore, storeRenderBytes } from "@/lib/images/generate";
import { ownedBrandReferenceImages } from "@/lib/images/blob";
import {
  addRender,
  createImage,
  deleteImage,
  findImageByRenderUrl,
  getCoverImage,
  getImage,
  setCurrentRender,
} from "@/lib/images/store";
import {
  altFromConcept,
  editPromptHistory,
  imageSlug,
  sizeForRole,
  sliceAroundHeading,
  validateUploadFile,
} from "@/lib/images/actions-support";

const NO_IDENTITY = "Set up your visual identity in Company settings before generating images.";
const NOT_FOUND = "Image not found.";
const COVER_RACE = "This draft already has a cover — reload and try again.";

// Same tenant-checked load as `actions.ts:17-24` in this directory — a
// separate copy for the same reason that file gives: no reaching into a
// sibling module's private helper.
async function loadOwnedDraft(tenantId: string, contentPieceId: string) {
  const [piece] = await db
    .select()
    .from(contentPieces)
    .where(and(eq(contentPieces.id, contentPieceId), eq(contentPieces.tenantId, tenantId)));
  if (!piece) throw new Error("Update not found for this tenant");
  return piece;
}

/** Style is brand-level (spec §5): every generation needs a ready identity. */
async function loadStyle(
  tenantId: string
): Promise<{ ok: true; vi: VisualIdentity; styleBlock: string } | { ok: false; error: string }> {
  const profile = await getOrCreateCompanyProfile(tenantId);
  const vi = profile.visualIdentity;
  if (!vi || !isVisualIdentityReady(vi)) return { ok: false, error: NO_IDENTITY };
  return { ok: true, vi, styleBlock: compileStyleBlock(vi) };
}

/** Brand refs, plus the piece's cover when the identity pins body style to it (as Plan 2's agent does). */
async function bodyReferences(tenantId: string, contentPieceId: string | null, vi: VisualIdentity): Promise<string[]> {
  // Finding 6 (mirrors illustrate.ts:158-160): array membership in
  // `styleReferenceImages` is not proof of ownership — `parseVisualIdentity`'s
  // `BLOB_URL_SCHEMA` only checks the URL's host, not that the pathname
  // belongs to this tenant. Filter to this tenant's own brand assets before
  // any of it reaches a render call. The cover URL pushed below is already
  // tenant-scoped by `getCoverImage(tenantId, ...)`, so it's not run through
  // this filter (it isn't a `brand/` pathname anyway).
  const refs = ownedBrandReferenceImages(tenantId, vi.styleReferenceImages);
  if (vi.pinStyleToCover && contentPieceId) {
    const cover = await getCoverImage(tenantId, contentPieceId);
    if (cover?.current) refs.push(cover.current.blobUrl);
  }
  return refs;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

// A unique-violation on `content_images_cover_unique` (Postgres 23505): two
// overlapping calls both read no existing cover and both try to insert one.
// Same walk-the-cause-chain shape as `isUniqueViolation` in
// `src/lib/publishing/dispatch.ts:33-41` — Drizzle wraps the driver error and
// puts the original pg error on `.cause`, so this doesn't assume exactly one
// level of wrapping or a particular error class.
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  while (current !== null && typeof current === "object") {
    const code = (current as { code?: unknown }).code;
    if (code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * A generation path, not a hand edit: swaps one render URL for another in the
 * stored body without stamping `bodyEditedAt` (same discipline as
 * `linkedin-actions.ts:45-47`). No-op when the URL isn't in the body.
 */
async function swapUrlInBody(contentPieceId: string, oldUrl: string, newUrl: string): Promise<void> {
  const [piece] = await db.select({ body: contentPieces.body }).from(contentPieces).where(eq(contentPieces.id, contentPieceId));
  if (!piece || !piece.body.includes(oldUrl)) return;
  await db
    .update(contentPieces)
    .set({ body: piece.body.split(oldUrl).join(newUrl) })
    .where(eq(contentPieces.id, contentPieceId));
}

/** Tenant-scoped image load; when the image belongs to a piece, that piece must be editable. */
async function loadOwnedImage(tenantId: string, imageId: string) {
  const image = await getImage(tenantId, imageId);
  if (!image) return null;
  if (image.contentPieceId) assertDraftEditable(await loadOwnedDraft(tenantId, image.contentPieceId));
  return image;
}

/**
 * "From library" for the body (spec §5b, Finding I2): reuse inserts the
 * existing blob — a new `role: "body"` row whose render copies the chosen
 * render's blob fields, no upload, no new render. Mirrors `setCoverFromImage`
 * for the cover slot. Giving the picked image a real row here (not just a
 * markdown line) is what lets Task 3's shared-blob guard in `store.ts` see
 * this reference: without a row, regenerating or deleting the SOURCE image
 * could silently prune or delete a blob this piece's body still points at.
 * Returns markdown for the caller to splice in and persist via
 * `saveDraftBody` (same client-side contract as `generateBodyImage`).
 */
export async function insertImageFromLibrary(a: {
  contentPieceId: string;
  imageId: string;
}): Promise<{ ok: true; markdown: string; imageId: string } | { ok: false; error: string }> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const piece = await loadOwnedDraft(tenantId, a.contentPieceId);
  assertDraftEditable(piece);
  const source = await getImage(tenantId, a.imageId);
  if (!source?.current) return { ok: false, error: NOT_FOUND };

  const image = await createImage({
    tenantId,
    contentPieceId: piece.id,
    role: "body",
    concept: source.concept,
    altText: source.altText,
    sourceKind: source.sourceKind as ImageSourceKind,
  });
  await addRender({
    imageId: image.id,
    prompt: source.current.prompt,
    blobUrl: source.current.blobUrl,
    blobPathname: source.current.blobPathname,
    width: source.current.width,
    height: source.current.height,
    bytes: source.current.bytes,
    model: source.current.model,
  });
  revalidatePath(`/drafts/${piece.id}`);
  revalidatePath("/images");
  return { ok: true, markdown: markdownImage(source.altText, source.current.blobUrl), imageId: image.id };
}

export async function generateBodyImage(a: {
  contentPieceId: string;
  prompt: string;
  concept?: string;
}): Promise<{ ok: true; markdown: string; imageId: string } | { ok: false; error: string }> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const piece = await loadOwnedDraft(tenantId, a.contentPieceId);
  // Before the render, not after: a stale tab must not pay for an image
  // `saveDraftBody` will then refuse to persist (mirrors actions.ts:74-76).
  assertDraftEditable(piece);

  const concept = (a.concept ?? a.prompt).trim();
  if (!concept) return { ok: false, error: "Describe what the image should show." };
  const style = await loadStyle(tenantId);
  if (!style.ok) return style;

  const altText = altFromConcept(concept);
  const image = await createImage({ tenantId, contentPieceId: piece.id, role: "body", concept, altText, sourceKind: "generated" });
  try {
    const render = await renderAndStore({
      tenantId,
      imageId: image.id,
      contentPieceId: piece.id,
      role: "body",
      slug: imageSlug(concept),
      prompt: buildImagePrompt({ styleBlock: style.styleBlock, concept, role: "body", allowText: style.vi.allowTextInImages }),
      size: sizeForRole("body"),
      referenceImages: await bodyReferences(tenantId, piece.id, style.vi),
    });
    revalidatePath(`/drafts/${piece.id}`);
    return { ok: true, markdown: markdownImage(altText, render.blobUrl), imageId: image.id };
  } catch (error) {
    // The panel still holds the prompt; a rowless failure leaves nothing to
    // retry from the library, so don't keep an orphan `failed` row.
    await deleteImage(tenantId, image.id);
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * "Suggest prompt": drafts a concept from the section under the caret. The
 * client sends the whole live body plus the nearest heading above the caret
 * (MDXEditor exposes no markdown offset for the caret, so the slice happens
 * here); with no heading the head of the document is used. Read-only — no
 * `assertDraftEditable`. `prompt` is the compiled prompt the concept would be
 * sent as (empty style block if the identity isn't ready yet), for display.
 */
export async function suggestImagePrompt(a: {
  contentPieceId: string;
  surroundingMarkdown: string;
  heading?: string | null;
  role?: "cover" | "body";
}): Promise<{ prompt: string; concept: string; altText: string }> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const piece = await loadOwnedDraft(tenantId, a.contentPieceId);
  const role = a.role ?? "body";
  const source = a.surroundingMarkdown.trim().length > 0 ? a.surroundingMarkdown : piece.body;
  const surroundingMarkdown = role === "cover" ? source.slice(0, 6000) : sliceAroundHeading(source, a.heading ?? null);

  const suggestion = await suggestImageConcept({ tenantId, title: piece.title, surroundingMarkdown, role });
  const style = await loadStyle(tenantId);
  const prompt = buildImagePrompt({
    styleBlock: style.ok ? style.styleBlock : "",
    concept: suggestion.concept,
    role,
    allowText: style.ok ? style.vi.allowTextInImages : false,
  });
  return { prompt, concept: suggestion.concept, altText: suggestion.altText || altFromConcept(suggestion.concept) };
}

export async function regenerateImage(a: {
  imageId: string;
  mode: "same" | "prompt" | "edit";
  prompt?: string;
  instruction?: string;
  /**
   * Findings I4/I6: `swapUrlInBody` below rewrites EVERY occurrence of the
   * old URL in the piece's stored body. The editor's per-image toolbar does
   * its own nodeKey-scoped `EditorOps.replaceImageSrc` + `saveDraftBody`
   * right after calling this — without this flag, the server's all-
   * occurrences write lands first and is then immediately overwritten by the
   * client's one-node-scoped result, silently discarding it. Pass `true`
   * from the editor toolbar (which always has this client-side bridge); leave
   * it unset from the library detail page (which does not, and needs the
   * server write as the only write).
   */
  skipBodyWrite?: boolean;
}): Promise<{ ok: true; url: string; renderId: string } | { ok: false; error: string }> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const image = await loadOwnedImage(tenantId, a.imageId);
  if (!image || !image.current) return { ok: false, error: NOT_FOUND };
  if (image.sourceKind !== "generated") return { ok: false, error: "Uploaded images can only be replaced or removed." };
  const style = await loadStyle(tenantId);
  if (!style.ok) return style;

  const role = image.role as ImageRole;
  const previous = image.current;
  let prompt: string;
  let storedPrompt: string;
  let editOf: string | undefined;
  let referenceImages: string[] | undefined;
  if (a.mode === "edit") {
    const instruction = (a.instruction ?? "").trim();
    if (!instruction) return { ok: false, error: "Describe the change you want." };
    prompt = instruction;
    storedPrompt = editPromptHistory(previous.prompt, instruction);
    editOf = previous.blobUrl;
  } else {
    prompt = a.mode === "prompt" ? (a.prompt ?? "").trim() : previous.prompt;
    if (!prompt) return { ok: false, error: "The prompt can't be empty." };
    storedPrompt = prompt;
    referenceImages =
      role === "cover"
        ? ownedBrandReferenceImages(tenantId, style.vi.styleReferenceImages)
        : await bodyReferences(tenantId, image.contentPieceId, style.vi);
  }

  try {
    const render = await renderAndStore({
      tenantId,
      imageId: image.id,
      contentPieceId: image.contentPieceId,
      role,
      slug: imageSlug(image.concept),
      prompt,
      storedPrompt,
      size: sizeForRole(role),
      referenceImages,
      editOf,
    });
    if (image.contentPieceId) {
      if (!a.skipBodyWrite) await swapUrlInBody(image.contentPieceId, previous.blobUrl, render.blobUrl);
      revalidatePath(`/drafts/${image.contentPieceId}`);
    }
    revalidatePath("/images");
    if (role === "cover") revalidatePath("/board");
    return { ok: true, url: render.blobUrl, renderId: render.id };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function restoreRender(a: {
  imageId: string;
  renderId: string;
  /** Same purpose and same caller split as `regenerateImage`'s flag above (Findings I4/I6). */
  skipBodyWrite?: boolean;
}): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const image = await loadOwnedImage(tenantId, a.imageId);
  if (!image) return { ok: false, error: NOT_FOUND };
  const target = image.renders.find((r) => r.id === a.renderId);
  if (!target) return { ok: false, error: "That render is no longer in the history." };

  await setCurrentRender(image.id, target.id);
  if (image.contentPieceId) {
    if (!a.skipBodyWrite && image.current) await swapUrlInBody(image.contentPieceId, image.current.blobUrl, target.blobUrl);
    revalidatePath(`/drafts/${image.contentPieceId}`);
  }
  revalidatePath("/images");
  if (image.role === "cover") revalidatePath("/board");
  return { ok: true, url: target.blobUrl };
}

export async function generateCover(a: {
  contentPieceId: string;
  mode: "from_post" | "prompt";
  prompt?: string;
}): Promise<{ ok: true; url: string; concept: string; altText: string } | { ok: false; error: string }> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const piece = await loadOwnedDraft(tenantId, a.contentPieceId);
  assertDraftEditable(piece);
  const style = await loadStyle(tenantId);
  if (!style.ok) return style;

  let concept: string;
  let altText: string;
  if (a.mode === "from_post") {
    const suggestion = await suggestImageConcept({ tenantId, title: piece.title, surroundingMarkdown: piece.body.slice(0, 6000), role: "cover" });
    concept = suggestion.concept;
    altText = suggestion.altText || altFromConcept(concept);
  } else {
    concept = (a.prompt ?? "").trim();
    if (!concept) return { ok: false, error: "Describe what the cover should show." };
    altText = altFromConcept(concept);
  }

  // A generated cover keeps its row so the history strip survives a Change;
  // an uploaded cover (or none) is replaced by a fresh generated row.
  const existing = await getCoverImage(tenantId, piece.id);
  let imageId: string;
  let created = false;
  if (existing && existing.sourceKind === "generated") {
    imageId = existing.id;
    await db.update(contentImages).set({ concept, altText, updatedAt: new Date() }).where(eq(contentImages.id, existing.id));
  } else {
    if (existing) await deleteImage(tenantId, existing.id);
    try {
      const image = await createImage({ tenantId, contentPieceId: piece.id, role: "cover", concept, altText, sourceKind: "generated" });
      imageId = image.id;
      created = true;
    } catch (error) {
      if (isUniqueViolation(error)) return { ok: false, error: COVER_RACE };
      throw error;
    }
  }

  try {
    const render = await renderAndStore({
      tenantId,
      imageId,
      contentPieceId: piece.id,
      role: "cover",
      slug: imageSlug(piece.title),
      prompt: buildImagePrompt({ styleBlock: style.styleBlock, concept, role: "cover", allowText: style.vi.allowTextInImages }),
      size: sizeForRole("cover"),
      referenceImages: ownedBrandReferenceImages(tenantId, style.vi.styleReferenceImages),
    });
    revalidatePath(`/drafts/${piece.id}`);
    revalidatePath("/board");
    return { ok: true, url: render.blobUrl, concept, altText };
  } catch (error) {
    if (created) await deleteImage(tenantId, imageId);
    return { ok: false, error: errorMessage(error) };
  }
}

export async function removeCover(a: { contentPieceId: string }): Promise<void> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const piece = await loadOwnedDraft(tenantId, a.contentPieceId);
  assertDraftEditable(piece);
  const cover = await getCoverImage(tenantId, piece.id);
  // Task 3's shared-blob guard means a cover set "from library" doesn't take
  // the source image's blob with it.
  if (cover) await deleteImage(tenantId, cover.id);
  revalidatePath(`/drafts/${piece.id}`);
  revalidatePath("/board");
}

/**
 * Alt text is human-editable (spec §2 alt policy). Body images edit theirs in
 * the editor's image-settings dialog (the markdown alt is the live alt); the
 * cover is not in the markdown, so this is its only edit path — and its alt is
 * what Webflow, LinkedIn and the webhook publish (Plan 4). Trimmed, capped at
 * 125 chars; empty means decorative.
 */
export async function updateCoverAlt(a: {
  contentPieceId: string;
  altText: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const piece = await loadOwnedDraft(tenantId, a.contentPieceId);
  assertDraftEditable(piece);
  const cover = await getCoverImage(tenantId, piece.id);
  if (!cover) return { ok: false, error: NOT_FOUND };

  await db
    .update(contentImages)
    .set({ altText: a.altText.trim().slice(0, 125), updatedAt: new Date() })
    .where(eq(contentImages.id, cover.id));
  revalidatePath(`/drafts/${piece.id}`);
  return { ok: true };
}

/** Fields: `contentPieceId` ("" for a library upload), `role`, `file`. */
export async function uploadImageFile(
  formData: FormData
): Promise<{ ok: true; url: string; imageId: string } | { ok: false; error: string }> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const contentPieceId = String(formData.get("contentPieceId") ?? "") || null;
  const roleField = String(formData.get("role") ?? "body");
  const role: ImageRole = roleField === "cover" ? "cover" : roleField === "library" ? "library" : "body";
  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, error: "Choose an image file to upload." };
  const valid = validateUploadFile({ type: file.type, size: file.size, name: file.name });
  if (!valid.ok) return valid;

  if (contentPieceId) assertDraftEditable(await loadOwnedDraft(tenantId, contentPieceId));
  if (role === "cover" && contentPieceId) {
    const existing = await getCoverImage(tenantId, contentPieceId);
    if (existing) await deleteImage(tenantId, existing.id);
  }

  const baseName = file.name.replace(/\.[a-z0-9]+$/i, "");
  // Uploads have no authored concept, so no alt is invented (spec §2:
  // decorative images get empty alt); the file name is the library caption.
  let image;
  try {
    image = await createImage({
      tenantId,
      contentPieceId: role === "library" ? null : contentPieceId,
      role,
      concept: baseName,
      altText: "",
      sourceKind: "uploaded",
    });
  } catch (error) {
    if (role === "cover" && isUniqueViolation(error)) return { ok: false, error: COVER_RACE };
    throw error;
  }
  try {
    const render = await storeRenderBytes({
      tenantId,
      imageId: image.id,
      contentPieceId: image.contentPieceId,
      role,
      slug: imageSlug(baseName),
      png: Buffer.from(await file.arrayBuffer()),
      prompt: "",
      model: "upload",
    });
    if (contentPieceId) revalidatePath(`/drafts/${contentPieceId}`);
    revalidatePath("/images");
    return { ok: true, url: render.blobUrl, imageId: image.id };
  } catch (error) {
    await deleteImage(tenantId, image.id);
    return { ok: false, error: errorMessage(error) };
  }
}

export type ImageLookup = {
  imageId: string;
  role: ImageRole;
  sourceKind: ImageSourceKind;
  contentPieceId: string | null;
  currentRenderId: string | null;
  currentPrompt: string;
  renders: { id: string; url: string; prompt: string; createdAt: string }[];
};

function toImageLookup(image: NonNullable<Awaited<ReturnType<typeof getImage>>>): ImageLookup {
  return {
    imageId: image.id,
    role: image.role as ImageRole,
    sourceKind: image.sourceKind as ImageSourceKind,
    contentPieceId: image.contentPieceId,
    currentRenderId: image.currentRenderId,
    currentPrompt: image.current?.prompt ?? "",
    renders: image.renders.map((r) => ({ id: r.id, url: r.blobUrl, prompt: r.prompt, createdAt: r.createdAt.toISOString() })),
  };
}

/**
 * The editor's `<img src>` → row map (spec §3), with history for the
 * toolbar. URL-keyed, so it is an ambiguous lookup once two rows can share a
 * blob (Finding I3 — see `findImageByRenderUrl`'s doc comment); MDXEditor
 * gives the toolbar no better key than the `src` string, so this stays the
 * toolbar's only option. A caller that already has the row's id should use
 * `lookupImageById` instead.
 */
export async function lookupImageBySrc(src: string): Promise<ImageLookup | null> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const found = await findImageByRenderUrl(tenantId, src);
  if (!found) return null;
  const image = await getImage(tenantId, found.image.id);
  if (!image) return null;
  return toImageLookup(image);
}

/**
 * Same shape as `lookupImageBySrc`, keyed by the row's own id instead of a
 * URL that may now be shared across rows by design (Finding I3). The library
 * detail page already has `imageId` from its own listing — it should load by
 * id, not round-trip through the ambiguous URL lookup.
 */
export async function lookupImageById(imageId: string): Promise<ImageLookup | null> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const image = await getImage(tenantId, imageId);
  if (!image) return null;
  return toImageLookup(image);
}

/**
 * "From library" for the cover (spec §5b): reuse inserts the existing blob —
 * a new cover row whose render copies the chosen render's blob fields, no
 * upload. Task 3's guard keeps deletion of either row from taking the blob.
 */
export async function setCoverFromImage(a: {
  contentPieceId: string;
  imageId: string;
}): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const piece = await loadOwnedDraft(tenantId, a.contentPieceId);
  assertDraftEditable(piece);
  const source = await getImage(tenantId, a.imageId);
  if (!source?.current) return { ok: false, error: NOT_FOUND };

  const existing = await getCoverImage(tenantId, piece.id);
  if (existing?.id === source.id) return { ok: true, url: source.current.blobUrl };
  if (existing) await deleteImage(tenantId, existing.id);

  let cover;
  try {
    cover = await createImage({
      tenantId,
      contentPieceId: piece.id,
      role: "cover",
      concept: source.concept,
      altText: source.altText,
      sourceKind: source.sourceKind as ImageSourceKind,
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, error: COVER_RACE };
    throw error;
  }
  await addRender({
    imageId: cover.id,
    prompt: source.current.prompt,
    blobUrl: source.current.blobUrl,
    blobPathname: source.current.blobPathname,
    width: source.current.width,
    height: source.current.height,
    bytes: source.current.bytes,
    model: source.current.model,
  });
  revalidatePath(`/drafts/${piece.id}`);
  revalidatePath("/board");
  return { ok: true, url: source.current.blobUrl };
}
