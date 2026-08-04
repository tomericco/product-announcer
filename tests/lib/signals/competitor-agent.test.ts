import { describe, it, expect, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, competitors, sources, signals, companyProfiles } from "../../../src/db/schema";
import { runCompetitorSource } from "../../../src/lib/signals/competitor-agent";
import type { PageResult } from "../../../src/lib/workspace/fetch-page";

/**
 * A `db`-shaped object whose `insert` throws for the Nth call against
 * `signals` (1-indexed) and otherwise delegates straight through to the real
 * `db`. Every other method (`select`, `update`, ...) is inherited from `db`'s
 * own prototype untouched, so callers besides the write-under-test (the
 * tenant/profile lookup, the source-row update) behave exactly as they do
 * against the real database.
 */
function dbWithFailingInsert(failOnCallNumber: number): typeof db {
  let calls = 0;
  const proxyDb = Object.assign(Object.create(Object.getPrototypeOf(db)), db) as typeof db;
  proxyDb.insert = ((table: unknown) => {
    if (table === signals) {
      calls++;
      if (calls === failOnCallNumber) {
        return {
          values: () => ({
            onConflictDoNothing: async () => {
              throw new Error("simulated write failure");
            },
          }),
        };
      }
    }
    return db.insert(table as Parameters<typeof db.insert>[0]);
  }) as typeof db.insert;
  return proxyDb;
}

const TENANT = "Competitor Agent Test Tenant";

const V1 = "## v2.3.0\nFixed a crash on load for large workspaces.";
const V2 = `## v2.4.0\nAdded SAML SSO for every plan.\n\n${V1}`;

const body = (text: string): PageResult => ({
  text,
  html: text,
  finalUrl: "https://rival.com/changelog.md",
  contentType: "text/markdown",
});

const scoreAll = (score: number | null) => async (items: unknown[]) =>
  (items as unknown[]).map(() => ({
    score,
    rationale: score === null ? "scoring failed" : "relevant",
    topics: [],
  }));

async function seed(agentUrl: string | null = "https://rival.com/changelog.md") {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  await db.insert(companyProfiles).values({
    tenantId: tenant.id,
    positioning: "Fast where incumbents are configurable.",
    topics: ["issue tracking"],
  });
  const [rival] = await db.insert(competitors).values({ tenantId: tenant.id, name: "Rival" }).returning();
  const [source] = await db
    .insert(sources)
    .values({
      tenantId: tenant.id,
      type: "competitor_web",
      competitorId: rival.id,
      url: "https://rival.com/changelog",
      agentUrl,
      label: "Rival changelog",
    })
    .returning();
  return { tenant, rival, source };
}

const reload = async (id: string) => (await db.select().from(sources).where(eq(sources.id, id)))[0];

async function competitorSignals(tenantId: string) {
  return db.select().from(signals).where(and(eq(signals.tenantId, tenantId), eq(signals.kind, "competitor_move")));
}

describe("runCompetitorSource", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("first run is a baseline: records blocks, writes no signals", async () => {
    const { tenant, source } = await seed();
    const result = await runCompetitorSource(source, {
      fetchPage: async () => body(V1),
      score: scoreAll(0.9),
    });

    expect(result.baseline).toBe(true);
    expect(result.written).toBe(0);
    expect(await competitorSignals(tenant.id)).toHaveLength(0);
    expect(await reload(source.id)).toHaveProperty("lastSuccessAt");
  });

  it("never calls score on a baseline run — locking in the control flow, not just its output", async () => {
    const { source } = await seed();
    const scoreSpy = vi.fn(scoreAll(0.9));

    const result = await runCompetitorSource(source, {
      fetchPage: async () => body(V1),
      score: scoreSpy,
    });

    expect(result.baseline).toBe(true);
    expect(scoreSpy).not.toHaveBeenCalled();
  });

  it("writes a signal only for the block that is new on the second run", async () => {
    const { tenant, source } = await seed();
    const deps = { score: scoreAll(0.9) };

    await runCompetitorSource(source, { ...deps, fetchPage: async () => body(V1) });
    const second = await runCompetitorSource(await reload(source.id), {
      ...deps,
      fetchPage: async () => body(V2),
    });

    expect(second.baseline).toBe(false);
    expect(second.written).toBe(1);

    const rows = await competitorSignals(tenant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toContain("v2.4.0");
    expect(rows[0].excerpt).toContain("SAML SSO");
    expect(rows[0].competitorId).toBe(source.competitorId);
    expect(rows[0].sourceId).toBe(source.id);
    expect(rows[0].url).toBe("https://rival.com/changelog");
  });

  it("writes nothing when the document has not changed", async () => {
    const { tenant, source } = await seed();
    const deps = { fetchPage: async () => body(V1), score: scoreAll(0.9) };

    await runCompetitorSource(source, deps);
    const second = await runCompetitorSource(await reload(source.id), deps);

    expect(second.written).toBe(0);
    expect(await competitorSignals(tenant.id)).toHaveLength(0);
  });

  it("drops new blocks below the relevance floor without writing them", async () => {
    const { tenant, source } = await seed();
    await runCompetitorSource(source, { fetchPage: async () => body(V1), score: scoreAll(0.9) });
    const second = await runCompetitorSource(await reload(source.id), {
      fetchPage: async () => body(V2),
      score: scoreAll(0.05),
    });

    expect(second.written).toBe(0);
    expect(second.dropped).toBe(1);
    expect(await competitorSignals(tenant.id)).toHaveLength(0);
  });

  it("WRITES unscored blocks — a scoring failure must stay visible, not vanish", async () => {
    const { tenant, source } = await seed();
    await runCompetitorSource(source, { fetchPage: async () => body(V1), score: scoreAll(0.9) });
    await runCompetitorSource(await reload(source.id), {
      fetchPage: async () => body(V2),
      score: scoreAll(null),
    });

    const [row] = await competitorSignals(tenant.id);
    expect(row.relevanceScore).toBeNull();
    expect(row.relevanceRationale).toMatch(/fail/i);
  });

  it("fetches agentUrl when present, and url when it is not", async () => {
    const { source } = await seed();
    const withAgent: string[] = [];
    await runCompetitorSource(source, {
      fetchPage: async (u: string) => {
        withAgent.push(u);
        return body(V1);
      },
      score: scoreAll(0.9),
    });
    expect(withAgent).toEqual(["https://rival.com/changelog.md"]);

    const { source: plain } = await seed(null);
    const withoutAgent: string[] = [];
    await runCompetitorSource(plain, {
      fetchPage: async (u: string) => {
        withoutAgent.push(u);
        return body(V1);
      },
      score: scoreAll(0.9),
    });
    expect(withoutAgent).toEqual(["https://rival.com/changelog"]);
  });

  it("marks the source failing and records the error when the fetch fails", async () => {
    const { tenant, source } = await seed();
    await runCompetitorSource(source, {
      fetchPage: async () => ({ error: "blocked" as const }),
      score: scoreAll(0.9),
    });

    const after = await reload(source.id);
    expect(after.status).toBe("failing");
    expect(after.lastError).toMatch(/blocked/);
    expect(after.lastRunAt).not.toBeNull();
    expect(after.lastSuccessAt).toBeNull();
    expect(await competitorSignals(tenant.id)).toHaveLength(0);
  });

  it("records a partial write failure without losing the surviving block, and keeps the failing block un-watermarked for retry", async () => {
    const BASE = "## v1.0.0\nInitial baseline release notes for the partial-write-failure test.";
    const TWO_NEW = `## v1.1.0\nFirst new feature block for the partial write failure test.\n\n## v1.2.0\nSecond new feature block for the partial write failure test.\n\n${BASE}`;

    const { tenant, source } = await seed();
    await runCompetitorSource(source, { fetchPage: async () => body(BASE), score: scoreAll(0.9) });

    const second = await runCompetitorSource(await reload(source.id), {
      fetchPage: async () => body(TWO_NEW),
      score: scoreAll(0.9),
      database: dbWithFailingInsert(1),
    });

    // One of the two new blocks threw on write; the other still landed.
    expect(second.written).toBe(1);
    expect(second.dropped).toBe(0);
    expect(await competitorSignals(tenant.id)).toHaveLength(1);

    const after = await reload(source.id);
    // The run itself succeeded (it fetched, extracted, scored) -- a write
    // failure is not a fetch failure, so this stays active with a fresh
    // lastSuccessAt, unlike the fetch-failure test above.
    expect(after.status).toBe("active");
    expect(after.lastSuccessAt).not.toBeNull();
    // ...but the failure must still be operator-visible, not just logged.
    expect(after.lastError).toMatch(/1 of 2/);
    // The baseline recorded 1 hash (BASE). Only the surviving new block may
    // be merged in -- if the failing block's hash had been marked "seen"
    // anyway, this would be 3, and that block's write would never be
    // retried, silently losing a competitor move for good.
    expect((after.watermark as { seenHashes: string[] }).seenHashes).toHaveLength(2);
  });

  it("clears failing status and lastError on the next successful run", async () => {
    const { source } = await seed();
    await runCompetitorSource(source, {
      fetchPage: async () => ({ error: "blocked" as const }),
      score: scoreAll(0.9),
    });
    await runCompetitorSource(await reload(source.id), {
      fetchPage: async () => body(V1),
      score: scoreAll(0.9),
    });

    const after = await reload(source.id);
    expect(after.status).toBe("active");
    expect(after.lastError).toBeNull();
    expect(after.lastSuccessAt).not.toBeNull();
  });
});
