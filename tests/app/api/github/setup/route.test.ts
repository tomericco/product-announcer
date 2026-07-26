import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../../../src/db";
import { tenants } from "../../../../../src/db/schema";

const TENANT = "GitHub Setup Test Tenant";
let currentTenantId = "";

vi.mock("../../../../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: "user-1" } })),
}));

import { GET } from "../../../../../src/app/api/github/setup/route";

function request(params: Record<string, string>, cookieNonce?: string) {
  const url = new URL("https://app.example.com/api/github/setup");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(
    url,
    cookieNonce ? { headers: { cookie: `github_oauth_state=${cookieNonce}` } } : undefined
  );
}

describe("github setup route", () => {
  beforeEach(async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning({ id: tenants.id });
    currentTenantId = tenant.id;
  });
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("stores githubInstallationId and redirects success when the nonce matches the cookie", async () => {
    const nonce = "gh-nonce-123";
    const res = await GET(
      request(
        { installation_id: "999", state: `${currentTenantId}|integrations|${nonce}` },
        nonce
      ) as never
    );
    expect(res.headers.get("location")).toContain("github_connect=success");
    expect(res.headers.get("location")).toContain("/integrations");

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, currentTenantId));
    expect(tenant.githubInstallationId).toBe("999");
  });

  it("redirects with error and does NOT update when the nonce does not match the cookie", async () => {
    const res = await GET(
      request(
        { installation_id: "999", state: `${currentTenantId}|integrations|state-nonce` },
        "different-cookie-nonce"
      ) as never
    );
    expect(res.headers.get("location")).toContain("github_connect=error");

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, currentTenantId));
    expect(tenant.githubInstallationId).toBeNull();
  });

  it("redirects with error and does NOT update when there is no state cookie", async () => {
    const res = await GET(
      request({ installation_id: "999", state: `${currentTenantId}|integrations|state-nonce` }) as never
    );
    expect(res.headers.get("location")).toContain("github_connect=error");

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, currentTenantId));
    expect(tenant.githubInstallationId).toBeNull();
  });

  it("redirects with error when state's tenant does not match the session", async () => {
    const nonce = "gh-nonce-123";
    const res = await GET(
      request({ installation_id: "999", state: `someone-else|integrations|${nonce}` }, nonce) as never
    );
    expect(res.headers.get("location")).toContain("github_connect=error");

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, currentTenantId));
    expect(tenant.githubInstallationId).toBeNull();
  });
});
