import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { companyProfiles, contentImages, contentPieces, imageRenders, llmUsage, tenants } from "../../src/db/schema";
import { seedTenant, dropTenant } from "../helpers/fixtures";

const TENANT = "Content Images Schema Test Tenant";

describe("content_images / image_renders schema", () => {
  afterEach(async () => {
    await dropTenant(TENANT);
  });

  it("stores an image with a piece, a render, and the current pointer", async () => {
    const tenant = await seedTenant(TENANT);
    const [piece] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, title: "T", body: "B", type: "blog_post" })
      .returning();
    const [image] = await db
      .insert(contentImages)
      .values({
        tenantId: tenant.id,
        contentPieceId: piece.id,
        role: "cover",
        concept: "a lighthouse",
        altText: "A lighthouse on a cliff",
        sourceKind: "generated",
        status: "pending",
      })
      .returning();
    expect(image.currentRenderId).toBeNull();

    const [render] = await db
      .insert(imageRenders)
      .values({
        imageId: image.id,
        prompt: "p",
        blobUrl: "https://blob.example/x.png",
        blobPathname: "tenants/t/content/p/cover-x.png",
        width: 1200,
        height: 630,
        bytes: 1000,
        model: "gpt-image-2",
      })
      .returning();
    const [updated] = await db
      .update(contentImages)
      .set({ currentRenderId: render.id, status: "ready" })
      .where(eq(contentImages.id, image.id))
      .returning();
    expect(updated.currentRenderId).toBe(render.id);
  });

  it("allows a library image with no piece", async () => {
    const tenant = await seedTenant(TENANT);
    const [image] = await db
      .insert(contentImages)
      .values({
        tenantId: tenant.id,
        contentPieceId: null,
        role: "library",
        concept: "c",
        altText: "a",
        sourceKind: "uploaded",
        status: "ready",
      })
      .returning();
    expect(image.contentPieceId).toBeNull();
  });

  it("refuses two covers on one piece but allows many body images", async () => {
    const tenant = await seedTenant(TENANT);
    const [piece] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, title: "T", body: "B", type: "blog_post" })
      .returning();
    const base = { tenantId: tenant.id, contentPieceId: piece.id, concept: "c", altText: "a", sourceKind: "generated", status: "pending" } as const;
    await db.insert(contentImages).values({ ...base, role: "cover" });
    await expect(db.insert(contentImages).values({ ...base, role: "cover" })).rejects.toThrow();
    await db.insert(contentImages).values({ ...base, role: "body" });
    await db.insert(contentImages).values({ ...base, role: "body" });
    const rows = await db.select().from(contentImages).where(eq(contentImages.contentPieceId, piece.id));
    expect(rows).toHaveLength(3);
  });

  it("cascades renders when the image is deleted, and images when the piece is deleted", async () => {
    const tenant = await seedTenant(TENANT);
    const [piece] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, title: "T", body: "B" })
      .returning();
    const [image] = await db
      .insert(contentImages)
      .values({ tenantId: tenant.id, contentPieceId: piece.id, role: "body", concept: "c", altText: "a", sourceKind: "generated", status: "pending" })
      .returning();
    await db.insert(imageRenders).values({ imageId: image.id, prompt: "p", blobUrl: "u", blobPathname: "p", width: 1, height: 1, bytes: 1, model: "m" });
    await db.delete(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(await db.select().from(contentImages).where(eq(contentImages.id, image.id))).toHaveLength(0);
    expect(await db.select().from(imageRenders).where(eq(imageRenders.imageId, image.id))).toHaveLength(0);
  });

  it("round-trips visual identity and image policy on the company profile", async () => {
    const tenant = await seedTenant(TENANT);
    const [profile] = await db.insert(companyProfiles).values({ tenantId: tenant.id }).returning();
    expect(profile.visualIdentity).toBeNull();
    expect(profile.imagePolicy).toBeNull();
    const [updated] = await db
      .update(companyProfiles)
      .set({
        visualIdentity: {
          palette: [{ hex: "#112233", role: "primary" }],
          stylePreset: "flat",
          moodWords: ["clean"],
          allowTextInImages: false,
          styleReferenceImages: [],
          customStyleDescriptors: "",
          imageGenerationRules: [{ kind: "dont", text: "no photorealism" }],
          backgroundTreatment: "solid",
          texture: "none",
          peopleStyle: "abstract_figures",
          pinStyleToCover: true,
        },
        imagePolicy: { blog_post: { cover: true, body: 2 } },
      })
      .where(eq(companyProfiles.id, profile.id))
      .returning();
    expect(updated.visualIdentity?.palette[0].hex).toBe("#112233");
    expect(updated.imagePolicy?.blog_post?.body).toBe(2);
  });

  it("stores an image count on llm_usage", async () => {
    const tenant = await seedTenant(TENANT);
    const [row] = await db
      .insert(llmUsage)
      .values({ tenantId: tenant.id, operation: "image_generation", model: "gpt-image-2", imageCount: 1 })
      .returning();
    expect(row.imageCount).toBe(1);
    expect(row.inputTokens).toBeNull();
    await db.delete(tenants).where(eq(tenants.id, tenant.id));
  });
});
