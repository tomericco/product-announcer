import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, linkedinConnections, contentPieces } from "../../src/db/schema";

const TENANT = "LinkedIn Connections Schema Test Tenant";

async function seedTenant(): Promise<string> {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning({ id: tenants.id });
  return tenant.id;
}

describe("linkedin_connections schema", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("stores a connection with encrypted tokens and defaults", async () => {
    const tenantId = await seedTenant();
    const [row] = await db
      .insert(linkedinConnections)
      .values({
        tenantId,
        accessTokenCiphertext: "aa",
        accessTokenIv: "bb",
        accessTokenAuthTag: "cc",
        expiresAt: new Date(),
      })
      .returning();
    expect(row.status).toBe("active");
    expect(row.organizationUrn).toBeNull();
    expect(row.baseUrl).toBeNull();
    expect(row.refreshTokenCiphertext).toBeNull();
  });

  it("adds nullable linkedin copy columns to content_pieces", async () => {
    const tenantId = await seedTenant();
    const [row] = await db
      .insert(contentPieces)
      .values({ tenantId, title: "T", body: "B", status: "draft" })
      .returning({ linkedinBody: contentPieces.linkedinBody, linkedinBodyEditedAt: contentPieces.linkedinBodyEditedAt });
    expect(row.linkedinBody).toBeNull();
    expect(row.linkedinBodyEditedAt).toBeNull();
  });
});
