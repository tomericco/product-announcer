import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, users, contentPieces, companyProfiles, contentImages, imageRenders, type VisualIdentity } from "../../../src/db/schema";
import { DEFAULT_VISUAL_IDENTITY } from "../../../src/lib/images/visual-identity";
import { NO_TEXT_CLAUSE } from "../../../src/lib/images/prompt";
import { createImage, addRender, getImage, getCoverImage } from "../../../src/lib/images/store";

const TENANT_NAME = "Image Actions Test Tenant";
// A distinct name for the cross-tenant cases — see the note under this test.
const OTHER_NAME = "Image Actions Other Tenant";
const USER_EMAIL = "image-actions-test@example.com";
let currentTenantId = "";
let currentUserId: string | null = null;

vi.mock("../../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: currentUserId } })),
}));
// Tracked at module scope so the I6 board-revalidation test can assert on
// which paths were actually revalidated.
const revalidatePath = vi.fn((_path: string) => {});
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

const renderImage = vi.fn(async (_args: { prompt: string; editOf?: unknown; referenceImages?: unknown }) => Buffer.from("PNG"));
vi.mock("../../../src/lib/ai/images", () => ({
  renderImage: (a: { prompt: string; editOf?: unknown; referenceImages?: unknown }) => renderImage(a),
}));
vi.mock("../../../src/lib/images/compress", () => ({
  compressPng: vi.fn(async (png: Buffer, maxWidth: number) => ({ png, width: maxWidth, height: 900 })),
}));
let uploadCount = 0;
// Tracked at module scope (not an inline `vi.fn()` in the factory below) so
// the shared-blob lifecycle test (Finding I5) can assert on which pathnames
// were actually asked to be deleted.
const deleteBlobs = vi.fn(async (_p: string[]) => {});
vi.mock("../../../src/lib/images/blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/images/blob")>();
  return {
    ...actual,
    uploadPng: vi.fn(async (pathname: string) => {
      uploadCount += 1;
      return { url: `https://blob.example/${pathname}-${uploadCount}`, pathname: `${pathname}-${uploadCount}` };
    }),
    deleteBlobs: (p: string[]) => deleteBlobs(p),
  };
});
// Local, minimal arg type (not imported from suggest.ts — that module is
// mocked below) so `mock.calls[0][0]` is typed for tsc; a `vi.fn(async () =>
// ...)` with no declared parameter infers `Parameters<T>` as the empty tuple.
type SuggestConceptArgs = { tenantId: string; title: string; surroundingMarkdown: string; role: "cover" | "body" };
const suggestImageConcept = vi.fn(async (_args: SuggestConceptArgs) => ({ concept: "A rocket over a laptop", altText: "Rocket over a laptop" }));
vi.mock("../../../src/lib/images/suggest", () => ({
  suggestImageConcept: (...a: unknown[]) => suggestImageConcept(...(a as [SuggestConceptArgs])),
}));

import {
  generateBodyImage,
  insertImageFromLibrary,
  suggestImagePrompt,
  regenerateImage,
  restoreRender,
  generateCover,
  removeCover,
  uploadImageFile,
  lookupImageBySrc,
  lookupImageById,
  setCoverFromImage,
  updateCoverAlt,
} from "../../../src/app/(dashboard)/drafts/[releaseId]/image-actions";
import { deleteLibraryImage } from "../../../src/app/(dashboard)/images/actions";

// `ownedBrandReferenceImages` (src/lib/images/blob.ts) only keeps URLs whose
// pathname starts with `tenants/{tenantId}/brand/` — the shape a real style
// reference gets from `brandAssetPathname`. Mirrors illustrate.test.ts's
// `refUrl` so a fixture reference actually survives the ownership filter.
function refUrl(tenantId: string): string {
  return `https://blob.example/tenants/${tenantId}/brand/ref.png`;
}

const VI: VisualIdentity = {
  ...DEFAULT_VISUAL_IDENTITY,
  palette: [
    { hex: "#112233", role: "primary" },
    { hex: "#445566", role: "secondary" },
    { hex: "#ffffff", role: "background" },
  ],
  // Placeholder — `seed()` substitutes a tenant-prefixed URL once the tenant
  // id is known, since `ownedBrandReferenceImages` is tenant-scoped.
  styleReferenceImages: [],
  pinStyleToCover: true,
};

async function seed(opts: { identity?: VisualIdentity | null; body?: string } = {}) {
  const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
  const [user] = await db.insert(users).values({ email: USER_EMAIL }).returning();
  currentTenantId = tenant.id;
  currentUserId = user.id;
  const identity = opts.identity === undefined ? { ...VI, styleReferenceImages: [refUrl(tenant.id)] } : opts.identity;
  await db.insert(companyProfiles).values({
    tenantId: tenant.id,
    topics: [],
    visualIdentity: identity,
  });
  const [piece] = await db
    .insert(contentPieces)
    .values({ tenantId: tenant.id, type: "blog_post", title: "Faster search", body: opts.body ?? "# Faster search\n\n## Search\n\nText.", status: "draft" })
    .returning();
  return { tenant, piece };
}

async function seedGeneratedBodyImage(tenantId: string, pieceId: string) {
  const image = await createImage({ tenantId, contentPieceId: pieceId, role: "body", concept: "gears", altText: "Gears", sourceKind: "generated" });
  const render = await addRender({ imageId: image.id, prompt: "FULL PROMPT", blobUrl: "https://blob.example/gears-1.png", blobPathname: "p/gears-1.png", width: 1200, height: 900, bytes: 10, model: "m" });
  return { image, render };
}

afterEach(async () => {
  renderImage.mockClear();
  suggestImageConcept.mockClear();
  deleteBlobs.mockClear();
  revalidatePath.mockClear();
  uploadCount = 0;
  await db.delete(tenants).where(eq(tenants.name, TENANT_NAME));
  await db.delete(tenants).where(eq(tenants.name, OTHER_NAME));
  await db.delete(users).where(eq(users.email, USER_EMAIL));
});

describe("generateBodyImage", () => {
  it("creates a body row, renders with the compiled style + brand refs, and returns the markdown line", async () => {
    const { tenant, piece } = await seed();
    const result = await generateBodyImage({ contentPieceId: piece.id, prompt: "A rocket launching from a laptop." });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown).toMatch(/^!\[A rocket launching from a laptop\]\(https:\/\/blob\.example\/tenants\/.+\/body-a-rocket-launching-from-a-laptop\.png-1\)$/);
    const sent = renderImage.mock.calls[0][0];
    expect(sent.prompt).toContain("A rocket launching from a laptop.");
    // The constant, not a copy of its wording: what matters here is that the
    // no-text instruction reached the model, not how it happens to be phrased
    // this week (tests/lib/images/prompt.test.ts owns the phrasing).
    expect(sent.prompt).toContain(NO_TEXT_CLAUSE);
    expect(sent.referenceImages).toEqual([refUrl(tenant.id)]);
    const row = await getImage(tenant.id, result.imageId);
    expect(row).toMatchObject({ role: "body", sourceKind: "generated", status: "ready", contentPieceId: piece.id });
  });

  it("drops a styleReferenceImages URL that isn't owned by this tenant before it reaches renderImage (Finding 6)", async () => {
    // `parseVisualIdentity`'s `BLOB_URL_SCHEMA` only restricts the URL's host,
    // not the tenant path, so a foreign tenant's public blob URL could in
    // principle end up persisted into this tenant's own `styleReferenceImages`
    // array. Array membership alone must not be enough to get it fetched as
    // reference bytes — mirrors illustrate.test.ts's own Finding 6 coverage.
    const { tenant, piece } = await seed();
    const foreignUrl = "https://blob.example/tenants/someone-elses-tenant/brand/foreign.png";
    await db
      .update(companyProfiles)
      .set({ visualIdentity: { ...VI, styleReferenceImages: [refUrl(tenant.id), foreignUrl] } })
      .where(eq(companyProfiles.tenantId, tenant.id));

    const result = await generateBodyImage({ contentPieceId: piece.id, prompt: "A rocket." });
    expect(result.ok).toBe(true);
    const sent = renderImage.mock.calls[0][0];
    expect(sent.referenceImages).toEqual([refUrl(tenant.id)]);
    expect(sent.referenceImages).not.toContain(foreignUrl);
  });

  it("refuses without a ready visual identity and creates no row", async () => {
    const { tenant, piece } = await seed({ identity: null });
    const result = await generateBodyImage({ contentPieceId: piece.id, prompt: "x" });
    expect(result).toEqual({ ok: false, error: "Set up your visual identity in Company settings before generating images." });
    expect(await db.select().from(contentImages).where(eq(contentImages.tenantId, tenant.id))).toHaveLength(0);
  });

  it("deletes the just-created row when the render fails, and reports the error", async () => {
    const { tenant, piece } = await seed();
    renderImage.mockRejectedValueOnce(new Error("model down"));
    const result = await generateBodyImage({ contentPieceId: piece.id, prompt: "x" });
    expect(result).toEqual({ ok: false, error: "model down" });
    expect(await db.select().from(contentImages).where(eq(contentImages.tenantId, tenant.id))).toHaveLength(0);
  });

  it("refuses a published piece", async () => {
    const { piece } = await seed();
    await db.update(contentPieces).set({ status: "published", publishedAt: new Date() }).where(eq(contentPieces.id, piece.id));
    await expect(generateBodyImage({ contentPieceId: piece.id, prompt: "x" })).rejects.toThrow(/already been published/);
  });
});

describe("suggestImagePrompt", () => {
  it("slices the body around the given heading and returns concept + compiled prompt + alt", async () => {
    const { piece } = await seed({ body: "# T\n\nIntro.\n\n## Search\n\nSearch is faster.\n\n## Billing\n\nBilling moved." });
    const out = await suggestImagePrompt({ contentPieceId: piece.id, surroundingMarkdown: "# T\n\nIntro.\n\n## Search\n\nSearch is faster.\n\n## Billing\n\nBilling moved.", heading: "Search" });
    const args = suggestImageConcept.mock.calls[0][0] as unknown as { surroundingMarkdown: string; role: string; title: string };
    expect(args.surroundingMarkdown).toContain("Search is faster.");
    expect(args.surroundingMarkdown).not.toContain("Billing moved.");
    expect(args.role).toBe("body");
    expect(args.title).toBe("Faster search");
    expect(out.concept).toBe("A rocket over a laptop");
    expect(out.altText).toBe("Rocket over a laptop");
    expect(out.prompt).toContain("A rocket over a laptop");
  });
});

describe("regenerateImage", () => {
  it("mode same: new render with the stored prompt, and the draft body's URL is swapped", async () => {
    const { tenant, piece } = await seed({ body: "## A\n\n![Gears](https://blob.example/gears-1.png)\n\nText." });
    const { image } = await seedGeneratedBodyImage(tenant.id, piece.id);
    const result = await regenerateImage({ imageId: image.id, mode: "same" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(renderImage.mock.calls[0][0]).toMatchObject({ prompt: "FULL PROMPT" });
    const after = await getImage(tenant.id, image.id);
    expect(after?.renders).toHaveLength(2);
    expect(after?.currentRenderId).toBe(result.renderId);
    const [row] = await db.select({ body: contentPieces.body, bodyEditedAt: contentPieces.bodyEditedAt }).from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(row.body).toContain(`![Gears](${result.url})`);
    expect(row.body).not.toContain("gears-1.png");
    expect(row.bodyEditedAt).toBeNull();
  });

  it("mode edit: sends the instruction against the current render and stores the history line", async () => {
    const { tenant, piece } = await seed();
    const { image } = await seedGeneratedBodyImage(tenant.id, piece.id);
    const result = await regenerateImage({ imageId: image.id, mode: "edit", instruction: "make it darker" });
    expect(result.ok).toBe(true);
    expect(renderImage.mock.calls[0][0]).toMatchObject({ prompt: "make it darker", editOf: "https://blob.example/gears-1.png" });
    const after = await getImage(tenant.id, image.id);
    expect(after?.current?.prompt).toBe("FULL PROMPT\n\nEdit: make it darker");
  });

  it("mode prompt: sends the given prompt verbatim", async () => {
    const { tenant, piece } = await seed();
    const { image } = await seedGeneratedBodyImage(tenant.id, piece.id);
    await regenerateImage({ imageId: image.id, mode: "prompt", prompt: "VERBATIM" });
    expect(renderImage.mock.calls[0][0]).toMatchObject({ prompt: "VERBATIM" });
  });

  it("returns not-found for another tenant's image", async () => {
    await seed();
    const [other] = await db.insert(tenants).values({ name: OTHER_NAME }).returning();
    const foreign = await createImage({ tenantId: other.id, contentPieceId: null, role: "library", concept: "c", altText: "a", sourceKind: "generated" });
    await addRender({ imageId: foreign.id, prompt: "p", blobUrl: "https://blob.example/f.png", blobPathname: "f", width: 1, height: 1, bytes: 1, model: "m" });
    expect(await regenerateImage({ imageId: foreign.id, mode: "same" })).toEqual({ ok: false, error: "Image not found." });
  });

  it("skipBodyWrite: true leaves the stored body's URL alone (Finding I4 — the editor toolbar does its own nodeKey-scoped write)", async () => {
    const { tenant, piece } = await seed({ body: "## A\n\n![Gears](https://blob.example/gears-1.png)\n\nText." });
    const { image } = await seedGeneratedBodyImage(tenant.id, piece.id);
    const result = await regenerateImage({ imageId: image.id, mode: "same", skipBodyWrite: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The render itself still happened and is now current...
    const after = await getImage(tenant.id, image.id);
    expect(after?.currentRenderId).toBe(result.renderId);
    // ...but the stored body was NOT rewritten server-side.
    const [row] = await db.select({ body: contentPieces.body }).from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(row.body).toContain("gears-1.png");
    expect(row.body).not.toContain(result.url);
  });

  it("revalidates /board when the regenerated image is the cover (Finding I6)", async () => {
    const { tenant, piece } = await seed();
    await generateCover({ contentPieceId: piece.id, mode: "prompt", prompt: "first" });
    revalidatePath.mockClear();
    const cover = await getCoverImage(tenant.id, piece.id);
    await regenerateImage({ imageId: cover!.id, mode: "same" });
    expect(revalidatePath.mock.calls.map((c) => c[0])).toContain("/board");
  });

  it("does not revalidate /board for a body image", async () => {
    const { tenant, piece } = await seed();
    const { image } = await seedGeneratedBodyImage(tenant.id, piece.id);
    revalidatePath.mockClear();
    await regenerateImage({ imageId: image.id, mode: "same" });
    expect(revalidatePath.mock.calls.map((c) => c[0])).not.toContain("/board");
  });
});

describe("restoreRender", () => {
  it("makes an older render current and swaps the URL in the body", async () => {
    const { tenant, piece } = await seed({ body: "![Gears](https://blob.example/gears-2.png)" });
    const { image, render: first } = await seedGeneratedBodyImage(tenant.id, piece.id);
    await addRender({ imageId: image.id, prompt: "FULL PROMPT", blobUrl: "https://blob.example/gears-2.png", blobPathname: "p/gears-2.png", width: 1200, height: 900, bytes: 10, model: "m" });
    const result = await restoreRender({ imageId: image.id, renderId: first.id });
    expect(result).toEqual({ ok: true, url: "https://blob.example/gears-1.png" });
    const after = await getImage(tenant.id, image.id);
    expect(after?.currentRenderId).toBe(first.id);
    const [row] = await db.select({ body: contentPieces.body }).from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(row.body).toBe("![Gears](https://blob.example/gears-1.png)");
  });

  it("skipBodyWrite: true leaves the stored body's URL alone (Finding I4)", async () => {
    const { tenant, piece } = await seed({ body: "![Gears](https://blob.example/gears-2.png)" });
    const { image, render: first } = await seedGeneratedBodyImage(tenant.id, piece.id);
    await addRender({ imageId: image.id, prompt: "FULL PROMPT", blobUrl: "https://blob.example/gears-2.png", blobPathname: "p/gears-2.png", width: 1200, height: 900, bytes: 10, model: "m" });
    const result = await restoreRender({ imageId: image.id, renderId: first.id, skipBodyWrite: true });
    expect(result).toEqual({ ok: true, url: "https://blob.example/gears-1.png" });
    const after = await getImage(tenant.id, image.id);
    expect(after?.currentRenderId).toBe(first.id);
    const [row] = await db.select({ body: contentPieces.body }).from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(row.body).toBe("![Gears](https://blob.example/gears-2.png)");
  });

  it("revalidates /board when restoring an older render of the cover (Finding I6)", async () => {
    const { tenant, piece } = await seed();
    await generateCover({ contentPieceId: piece.id, mode: "prompt", prompt: "first" });
    const cover = await getCoverImage(tenant.id, piece.id);
    await generateCover({ contentPieceId: piece.id, mode: "prompt", prompt: "second" });
    const withHistory = await getImage(tenant.id, cover!.id);
    const oldest = withHistory!.renders[withHistory!.renders.length - 1];
    revalidatePath.mockClear();
    await restoreRender({ imageId: cover!.id, renderId: oldest.id });
    expect(revalidatePath.mock.calls.map((c) => c[0])).toContain("/board");
  });
});

describe("generateCover / removeCover / setCoverFromImage", () => {
  it("from_post asks the text model for a cover concept and creates the cover row at 1200x624", async () => {
    const { tenant, piece } = await seed();
    const result = await generateCover({ contentPieceId: piece.id, mode: "from_post" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Finding M9: the caller (CoverPanel) seeds its local concept/alt state
    // from these returned values, not from empty strings — they must be the
    // real generated ones, not placeholders.
    expect(result.concept).toBe("A rocket over a laptop");
    expect(result.altText).toBe("Rocket over a laptop");
    const args = suggestImageConcept.mock.calls[0][0] as unknown as { role: string };
    expect(args.role).toBe("cover");
    expect(renderImage.mock.calls[0][0]).toMatchObject({ size: "1200x624", referenceImages: [refUrl(tenant.id)] });
    const cover = await getCoverImage(tenant.id, piece.id);
    expect(cover).toMatchObject({ role: "cover", concept: "A rocket over a laptop", sourceKind: "generated" });
  });

  it("prompt mode on an existing generated cover adds a render to the SAME row (history survives)", async () => {
    const { tenant, piece } = await seed();
    await generateCover({ contentPieceId: piece.id, mode: "prompt", prompt: "first" });
    const before = await getCoverImage(tenant.id, piece.id);
    await generateCover({ contentPieceId: piece.id, mode: "prompt", prompt: "second concept" });
    const after = await getImage(tenant.id, before!.id);
    expect(after?.renders).toHaveLength(2);
    expect(after?.concept).toBe("second concept");
  });

  it("removeCover deletes the cover row", async () => {
    const { tenant, piece } = await seed();
    await generateCover({ contentPieceId: piece.id, mode: "prompt", prompt: "first" });
    await removeCover({ contentPieceId: piece.id });
    expect(await getCoverImage(tenant.id, piece.id)).toBeNull();
  });

  it("setCoverFromImage copies the chosen render's blob fields into a new cover row without uploading", async () => {
    const { tenant, piece } = await seed();
    const { image } = await seedGeneratedBodyImage(tenant.id, piece.id);
    const result = await setCoverFromImage({ contentPieceId: piece.id, imageId: image.id });
    expect(result).toEqual({ ok: true, url: "https://blob.example/gears-1.png" });
    expect(uploadCount).toBe(0);
    const cover = await getCoverImage(tenant.id, piece.id);
    expect(cover?.current?.blobPathname).toBe("p/gears-1.png");
    expect(cover?.id).not.toBe(image.id);
    // Both rows point at one blob; the render count is 1 + 1.
    expect(await db.select().from(imageRenders).where(eq(imageRenders.blobPathname, "p/gears-1.png"))).toHaveLength(2);
  });
});

describe("insertImageFromLibrary", () => {
  it("creates a new body row sharing the picked blob, with no upload (Finding I2)", async () => {
    const { tenant, piece } = await seed();
    const source = await createImage({ tenantId: tenant.id, contentPieceId: null, role: "library", concept: "A compass on a map", altText: "A compass resting on a map", sourceKind: "generated" });
    await addRender({ imageId: source.id, prompt: "p", blobUrl: "https://blob.example/compass.png", blobPathname: "tenants/x/compass.png", width: 1200, height: 900, bytes: 10, model: "m" });

    const result = await insertImageFromLibrary({ contentPieceId: piece.id, imageId: source.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown).toBe("![A compass resting on a map](https://blob.example/compass.png)");
    expect(uploadCount).toBe(0);

    const newRow = await getImage(tenant.id, result.imageId);
    expect(newRow).toMatchObject({ role: "body", contentPieceId: piece.id, sourceKind: "generated", status: "ready" });
    expect(newRow?.id).not.toBe(source.id);
    expect(newRow?.current?.blobPathname).toBe("tenants/x/compass.png");
    // Both rows point at one blob — the render count is 1 + 1, same shape as
    // setCoverFromImage's own sharing, which is exactly what Task 3's guard
    // (`unreferencedPathnames`) exists to keep safe.
    expect(await db.select().from(imageRenders).where(eq(imageRenders.blobPathname, "tenants/x/compass.png"))).toHaveLength(2);
  });

  it("refuses a source image with no current render", async () => {
    const { tenant, piece } = await seed();
    const source = await createImage({ tenantId: tenant.id, contentPieceId: null, role: "library", concept: "c", altText: "a", sourceKind: "generated" });
    expect(await insertImageFromLibrary({ contentPieceId: piece.id, imageId: source.id })).toEqual({ ok: false, error: "Image not found." });
  });
});

describe("shared blob lifecycle (Finding I5)", () => {
  it("deleting the library source after setCoverFromImage spares the shared blob and the cover row", async () => {
    const { tenant, piece } = await seed();
    const source = await createImage({ tenantId: tenant.id, contentPieceId: null, role: "library", concept: "compass", altText: "A compass", sourceKind: "generated" });
    await addRender({ imageId: source.id, prompt: "p", blobUrl: "https://blob.example/shared-compass.png", blobPathname: "tenants/x/shared-compass.png", width: 1200, height: 630, bytes: 10, model: "m" });

    const setResult = await setCoverFromImage({ contentPieceId: piece.id, imageId: source.id });
    expect(setResult).toEqual({ ok: true, url: "https://blob.example/shared-compass.png" });
    const cover = await getCoverImage(tenant.id, piece.id);
    expect(cover?.current?.blobPathname).toBe("tenants/x/shared-compass.png");

    // Delete the SOURCE library row — the direction a user would take cleaning
    // up their library after already having set a piece's cover from it.
    expect(await deleteLibraryImage(source.id)).toEqual({ ok: true });

    expect(deleteBlobs.mock.calls.flatMap((c) => c[0])).not.toContain("tenants/x/shared-compass.png");
    const afterCover = await getCoverImage(tenant.id, piece.id);
    expect(afterCover?.id).toBe(cover?.id);
    expect(afterCover?.current?.blobUrl).toBe("https://blob.example/shared-compass.png");
    expect(afterCover?.current?.blobPathname).toBe("tenants/x/shared-compass.png");
  });
});

describe("updateCoverAlt", () => {
  it("trims and persists the cover's alt text", async () => {
    const { tenant, piece } = await seed();
    await generateCover({ contentPieceId: piece.id, mode: "prompt", prompt: "first" });
    expect(await updateCoverAlt({ contentPieceId: piece.id, altText: "  A lighthouse over a grid  " })).toEqual({ ok: true });
    const cover = await getCoverImage(tenant.id, piece.id);
    expect(cover?.altText).toBe("A lighthouse over a grid");
  });

  it("returns not-found when the piece has no cover", async () => {
    const { piece } = await seed();
    expect(await updateCoverAlt({ contentPieceId: piece.id, altText: "x" })).toEqual({ ok: false, error: "Image not found." });
  });
});

describe("uploadImageFile", () => {
  function form(fields: Record<string, string>, file: File) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    fd.set("file", file);
    return fd;
  }

  it("rejects an unsupported mime type before touching the database", async () => {
    const { tenant, piece } = await seed();
    const result = await uploadImageFile(form({ contentPieceId: piece.id, role: "body" }, new File([Buffer.from("GIF")], "a.gif", { type: "image/gif" })));
    expect(result).toEqual({ ok: false, error: "Only PNG, JPEG or WebP images can be uploaded." });
    expect(await db.select().from(contentImages).where(eq(contentImages.tenantId, tenant.id))).toHaveLength(0);
  });

  it("stores an uploaded body image with prompt '' and model 'upload'", async () => {
    const { tenant, piece } = await seed();
    const result = await uploadImageFile(form({ contentPieceId: piece.id, role: "body" }, new File([Buffer.from("JPEG")], "photo.jpg", { type: "image/jpeg" })));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = await getImage(tenant.id, result.imageId);
    expect(row).toMatchObject({ sourceKind: "uploaded", role: "body", status: "ready" });
    expect(row?.current).toMatchObject({ prompt: "", model: "upload" });
    expect(renderImage).not.toHaveBeenCalled();
  });

  it("rejects bytes that are not an image, and leaves no orphan row or blob behind", async () => {
    // `file.type` is browser-supplied: a renamed .zip arrives as "image/png"
    // and passes `validateUploadFile`. sharp is what actually rejects it, and
    // the row created just before must be cleaned up when it does.
    const { tenant, piece } = await seed();
    const { compressPng } = await import("../../../src/lib/images/compress");
    vi.mocked(compressPng).mockRejectedValueOnce(new Error("Input buffer contains unsupported image format"));

    const result = await uploadImageFile(
      form({ contentPieceId: piece.id, role: "body" }, new File([Buffer.from("PK not a png")], "a.png", { type: "image/png" }))
    );

    expect(result.ok).toBe(false);
    expect(await db.select().from(contentImages).where(eq(contentImages.tenantId, tenant.id))).toHaveLength(0);
  });

  it("rejects a file over the 10 MB cap without touching the database", async () => {
    const { tenant, piece } = await seed();
    const big = new File([new Uint8Array(1)], "huge.png", { type: "image/png" });
    Object.defineProperty(big, "size", { value: 10 * 1024 * 1024 + 1 });

    const result = await uploadImageFile(form({ contentPieceId: piece.id, role: "body" }, big));

    expect(result).toEqual({ ok: false, error: "Images must be 10 MB or smaller." });
    expect(await db.select().from(contentImages).where(eq(contentImages.tenantId, tenant.id))).toHaveLength(0);
  });

  it("refuses an upload aimed at another tenant's piece", async () => {
    await seed();
    const [other] = await db.insert(tenants).values({ name: OTHER_NAME }).returning();
    const [foreignPiece] = await db.insert(contentPieces).values({ tenantId: other.id, title: "X", body: "b" }).returning();

    await expect(
      uploadImageFile(form({ contentPieceId: foreignPiece.id, role: "body" }, new File([Buffer.from("PNG")], "a.png", { type: "image/png" })))
    ).rejects.toThrow(/not found/i);
    expect(await db.select().from(contentImages).where(eq(contentImages.tenantId, other.id))).toHaveLength(0);
  });

  it("an uploaded cover replaces the existing cover row", async () => {
    const { tenant, piece } = await seed();
    await generateCover({ contentPieceId: piece.id, mode: "prompt", prompt: "first" });
    const result = await uploadImageFile(form({ contentPieceId: piece.id, role: "cover" }, new File([Buffer.from("PNG")], "c.png", { type: "image/png" })));
    expect(result.ok).toBe(true);
    const cover = await getCoverImage(tenant.id, piece.id);
    expect(cover?.sourceKind).toBe("uploaded");
    expect(await db.select().from(contentImages).where(eq(contentImages.tenantId, tenant.id))).toHaveLength(1);
  });
});

describe("lookupImageBySrc", () => {
  it("maps a render URL to its row and history; unknown URLs return null", async () => {
    const { tenant, piece } = await seed();
    const { image, render } = await seedGeneratedBodyImage(tenant.id, piece.id);
    const found = await lookupImageBySrc("https://blob.example/gears-1.png");
    expect(found).toMatchObject({ imageId: image.id, sourceKind: "generated", currentRenderId: render.id, currentPrompt: "FULL PROMPT" });
    expect(found?.renders.map((r) => r.url)).toEqual(["https://blob.example/gears-1.png"]);
    expect(await lookupImageBySrc("https://blob.example/nope.png")).toBeNull();
  });

  it("lookupImageById resolves the exact row by id, unambiguous even when its blob is shared (Finding I3)", async () => {
    const { tenant, piece } = await seed();
    const { image } = await seedGeneratedBodyImage(tenant.id, piece.id);
    await setCoverFromImage({ contentPieceId: piece.id, imageId: image.id });
    const cover = await getCoverImage(tenant.id, piece.id);

    // Both rows now share "https://blob.example/gears-1.png" — looking each
    // up BY ID must return exactly that row, not whichever one a URL lookup
    // happens to tie-break to.
    const bySourceId = await lookupImageById(image.id);
    expect(bySourceId?.imageId).toBe(image.id);
    const byCoverId = await lookupImageById(cover!.id);
    expect(byCoverId?.imageId).toBe(cover!.id);
    expect(bySourceId?.imageId).not.toBe(byCoverId?.imageId);
  });

  it("never resolves another tenant's blob URL — the src is raw client input", async () => {
    // The editor calls this with whatever `<img src>` it finds. Pasting a blob
    // URL from another workspace must NOT return that workspace's prompt (which
    // contains their compiled brand style) or their render history.
    await seed();
    const [other] = await db.insert(tenants).values({ name: OTHER_NAME }).returning();
    const foreign = await createImage({ tenantId: other.id, contentPieceId: null, role: "library", concept: "their secret concept", altText: "a", sourceKind: "generated" });
    await addRender({ imageId: foreign.id, prompt: "THEIR STYLE BLOCK", blobUrl: "https://blob.example/theirs.png", blobPathname: "p/theirs.png", width: 1, height: 1, bytes: 1, model: "m" });

    expect(await lookupImageBySrc("https://blob.example/theirs.png")).toBeNull();
  });
});

/**
 * `content_images_cover_unique` is a PARTIAL unique index on
 * (content_piece_id) where role='cover'. Every cover writer here follows
 * read-then-insert — `getCoverImage` returns null, then `createImage` inserts —
 * with no transaction around the pair. Two overlapping calls (a double-click on
 * "Generate from post", or Generate racing an Upload) both read null and the
 * second insert raises Postgres 23505. `createImage` sits OUTSIDE each action's
 * try/catch, so that surfaces as an unhandled Server Action rejection — a red
 * error overlay in dev, a generic client error in prod — rather than the
 * `{ ok: false, error }` toast every other failure in this file produces.
 *
 * The fix is small and local: wrap each cover-creating `createImage` in a
 * try/catch that recognises a unique violation (walk `error.cause` for
 * `code === "23505"` — the same helper shape as `isUniqueViolation` in
 * `src/lib/publishing/dispatch.ts:33-41`) and returns
 * `{ ok: false, error: "This draft already has a cover — reload and try again." }`.
 * Apply it in `generateCover`, `setCoverFromImage` and `uploadImageFile`.
 */
describe("cover uniqueness under overlapping requests", () => {
  it("two concurrent generateCover calls leave one cover and neither rejects", async () => {
    const { tenant, piece } = await seed();

    const results = await Promise.all([
      generateCover({ contentPieceId: piece.id, mode: "prompt", prompt: "first" }),
      generateCover({ contentPieceId: piece.id, mode: "prompt", prompt: "second" }),
    ]);

    // At least one succeeds; neither throws; exactly one cover row exists.
    expect(results.some((r) => r.ok)).toBe(true);
    for (const r of results) if (!r.ok) expect(r.error).toEqual(expect.any(String));
    const covers = (await db.select().from(contentImages).where(eq(contentImages.contentPieceId, piece.id))).filter(
      (c) => c.role === "cover"
    );
    expect(covers).toHaveLength(1);
  });

  it("generateCover racing uploadImageFile(role=cover) does not reject either caller", async () => {
    const { tenant, piece } = await seed();
    const fd = new FormData();
    fd.set("contentPieceId", piece.id);
    fd.set("role", "cover");
    fd.set("file", new File([Buffer.from("PNG")], "c.png", { type: "image/png" }));

    const results = await Promise.allSettled([
      generateCover({ contentPieceId: piece.id, mode: "prompt", prompt: "first" }),
      uploadImageFile(fd),
    ]);

    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const covers = (await db.select().from(contentImages).where(eq(contentImages.contentPieceId, piece.id))).filter(
      (c) => c.role === "cover"
    );
    expect(covers).toHaveLength(1);
  });

  it("a second generateCover on an existing GENERATED cover reuses the row (no second insert to race)", async () => {
    const { tenant, piece } = await seed();
    await generateCover({ contentPieceId: piece.id, mode: "prompt", prompt: "first" });
    await generateCover({ contentPieceId: piece.id, mode: "prompt", prompt: "second" });
    const covers = (await db.select().from(contentImages).where(eq(contentImages.contentPieceId, piece.id))).filter(
      (c) => c.role === "cover"
    );
    expect(covers).toHaveLength(1);
    expect(covers[0].concept).toBe("second");
  });
});
