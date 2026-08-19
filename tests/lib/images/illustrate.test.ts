import { describe, it, expect, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, contentPieces, companyProfiles, contentImages, imageRenders, type VisualIdentity } from "../../../src/db/schema";
import { DEFAULT_VISUAL_IDENTITY } from "../../../src/lib/images/visual-identity";
import { illustratePiece, type IllustrateDeps } from "../../../src/lib/images/illustrate";
import type { IllustrationPlan } from "../../../src/lib/images/plan";

const TENANT = "Illustrate Piece Test Tenant";

const VI: VisualIdentity = {
  ...DEFAULT_VISUAL_IDENTITY,
  palette: [
    { hex: "#112233", role: "primary" },
    { hex: "#445566", role: "secondary" },
    { hex: "#ffffff", role: "background" },
  ],
  styleReferenceImages: ["https://blob.example/ref-1.png"],
  pinStyleToCover: true,
};

const BODY = "Intro.\n\n## Alpha\n\nA para.\n\n## Beta\n\nB para.\n\n## Wrap Up\n\nBye.";

const PLAN: IllustrationPlan = {
  cover: { concept: "lighthouse", prompt: "PROMPT cover", altText: "A lighthouse beam" },
  body: [
    { anchorHeading: "Alpha", concept: "gears", prompt: "PROMPT alpha", altText: "Gears turning" },
    { anchorHeading: "Beta", concept: "door", prompt: "PROMPT beta", altText: "A door opening" },
  ],
};

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
});

async function seed(opts: { visualIdentity?: VisualIdentity | null; imagePolicy?: Record<string, unknown> | null } = {}) {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  await db.insert(companyProfiles).values({
    tenantId: tenant.id,
    topics: [],
    visualIdentity: opts.visualIdentity === undefined ? VI : opts.visualIdentity,
    imagePolicy: (opts.imagePolicy ?? null) as never,
  });
  const [piece] = await db
    .insert(contentPieces)
    .values({ tenantId: tenant.id, type: "blog_post", title: "T", body: BODY, status: "brief" })
    .returning();
  return { tenant, piece };
}

/** Fakes for every network seam. `renderImage` records what it was asked for. */
function fakes(overrides: Partial<IllustrateDeps> & { failPrompts?: string[] } = {}) {
  const renderCalls: { prompt: string; size: string; referenceImages: (string | Buffer)[]; enforceAspect?: boolean }[] = [];
  const uploadCalls: string[] = [];
  const failing = new Set(overrides.failPrompts ?? []);
  // Every pathname is distinct: two body images rendered in parallel would
  // otherwise share a blob URL and the splice assertions could not tell them
  // apart. Real `uploadPng` gets uniqueness from `addRandomSuffix`.
  let uploadCounter = 0;
  const deleteBlobs = vi.fn(async (_pathnames: string[]) => {});
  const deps: Required<IllustrateDeps> = {
    planIllustrations: vi.fn(async () => PLAN),
    renderImage: vi.fn(async (args: { prompt: string; size: string; referenceImages?: (string | Buffer)[]; enforceAspect?: boolean }) => {
      renderCalls.push({
        prompt: args.prompt,
        size: args.size,
        referenceImages: args.referenceImages ?? [],
        enforceAspect: args.enforceAspect,
      });
      if (failing.has(args.prompt)) throw new Error(`render failed: ${args.prompt}`);
      return Buffer.from(`PNG:${args.prompt}`);
    }) as never,
    compressPng: vi.fn(async (input: Buffer, maxWidth: number) => ({ png: input, width: maxWidth, height: 630 })),
    uploadPng: vi.fn(async (pathname: string) => {
      uploadCalls.push(pathname);
      const unique = `${pathname}-${++uploadCounter}`;
      return { url: `https://blob.example/${unique}`, pathname: unique };
    }),
    deleteBlobs,
    ...overrides,
  };
  return { deps, renderCalls, uploadCalls, deleteBlobs };
}

async function imagesFor(pieceId: string) {
  return db.select().from(contentImages).where(eq(contentImages.contentPieceId, pieceId)).orderBy(contentImages.createdAt);
}

describe("illustratePiece", () => {
  it("skips with a reason when the tenant has no ready visual identity", async () => {
    const { tenant, piece } = await seed({ visualIdentity: null });
    const { deps } = fakes();
    const result = await illustratePiece(
      { tenantId: tenant.id, contentPieceId: piece.id, title: "T", body: BODY, contentType: "blog_post", database: db },
      deps
    );
    expect(result).toEqual({ body: BODY, failures: 0, skipped: "no_visual_identity" });
    expect(deps.planIllustrations).not.toHaveBeenCalled();
    expect(await imagesFor(piece.id)).toHaveLength(0);
  });

  it("returns the body untouched when the type's policy has no cover and body off", async () => {
    // social_post: DEFAULT_IMAGE_POLICY {cover:false, body:"off"}.
    const { tenant, piece } = await seed();
    const { deps } = fakes();
    const result = await illustratePiece(
      { tenantId: tenant.id, contentPieceId: piece.id, title: "T", body: BODY, contentType: "social_post", database: db },
      deps
    );
    expect(result).toEqual({ body: BODY, failures: 0, skipped: "policy_off" });
    expect(deps.planIllustrations).not.toHaveBeenCalled();
  });

  it("creates cover + body rows, renders cover first, body with the cover as a reference, and splices", async () => {
    const { tenant, piece } = await seed();
    const { deps, renderCalls } = fakes();

    const result = await illustratePiece(
      { tenantId: tenant.id, contentPieceId: piece.id, title: "T", body: BODY, contentType: "blog_post", database: db },
      deps
    );

    expect(result.failures).toBe(0);
    expect(result.skipped).toBeUndefined();

    // Cover first, at 1200x630, with only the brand references — and asking
    // renderImage to hold it to that shape (product owner decision 1: the
    // cover is GENERATED wide, never cropped afterwards).
    expect(renderCalls[0]).toMatchObject({ prompt: "PROMPT cover", size: "1200x630", enforceAspect: true });
    expect(renderCalls[0].referenceImages).toEqual(["https://blob.example/ref-1.png"]);
    // Body renders after, at 1200x900, brand refs + the fresh cover bytes (pinStyleToCover).
    const bodyCalls = renderCalls.slice(1);
    expect(bodyCalls.map((c) => c.prompt).sort()).toEqual(["PROMPT alpha", "PROMPT beta"]);
    for (const call of bodyCalls) {
      expect(call.size).toBe("1200x900");
      // Body images have no fixed shape to hold; only covers are guarded.
      expect(call.enforceAspect).toBeFalsy();
      expect(call.referenceImages[0]).toBe("https://blob.example/ref-1.png");
      expect(Buffer.isBuffer(call.referenceImages[1])).toBe(true);
    }

    // Rows: one cover, two body, all ready with a current render and the anchor stored.
    const rows = await imagesFor(piece.id);
    expect(rows.map((r) => r.role).sort()).toEqual(["body", "body", "cover"]);
    expect(rows.every((r) => r.status === "ready" && r.currentRenderId !== null)).toBe(true);
    const alpha = rows.find((r) => r.concept === "gears")!;
    expect(alpha.anchorHeading).toBe("Alpha");
    expect(alpha.altText).toBe("Gears turning");
    expect(rows.find((r) => r.role === "cover")!.anchorHeading).toBeNull();

    // Renders carry the exact prompt and the blob URL.
    const [alphaRender] = await db.select().from(imageRenders).where(eq(imageRenders.imageId, alpha.id));
    expect(alphaRender.prompt).toBe("PROMPT alpha");
    expect(alphaRender.blobUrl).toMatch(/^https:\/\/blob\.example\/tenants\//);

    // Spliced after the anchors, cover NOT in the body.
    expect(result.body).toContain(`## Alpha\n\n![Gears turning](${alphaRender.blobUrl})\n\nA para.`);
    expect(result.body).toMatch(/## Beta\n\n!\[A door opening\]\(https:\/\/blob\.example\/[^)]+\)\n\nB para\./);
    expect(result.body).not.toContain("lighthouse");
    expect(result.body).toContain("## Wrap Up\n\nBye.");
  });

  it("retries a failed render once, silently", async () => {
    const { tenant, piece } = await seed();
    let alphaAttempts = 0;
    const { deps } = fakes();
    (deps.renderImage as ReturnType<typeof vi.fn>).mockImplementation(async (args: { prompt: string }) => {
      if (args.prompt === "PROMPT alpha" && alphaAttempts++ === 0) throw new Error("transient");
      return Buffer.from("PNG");
    });
    const result = await illustratePiece(
      { tenantId: tenant.id, contentPieceId: piece.id, title: "T", body: BODY, contentType: "blog_post", database: db },
      deps
    );
    expect(result.failures).toBe(0);
    expect(alphaAttempts).toBe(2);
    expect(result.body).toMatch(/## Alpha\n\n!\[Gears turning\]/);
  });

  it("marks a twice-failed body image failed, keeps its row and anchor, omits it from the body, counts it", async () => {
    const { tenant, piece } = await seed();
    const { deps } = fakes({ failPrompts: ["PROMPT beta"] });
    const result = await illustratePiece(
      { tenantId: tenant.id, contentPieceId: piece.id, title: "T", body: BODY, contentType: "blog_post", database: db },
      deps
    );
    expect(result.failures).toBe(1);
    expect(result.body).toMatch(/## Alpha\n\n!\[Gears turning\]/);
    expect(result.body).toContain("## Beta\n\nB para.");
    const beta = (await imagesFor(piece.id)).find((r) => r.concept === "door")!;
    expect(beta.status).toBe("failed");
    expect(beta.anchorHeading).toBe("Beta");
    expect(beta.currentRenderId).toBeNull();
  });

  it("saves the draft coverless when the cover fails, and still renders body images without it as a reference", async () => {
    const { tenant, piece } = await seed();
    const { deps, renderCalls } = fakes({ failPrompts: ["PROMPT cover"] });
    const result = await illustratePiece(
      { tenantId: tenant.id, contentPieceId: piece.id, title: "T", body: BODY, contentType: "blog_post", database: db },
      deps
    );
    expect(result.failures).toBe(1);
    const cover = (await imagesFor(piece.id)).find((r) => r.role === "cover")!;
    // The row persists with its concept — Plan 3's Add-cover menu pre-fills from it.
    expect(cover.status).toBe("failed");
    expect(cover.concept).toBe("lighthouse");
    const bodyCalls = renderCalls.filter((c) => c.size === "1200x900");
    expect(bodyCalls).toHaveLength(2);
    for (const call of bodyCalls) expect(call.referenceImages).toEqual(["https://blob.example/ref-1.png"]);
  });

  it("does not pass the cover as a reference when pinStyleToCover is off", async () => {
    const { tenant, piece } = await seed({ visualIdentity: { ...VI, pinStyleToCover: false } });
    const { deps, renderCalls } = fakes();
    await illustratePiece(
      { tenantId: tenant.id, contentPieceId: piece.id, title: "T", body: BODY, contentType: "blog_post", database: db },
      deps
    );
    for (const call of renderCalls.filter((c) => c.size === "1200x900")) {
      expect(call.referenceImages).toEqual(["https://blob.example/ref-1.png"]);
    }
  });

  it("plans no cover for a type whose policy has cover off, and honours the body cap", async () => {
    const { tenant, piece } = await seed({ imagePolicy: { blog_post: { cover: false, body: 1 } } });
    const { deps } = fakes();
    await illustratePiece(
      { tenantId: tenant.id, contentPieceId: piece.id, title: "T", body: BODY, contentType: "blog_post", database: db },
      deps
    );
    expect(deps.planIllustrations).toHaveBeenCalledWith(
      expect.objectContaining({ wantCover: false, bodyCap: 1, tenantId: tenant.id }),
      expect.anything()
    );
  });

  it("removes leftover generated rows from an earlier run before creating new ones", async () => {
    const { tenant, piece } = await seed();
    // A cover row from an aborted earlier generation. Without cleanup the
    // partial unique index on (content_piece_id) where role='cover' would
    // reject the new cover.
    await db.insert(contentImages).values({
      tenantId: tenant.id,
      contentPieceId: piece.id,
      role: "cover",
      concept: "stale",
      altText: "stale",
      sourceKind: "generated",
      status: "failed",
    });
    const { deps } = fakes();
    const result = await illustratePiece(
      { tenantId: tenant.id, contentPieceId: piece.id, title: "T", body: BODY, contentType: "blog_post", database: db },
      deps
    );
    expect(result.failures).toBe(0);
    const covers = (await imagesFor(piece.id)).filter((r) => r.role === "cover");
    expect(covers).toHaveLength(1);
    expect(covers[0].concept).toBe("lighthouse");
  });

  it("deletes a leftover row's BLOBS too, through the injected seam — never the real del()", async () => {
    // The realistic regenerate case: an earlier run succeeded, its rows and
    // blobs exist, and this run must not orphan them. Without an injected
    // deleteBlobs this test would call @vercel/blob for real.
    const { tenant, piece } = await seed();
    const [stale] = await db
      .insert(contentImages)
      .values({
        tenantId: tenant.id,
        contentPieceId: piece.id,
        role: "body",
        concept: "stale gears",
        altText: "Stale",
        sourceKind: "generated",
        status: "ready",
      })
      .returning();
    const [staleRender] = await db
      .insert(imageRenders)
      .values({
        imageId: stale.id,
        prompt: "old",
        blobUrl: "https://blob.example/old.png",
        blobPathname: "tenants/x/old.png",
        width: 1200,
        height: 900,
        bytes: 10,
        model: "m",
      })
      .returning();
    await db.update(contentImages).set({ currentRenderId: staleRender.id }).where(eq(contentImages.id, stale.id));

    const { deps, deleteBlobs } = fakes();
    await illustratePiece(
      { tenantId: tenant.id, contentPieceId: piece.id, title: "T", body: BODY, contentType: "blog_post", database: db },
      deps
    );

    expect(deleteBlobs).toHaveBeenCalledWith(["tenants/x/old.png"]);
    expect(await db.select().from(contentImages).where(eq(contentImages.id, stale.id))).toHaveLength(0);
    expect((await imagesFor(piece.id)).map((r) => r.concept).sort()).toEqual(["door", "gears", "lighthouse"]);
  });

  it("leaves an UPLOADED leftover row and its blob alone", async () => {
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
        status: "ready",
      })
      .returning();

    const { deps, deleteBlobs } = fakes();
    await illustratePiece(
      { tenantId: tenant.id, contentPieceId: piece.id, title: "T", body: BODY, contentType: "blog_post", database: db },
      deps
    );

    expect(await db.select().from(contentImages).where(eq(contentImages.id, uploaded.id))).toHaveLength(1);
    expect(deleteBlobs).not.toHaveBeenCalled();
  });

  it("keeps blob pathnames short — the slug is clamped, not the raw title", async () => {
    // `slugify` (publishing/slug.ts) allows 200 chars; `slugForImage`
    // (images/blob.ts) clamps to 40. Pathnames are stored on every render row
    // and shown in the Blob UI, so the image slug is the right one here.
    const { tenant, piece } = await seed();
    const longTitle = "The Very Long Title That Keeps Going ".repeat(6);
    const { deps, uploadCalls } = fakes();
    await illustratePiece(
      { tenantId: tenant.id, contentPieceId: piece.id, title: longTitle, body: BODY, contentType: "blog_post", database: db },
      deps
    );
    const coverPath = uploadCalls.find((p) => p.includes("/cover-"))!;
    expect(coverPath.split("/").pop()!.length).toBeLessThanOrEqual(50); // "cover-" + <=40 + ".png"
  });

  it("scopes to the tenant: image rows carry the tenant id", async () => {
    const { tenant, piece } = await seed();
    const { deps } = fakes();
    await illustratePiece(
      { tenantId: tenant.id, contentPieceId: piece.id, title: "T", body: BODY, contentType: "blog_post", database: db },
      deps
    );
    const rows = await db
      .select()
      .from(contentImages)
      .where(and(eq(contentImages.contentPieceId, piece.id), eq(contentImages.tenantId, tenant.id)));
    expect(rows).toHaveLength(3);
  });
});
