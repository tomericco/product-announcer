import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, linkedinConnections } from "../../../src/db/schema";
import { encryptSecret, decryptSecret } from "../../../src/lib/credentials/encryption";
import { getValidAccessToken } from "../../../src/lib/integrations/linkedin/token";

vi.mock("../../../src/lib/integrations/linkedin/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/integrations/linkedin/client")>();
  return { ...actual, refreshAccessToken: vi.fn() };
});
import { refreshAccessToken } from "../../../src/lib/integrations/linkedin/client";

const TENANT = "LinkedIn Token Test Tenant";

function enc(value: string) {
  const p = encryptSecret(value);
  return { ciphertext: p.ciphertext, iv: p.iv, authTag: p.authTag };
}

async function seedConnection(overrides: Partial<typeof linkedinConnections.$inferInsert>) {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  const access = enc("current-token");
  const [row] = await db
    .insert(linkedinConnections)
    .values({
      tenantId: tenant.id,
      accessTokenCiphertext: access.ciphertext,
      accessTokenIv: access.iv,
      accessTokenAuthTag: access.authTag,
      expiresAt: new Date(Date.now() + 3600_000),
      ...overrides,
    })
    .returning();
  return row;
}

describe("getValidAccessToken", () => {
  beforeEach(() => vi.mocked(refreshAccessToken).mockReset());
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("returns the current token when not near expiry", async () => {
    const row = await seedConnection({});
    const token = await getValidAccessToken(row, db);
    expect(token).toBe("current-token");
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it("refreshes and persists when near expiry", async () => {
    const refresh = enc("refresh-token");
    const row = await seedConnection({
      expiresAt: new Date(Date.now() + 10_000),
      refreshTokenCiphertext: refresh.ciphertext,
      refreshTokenIv: refresh.iv,
      refreshTokenAuthTag: refresh.authTag,
    });
    vi.mocked(refreshAccessToken).mockResolvedValue({ accessToken: "fresh", refreshToken: null, expiresInSeconds: 3600 });
    const token = await getValidAccessToken(row, db);
    expect(token).toBe("fresh");
    const [persisted] = await db.select().from(linkedinConnections).where(eq(linkedinConnections.id, row.id));
    expect(decryptSecret({ ciphertext: persisted.accessTokenCiphertext, iv: persisted.accessTokenIv, authTag: persisted.accessTokenAuthTag })).toBe("fresh");
  });

  it("throws 401 when near expiry with no refresh token", async () => {
    const row = await seedConnection({ expiresAt: new Date(Date.now() + 10_000) });
    await expect(getValidAccessToken(row, db)).rejects.toMatchObject({ status: 401 });
  });
});
