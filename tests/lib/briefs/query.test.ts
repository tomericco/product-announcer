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

  /**
   * An `ai_visibility` signal has no URL to link to — an engine's answer is
   * not a page — so the chip in a brief's evidence row can only show what this
   * select fetches. There is no second read to fall back on.
   */
  it("carries an ai_visibility signal's payload through, so the chip has something to show", async () => {
    const tenant = await seedTenant(TENANT);
    const brief = await seedBrief(tenant.id, { title: "Cites an engine" });
    const payload = {
      signalType: "gap_vs_competitor" as const,
      promptText: "best localization tools for design teams",
      engineLabel: "ChatGPT API + web search",
      runId: "44444444-4444-4444-8444-444444444444",
      runDate: "2026-08-17T00:00:00.000Z",
      samples: "0 of 3, two runs",
      excerpt: "For design teams, Lokalise and Phrase are the usual choices.",
      citedUrls: [{ url: "https://g2.com/x", domain: "g2.com", domainClass: "review" }],
    };
    const [signal] = await db
      .insert(signals)
      .values({
        tenantId: tenant.id,
        kind: "ai_visibility",
        externalId: "ai-visibility-brief-evidence-1",
        title: "Absent from 'best localization tools' on ChatGPT",
        occurredAt: new Date(),
        payload,
      })
      .returning();
    await db.insert(briefSignals).values({ briefId: brief.id, signalId: signal.id });

    const rows = await listBriefSignals(brief.id, tenant.id, db);

    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual(payload);
    // The four columns the row already carried are untouched — widening the
    // select must not have cost an existing caller anything.
    expect(rows[0].kind).toBe("ai_visibility");
    expect(rows[0].url).toBeNull();
    expect(rows[0].title).toBe("Absent from 'best localization tools' on ChatGPT");
  });

  it("hands every other kind a null payload rather than omitting the key", async () => {
    // `BriefEvidence` branches on `signal.payload` being truthy. An absent key
    // would work today and stop working the moment anything destructures it.
    const tenant = await seedTenant(TENANT);
    const brief = await seedBrief(tenant.id, { title: "Cites the news" });
    const [signal] = await db
      .insert(signals)
      .values({
        tenantId: tenant.id,
        kind: "market_news",
        externalId: "https://a.example.com/z",
        url: "https://a.example.com/z",
        title: "Ordinary evidence",
        occurredAt: new Date(),
      })
      .returning();
    await db.insert(briefSignals).values({ briefId: brief.id, signalId: signal.id });

    const [row] = await listBriefSignals(brief.id, tenant.id, db);

    expect(row).toHaveProperty("payload");
    expect(row.payload).toBeNull();
  });
});
