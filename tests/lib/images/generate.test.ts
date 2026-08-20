import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, imageRenders } from "../../../src/db/schema";
import { createImage, getImage } from "../../../src/lib/images/store";
import { renderAndStore, storeRenderBytes, markdownImage } from "../../../src/lib/images/generate";
// Type-only: pins the mock's parameter shape so `mock.calls[0][0]` is typed
// (a `vi.fn(async () => ...)` with no declared parameter infers `Parameters<T>`
// as the empty tuple, which tsc then refuses to index). Erased at compile
// time, so this never touches the real render seam.
import type { RenderImageArgs } from "../../../src/lib/ai/images";

const TENANT = "Generate Helper Test Tenant";

async function seed() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  const image = await createImage({
    tenantId: tenant.id,
    contentPieceId: null,
    role: "library",
    concept: "a rocket",
    altText: "A rocket",
    sourceKind: "generated",
  });
  return { tenant, image };
}

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
});

describe("renderAndStore", () => {
  it("renders, compresses, uploads under the role pathname and records the render as current", async () => {
    const { tenant, image } = await seed();
    const renderImage = vi.fn(async (_args: RenderImageArgs) => Buffer.from("RAW"));
    const compressPng = vi.fn(async (png: Buffer, maxWidth: number) => ({ png: Buffer.concat([png, Buffer.from("!")]), width: maxWidth, height: 900 }));
    const uploadPng = vi.fn(async (pathname: string) => ({ url: `https://blob.example/${pathname}-abc`, pathname: `${pathname}-abc` }));

    const render = await renderAndStore(
      {
        tenantId: tenant.id,
        imageId: image.id,
        contentPieceId: null,
        role: "library",
        slug: "a-rocket",
        prompt: "FULL PROMPT",
        size: "1200x896",
        referenceImages: ["https://blob.example/ref.png"],
      },
      { renderImage, compressPng, uploadPng }
    );

    expect(renderImage.mock.calls[0][0]).toMatchObject({ tenantId: tenant.id, prompt: "FULL PROMPT", size: "1200x896", referenceImages: ["https://blob.example/ref.png"] });
    // Only covers ask renderImage to hold the shape.
    expect(renderImage.mock.calls[0][0].enforceAspect).toBe(false);
    expect(compressPng).toHaveBeenCalledWith(Buffer.from("RAW"), 1200);
    expect(uploadPng.mock.calls[0][0]).toBe(`tenants/${tenant.id}/content/library/library-a-rocket.png`);
    expect(render).toMatchObject({ imageId: image.id, prompt: "FULL PROMPT", width: 1200, height: 900, bytes: 4 });
    expect(render.blobUrl).toBe(`https://blob.example/tenants/${tenant.id}/content/library/library-a-rocket.png-abc`);

    const stored = await getImage(tenant.id, image.id);
    expect(stored?.currentRenderId).toBe(render.id);
    expect(stored?.status).toBe("ready");
  });

  it("asks renderImage to hold the 1.91:1 shape for a cover — generated wide, never cropped", async () => {
    // Product owner decision 1 (2026-08-19). Derived from the role inside
    // renderAndStore, so every cover path in this plan is guarded without each
    // call site remembering. compressPng still only ever resizes by width.
    const { tenant, image } = await seed();
    const renderImage = vi.fn(async (_args: RenderImageArgs) => Buffer.from("RAW"));
    const compressPng = vi.fn(async (png: Buffer, maxWidth: number) => ({ png, width: maxWidth, height: 630 }));

    await renderAndStore(
      {
        tenantId: tenant.id,
        imageId: image.id,
        contentPieceId: null,
        role: "cover",
        slug: "a-rocket",
        prompt: "FULL PROMPT",
        size: "1200x624",
      },
      { renderImage, compressPng, uploadPng: async (pathname) => ({ url: `https://blob.example/${pathname}`, pathname }) }
    );

    expect(renderImage.mock.calls[0][0]).toMatchObject({ size: "1200x624", enforceAspect: true });
    expect(compressPng).toHaveBeenCalledWith(Buffer.from("RAW"), 1200);
  });

  it("stores `storedPrompt` (the edit history) rather than the instruction it sent, and passes editOf through", async () => {
    const { tenant, image } = await seed();
    const renderImage = vi.fn(async (_args: RenderImageArgs) => Buffer.from("RAW"));
    const render = await renderAndStore(
      {
        tenantId: tenant.id,
        imageId: image.id,
        contentPieceId: null,
        role: "library",
        slug: "a-rocket",
        prompt: "make it darker",
        storedPrompt: "FULL PROMPT\n\nEdit: make it darker",
        size: "1200x896",
        editOf: "https://blob.example/current.png",
      },
      {
        renderImage,
        compressPng: async (png) => ({ png, width: 1, height: 1 }),
        uploadPng: async (pathname) => ({ url: `https://blob.example/${pathname}`, pathname }),
      }
    );
    expect(renderImage.mock.calls[0][0]).toMatchObject({ prompt: "make it darker", editOf: "https://blob.example/current.png" });
    expect(render.prompt).toBe("FULL PROMPT\n\nEdit: make it darker");
  });
});

describe("storeRenderBytes", () => {
  it("skips the model: compresses the given bytes, uploads, and records prompt/model as given", async () => {
    const { tenant, image } = await seed();
    const uploadPng = vi.fn(async (pathname: string) => ({ url: `https://blob.example/${pathname}`, pathname }));
    const render = await storeRenderBytes(
      { tenantId: tenant.id, imageId: image.id, contentPieceId: null, role: "library", slug: "upload", png: Buffer.from("JPEGBYTES"), prompt: "", model: "upload" },
      { compressPng: async (png) => ({ png, width: 640, height: 480 }), uploadPng }
    );
    expect(render).toMatchObject({ prompt: "", model: "upload", width: 640, height: 480 });
    const [row] = await db.select().from(imageRenders).where(eq(imageRenders.id, render.id));
    expect(row.blobPathname).toBe(`tenants/${tenant.id}/content/library/library-upload.png`);
  });
});

describe("markdownImage", () => {
  it("writes the image line and strips brackets from the alt so the markdown stays parseable", () => {
    expect(markdownImage("A [bold] rocket", "https://x/a.png")).toBe("![A bold rocket](https://x/a.png)");
  });
});
