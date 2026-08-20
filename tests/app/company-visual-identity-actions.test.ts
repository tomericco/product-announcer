import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { companyProfiles, contentImages } from "../../src/db/schema";
import { seedTenant, dropTenant } from "../helpers/fixtures";
import { DEFAULT_VISUAL_IDENTITY } from "../../src/lib/images/visual-identity";

let currentTenantId = "";
vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: "user-1" } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const deriveMock = vi.fn(async (..._args: unknown[]) => ({ ok: false, reason: "blocked" }) as { ok: boolean; reason?: string });
vi.mock("../../src/lib/workspace/derive-visual-identity", () => ({
  deriveVisualIdentityFromPage: (...args: unknown[]) => deriveMock(...args),
}));

// No test may reach sharp's real work or Vercel Blob (Global Constraints).
vi.mock("../../src/lib/images/compress", () => ({
  compressPng: vi.fn(async (png: Buffer, maxWidth: number) => ({ png, width: maxWidth, height: 900 })),
}));
const deleteBrandAssets = vi.fn(async (_pathnames: string[]) => {});
vi.mock("../../src/lib/images/blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/images/blob")>();
  return {
    ...actual,
    uploadBrandAsset: vi.fn(async (pathname: string) => ({ url: `https://blob.example.private.blob.vercel-storage.com/${pathname}`, pathname })),
    deleteBrandAssets: (pathnames: string[]) => deleteBrandAssets(pathnames),
  };
});

import {
  saveVisualIdentity,
  deriveVisualIdentityFromUrl,
  uploadStyleReference,
  removeStyleReference,
} from "../../src/app/(dashboard)/company/actions";

const TENANT = "Visual Identity Actions Test Tenant";

afterEach(async () => {
  await dropTenant(TENANT);
  vi.clearAllMocks();
});

const IDENTITY = {
  ...DEFAULT_VISUAL_IDENTITY,
  palette: [
    { hex: "#1A73E8", role: "primary" },
    { hex: "#ffffff", role: "background" },
    { hex: "#fbbc04", role: "accent" },
  ],
};

describe("saveVisualIdentity", () => {
  it("validates, normalises and persists to the tenant's profile", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;

    expect(await saveVisualIdentity(IDENTITY)).toEqual({ ok: true });

    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile.visualIdentity?.palette[0]).toEqual({ hex: "#1a73e8", role: "primary" });
    expect(profile.visualIdentity?.stylePreset).toBe("flat");
  });

  it("rejects invalid input without writing", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;

    expect(await saveVisualIdentity({ ...IDENTITY, stylePreset: "photo" })).toEqual({ ok: false, reason: "invalid" });
    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile?.visualIdentity ?? null).toBeNull();
  });
});

describe("deriveVisualIdentityFromUrl", () => {
  it("passes the tenant and trimmed url through and never writes", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    deriveMock.mockResolvedValueOnce({ ok: true, identity: IDENTITY } as never);

    const result = await deriveVisualIdentityFromUrl("  https://example.com  ");
    expect(result.ok).toBe(true);
    expect(deriveMock).toHaveBeenCalledWith(tenant.id, "https://example.com");
    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile?.visualIdentity ?? null).toBeNull();
  });

  it("refuses an empty url", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    expect(await deriveVisualIdentityFromUrl("   ")).toEqual({ ok: false, reason: "empty" });
    expect(deriveMock).not.toHaveBeenCalled();
  });
});

describe("uploadStyleReference", () => {
  function form(file: File): FormData {
    const fd = new FormData();
    fd.set("file", file);
    return fd;
  }
  const png = (name = "illustration.png") => new File([Buffer.from("PNG")], name, { type: "image/png" });

  async function seedWithIdentity() {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    await saveVisualIdentity(IDENTITY);
    return tenant;
  }

  it("stores the file under the tenant's brand prefix and appends it to the identity", async () => {
    const tenant = await seedWithIdentity();

    const result = await uploadStyleReference(form(png("Our Hero Illustration.png")));

    expect(result).toEqual({
      ok: true,
      styleReferenceImages: [`https://blob.example.private.blob.vercel-storage.com/tenants/${tenant.id}/brand/our-hero-illustration.png`],
    });
    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile.visualIdentity?.styleReferenceImages).toEqual(result.ok ? result.styleReferenceImages : []);
    // Brand inputs are not content: no content_images row is written.
    expect(await db.select().from(contentImages).where(eq(contentImages.tenantId, tenant.id))).toHaveLength(0);
  });

  it("rejects a wrong mime type and an oversized file without storing anything", async () => {
    const tenant = await seedWithIdentity();

    const gif = await uploadStyleReference(form(new File([Buffer.from("GIF")], "a.gif", { type: "image/gif" })));
    expect(gif.ok).toBe(false);
    if (!gif.ok) expect(gif.error).toMatch(/PNG, JPEG or WebP/);

    const huge = new File([Buffer.from("PNG")], "big.png", { type: "image/png" });
    Object.defineProperty(huge, "size", { value: 11 * 1024 * 1024 });
    const tooBig = await uploadStyleReference(form(huge));
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.error).toMatch(/10 MB/);

    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile.visualIdentity?.styleReferenceImages).toEqual([]);
  });

  it("refuses the fifth reference with a message that says what to do", async () => {
    // The schema allows 1–4 (Task 4, MAX_REFERENCE_IMAGES); the cap is
    // enforced BEFORE the upload so a refused add never leaves a paid orphan.
    await seedWithIdentity();
    for (let i = 0; i < 4; i++) {
      expect((await uploadStyleReference(form(png(`ref-${i}.png`)))).ok).toBe(true);
    }

    const fifth = await uploadStyleReference(form(png("ref-5.png")));
    expect(fifth.ok).toBe(false);
    if (!fifth.ok) expect(fifth.error).toMatch(/up to 4 .*Remove one/i);
  });
});

describe("removeStyleReference", () => {
  it("drops the url from the identity and deletes its blob", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    await saveVisualIdentity(IDENTITY);
    const fd = new FormData();
    fd.set("file", new File([Buffer.from("PNG")], "a.png", { type: "image/png" }));
    const added = await uploadStyleReference(fd);
    const url = added.ok ? added.styleReferenceImages[0] : "";

    expect(await removeStyleReference(url)).toEqual({ ok: true, styleReferenceImages: [] });
    expect(deleteBrandAssets).toHaveBeenCalledWith([`tenants/${tenant.id}/brand/a.png`]);
    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile.visualIdentity?.styleReferenceImages).toEqual([]);
  });

  it("is a no-op for a url this tenant does not have", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    await saveVisualIdentity(IDENTITY);

    expect(await removeStyleReference("https://blob.example/somebody/else.png")).toEqual({ ok: true, styleReferenceImages: [] });
    expect(deleteBrandAssets).not.toHaveBeenCalled();
  });

  it("refuses to delete another tenant's blob even when it is (maliciously) in this tenant's own array", async () => {
    // Attack: tenant A calls saveVisualIdentity with a styleReferenceImages
    // entry pointing at tenant B's real blob-storage URL (same allow-listed
    // host as `next.config.ts`, so it passes the schema's host check), then
    // calls removeStyleReference with that same URL. Array membership alone
    // used to be treated as proof of ownership; it is not — this must be
    // rejected by the tenant-prefix check before `deleteBrandAssets` ever runs.
    const otherTenantId = "00000000-0000-0000-0000-000000000099";
    const foreignUrl = `https://example.private.blob.vercel-storage.com/tenants/${otherTenantId}/brand/cover-abc123.png`;

    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;

    expect(await saveVisualIdentity({ ...IDENTITY, styleReferenceImages: [foreignUrl] })).toEqual({ ok: true });

    const result = await removeStyleReference(foreignUrl);
    expect(result).toEqual({ ok: true, styleReferenceImages: [foreignUrl] });
    expect(deleteBrandAssets).toHaveBeenCalledTimes(0);

    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile.visualIdentity?.styleReferenceImages).toEqual([foreignUrl]);
  });
});
