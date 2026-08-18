import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, rejectedArticles } from "../../../src/db/schema";
import { seedTenant, dropTenant } from "../../helpers/fixtures";

const TENANT = "Rejected Articles Test Tenant";

afterEach(async () => {
  await dropTenant(TENANT);
});

describe("rejectedArticles", () => {
  it("treats a repeat rejection of the same url as a no-op", async () => {
    const tenant = await seedTenant(TENANT);
    const row = { tenantId: tenant.id, url: "https://a.example.com/x", title: "X", reason: "stale" as const };

    await db.insert(rejectedArticles).values(row);
    // The agent re-records on every run it sees the article again. This must
    // not raise — if it does, one repeat rejection kills a whole run.
    await db
      .insert(rejectedArticles)
      .values({ ...row, reason: "not_selected" as const })
      .onConflictDoNothing({ target: [rejectedArticles.tenantId, rejectedArticles.url] });

    const rows = await db.select().from(rejectedArticles).where(eq(rejectedArticles.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
    // First write wins: the conflict is ignored, not merged.
    expect(rows[0].reason).toBe("stale");
  });

  it("scopes a rejection to one tenant", async () => {
    const a = await seedTenant(TENANT);
    const [b] = await db.insert(tenants).values({ name: TENANT }).returning();

    await db.insert(rejectedArticles).values([
      { tenantId: a.id, url: "https://a.example.com/shared", title: "Shared", reason: "stale" },
      { tenantId: b.id, url: "https://a.example.com/shared", title: "Shared", reason: "stale" },
    ]);

    // The same article rejected by two tenants is two rows. A unique index on
    // url alone would let one tenant's judgement hide an article from another.
    const rows = await db.select().from(rejectedArticles).where(eq(rejectedArticles.tenantId, a.id));
    expect(rows).toHaveLength(1);
  });

  it("drops a tenant's rejections when the tenant is deleted", async () => {
    const tenant = await seedTenant(TENANT);
    await db
      .insert(rejectedArticles)
      .values({ tenantId: tenant.id, url: "https://a.example.com/y", title: "Y", reason: "not_selected" });

    await db.delete(tenants).where(eq(tenants.id, tenant.id));

    const rows = await db.select().from(rejectedArticles).where(eq(rejectedArticles.tenantId, tenant.id));
    expect(rows).toHaveLength(0);
  });
});
