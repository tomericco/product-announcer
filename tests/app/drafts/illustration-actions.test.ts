import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, contentPieces, companyProfiles, contentImages, imageRenders, users, type VisualIdentity } from "../../../src/db/schema";
import { DEFAULT_VISUAL_IDENTITY } from "../../../src/lib/images/visual-identity";

const TENANT_NAME = "Illustration Actions Test Tenant";
const OTHER_NAME = "Illustration Actions Other Tenant";
const USER_EMAIL = "illustration-actions-test@example.com";
let currentTenantId = "";
let currentUserId: string | null = null;

vi.mock("../../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: currentUserId } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

type RenderArgs = { prompt: string; size: string; referenceImages?: (string | Buffer)[]; enforceAspect?: boolean };
const renderImage = vi.fn(async (_args: RenderArgs) => Buffer.from("PNG"));
vi.mock("../../../src/lib/ai/images", () => ({ renderImage: (a: RenderArgs) => renderImage(a) }));
vi.mock("../../../src/lib/images/compress", () => ({
  compressPng: vi.fn(async (png: Buffer, maxWidth: number) => ({ png, width: maxWidth, height: 900 })),
}));
vi.mock("../../../src/lib/images/blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/images/blob")>();
  return {
    ...actual,
    uploadPng: vi.fn(async (pathname: string) => ({ url: `https://blob.example/${pathname}`, pathname })),
    deleteBlobs: vi.fn(async () => {}),
  };
});

import { retryFailedIllustration, dismissFailedIllustrations } from "../../../src/app/(dashboard)/drafts/[releaseId]/illustration-actions";

const VI: VisualIdentity = {
  ...DEFAULT_VISUAL_IDENTITY,
  palette: [
    { hex: "#112233", role: "primary" },
    { hex: "#445566", role: "secondary" },
    { hex: "#ffffff", role: "background" },
  ],
};

const BODY = "Intro.\n\n## Alpha\n\nA para.\n\n## Beta\n\nB para.";

async function seed(opts: { anchor?: string | null; status?: "draft" | "published"; role?: "body" | "cover" } = {}) {
  const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
  const [user] = await db.insert(users).values({ email: USER_EMAIL }).returning();
  currentTenantId = tenant.id;
  currentUserId = user.id;
  await db.insert(companyProfiles).values({ tenantId: tenant.id, topics: [], visualIdentity: VI });
  const [piece] = await db
    .insert(contentPieces)
    .values({ tenantId: tenant.id, type: "blog_post", title: "T", body: BODY, status: opts.status ?? "draft" })
    .returning();
  const [image] = await db
    .insert(contentImages)
    .values({
      tenantId: tenant.id,
      contentPieceId: piece.id,
      role: opts.role ?? "body",
      concept: "gears meshing",
      altText: "Gears meshing",
      sourceKind: "generated",
      status: "failed",
      anchorHeading: opts.anchor === undefined ? "Beta" : opts.anchor,
    })
    .returning();
  return { tenant, piece, image };
}

afterEach(async () => {
  renderImage.mockClear();
  await db.delete(tenants).where(eq(tenants.name, TENANT_NAME));
  await db.delete(tenants).where(eq(tenants.name, OTHER_NAME));
  await db.delete(users).where(eq(users.email, USER_EMAIL));
});

describe("retryFailedIllustration", () => {
  it("re-renders from the stored concept, adds a render, and splices at the stored anchor without stamping bodyEditedAt", async () => {
    const { piece, image } = await seed();
    const result = await retryFailedIllustration({ contentPieceId: piece.id, imageId: image.id });
    expect(result).toMatchObject({ ok: true, placed: true });

    // The prompt is rebuilt from the concept + the CURRENT style block, in code.
    expect(renderImage).toHaveBeenCalledTimes(1);
    expect(renderImage.mock.calls[0][0].prompt).toContain("gears meshing");
    expect(renderImage.mock.calls[0][0].prompt).toContain("#112233");

    const [row] = await db.select().from(contentImages).where(eq(contentImages.id, image.id));
    expect(row.status).toBe("ready");
    expect(row.currentRenderId).not.toBeNull();
    const [render] = await db.select().from(imageRenders).where(eq(imageRenders.imageId, image.id));
    expect(render.prompt).toBe(renderImage.mock.calls[0][0].prompt);

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.body).toBe(`Intro.\n\n## Alpha\n\nA para.\n\n## Beta\n\n![Gears meshing](${render.blobUrl})\n\nB para.`);
    expect(after.bodyEditedAt).toBeNull();
    expect(after.editedBy).toBeNull();
  });

  it("re-renders a failed cover without touching the body", async () => {
    const { piece, image } = await seed({ role: "cover", anchor: null });
    const result = await retryFailedIllustration({ contentPieceId: piece.id, imageId: image.id });
    expect(result).toMatchObject({ ok: true, placed: true });
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.body).toBe(BODY);
    const [row] = await db.select().from(contentImages).where(eq(contentImages.id, image.id));
    expect(row.status).toBe("ready");
  });

  it("renders but reports placed:false when the anchor heading no longer exists", async () => {
    const { piece, image } = await seed({ anchor: "Gone" });
    const result = await retryFailedIllustration({ contentPieceId: piece.id, imageId: image.id });
    expect(result).toMatchObject({ ok: true, placed: false });
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.body).toBe(BODY);
    const [row] = await db.select().from(contentImages).where(eq(contentImages.id, image.id));
    expect(row.status).toBe("ready");
  });

  it("refuses an image that is not failed", async () => {
    const { piece, image } = await seed();
    await db.update(contentImages).set({ status: "ready" }).where(eq(contentImages.id, image.id));
    const result = await retryFailedIllustration({ contentPieceId: piece.id, imageId: image.id });
    expect(result.ok).toBe(false);
    expect(renderImage).not.toHaveBeenCalled();
  });

  it("refuses another tenant's image and never renders", async () => {
    await seed();
    const [other] = await db.insert(tenants).values({ name: OTHER_NAME }).returning();
    const [foreignPiece] = await db.insert(contentPieces).values({ tenantId: other.id, title: "X", body: "b" }).returning();
    const [foreign] = await db
      .insert(contentImages)
      .values({ tenantId: other.id, contentPieceId: foreignPiece.id, role: "body", concept: "c", altText: "a", sourceKind: "generated", status: "failed" })
      .returning();
    const result = await retryFailedIllustration({ contentPieceId: foreignPiece.id, imageId: foreign.id });
    expect(result.ok).toBe(false);
    expect(renderImage).not.toHaveBeenCalled();
  });

  it("refuses an image that belongs to a different piece than the one named", async () => {
    const { tenant, image } = await seed();
    const [otherPiece] = await db.insert(contentPieces).values({ tenantId: tenant.id, title: "Y", body: "b" }).returning();
    const result = await retryFailedIllustration({ contentPieceId: otherPiece.id, imageId: image.id });
    expect(result.ok).toBe(false);
    expect(renderImage).not.toHaveBeenCalled();
  });

  it("refuses when the piece is no longer editable", async () => {
    const { piece, image } = await seed({ status: "published" });
    const result = await retryFailedIllustration({ contentPieceId: piece.id, imageId: image.id });
    expect(result.ok).toBe(false);
    expect(renderImage).not.toHaveBeenCalled();
  });

  it("passes the piece's ready cover as a style reference for a BODY retry when pinStyleToCover is on", async () => {
    // The whole-post consistency the agent buys with pinStyleToCover must
    // survive a retry, or the retried image is the one that looks wrong.
    const { tenant, piece, image } = await seed();
    const [cover] = await db
      .insert(contentImages)
      .values({ tenantId: tenant.id, contentPieceId: piece.id, role: "cover", concept: "c", altText: "a", sourceKind: "generated", status: "ready" })
      .returning();
    const [coverRender] = await db
      .insert(imageRenders)
      .values({ imageId: cover.id, prompt: "p", blobUrl: "https://blob.example/cover.png", blobPathname: "p/cover.png", width: 1200, height: 630, bytes: 10, model: "m" })
      .returning();
    await db.update(contentImages).set({ currentRenderId: coverRender.id }).where(eq(contentImages.id, cover.id));

    await retryFailedIllustration({ contentPieceId: piece.id, imageId: image.id });

    expect(renderImage.mock.calls[0][0].referenceImages).toContain("https://blob.example/cover.png");
  });

  it("holds a retried COVER to 1200x630", async () => {
    // Product owner decision 1: covers are generated wide, never cropped —
    // and a retry is a generation like any other, so it asks for the shape
    // the same way (renderImage restates size + aspect ratio and re-asks once).
    const { piece, image } = await seed({ role: "cover", anchor: null });
    await retryFailedIllustration({ contentPieceId: piece.id, imageId: image.id });
    expect(renderImage.mock.calls[0][0]).toMatchObject({ size: "1200x630", enforceAspect: true });
  });

  it("does not guard the shape of a retried body image", async () => {
    const { piece, image } = await seed();
    await retryFailedIllustration({ contentPieceId: piece.id, imageId: image.id });
    expect(renderImage.mock.calls[0][0]).toMatchObject({ size: "1200x900" });
    expect(renderImage.mock.calls[0][0].enforceAspect).toBeFalsy();
  });

  it("does NOT pass the cover as a reference when retrying the cover itself", async () => {
    const { piece, image } = await seed({ role: "cover", anchor: null });
    await retryFailedIllustration({ contentPieceId: piece.id, imageId: image.id });
    expect(renderImage.mock.calls[0][0].referenceImages).toEqual([]);
  });

  it("marks the row failed again and reports the error when the render fails twice", async () => {
    const { piece, image } = await seed();
    renderImage.mockImplementation(async () => {
      throw new Error("model down");
    });
    const result = await retryFailedIllustration({ contentPieceId: piece.id, imageId: image.id });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("model down") });
    expect(renderImage).toHaveBeenCalledTimes(2);
    const [row] = await db.select().from(contentImages).where(eq(contentImages.id, image.id));
    expect(row.status).toBe("failed");
  });
});

describe("dismissFailedIllustrations", () => {
  it("deletes the piece's failed generated rows so the notice disappears", async () => {
    const { piece, image } = await seed();
    expect(await dismissFailedIllustrations({ contentPieceId: piece.id })).toEqual({ ok: true });
    expect(await db.select().from(contentImages).where(eq(contentImages.id, image.id))).toHaveLength(0);
  });

  it("leaves ready and uploaded images alone", async () => {
    const { tenant, piece } = await seed();
    const [ready] = await db
      .insert(contentImages)
      .values({ tenantId: tenant.id, contentPieceId: piece.id, role: "body", concept: "keep", altText: "Keep", sourceKind: "uploaded", status: "ready" })
      .returning();
    await dismissFailedIllustrations({ contentPieceId: piece.id });
    expect(await db.select().from(contentImages).where(eq(contentImages.id, ready.id))).toHaveLength(1);
  });

  it("refuses another tenant's piece", async () => {
    const { image } = await seed();
    const [other] = await db.insert(tenants).values({ name: OTHER_NAME }).returning();
    const [foreignPiece] = await db.insert(contentPieces).values({ tenantId: other.id, title: "X", body: "b" }).returning();
    currentTenantId = other.id;
    // The other tenant can dismiss only its own pieces; ours is untouched.
    expect((await dismissFailedIllustrations({ contentPieceId: foreignPiece.id })).ok).toBe(true);
    expect(await db.select().from(contentImages).where(eq(contentImages.id, image.id))).toHaveLength(1);
  });
});
