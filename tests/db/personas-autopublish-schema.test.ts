import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, brandProfiles } from "../../src/db/schema";

describe("personas + auto-publish schema", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, "Personas Schema Test Tenant"));
  });

  it("stores structured personas as jsonb and defaults auto_publish to false", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "Personas Schema Test Tenant" }).returning();
    expect(tenant.autoPublish).toBe(false);

    const [profile] = await db
      .insert(brandProfiles)
      .values({
        tenantId: tenant.id,
        userPersonas: [{ name: "Eng managers", usage: "track shipped work", deliveredValue: "know what changed" }],
      })
      .returning();

    expect(profile.userPersonas).toEqual([
      { name: "Eng managers", usage: "track shipped work", deliveredValue: "know what changed" },
    ]);
  });
});
