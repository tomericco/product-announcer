import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../../src/db";
import { tenants, notionConnections } from "../../../../src/db/schema";
import { encryptSecret } from "../../../../src/lib/credentials/encryption";
import { NotionApiError } from "../../../../src/lib/integrations/notion/client";
import { withFreshToken } from "../../../../src/lib/integrations/notion/connection";

const TENANT = "Notion Connection Refresh Test Tenant";
process.env.CREDENTIALS_ENCRYPTION_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY ?? "a".repeat(64);

vi.mock("../../../../src/lib/integrations/notion/oauth", () => ({
  refreshAccessToken: vi.fn(),
}));
import { refreshAccessToken } from "../../../../src/lib/integrations/notion/oauth";

async function seedConnection(overrides: Partial<typeof notionConnections.$inferInsert> = {}) {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning({ id: tenants.id });
  const at = encryptSecret("old-access");
  const rt = encryptSecret("the-refresh");
  const [conn] = await db
    .insert(notionConnections)
    .values({
      tenantId: tenant.id,
      accessTokenCiphertext: at.ciphertext,
      accessTokenIv: at.iv,
      accessTokenAuthTag: at.authTag,
      refreshTokenCiphertext: rt.ciphertext,
      refreshTokenIv: rt.iv,
      refreshTokenAuthTag: rt.authTag,
      workspaceId: "ws-1",
      status: "active",
      ...overrides,
    })
    .returning();
  return conn;
}

describe("withFreshToken", () => {
  afterEach(async () => {
    vi.mocked(refreshAccessToken).mockReset();
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("passes the current access token when the call succeeds", async () => {
    const conn = await seedConnection();
    const result = await withFreshToken(db, conn, async (token) => token);
    expect(result).toBe("old-access");
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it("refreshes once on a 401 and retries with the new token", async () => {
    const conn = await seedConnection();
    vi.mocked(refreshAccessToken).mockResolvedValue({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      workspaceId: "ws-1",
      botId: null,
    });
    let calls = 0;
    const result = await withFreshToken(db, conn, async (token) => {
      calls += 1;
      if (calls === 1) throw new NotionApiError(401, "unauthorized");
      return token;
    });
    expect(result).toBe("new-access");
    expect(refreshAccessToken).toHaveBeenCalledWith("the-refresh");
    const [row] = await db.select().from(notionConnections).where(eq(notionConnections.id, conn.id));
    expect(row.status).toBe("active");
  });

  it("flips to needs_reauth and rethrows when the retry still 401s", async () => {
    const conn = await seedConnection();
    vi.mocked(refreshAccessToken).mockResolvedValue({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      workspaceId: "ws-1",
      botId: null,
    });
    await expect(
      withFreshToken(db, conn, async () => {
        throw new NotionApiError(401, "still unauthorized");
      })
    ).rejects.toBeInstanceOf(NotionApiError);
    const [row] = await db.select().from(notionConnections).where(eq(notionConnections.id, conn.id));
    expect(row.status).toBe("needs_reauth");
  });

  it("flips to needs_reauth immediately when there is no refresh token", async () => {
    const conn = await seedConnection({
      refreshTokenCiphertext: null,
      refreshTokenIv: null,
      refreshTokenAuthTag: null,
    });
    await expect(
      withFreshToken(db, conn, async () => {
        throw new NotionApiError(401, "unauthorized");
      })
    ).rejects.toBeInstanceOf(NotionApiError);
    expect(refreshAccessToken).not.toHaveBeenCalled();
    const [row] = await db.select().from(notionConnections).where(eq(notionConnections.id, conn.id));
    expect(row.status).toBe("needs_reauth");
  });
});
