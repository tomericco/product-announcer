import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants } from "../../src/db/schema";

describe("tenants table", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, "Test Tenant"));
  });

  it("round-trips an insert and a select", async () => {
    const [inserted] = await db.insert(tenants).values({ name: "Test Tenant" }).returning();

    const found = await db.select().from(tenants).where(eq(tenants.id, inserted.id));

    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("Test Tenant");
    expect(found[0].id).toBe(inserted.id);
  });
});
