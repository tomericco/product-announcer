import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@vercel/blob", () => ({ put: vi.fn(), del: vi.fn() }));

import { put, del } from "@vercel/blob";
import {
  UPLOAD_MAX_BYTES,
  blobPathnameFromUrl,
  brandAssetPathname,
  deleteBlobs,
  imagePathname,
  slugForImage,
  uploadPng,
  validateUploadFile,
} from "../../../src/lib/images/blob";

beforeEach(() => {
  vi.mocked(put).mockReset();
  vi.mocked(del).mockReset();
  vi.restoreAllMocks();
});

describe("imagePathname", () => {
  it("nests under the tenant and piece", () => {
    expect(imagePathname({ tenantId: "t1", contentPieceId: "p1", role: "cover", slug: "lighthouse" })).toBe(
      "tenants/t1/content/p1/cover-lighthouse.png"
    );
  });
  it("uses 'library' when there is no piece", () => {
    expect(imagePathname({ tenantId: "t1", contentPieceId: null, role: "library", slug: "x" })).toBe(
      "tenants/t1/content/library/library-x.png"
    );
  });
});

describe("brandAssetPathname", () => {
  it("keeps brand inputs out of the content tree", () => {
    // Style reference images are brand INPUTS, not content output: they get no
    // content_images row and no piece, so they get their own prefix (product
    // owner decision 3).
    expect(brandAssetPathname({ tenantId: "t1", slug: "hero-illustration" })).toBe("tenants/t1/brand/hero-illustration.png");
  });

  it("stays inside the tenant prefix for a hostile file name", () => {
    const path = brandAssetPathname({ tenantId: "t1", slug: slugForImage("../../../etc/passwd") });
    expect(path.startsWith("tenants/t1/brand/")).toBe(true);
    expect(path).not.toContain("..");
  });
});

describe("validateUploadFile", () => {
  it("accepts png, jpeg and webp under the cap", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp"]) {
      expect(validateUploadFile({ type, size: 1024 })).toEqual({ ok: true });
    }
  });
  it("rejects other mime types with a readable error", () => {
    const result = validateUploadFile({ type: "image/gif", size: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/PNG, JPEG or WebP/);
  });
  it("rejects files over the 10 MB input cap", () => {
    const result = validateUploadFile({ type: "image/png", size: UPLOAD_MAX_BYTES + 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/10 MB/);
    expect(UPLOAD_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe("blobPathnameFromUrl", () => {
  it("recovers the pathname a blob URL was stored under", () => {
    expect(blobPathnameFromUrl("https://abc.public.blob.vercel-storage.com/tenants/t1/brand/a-b12ce.png")).toBe(
      "tenants/t1/brand/a-b12ce.png"
    );
  });
  it("passes a bare pathname through unchanged", () => {
    expect(blobPathnameFromUrl("tenants/t1/brand/a.png")).toBe("tenants/t1/brand/a.png");
  });
});

describe("slugForImage", () => {
  it("lowercases, hyphenates and clamps", () => {
    expect(slugForImage("A Lighthouse, Guiding Ships!")).toBe("a-lighthouse-guiding-ships");
    expect(slugForImage("   ")).toBe("image");
    expect(slugForImage("x".repeat(100))).toHaveLength(40);
  });

  it("cannot escape its directory: the slug is the ONLY caller-controlled part of a pathname", () => {
    // The concept, the piece title and an uploaded file's name all reach
    // `imagePathname` through this function. Slashes, dots and query characters
    // must not survive, or a crafted concept writes outside its tenant prefix.
    for (const hostile of ["../../etc/passwd", "..%2f..%2fsecret", "a/b/c", "x?y=z#frag", "\\windows\\system32"]) {
      const slug = slugForImage(hostile);
      expect(slug).toMatch(/^[a-z0-9-]+$/);
      expect(slug).not.toContain("..");
    }
  });

  it("keeps a hostile concept inside the tenant prefix once composed", () => {
    const path = imagePathname({ tenantId: "t1", contentPieceId: "p1", role: "body", slug: slugForImage("../../../x") });
    expect(path.startsWith("tenants/t1/content/p1/")).toBe(true);
    expect(path).not.toContain("..");
  });
});

describe("uploadPng", () => {
  it("puts a public, random-suffixed PNG and returns url + pathname", async () => {
    vi.mocked(put).mockResolvedValue({ url: "https://blob/x-abc.png", pathname: "tenants/t/x-abc.png" } as never);
    const png = Buffer.from("png");
    const result = await uploadPng("tenants/t/x.png", png);
    expect(put).toHaveBeenCalledWith("tenants/t/x.png", png, {
      access: "public",
      addRandomSuffix: true,
      contentType: "image/png",
    });
    expect(result).toEqual({ url: "https://blob/x-abc.png", pathname: "tenants/t/x-abc.png" });
  });
});

describe("deleteBlobs", () => {
  it("deletes in one call and is a no-op for an empty list", async () => {
    vi.mocked(del).mockResolvedValue(undefined as never);
    await deleteBlobs(["a.png", "b.png"]);
    expect(del).toHaveBeenCalledWith(["a.png", "b.png"]);
    await deleteBlobs([]);
    expect(del).toHaveBeenCalledTimes(1);
  });

  it("swallows and logs failures", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(del).mockRejectedValue(new Error("quota"));
    await expect(deleteBlobs(["a.png"])).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();
  });
});
