import { describe, it, expect, vi, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
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

// A controllable delay inserted into `getOrCreateCompanyProfile`, zero by
// default. The Finding-4 concurrency test below uses it to force two
// concurrent `retryFailedIllustration` calls to both pass their initial
// `image.status !== "failed"` reads before either reaches the claim step —
// reproducing genuine overlap deterministically. Without it, real
// connection-pool timing tends to fully serialize the two calls (the first
// finishes end-to-end before the second's own first query even runs), which
// would make that test pass whether or not the claim fix exists.
let profileReadDelayMs = 0;
vi.mock("../../../src/lib/workspace/company-profile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/workspace/company-profile")>();
  return {
    ...actual,
    getOrCreateCompanyProfile: async (...args: Parameters<typeof actual.getOrCreateCompanyProfile>) => {
      if (profileReadDelayMs > 0) await new Promise((r) => setTimeout(r, profileReadDelayMs));
      return actual.getOrCreateCompanyProfile(...args);
    },
  };
});

import { retryFailedIllustration, dismissFailedIllustrations } from "../../../src/app/(dashboard)/drafts/[releaseId]/illustration-actions";
// The real illustratePiece, not a mock: the composition test below needs its
// actual DB writes (row + anchorHeading), and it picks up the same mocked
// renderImage/compressPng/uploadPng/deleteBlobs modules already set up above.
import { illustratePiece } from "../../../src/lib/images/illustrate";
import type { IllustrationPlan } from "../../../src/lib/images/plan";

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

  it("refuses an uploaded image even though it is a failed body/cover row (Finding 1: sourceKind guard)", async () => {
    // Nothing in this plan creates a `failed` row with `sourceKind:
    // "uploaded"` yet (Plan 3 adds editor uploads), so it's constructed
    // directly here, matching this file's own seed() pattern.
    const { tenant, piece } = await seed();
    const [uploaded] = await db
      .insert(contentImages)
      .values({
        tenantId: tenant.id,
        contentPieceId: piece.id,
        role: "body",
        concept: "screenshot.png",
        altText: "",
        sourceKind: "uploaded",
        status: "failed",
        anchorHeading: "Beta",
      })
      .returning();
    const result = await retryFailedIllustration({ contentPieceId: piece.id, imageId: uploaded.id });
    expect(result.ok).toBe(false);
    expect(renderImage).not.toHaveBeenCalled();
    const [row] = await db.select().from(contentImages).where(eq(contentImages.id, uploaded.id));
    expect(row.status).toBe("failed");
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

  it("holds a retried COVER to 1200x624", async () => {
    // Product owner decision 1: covers are generated wide, never cropped —
    // and a retry is a generation like any other, so it asks for the shape
    // the same way (renderImage restates size + aspect ratio and re-asks once).
    const { piece, image } = await seed({ role: "cover", anchor: null });
    await retryFailedIllustration({ contentPieceId: piece.id, imageId: image.id });
    expect(renderImage.mock.calls[0][0]).toMatchObject({ size: "1200x624", enforceAspect: true });
  });

  it("does not guard the shape of a retried body image", async () => {
    const { piece, image } = await seed();
    await retryFailedIllustration({ contentPieceId: piece.id, imageId: image.id });
    expect(renderImage.mock.calls[0][0]).toMatchObject({ size: "1200x896" });
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

  it("claims the row before rendering: two concurrent retries of the same image only bill once (Finding 4)", async () => {
    const { piece, image } = await seed();
    // The previous test permanently overrode the module-level mock's
    // implementation to always throw (mockClear in afterEach only clears
    // call history, not the implementation) — reset it to a normal success.
    renderImage.mockImplementation(async () => Buffer.from("PNG"));
    // Force genuine overlap at the claim step — see profileReadDelayMs's doc
    // comment above.
    profileReadDelayMs = 15;

    try {
      const [first, second] = await Promise.all([
        retryFailedIllustration({ contentPieceId: piece.id, imageId: image.id }),
        retryFailedIllustration({ contentPieceId: piece.id, imageId: image.id }),
      ]);

      const results = [first, second];
      const succeeded = results.filter((r) => r.ok);
      const refused = results.filter((r) => !r.ok);
      expect(succeeded).toHaveLength(1);
      expect(refused).toHaveLength(1);
      if (!refused[0].ok) expect(refused[0].error).toMatch(/already being retried/i);
      // Only the winner actually rendered — the claim refused the loser
      // before it ever called renderImage, so this is not a race on the
      // mock's call count either.
      expect(renderImage).toHaveBeenCalledTimes(1);

      const [row] = await db.select().from(contentImages).where(eq(contentImages.id, image.id));
      expect(row.status).toBe("ready");
    } finally {
      profileReadDelayMs = 0;
    }
  });

  it("rejects the body write when the draft changed mid-retry, but keeps the successful render as ready (Finding 3)", async () => {
    const { piece, image } = await seed();
    renderImage.mockImplementation(async () => {
      // Simulate a concurrent Save landing while this render is in flight —
      // the write predicate below must catch this, not the read at the top
      // of the action (which ran before this happened).
      await db.update(contentPieces).set({ body: "Someone else's concurrent edit." }).where(eq(contentPieces.id, piece.id));
      return Buffer.from("PNG");
    });

    const result = await retryFailedIllustration({ contentPieceId: piece.id, imageId: image.id });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/draft changed/i);

    // The concurrent edit survives untouched — not silently overwritten by
    // the stale-plus-one-image body the retry computed from its snapshot.
    const [afterPiece] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(afterPiece.body).toBe("Someone else's concurrent edit.");

    // The render itself was not wasted: it succeeded and is usable, only its
    // placement into the body lost the race.
    const [row] = await db.select().from(contentImages).where(eq(contentImages.id, image.id));
    expect(row.status).toBe("ready");
    expect(row.currentRenderId).not.toBeNull();
  });
});

describe("composition: illustratePiece failure -> retryFailedIllustration placement", () => {
  it("places a retried image at the anchor illustratePiece originally stored (Recommendation #5)", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
    const [user] = await db.insert(users).values({ email: USER_EMAIL }).returning();
    currentTenantId = tenant.id;
    currentUserId = user.id;
    await db.insert(companyProfiles).values({ tenantId: tenant.id, topics: [], visualIdentity: VI });
    const [piece] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, type: "blog_post", title: "T", body: BODY, status: "draft" })
      .returning();

    const plan: IllustrationPlan = {
      cover: null,
      body: [{ anchorHeading: "Beta", concept: "gears meshing", prompt: "PROMPT beta", altText: "Gears meshing" }],
    };
    renderImage.mockImplementation(async (args: RenderArgs) => {
      if (args.prompt === "PROMPT beta") throw new Error("model down");
      return Buffer.from("PNG");
    });

    const illustrateResult = await illustratePiece(
      { tenantId: currentTenantId, contentPieceId: piece.id, title: piece.title, body: piece.body, contentType: "blog_post", database: db },
      { planIllustrations: async () => plan }
    );
    expect(illustrateResult.failures).toBe(1);
    expect(illustrateResult.body).toBe(BODY);

    const [failedImage] = await db
      .select()
      .from(contentImages)
      .where(and(eq(contentImages.contentPieceId, piece.id), eq(contentImages.role, "body")));
    expect(failedImage.status).toBe("failed");
    expect(failedImage.anchorHeading).toBe("Beta");

    renderImage.mockClear();
    renderImage.mockImplementation(async () => Buffer.from("PNG-RETRY"));

    const retryResult = await retryFailedIllustration({ contentPieceId: piece.id, imageId: failedImage.id });
    expect(retryResult).toMatchObject({ ok: true, placed: true });

    const [afterPiece] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(afterPiece.body).toMatch(/## Beta\n\n!\[Gears meshing\]\(https:\/\/blob\.example\/[^)]+\)\n\nB para\./);
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
