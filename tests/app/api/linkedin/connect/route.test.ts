import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("../../../../../src/lib/workspace/session", () => ({ requireSession: vi.fn() }));

import { requireSession } from "../../../../../src/lib/workspace/session";
import { GET } from "../../../../../src/app/api/linkedin/connect/route";

function request() {
  return new NextRequest(new URL("https://app/api/linkedin/connect"));
}

describe("GET /api/linkedin/connect", () => {
  beforeEach(() => {
    vi.mocked(requireSession).mockReset();
    vi.stubEnv("LINKEDIN_CLIENT_ID", "client-123");
    vi.stubEnv("LINKEDIN_REDIRECT_URI", "https://app/api/linkedin/callback");
  });

  it("redirects to the LinkedIn authorize URL with a tenant-bound state and sets the nonce cookie", async () => {
    const tenantId = "tenant-abc";
    vi.mocked(requireSession).mockResolvedValue({ user: { tenantId } } as never);

    const res = await GET(request());

    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    const url = new URL(location!);
    expect(url.hostname).toBe("www.linkedin.com");
    const state = url.searchParams.get("state");
    expect(state).toBeTruthy();
    const [stateTenantId, returnTo, nonce] = state!.split("|");
    expect(stateTenantId).toBe(tenantId);
    expect(returnTo).toBe("integrations");
    expect(nonce).toBeTruthy();

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`linkedin_oauth_state=${nonce}`);
  });

  it("redirects to an error page when the LinkedIn client env is not configured", async () => {
    vi.stubEnv("LINKEDIN_CLIENT_ID", "");
    vi.stubEnv("LINKEDIN_REDIRECT_URI", "");
    vi.mocked(requireSession).mockResolvedValue({ user: { tenantId: "tenant-abc" } } as never);

    const res = await GET(request());

    expect(res.headers.get("location")).toContain("/integrations?linkedin_connect=error");
  });
});
