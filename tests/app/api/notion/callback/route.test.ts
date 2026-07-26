import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../../../src/db";
import { tenants, notionConnections } from "../../../../../src/db/schema";
import { decryptSecret } from "../../../../../src/lib/credentials/encryption";

const TENANT = "Notion Callback Test Tenant";
let currentTenantId = "";
process.env.CREDENTIALS_ENCRYPTION_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY ?? "a".repeat(64);

vi.mock("../../../../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: "user-1" } })),
}));
vi.mock("../../../../../src/lib/integrations/notion/oauth", () => ({
  exchangeCode: vi.fn(async () => ({
    accessToken: "at",
    refreshToken: "rt",
    workspaceId: "ws-xyz",
    botId: "bot-1",
  })),
}));

import { GET } from "../../../../../src/app/api/notion/callback/route";

function request(params: Record<string, string>, cookieNonce?: string) {
  const url = new URL("https://app.example.com/api/notion/callback");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(
    url,
    cookieNonce ? { headers: { cookie: `notion_oauth_state=${cookieNonce}` } } : undefined
  );
}

describe("notion callback route", () => {
  beforeEach(async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning({ id: tenants.id });
    currentTenantId = tenant.id;
  });
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("stores an encrypted, misconfigured connection and redirects to integrations", async () => {
    const nonce = "abc123def456";
    const res = await GET(
      request({ code: "the-code", state: `${currentTenantId}|integrations|${nonce}` }, nonce) as never
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/integrations");

    const [conn] = await db.select().from(notionConnections).where(eq(notionConnections.tenantId, currentTenantId));
    expect(conn.status).toBe("misconfigured");
    expect(conn.workspaceId).toBe("ws-xyz");
    expect(conn.botId).toBe("bot-1");
    expect(decryptSecret({ ciphertext: conn.accessTokenCiphertext, iv: conn.accessTokenIv, authTag: conn.accessTokenAuthTag })).toBe("at");
    expect(conn.accessTokenCiphertext).not.toContain("at");
  });

  it("redirects with an error when state's tenant does not match the session", async () => {
    const nonce = "abc123def456";
    const res = await GET(request({ code: "c", state: `someone-else|integrations|${nonce}` }, nonce) as never);
    expect(res.headers.get("location")).toContain("notion_connect=error");
    const rows = await db.select().from(notionConnections).where(eq(notionConnections.tenantId, currentTenantId));
    expect(rows).toHaveLength(0);
  });

  it("redirects with an error when the state nonce does not match the cookie", async () => {
    const res = await GET(
      request({ code: "c", state: `${currentTenantId}|integrations|nonce-from-state` }, "different-cookie-nonce") as never
    );
    expect(res.headers.get("location")).toContain("notion_connect=error");
    const rows = await db.select().from(notionConnections).where(eq(notionConnections.tenantId, currentTenantId));
    expect(rows).toHaveLength(0);
  });
});
