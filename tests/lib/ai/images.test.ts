import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { db } from "../../../src/db";
import { llmUsage } from "../../../src/db/schema";
import { seedTenant, dropTenant } from "../../helpers/fixtures";
import { renderImage, type RenderImageDeps } from "../../../src/lib/ai/images";

process.env.OPENAI_API_KEY ??= "test-key";

const TENANT = "Render Image Test Tenant";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function fakeGenerate(bytes: Buffer = PNG, warnings: unknown[] = []) {
  const calls: unknown[] = [];
  const generate = vi.fn(async (opts: unknown) => {
    calls.push(opts);
    return {
      images: [{ uint8Array: new Uint8Array(bytes), base64: "", mediaType: "image/png" }],
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      warnings,
    };
  }) as unknown as NonNullable<RenderImageDeps["generate"]>;
  return { generate, calls: calls as { model: { modelId: string }; prompt: unknown; size?: string; aspectRatio?: string }[] };
}

/** A REAL png of the given shape — the aspect guard measures pixels with sharp. */
async function realPng(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } })
    .png()
    .toBuffer();
}

afterEach(async () => {
  await dropTenant(TENANT);
});

describe("renderImage", () => {
  it("sends a plain string prompt with the requested size and returns the PNG bytes", async () => {
    const tenant = await seedTenant(TENANT);
    const { generate, calls } = fakeGenerate();

    const png = await renderImage({ tenantId: tenant.id, prompt: "a lighthouse", size: "1200x630" }, { generate });

    expect(Buffer.isBuffer(png)).toBe(true);
    expect(png.equals(PNG)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toBe("a lighthouse");
    expect(calls[0].size).toBe("1200x630");
    // Covers are generated wide NATIVELY, never cropped later: the request
    // states the shape both ways so a provider honouring either one returns
    // 1.91:1 (product owner decision 1).
    expect(calls[0].aspectRatio).toBe("40:21");
    expect(calls[0].model.modelId).toBe("gpt-image-2");
  });

  it("passes reference images as {images, text}, downloading URL references to bytes", async () => {
    const tenant = await seedTenant(TENANT);
    const { generate, calls } = fakeGenerate();
    const refBytes = Buffer.from("ref-png");
    const fetchImpl = vi.fn(async () => new Response(refBytes)) as unknown as typeof fetch;

    await renderImage(
      { tenantId: tenant.id, prompt: "p", size: "1200x900", referenceImages: ["https://blob/ref.png", Buffer.from("local")] },
      { generate, fetchImpl }
    );

    expect(fetchImpl).toHaveBeenCalledWith("https://blob/ref.png");
    const prompt = calls[0].prompt as { images: Buffer[]; text: string };
    expect(prompt.text).toBe("p");
    expect(prompt.images).toHaveLength(2);
    expect(Buffer.from(prompt.images[0]).equals(refBytes)).toBe(true);
    expect(Buffer.from(prompt.images[1]).toString()).toBe("local");
  });

  it("edits: passes editOf as the single image and the prompt as the instruction", async () => {
    const tenant = await seedTenant(TENANT);
    const { generate, calls } = fakeGenerate();
    const original = Buffer.from("orig");

    await renderImage({ tenantId: tenant.id, prompt: "make the background darker", size: "1200x900", editOf: original }, { generate });

    const prompt = calls[0].prompt as { images: Buffer[]; text: string };
    expect(prompt.images).toHaveLength(1);
    expect(Buffer.from(prompt.images[0]).toString()).toBe("orig");
    expect(prompt.text).toBe("make the background darker");
  });

  it("records an image_generation usage row with imageCount 1", async () => {
    const tenant = await seedTenant(TENANT);
    const { generate } = fakeGenerate();

    await renderImage({ tenantId: tenant.id, prompt: "p", size: "1200x630" }, { generate });

    const [row] = await db.select().from(llmUsage).where(eq(llmUsage.tenantId, tenant.id));
    expect(row).toMatchObject({ operation: "image_generation", model: "gpt-image-2", imageCount: 1, inputTokens: 10, totalTokens: 30 });
  });

  it("accepts a cover that came back the right shape without a second call", async () => {
    const tenant = await seedTenant(TENANT);
    const { generate, calls } = fakeGenerate(await realPng(1200, 630));

    const png = await renderImage({ tenantId: tenant.id, prompt: "p", size: "1200x630", enforceAspect: true }, { generate });

    expect(calls).toHaveLength(1);
    expect((await sharp(png).metadata()).width).toBe(1200);
  });

  it("retries a cover ONCE when the provider returns a square, then stores the true dimensions — never a crop", async () => {
    const tenant = await seedTenant(TENANT);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const square = await realPng(1024, 1024);
    const { generate, calls } = fakeGenerate(square);

    const png = await renderImage({ tenantId: tenant.id, prompt: "p", size: "1200x630", enforceAspect: true }, { generate });

    // Exactly two attempts — one retry, not a loop — and the retry is a
    // byte-identical repeat of the same size/aspect ratio, not a strengthened
    // second request.
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ size: "1200x630", aspectRatio: "40:21" });
    // Still square, and returned untouched: no crop, no letterbox, no lie
    // about the dimensions. Plan 4 publishes 1024x1024 for this cover.
    const meta = await sharp(png).metadata();
    expect({ width: meta.width, height: meta.height }).toEqual({ width: 1024, height: 1024 });
    expect(consoleWarn).toHaveBeenCalled();
    // Two images were generated, so two usage rows: the retry is billed.
    expect(await db.select().from(llmUsage).where(eq(llmUsage.tenantId, tenant.id))).toHaveLength(2);
    consoleWarn.mockRestore();
  });

  it("does not guard a body render — only covers pass enforceAspect", async () => {
    const tenant = await seedTenant(TENANT);
    const { generate, calls } = fakeGenerate(await realPng(1024, 1024));

    await renderImage({ tenantId: tenant.id, prompt: "p", size: "1200x900" }, { generate });

    expect(calls).toHaveLength(1);
    expect(calls[0].aspectRatio).toBe("4:3");
  });

  it("defaults enforceAspect to true for a cover render even when the caller never passes it", async () => {
    // A caller that forgets `enforceAspect: true` for a cover must not
    // silently lose the no-crop guard (product owner decision 1) — the
    // default now turns it on for any 1200x630 (IMAGE_SIZES.cover) render.
    const tenant = await seedTenant(TENANT);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const square = await realPng(1024, 1024);
    const { generate, calls } = fakeGenerate(square);

    await renderImage({ tenantId: tenant.id, prompt: "p", size: "1200x630" }, { generate });

    expect(calls).toHaveLength(2);
    consoleWarn.mockRestore();
  });

  it("an explicit enforceAspect: false still opts out of the guard for a cover render", async () => {
    const tenant = await seedTenant(TENANT);
    const square = await realPng(1024, 1024);
    const { generate, calls } = fakeGenerate(square);

    await renderImage({ tenantId: tenant.id, prompt: "p", size: "1200x630", enforceAspect: false }, { generate });

    expect(calls).toHaveLength(1);
  });

  it("stores unmeasurable bytes as-is rather than failing the render", async () => {
    // If sharp cannot read what came back, the guard has nothing to compare
    // and must not take the render down with it.
    const tenant = await seedTenant(TENANT);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { generate, calls } = fakeGenerate(PNG); // 7 bytes, not a real PNG

    const png = await renderImage({ tenantId: tenant.id, prompt: "p", size: "1200x630", enforceAspect: true }, { generate });

    expect(calls).toHaveLength(1);
    expect(png.equals(PNG)).toBe(true);
    consoleWarn.mockRestore();
  });

  it("logs provider warnings instead of dropping them", async () => {
    // e.g. @ai-sdk/openai pushing "This model does not support aspect ratio.
    // Use `size` instead." on every call — previously never read or logged.
    const tenant = await seedTenant(TENANT);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const warnings = [{ type: "unsupported-setting", setting: "aspectRatio", details: "Use `size` instead." }];
    const { generate } = fakeGenerate(PNG, warnings);

    await renderImage({ tenantId: tenant.id, prompt: "p", size: "1200x900" }, { generate });

    expect(consoleWarn).toHaveBeenCalledWith("[ai/images] generateImage warnings:", warnings);
    consoleWarn.mockRestore();
  });

  it("does not warn when the provider returns no warnings", async () => {
    const tenant = await seedTenant(TENANT);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { generate } = fakeGenerate(PNG, []);

    await renderImage({ tenantId: tenant.id, prompt: "p", size: "1200x900" }, { generate });

    expect(consoleWarn).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it("propagates a model failure and records nothing", async () => {
    const tenant = await seedTenant(TENANT);
    const generate = vi.fn(async () => {
      throw new Error("model down");
    }) as unknown as NonNullable<RenderImageDeps["generate"]>;

    await expect(renderImage({ tenantId: tenant.id, prompt: "p", size: "1200x630" }, { generate })).rejects.toThrow("model down");
    expect(await db.select().from(llmUsage).where(eq(llmUsage.tenantId, tenant.id))).toHaveLength(0);
  });
});
