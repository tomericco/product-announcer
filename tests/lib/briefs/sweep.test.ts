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

async function seedTenant(name: string = TENANT) {
  const [tenant] = await db.insert(tenants).values({ name }).returning();
  await db.insert(companyProfiles).values({ tenantId: tenant.id, topics: ["localization"] });
  return tenant;
}

type SeedBriefOptions = {
  status?: "new" | "accepted";
  origin?: "agent" | "manual";
  expiresAt?: Date | null;
};

async function seedBrief(tenantId: string, opts: SeedBriefOptions = {}) {
  const { status = "new", origin = "agent", expiresAt = null } = opts;
  const [b] = await db
    .insert(briefs)
    .values({
      tenantId,
      origin,
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
    const b = await seedBrief(tenant.id, { status: "new", expiresAt: past });

    await expireStaleBriefs({ database: db });

    const [after] = await db.select().from(briefs).where(eq(briefs.id, b.id));
    expect(after.status).toBe("expired");
  });

  it("leaves an undecided brief that has not expired", async () => {
    const tenant = await seedTenant(TENANT);
    const b = await seedBrief(tenant.id, { status: "new", expiresAt: future });

    await expireStaleBriefs({ database: db });

    const [after] = await db.select().from(briefs).where(eq(briefs.id, b.id));
    expect(after.status).toBe("new");
  });

  it("never touches a brief someone already acted on", async () => {
    const tenant = await seedTenant(TENANT);
    // Accepted long ago and long past its expiry: expiry is about undecided
    // work, and re-expiring a decision would rewrite history.
    const b = await seedBrief(tenant.id, { status: "accepted", expiresAt: past });

    await expireStaleBriefs({ database: db });

    const [after] = await db.select().from(briefs).where(eq(briefs.id, b.id));
    expect(after.status).toBe("accepted");
  });

  it("never expires a brief with no expiry date", async () => {
    const tenant = await seedTenant();
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const agentBrief = await seedBrief(tenant.id, { origin: "agent", expiresAt: past });
    const manualBrief = await seedBrief(tenant.id, { origin: "manual", expiresAt: null });

    const expired = await expireStaleBriefs({ database: db });
    expect(expired).toBe(1);

    const [agent] = await db.select().from(briefs).where(eq(briefs.id, agentBrief.id));
    const [manual] = await db.select().from(briefs).where(eq(briefs.id, manualBrief.id));
    expect(agent.status).toBe("expired");
    // A brief someone wrote by hand is a decision, not a proposal awaiting one.
    expect(manual.status).toBe("new");
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

  it("one tenant's failure does not stop the other's", async () => {
    const angry = await seedTenant(TENANT);
    const calm = await seedTenant(OTHER);
    const mine = new Set([angry.id, calm.id]);
    const seen: string[] = [];
    let thrownForMine = false;

    await expect(
      sweepIdeation({
        database: db,
        runFn: async (tenantId) => {
          // Throw for the FIRST of OUR OWN two tenants the sweep reaches,
          // whichever it is. Keying on call order alone breaks when other test
          // files' tenants are swept first; keying on a specific id makes the
          // test a coin flip on how two random UUIDs happen to sort. This does
          // neither.
          if (mine.has(tenantId) && !thrownForMine) {
            thrownForMine = true;
            throw new Error("boom");
          }
          seen.push(tenantId);
          return { proposed: 0, extended: 0, assessment: null };
        },
      })
    ).resolves.toBeUndefined();

    // With the per-tenant catch: one of ours throws, the other is recorded.
    // With a single catch around the whole loop: the throw aborts the loop
    // before the second of ours is reached, whichever order they came back in.
    expect(seen.filter((id) => mine.has(id))).toHaveLength(1);
  });
});
