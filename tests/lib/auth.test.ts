import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/lib/tenant-bootstrap", () => ({
  getOrCreateTenantForUser: vi.fn(),
}));

import { authOptions } from "../../src/lib/auth";
import { getOrCreateTenantForUser } from "../../src/lib/tenant-bootstrap";

describe("authOptions.callbacks.jwt", () => {
  beforeEach(() => {
    vi.mocked(getOrCreateTenantForUser).mockReset();
  });

  it("attaches tenant info to the token on first sign-in", async () => {
    vi.mocked(getOrCreateTenantForUser).mockResolvedValue({
      userId: "user-1",
      tenantId: "tenant-1",
      role: "owner",
    });

    const token = await authOptions.callbacks!.jwt!({
      token: {},
      account: { provider: "github" },
      profile: { id: 42, email: "tomer@frontitude.com", name: "Tomer" },
    } as Parameters<NonNullable<NonNullable<typeof authOptions.callbacks>["jwt"]>>[0]);

    expect(token.userId).toBe("user-1");
    expect(token.tenantId).toBe("tenant-1");
    expect(token.role).toBe("owner");
    expect(getOrCreateTenantForUser).toHaveBeenCalledWith({
      email: "tomer@frontitude.com",
      name: "Tomer",
      githubId: "42",
    });
  });

  it("leaves the token unchanged when there is no account/profile", async () => {
    const existingToken = { userId: "user-1", tenantId: "tenant-1", role: "owner" as const };

    const token = await authOptions.callbacks!.jwt!({
      token: existingToken,
      account: null,
      profile: undefined,
    } as Parameters<NonNullable<NonNullable<typeof authOptions.callbacks>["jwt"]>>[0]);

    expect(token).toEqual(existingToken);
    expect(getOrCreateTenantForUser).not.toHaveBeenCalled();
  });
});
