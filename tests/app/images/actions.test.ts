import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, users, contentPieces, companyProfiles, contentImages, type VisualIdentity } from "../../../src/db/schema";
import { DEFAULT_VISUAL_IDENTITY } from "../../../src/lib/images/visual-identity";
import { createImage, addRender, getImage } from "../../../src/lib/images/store";

const TENANT_NAME = "Images Library Actions Test Tenant";
const USER_EMAIL = "images-actions-test@example.com";
let currentTenantId = "";
let currentUserId: string | null = null;

vi.mock("../../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: currentUserId } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// Forwards its call args (not `() => renderImage()`, which would discard
// them) — that discarding is what made the C1 cross-tenant reference-image
// leak structurally impossible to catch here; see the Finding C1 test below.
const renderImage = vi.fn(async (_args: { prompt: string; referenceImages?: unknown }) => Buffer.from("PNG"));
vi.mock("../../../src/lib/ai/images", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/ai/images")>();
  return {
    ...actual,
    renderImage: (a: { prompt: string; referenceImages?: unknown }) => renderImage(a),
  };
});
vi.mock("../../../src/lib/images/compress", () => ({
  compressPng: vi.fn(async (png: Buffer, maxWidth: number) => ({ png, width: maxWidth, height: 900 })),
}));
const deleteBlobs = vi.fn(async (_p: string[]) => {});
vi.mock("../../../src/lib/images/blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/images/blob")>();
  return {
    ...actual,
    uploadPng: vi.fn(async (pathname: string) => ({ url: `https://blob.example/${pathname}`, pathname })),
    deleteBlobs: (p: string[]) => deleteBlobs(p),
  };
});

import { deleteLibraryImage, generateLibraryImage, listImagesForPicker } from "../../../src/app/(dashboard)/images/actions";

const VI: VisualIdentity = {
  ...DEFAULT_VISUAL_IDENTITY,
  palette: [
    { hex: "#112233", role: "primary" },
    { hex: "#445566", role: "secondary" },
    { hex: "#ffffff", role: "background" },
  ],
};

// Mirrors tests/app/drafts/image-actions.test.ts's `refUrl` — a URL whose
// pathname genuinely starts with `tenants/{tenantId}/brand/`, the shape
// `ownedBrandReferenceImages` requires.
function refUrl(tenantId: string): string {
  return `https://blob.example/tenants/${tenantId}/brand/ref.png`;
}

/**
 * Default status is "review", not "brief": the library only excludes images
 * of pieces still in "brief" (product owner decision, 2026-08-20 — a
 * "draft"-status piece is a finished draft, always library-visible), so a
 * brief-status piece is the wrong fixture for a library test. `status:
 * "brief"` is passed explicitly where the exclusion itself is being tested.
 */
async function seed(opts: { published?: boolean; status?: "brief" | "draft" | "review" | "scheduled" | "archived" } = {}) {
  const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
  const [user] = await db.insert(users).values({ email: USER_EMAIL }).returning();
  currentTenantId = tenant.id;
  currentUserId = user.id;
  await db.insert(companyProfiles).values({ tenantId: tenant.id, topics: [], visualIdentity: VI });
  const [piece] = await db
    .insert(contentPieces)
    .values({
      tenantId: tenant.id,
      type: "blog_post",
      title: "Piece",
      body: "## A\n\n![Gears](https://blob.example/gears.png)\n\nText.",
      status: opts.published ? "published" : (opts.status ?? "review"),
      publishedAt: opts.published ? new Date() : null,
    })
    .returning();
  const image = await createImage({ tenantId: tenant.id, contentPieceId: piece.id, role: "body", concept: "gears", altText: "Gears", sourceKind: "generated" });
  await addRender({ imageId: image.id, prompt: "p", blobUrl: "https://blob.example/gears.png", blobPathname: "p/gears.png", width: 1, height: 1, bytes: 1, model: "m" });
  return { tenant, piece, image };
}

afterEach(async () => {
  deleteBlobs.mockClear();
  renderImage.mockClear();
  await db.delete(tenants).where(eq(tenants.name, TENANT_NAME));
  await db.delete(users).where(eq(users.email, USER_EMAIL));
});

describe("deleteLibraryImage", () => {
  it("removes the row, its blobs, and the image line from the piece body — without stamping bodyEditedAt", async () => {
    const { tenant, piece, image } = await seed();
    expect(await deleteLibraryImage(image.id)).toEqual({ ok: true });
    expect(await getImage(tenant.id, image.id)).toBeNull();
    expect(deleteBlobs).toHaveBeenLastCalledWith(["p/gears.png"]);
    const [row] = await db
      .select({ body: contentPieces.body, bodyEditedAt: contentPieces.bodyEditedAt, editedBy: contentPieces.editedBy })
      .from(contentPieces)
      .where(eq(contentPieces.id, piece.id));
    expect(row.body).toBe("## A\n\nText.");
    // Product owner decision 4 (2026-08-19): a library delete is a cleanup
    // write, not an authored edit. Stamping would freeze whole-draft
    // regeneration for that piece forever (`generateDraftForPiece` refuses a
    // hand-edited body) over one deleted image.
    expect(row.bodyEditedAt).toBeNull();
    expect(row.editedBy).toBeNull();
  });

  it("refuses an image referenced by a published piece, leaving body and row alone", async () => {
    const { tenant, piece, image } = await seed({ published: true });
    expect(await deleteLibraryImage(image.id)).toEqual({ ok: false, reason: "published" });
    expect(await getImage(tenant.id, image.id)).not.toBeNull();
    const [row] = await db.select({ body: contentPieces.body }).from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(row.body).toContain("gears.png");
  });

  it("returns not_found for another tenant's image", async () => {
    await seed();
    const [other] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
    const foreign = await createImage({ tenantId: other.id, contentPieceId: null, role: "library", concept: "c", altText: "a", sourceKind: "generated" });
    expect(await deleteLibraryImage(foreign.id)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("generateLibraryImage", () => {
  it("creates a role:library row with no piece and a ready render", async () => {
    const { tenant } = await seed();
    const result = await generateLibraryImage({ prompt: "A compass on a map", concept: "A compass on a map" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = await getImage(tenant.id, result.imageId);
    expect(row).toMatchObject({ role: "library", contentPieceId: null, sourceKind: "generated", status: "ready" });
    expect(row?.current?.blobUrl).toBe(result.url);
    expect(row?.current?.blobPathname).toContain(`tenants/${tenant.id}/content/library/library-a-compass-on-a-map.png`);
  });

  it("refuses without a ready identity", async () => {
    const { tenant } = await seed();
    await db.update(companyProfiles).set({ visualIdentity: null }).where(eq(companyProfiles.tenantId, tenant.id));
    expect(await generateLibraryImage({ prompt: "x", concept: "x" })).toEqual({
      ok: false,
      error: "Set up your visual identity in Company settings before generating images.",
    });
  });

  it("drops a styleReferenceImages URL that isn't owned by this tenant before it reaches renderImage (Finding C1)", async () => {
    // `parseVisualIdentity`'s `BLOB_URL_SCHEMA` only restricts the URL's host,
    // not the tenant path, so a foreign tenant's public blob URL could in
    // principle end up persisted into this tenant's own `styleReferenceImages`
    // array. Array membership alone must not be enough to get it fetched as
    // reference bytes for a library generation — mirrors
    // tests/app/drafts/image-actions.test.ts's own Finding 6 coverage, which
    // this action lacked entirely (the original vulnerability).
    const { tenant } = await seed();
    const foreignUrl = "https://blob.example/tenants/someone-elses-tenant/brand/foreign.png";
    await db
      .update(companyProfiles)
      .set({ visualIdentity: { ...VI, styleReferenceImages: [refUrl(tenant.id), foreignUrl] } })
      .where(eq(companyProfiles.tenantId, tenant.id));

    const result = await generateLibraryImage({ prompt: "A compass on a map", concept: "A compass on a map" });
    expect(result.ok).toBe(true);
    const sent = renderImage.mock.calls[0][0];
    expect(sent.referenceImages).toEqual([refUrl(tenant.id)]);
    expect(sent.referenceImages).not.toContain(foreignUrl);
  });
});

describe("listImagesForPicker", () => {
  it("lists only images with a current render, newest first, with the piece title", async () => {
    const { tenant, piece } = await seed();
    await createImage({ tenantId: tenant.id, contentPieceId: null, role: "library", concept: "no render yet", altText: "", sourceKind: "generated" });
    const out = await listImagesForPicker();
    expect(out).toHaveLength(1);
    // altText and sourceKind (Finding M9): CoverPanel's "From library" pick
    // seeds its local state from these directly, so the picker must carry the
    // source row's real values, not omit them.
    expect(out[0]).toMatchObject({
      url: "https://blob.example/gears.png",
      concept: "gears",
      altText: "Gears",
      role: "body",
      sourceKind: "generated",
      pieceTitle: "Piece",
    });
    expect(piece.id).toBeTruthy();
  });

  it("does not offer an image belonging to a piece that is still being briefed", async () => {
    // A "brief"-status piece is the only one generation can still be
    // actively running under, so it's the one the picker must still keep to
    // itself. The picker reads `listLibraryImages`, so this is the same rule
    // the /images page enforces — asserted here because the picker is the
    // path that would otherwise paste an in-flight generation's image
    // elsewhere.
    const { tenant } = await seed({ status: "brief" });
    const standalone = await createImage({ tenantId: tenant.id, contentPieceId: null, role: "library", concept: "compass", altText: "", sourceKind: "generated" });
    await addRender({ imageId: standalone.id, prompt: "p", blobUrl: "https://blob.example/compass.png", blobPathname: "p/compass.png", width: 1, height: 1, bytes: 1, model: "m" });

    const out = await listImagesForPicker();
    expect(out.map((i) => i.concept)).toEqual(["compass"]);
  });

  it("filters to cover-shaped renders when asked for the cover slot", async () => {
    // Resolves the brief's open question (build option a): "From library"
    // for a cover only offers images whose stored render is cover-shaped
    // (1200x624, 1.91:1) within the 2% tolerance renderImage's own guard
    // uses — a body-shaped (4:3) render picked into the cover slot would
    // ship distorted/cropped into LinkedIn and OG, which product owner
    // decision 1 forbids us to do ourselves.
    const { tenant } = await seed(); // seeds a 1x1 "body" render (not cover-shaped)
    const cover = await createImage({ tenantId: tenant.id, contentPieceId: null, role: "library", concept: "cover-shaped", altText: "", sourceKind: "generated" });
    await addRender({ imageId: cover.id, prompt: "p", blobUrl: "https://blob.example/cover.png", blobPathname: "p/cover.png", width: 1200, height: 630, bytes: 1, model: "m" });

    const out = await listImagesForPicker({ role: "cover" });
    expect(out.map((i) => i.concept)).toEqual(["cover-shaped"]);
  });
});
