import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => undefined, set: () => {} })) }));
const readBrandAsset = vi.fn();
vi.mock("../../../../src/lib/images/blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/lib/images/blob")>();
  return { ...actual, readBrandAsset: (urlOrPathname: string) => readBrandAsset(urlOrPathname) };
});

import { getServerSession } from "next-auth";
import { db } from "../../../../src/db";
import { users, tenants, tenantMembers } from "../../../../src/db/schema";
import { GET } from "../../../../src/app/api/brand-assets/route";

const TENANT_NAME = "Brand Assets Route Test Tenant";
const OTHER_TENANT_NAME = "Brand Assets Route Other Tenant";
const emails = ["brand-assets-route-test@example.com"];

function getRequest(url?: string) {
  const params = url ? `?url=${encodeURIComponent(url)}` : "";
  return new Request(`http://x/api/brand-assets${params}`);
}

async function makeAuthedUserAndTenant() {
  const [user] = await db.insert(users).values({ email: emails[0] }).returning();
  const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
  await db.insert(tenantMembers).values({ tenantId: tenant.id, userId: user.id, role: "owner" });
  return { user, tenant };
}

beforeEach(() => {
  vi.mocked(getServerSession).mockReset();
  readBrandAsset.mockReset();
});

afterEach(async () => {
  const us = await db.select().from(users).where(inArray(users.email, emails));
  for (const u of us) {
    await db.delete(tenantMembers).where(eq(tenantMembers.userId, u.id));
    await db.delete(users).where(eq(users.id, u.id));
  }
  for (const name of [TENANT_NAME, OTHER_TENANT_NAME]) {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.name, name));
    if (tenant) await db.delete(tenants).where(eq(tenants.id, tenant.id));
  }
});

describe("GET /api/brand-assets", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null as never);
    const res = await GET(getRequest("https://x.private.blob.vercel-storage.com/tenants/t/brand/a.png"));
    expect(res.status).toBe(401);
    expect(readBrandAsset).not.toHaveBeenCalled();
  });

  it("returns 401 when the user has no membership", async () => {
    const [user] = await db.insert(users).values({ email: emails[0] }).returning();
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: user.id } } as never);
    const res = await GET(getRequest("https://x.private.blob.vercel-storage.com/tenants/t/brand/a.png"));
    expect(res.status).toBe(401);
    expect(readBrandAsset).not.toHaveBeenCalled();
  });

  it("returns 400 when no url param is given", async () => {
    const { user } = await makeAuthedUserAndTenant();
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: user.id } } as never);
    const res = await GET(getRequest());
    expect(res.status).toBe(400);
    expect(readBrandAsset).not.toHaveBeenCalled();
  });

  it("returns 404 and never reads the blob for a url outside this tenant's own brand prefix", async () => {
    // The security-critical check: array membership in styleReferenceImages
    // is not proof of ownership, and neither is a caller-supplied url alone
    // — the pathname must actually start with THIS tenant's own
    // tenants/{tenantId}/brand/ prefix before any read happens (mirrors
    // removeStyleReference's ownership check on delete).
    const { user } = await makeAuthedUserAndTenant();
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: user.id } } as never);

    const foreignUrl = "https://x.private.blob.vercel-storage.com/tenants/some-other-tenant/brand/logo.png";
    const res = await GET(getRequest(foreignUrl));

    expect(res.status).toBe(404);
    expect(readBrandAsset).not.toHaveBeenCalled();
  });

  it("returns 404 when the asset is not found", async () => {
    const { user, tenant } = await makeAuthedUserAndTenant();
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: user.id } } as never);
    readBrandAsset.mockResolvedValue(null);

    const url = `https://x.private.blob.vercel-storage.com/tenants/${tenant.id}/brand/gone.png`;
    const res = await GET(getRequest(url));

    expect(res.status).toBe(404);
    expect(readBrandAsset).toHaveBeenCalledWith(url);
  });

  it("streams the asset's bytes with its content type for a url this tenant owns", async () => {
    const { user, tenant } = await makeAuthedUserAndTenant();
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: user.id } } as never);
    readBrandAsset.mockResolvedValue({ bytes: Buffer.from("png-bytes"), contentType: "image/png" });

    const url = `https://x.private.blob.vercel-storage.com/tenants/${tenant.id}/brand/logo.png`;
    const res = await GET(getRequest(url));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("png-bytes");
  });
});
