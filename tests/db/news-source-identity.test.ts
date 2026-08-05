import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, sources } from "../../src/db/schema";

const TENANT = "News Source Identity Test Tenant";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
});

async function seed() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  return tenant;
}

describe("null-url source identity", () => {
  it("permits only one news source per tenant", async () => {
    const tenant = await seed();

    await db.insert(sources).values({
      tenantId: tenant.id,
      type: "news",
      url: null,
      label: "Industry news",
    });

    await expect(
      db.insert(sources).values({
        tenantId: tenant.id,
        type: "news",
        url: null,
        label: "Industry news again",
      })
    ).rejects.toThrow();
  });

  it("still permits two competitor sources with distinct urls", async () => {
    const tenant = await seed();

    await db.insert(sources).values({
      tenantId: tenant.id,
      type: "competitor_web",
      url: "https://rival.example.com/changelog",
      label: "Rival changelog",
    });

    await expect(
      db.insert(sources).values({
        tenantId: tenant.id,
        type: "competitor_web",
        url: "https://rival.example.com/blog",
        label: "Rival blog",
      })
    ).resolves.toBeDefined();
  });
});
