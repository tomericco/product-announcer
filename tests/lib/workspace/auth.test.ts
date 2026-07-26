import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/lib/workspace/tenant-bootstrap", () => ({
  getOrCreateUserFromOAuth: vi.fn(),
}));

import { authOptions } from "../../../src/lib/workspace/auth";
import { getOrCreateUserFromOAuth } from "../../../src/lib/workspace/tenant-bootstrap";

describe("authOptions.callbacks.jwt", () => {
  beforeEach(() => {
    vi.mocked(getOrCreateUserFromOAuth).mockReset();
  });

  it("attaches tenant info to the token on first sign-in", async () => {
    vi.mocked(getOrCreateUserFromOAuth).mockResolvedValue({
      userId: "user-1",
      tenantId: "tenant-1",
      role: "owner",
    });

    const token = await authOptions.callbacks!.jwt!({
      token: {},
      account: { provider: "github" },
      profile: { id: 42, email: "tomer@frontitude.com", name: "Tomer" },
    } as unknown as Parameters<NonNullable<NonNullable<typeof authOptions.callbacks>["jwt"]>>[0]);

    expect(token.userId).toBe("user-1");
    expect(token.tenantId).toBe("tenant-1");
    expect(token.role).toBe("owner");
    expect(getOrCreateUserFromOAuth).toHaveBeenCalledWith({
      email: "tomer@frontitude.com",
      emailVerified: true,
      name: "Tomer",
      provider: "github",
      providerAccountId: "42",
    });
  });

  it("leaves the token unchanged when there is no account/profile", async () => {
    const existingToken = { userId: "user-1", tenantId: "tenant-1", role: "owner" as const };

    const token = await authOptions.callbacks!.jwt!({
      token: existingToken,
      account: null,
      profile: undefined,
    } as unknown as Parameters<NonNullable<NonNullable<typeof authOptions.callbacks>["jwt"]>>[0]);

    expect(token).toEqual(existingToken);
    expect(getOrCreateUserFromOAuth).not.toHaveBeenCalled();
  });
});
