import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { db } from "../../src/db";
import { competitors, signals, sources } from "../../src/db/schema";
import { seedTenant, dropTenant } from "../helpers/fixtures";
import { signalWindowStart } from "../../src/lib/signals/window";

/**
 * `loadSourceEvidence` — the read behind the Evidence dialog for the
 * link-backed signal kinds (`market_news`, `competitor_move`, `manual`).
 *
 * The scoping assertions mirror `signals-ai-visibility-evidence.test.ts` for
 * the same reason: the `signalId` comes off the browser, so the tenant, the
 * kind set and the 60-day window all have to live in the WHERE clause rather
 * than in a caller's guard.
 */
const TENANT = "Source Evidence Action Test Tenant";
const OTHER_TENANT = "Source Evidence Action Test Tenant (Other)";

let currentTenantId = "";
vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: "user-1" } })),
}));

import { loadSourceEvidence, safeHttpUrl } from "../../src/app/(dashboard)/signals/source-evidence-actions";

let counter = 0;

async function seedSignal(tenantId: string, overrides: Partial<typeof signals.$inferInsert> = {}) {
  const [signal] = await db
    .insert(signals)
    .values({
      tenantId,
      kind: "market_news",
      externalId: `source-evidence-${counter++}`,
      title: "Why localization budgets moved to design",
      url: "https://example.com/news/localization-budgets?utm_source=x",
      excerpt: "The first 500 characters of the article body.",
      occurredAt: new Date("2026-08-17T00:00:00.000Z"),
      relevanceScore: 0.82,
      relevanceRationale: "Names the buyer shift this company sells into.",
      topics: ["localization", "design ops"],
      ...overrides,
    })
    .returning();
  return signal;
}

beforeEach(() => {
  counter = 0;
});

afterEach(async () => {
  await dropTenant(TENANT);
  await dropTenant(OTHER_TENANT);
});

describe("loadSourceEvidence", () => {
  it("returns the article link a market_news signal was built from", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    const signal = await seedSignal(tenant.id);

    const view = await loadSourceEvidence(signal.id);

    expect(view).not.toBeNull();
    expect(view!.kindLabel).toBe("Market news");
    expect(view!.links).toEqual([
      {
        role: "article",
        label: "Article",
        url: "https://example.com/news/localization-budgets?utm_source=x",
        domain: "example.com",
      },
    ]);
    expect(view!.excerpt).toBe("The first 500 characters of the article body.");
    expect(view!.relevanceRationale).toBe("Names the buyer shift this company sells into.");
    expect(view!.topics).toEqual(["localization", "design ops"]);
  });

  it("adds the watched page as a second link for a competitor move, and names the competitor", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    const [competitor] = await db
      .insert(competitors)
      .values({ tenantId: tenant.id, name: "Lokalise" })
      .returning();
    const [source] = await db
      .insert(sources)
      .values({
        tenantId: tenant.id,
        type: "competitor_web",
        competitorId: competitor.id,
        url: "https://lokalise.com/changelog",
        // Preferred over `url`: it is the page the agent actually read.
        agentUrl: "https://lokalise.com/changelog.md",
        label: "Lokalise changelog",
      })
      .returning();

    const signal = await seedSignal(tenant.id, {
      kind: "competitor_move",
      url: "https://lokalise.com/changelog",
      // What `competitor-agent` recorded as `page.finalUrl` — the page the
      // fetch actually landed on, which is not the configured `url`.
      fetchedUrl: "https://lokalise.com/llms.txt",
      sourceId: source.id,
      competitorId: competitor.id,
    });

    const view = await loadSourceEvidence(signal.id);

    expect(view!.competitorName).toBe("Lokalise");
    expect(view!.links).toEqual([
      {
        role: "article",
        label: "Page that changed",
        url: "https://lokalise.com/changelog",
        domain: "lokalise.com",
      },
      {
        role: "source",
        // The signal's own fetchedUrl wins over the source's agentUrl: the
        // source can be reconfigured after the signal was written, and only
        // the signal knows what was read at the time.
        label: "Page fetched — Lokalise changelog",
        url: "https://lokalise.com/llms.txt",
        domain: "lokalise.com",
      },
    ]);
  });

  it("falls back to the source's agentUrl for a row written before fetchedUrl existed", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    const [source] = await db
      .insert(sources)
      .values({
        tenantId: tenant.id,
        type: "competitor_web",
        url: "https://lokalise.com/changelog",
        agentUrl: "https://lokalise.com/changelog.md",
        label: "Lokalise changelog",
      })
      .returning();

    const signal = await seedSignal(tenant.id, {
      kind: "competitor_move",
      url: "https://lokalise.com/changelog",
      fetchedUrl: null,
      sourceId: source.id,
    });

    const view = await loadSourceEvidence(signal.id);

    expect(view!.links.map((link) => link.url)).toEqual([
      "https://lokalise.com/changelog",
      "https://lokalise.com/changelog.md",
    ]);
  });

  it("returns no links for a manual signal filed without a url", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    const signal = await seedSignal(tenant.id, { kind: "manual", url: null });

    const view = await loadSourceEvidence(signal.id);

    expect(view!.links).toEqual([]);
  });

  it("drops a url that would not be safe to render as an href", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    // Parses as an ordinary URL with hostname `evil.com` — the reason the
    // scheme is checked rather than the host.
    const signal = await seedSignal(tenant.id, { url: "javascript://evil.com/%0aalert(1)" });

    const view = await loadSourceEvidence(signal.id);

    expect(view!.links).toEqual([]);
    expect(safeHttpUrl("javascript://evil.com/%0aalert(1)")).toBeNull();
    expect(safeHttpUrl("https://example.com")).toBe("https://example.com");
  });

  it("returns null for a shipped_work signal — that kind has its own drawer", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    const signal = await seedSignal(tenant.id, { kind: "shipped_work" });

    expect(await loadSourceEvidence(signal.id)).toBeNull();
  });

  it("returns null for another tenant's signal, undistinguished from a miss", async () => {
    const tenant = await seedTenant(TENANT);
    const other = await seedTenant(OTHER_TENANT);
    const signal = await seedSignal(other.id);
    currentTenantId = tenant.id;

    expect(await loadSourceEvidence(signal.id)).toBeNull();
    expect(await loadSourceEvidence("not-a-uuid")).toBeNull();
  });

  it("returns null for a signal that has aged out of the 60-day window", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    const aged = new Date(signalWindowStart(new Date()).getTime() - 24 * 60 * 60 * 1000);
    const signal = await seedSignal(tenant.id, { createdAt: aged });

    expect(await loadSourceEvidence(signal.id)).toBeNull();
  });
});
