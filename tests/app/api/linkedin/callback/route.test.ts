import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "../../../../../src/db";
import { tenants, linkedinConnections } from "../../../../../src/db/schema";

vi.mock("../../../../../src/lib/workspace/session", () => ({ requireSession: vi.fn() }));
vi.mock("../../../../../src/lib/integrations/linkedin/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../src/lib/integrations/linkedin/client")>();
  return { ...actual, exchangeCode: vi.fn() };
});
import { requireSession } from "../../../../../src/lib/workspace/session";
import { exchangeCode } from "../../../../../src/lib/integrations/linkedin/client";
import { GET } from "../../../../../src/app/api/linkedin/callback/route";

const TENANT = "LinkedIn Callback Test Tenant";

async function seedTenant() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  return tenant.id;
}

describe("GET /api/linkedin/callback", () => {
  beforeEach(() => {
    vi.mocked(requireSession).mockReset();
    vi.mocked(exchangeCode).mockReset();
  });
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("rejects a state whose tenant does not match the session", async () => {
    const tenantId = await seedTenant();
    vi.mocked(requireSession).mockResolvedValue({ user: { tenantId } } as never);
    const req = new NextRequest("https://app/api/linkedin/callback?code=c&state=other|integrations");
    const res = await GET(req);
    expect(res.headers.get("location")).toContain("linkedin_connect=error");
  });

  it("exchanges the code and stores the connection", async () => {
    const tenantId = await seedTenant();
    vi.mocked(requireSession).mockResolvedValue({ user: { tenantId } } as never);
    vi.mocked(exchangeCode).mockResolvedValue({ accessToken: "at", refreshToken: "rt", expiresInSeconds: 3600 });
    const req = new NextRequest(`https://app/api/linkedin/callback?code=c&state=${tenantId}|integrations`);
    const res = await GET(req);
    expect(res.headers.get("location")).toContain("linkedin_connect=success");
    const [row] = await db.select().from(linkedinConnections).where(eq(linkedinConnections.tenantId, tenantId));
    expect(row.refreshTokenCiphertext).not.toBeNull();
    // Tokens must be stored encrypted, never in plaintext.
    expect(row.accessTokenCiphertext).not.toBeNull();
    expect(row.accessTokenCiphertext).not.toBe("at");
    expect(row.refreshTokenCiphertext).not.toBe("rt");
  });

  it("does not write any row when code is missing", async () => {
    const tenantId = await seedTenant();
    vi.mocked(requireSession).mockResolvedValue({ user: { tenantId } } as never);
    const req = new NextRequest(`https://app/api/linkedin/callback?state=${tenantId}|integrations`);
    const res = await GET(req);
    expect(res.headers.get("location")).toContain("linkedin_connect=error");
    const [row] = await db.select().from(linkedinConnections).where(eq(linkedinConnections.tenantId, tenantId));
    expect(row).toBeUndefined();
  });

  it("redirects to error, not a 500, when the code exchange throws", async () => {
    const tenantId = await seedTenant();
    vi.mocked(requireSession).mockResolvedValue({ user: { tenantId } } as never);
    vi.mocked(exchangeCode).mockRejectedValue(new Error("upstream failure"));
    const req = new NextRequest(`https://app/api/linkedin/callback?code=c&state=${tenantId}|integrations`);
    const res = await GET(req);
    expect(res.status).toBeLessThan(500);
    expect(res.headers.get("location")).toContain("linkedin_connect=error");
    const [row] = await db.select().from(linkedinConnections).where(eq(linkedinConnections.tenantId, tenantId));
    expect(row).toBeUndefined();
  });
});
