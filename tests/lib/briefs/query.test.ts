import { describe, it, expect, afterEach } from "vitest";
import { db } from "../../../src/db";
import { tenants, briefs, briefSignals, signals } from "../../../src/db/schema";
import { listBriefSignals } from "../../../src/lib/briefs/query";
import { seedTenant, dropTenant } from "../../helpers/fixtures";

const TENANT = "Brief Query Test Tenant";

afterEach(async () => {
  await dropTenant(TENANT);
});

async function seedBrief(
  tenantId: string,
  overrides: Partial<typeof briefs.$inferInsert> = {}
) {
  const [brief] = await db
    .insert(briefs)
    .values({
      tenantId,
      origin: "agent",
      contentType: "blog_post",
      title: "A title",
      angle: "An angle",
      whyNow: "Because",
      suggestedChannel: "blog",
      score: 0.8,
      lastEvidenceAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
      ...overrides,
    })
    .returning();
  return brief;
}

/**
 * The evidence read the editor at `/briefs/[briefId]` uses — a targeted
 * single-brief read, replacing the join `listBriefs` used to carry for every
 * row in the list (nothing there read `.signals`).
 */
describe("listBriefSignals", () => {
  it("returns the signals cited by the brief", async () => {
    const tenant = await seedTenant(TENANT);
    const brief = await seedBrief(tenant.id);
    const [signal] = await db
      .insert(signals)
      .values({
        tenantId: tenant.id,
        kind: "market_news",
        externalId: "https://a.example.com/x",
        url: "https://a.example.com/x",
        title: "The evidence",
        occurredAt: new Date(),
      })
      .returning();
    await db.insert(briefSignals).values({ briefId: brief.id, signalId: signal.id });

    const rows = await listBriefSignals(brief.id, tenant.id, db);
    // The evidence is the point: it is what lets a human tell reasoning from
    // confabulation before accepting.
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("The evidence");
    expect(rows[0].url).toBe("https://a.example.com/x");
  });

  it("returns an empty list for an uncited brief", async () => {
    const tenant = await seedTenant(TENANT);
    const brief = await seedBrief(tenant.id, { title: "Uncited" });

    expect(await listBriefSignals(brief.id, tenant.id, db)).toEqual([]);
  });

  // GUARD: the brief id arrives from the URL and is untrusted. This must be
  // tenant-scoped in its own right, not merely inherited from a check made
  // before this function is ever called — asserted by id (real evidence
  // exists for the brief, and is withheld) rather than by an empty result
  // that could just as well mean "no evidence exists at all". Per the
  // standing rule: delete the tenant filter and re-run this to confirm it
  // fails.
  it("refuses another tenant's brief", async () => {
    const owner = await seedTenant(TENANT);
    const [attacker] = await db.insert(tenants).values({ name: TENANT }).returning();
    const brief = await seedBrief(owner.id, { title: "The victim's brief" });
    const [signal] = await db
      .insert(signals)
      .values({
        tenantId: owner.id,
        kind: "market_news",
        externalId: "https://a.example.com/y",
        url: "https://a.example.com/y",
        title: "The victim's evidence",
        occurredAt: new Date(),
      })
      .returning();
    await db.insert(briefSignals).values({ briefId: brief.id, signalId: signal.id });

    expect(await listBriefSignals(brief.id, attacker.id, db)).toEqual([]);
  });
});
