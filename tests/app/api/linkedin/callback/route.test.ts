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

function request(params: Record<string, string>, cookieNonce?: string) {
  const url = new URL("https://app/api/linkedin/callback");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(
    url,
    cookieNonce ? { headers: { cookie: `linkedin_oauth_state=${cookieNonce}` } } : undefined
  );
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
    const nonce = "li-nonce-123";
    const req = request({ code: "c", state: `other|integrations|${nonce}` }, nonce);
    const res = await GET(req);
    expect(res.headers.get("location")).toContain("linkedin_connect=error");
  });

  it("exchanges the code and stores the connection when the nonce matches the cookie", async () => {
    const tenantId = await seedTenant();
    vi.mocked(requireSession).mockResolvedValue({ user: { tenantId } } as never);
    vi.mocked(exchangeCode).mockResolvedValue({ accessToken: "at", refreshToken: "rt", expiresInSeconds: 3600 });
    const nonce = "li-nonce-456";
    const req = request({ code: "c", state: `${tenantId}|integrations|${nonce}` }, nonce);
    const res = await GET(req);
    expect(res.headers.get("location")).toContain("linkedin_connect=success");
    const [row] = await db.select().from(linkedinConnections).where(eq(linkedinConnections.tenantId, tenantId));
    expect(row.refreshTokenCiphertext).not.toBeNull();
    // Tokens must be stored encrypted, never in plaintext.
    expect(row.accessTokenCiphertext).not.toBeNull();
    expect(row.accessTokenCiphertext).not.toBe("at");
    expect(row.refreshTokenCiphertext).not.toBe("rt");
    // The single-use state cookie must be cleared on the way out.
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("linkedin_oauth_state=");
    expect(setCookie).toMatch(/Max-Age=0/i);
  });

  it("redirects with error and does NOT store a connection when the nonce does not match the cookie", async () => {
    const tenantId = await seedTenant();
    vi.mocked(requireSession).mockResolvedValue({ user: { tenantId } } as never);
    const req = request(
      { code: "c", state: `${tenantId}|integrations|state-nonce` },
      "different-cookie-nonce"
    );
    const res = await GET(req);
    expect(res.headers.get("location")).toContain("linkedin_connect=error");
    const [row] = await db.select().from(linkedinConnections).where(eq(linkedinConnections.tenantId, tenantId));
    expect(row).toBeUndefined();
  });

  it("redirects with error and does NOT store a connection when there is no state cookie", async () => {
    const tenantId = await seedTenant();
    vi.mocked(requireSession).mockResolvedValue({ user: { tenantId } } as never);
    const req = request({ code: "c", state: `${tenantId}|integrations|state-nonce` });
    const res = await GET(req);
    expect(res.headers.get("location")).toContain("linkedin_connect=error");
    const [row] = await db.select().from(linkedinConnections).where(eq(linkedinConnections.tenantId, tenantId));
    expect(row).toBeUndefined();
  });

  it("surfaces a LinkedIn OAuth error via the reason param and stores nothing", async () => {
    const tenantId = await seedTenant();
    vi.mocked(requireSession).mockResolvedValue({ user: { tenantId } } as never);
    const nonce = "li-nonce-err";
    const req = request(
      {
        error: "unauthorized_scope_error",
        error_description: "Scope w_organization_social is not authorized for your application",
        state: `${tenantId}|integrations|${nonce}`,
      },
      nonce
    );
    const res = await GET(req);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("linkedin_connect")).toBe("error");
    // searchParams.get decodes the `+`-encoded spaces back to a readable reason.
    expect(location.searchParams.get("reason")).toContain("not authorized for your application");
    const [row] = await db.select().from(linkedinConnections).where(eq(linkedinConnections.tenantId, tenantId));
    expect(row).toBeUndefined();
  });

  it("does not write any row when code is missing", async () => {
    const tenantId = await seedTenant();
    vi.mocked(requireSession).mockResolvedValue({ user: { tenantId } } as never);
    const nonce = "li-nonce-789";
    const req = request({ state: `${tenantId}|integrations|${nonce}` }, nonce);
    const res = await GET(req);
    expect(res.headers.get("location")).toContain("linkedin_connect=error");
    const [row] = await db.select().from(linkedinConnections).where(eq(linkedinConnections.tenantId, tenantId));
    expect(row).toBeUndefined();
  });

  it("redirects to error, not a 500, when the code exchange throws", async () => {
    const tenantId = await seedTenant();
    vi.mocked(requireSession).mockResolvedValue({ user: { tenantId } } as never);
    vi.mocked(exchangeCode).mockRejectedValue(new Error("upstream failure"));
    const nonce = "li-nonce-abc";
    const req = request({ code: "c", state: `${tenantId}|integrations|${nonce}` }, nonce);
    const res = await GET(req);
    expect(res.status).toBeLessThan(500);
    expect(res.headers.get("location")).toContain("linkedin_connect=error");
    const [row] = await db.select().from(linkedinConnections).where(eq(linkedinConnections.tenantId, tenantId));
    expect(row).toBeUndefined();
  });
});
