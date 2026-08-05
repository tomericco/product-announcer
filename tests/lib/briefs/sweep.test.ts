import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, companyProfiles, briefs } from "../../../src/db/schema";
import { expireStaleBriefs, sweepIdeation } from "../../../src/lib/briefs/sweep";

const TENANT = "Brief Sweep Test Tenant";
const OTHER = "Brief Sweep Other Test Tenant";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
  await db.delete(tenants).where(eq(tenants.name, OTHER));
  vi.restoreAllMocks();
});

async function seedTenant(name: string) {
  const [tenant] = await db.insert(tenants).values({ name }).returning();
  await db.insert(companyProfiles).values({ tenantId: tenant.id, topics: ["localization"] });
  return tenant;
}

async function seedBrief(tenantId: string, status: "new" | "accepted", expiresAt: Date) {
  const [b] = await db
    .insert(briefs)
    .values({
      tenantId,
      origin: "agent",
      contentType: "blog_post",
      title: "T",
      angle: "A",
      whyNow: "W",
      suggestedChannel: "blog",
      keyPoints: ["One.", "Two.", "Three."],
      score: 0.5,
      status,
      lastEvidenceAt: new Date(),
      expiresAt,
    })
    .returning();
  return b;
}

const past = new Date(Date.now() - 86_400_000);
const future = new Date(Date.now() + 86_400_000);

describe("expireStaleBriefs", () => {
  it("expires an undecided brief past its expiry", async () => {
    const tenant = await seedTenant(TENANT);
    const b = await seedBrief(tenant.id, "new", past);

    await expireStaleBriefs({ database: db });

    const [after] = await db.select().from(briefs).where(eq(briefs.id, b.id));
    expect(after.status).toBe("expired");
  });

  it("leaves an undecided brief that has not expired", async () => {
    const tenant = await seedTenant(TENANT);
    const b = await seedBrief(tenant.id, "new", future);

    await expireStaleBriefs({ database: db });

    const [after] = await db.select().from(briefs).where(eq(briefs.id, b.id));
    expect(after.status).toBe("new");
  });

  it("never touches a brief someone already acted on", async () => {
    const tenant = await seedTenant(TENANT);
    // Accepted long ago and long past its expiry: expiry is about undecided
    // work, and re-expiring a decision would rewrite history.
    const b = await seedBrief(tenant.id, "accepted", past);

    await expireStaleBriefs({ database: db });

    const [after] = await db.select().from(briefs).where(eq(briefs.id, b.id));
    expect(after.status).toBe("accepted");
  });
});

// NOTE: this sweep reads the whole shared test database, and other test files
// insert tenants concurrently. Every assertion below is scoped to ids this test
// created — never to a raw call count.
describe("sweepIdeation", () => {
  it("runs ideation for a tenant that has a company profile", async () => {
    const tenant = await seedTenant(TENANT);
    const seen: string[] = [];

    await sweepIdeation({
      database: db,
      runFn: async (tenantId) => {
        seen.push(tenantId);
        return { proposed: 0, extended: 0, assessment: null };
      },
    });

    expect(seen).toContain(tenant.id);
  });

  it("one tenant's failure does not stop another's", async () => {
    const angry = await seedTenant(TENANT);
    const calm = await seedTenant(OTHER);
    const seen: string[] = [];

    await expect(
      sweepIdeation({
        database: db,
        runFn: async (tenantId) => {
          if (tenantId === angry.id) throw new Error("boom");
          seen.push(tenantId);
          return { proposed: 0, extended: 0, assessment: null };
        },
      })
    ).resolves.toBeUndefined();

    expect(seen).toContain(calm.id);
  });
});
