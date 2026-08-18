import { describe, it, expect, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, competitors, sources, signals, companyProfiles } from "../../../src/db/schema";
import { runCompetitorSource } from "../../../src/lib/signals/competitor-agent";
import { extractBlocks } from "../../../src/lib/signals/agent-page";
import { MAX_TEXT_CHARS, type PageResult } from "../../../src/lib/workspace/fetch-page";

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
  truncated: false,
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

  it("dedupes across two sources that fetch the same agentUrl, so one page change yields one signal, not two", async () => {
    // The common configuration today: a competitor has no per-page .md
    // variant, so discovery resolves both a "Changelog" source and a "Blog"
    // source to the same site-wide llms.txt. Both get swept independently,
    // both fetch and diff the same text -- without keying externalId on the
    // fetched page rather than the source, this would write the same block
    // twice, once attributed to each source.
    // Not `seed()` -- it already inserts a source at
    // https://rival.com/changelog for this tenant, which would collide with
    // the sources this test creates below.
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    await db.insert(companyProfiles).values({
      tenantId: tenant.id,
      positioning: "Fast where incumbents are configurable.",
      topics: ["issue tracking"],
    });
    const [rival] = await db.insert(competitors).values({ tenantId: tenant.id, name: "Rival" }).returning();
    const sharedAgentUrl = "https://rival.com/llms.txt";
    const [changelogSource] = await db
      .insert(sources)
      .values({
        tenantId: tenant.id,
        type: "competitor_web",
        competitorId: rival.id,
        url: "https://rival.com/changelog",
        agentUrl: sharedAgentUrl,
        label: "Changelog",
      })
      .returning();
    const [blogSource] = await db
      .insert(sources)
      .values({
        tenantId: tenant.id,
        type: "competitor_web",
        competitorId: rival.id,
        url: "https://rival.com/blog",
        agentUrl: sharedAgentUrl,
        label: "Blog",
      })
      .returning();

    const deps = { score: scoreAll(0.9) };
    // Both sources baseline independently on their own first run.
    await runCompetitorSource(changelogSource, { ...deps, fetchPage: async () => body(V1) });
    await runCompetitorSource(blogSource, { ...deps, fetchPage: async () => body(V1) });

    // The page changes; both sources see the same new block on their next run.
    await runCompetitorSource(await reload(changelogSource.id), { ...deps, fetchPage: async () => body(V2) });
    await runCompetitorSource(await reload(blogSource.id), { ...deps, fetchPage: async () => body(V2) });

    const rows = await competitorSignals(tenant.id);
    expect(rows).toHaveLength(1);
  });

  describe("truncated pages (MAX_TEXT_CHARS)", () => {
    // FILLER_ENTRY blocks are used to build page text that overruns
    // MAX_TEXT_CHARS before being sliced down to exactly that length, the
    // same way fetchPageText truncates a real page -- so the slice is
    // guaranteed to land inside a block rather than neatly between two.
    const fillerEntry = (n: number) =>
      `## Entry ${n}\nPadding text for changelog entry number ${n} so it clears the block length floor with room to spare.`;

    function buildTruncatedFixture(prependBlock?: string): Extract<PageResult, { text: string }> {
      let raw = prependBlock ? `${prependBlock}\n\n` : "";
      let n = 0;
      while (raw.length < MAX_TEXT_CHARS + 1000) {
        raw += `${fillerEntry(n)}\n\n`;
        n++;
      }
      const text = raw.slice(0, MAX_TEXT_CHARS);
      // These fixtures build text well past MAX_TEXT_CHARS before slicing it
      // down, exactly mirroring how fetchPageText itself would have set
      // `truncated: true` on a page like this.
      return { text, html: text, finalUrl: "https://rival.com/llms-full.txt", contentType: "text/markdown", truncated: true };
    }

    it("drops the final block when the fetched text was truncated at MAX_TEXT_CHARS", async () => {
      const { source } = await seed();
      const page = buildTruncatedFixture();
      expect(page.text.length).toBe(MAX_TEXT_CHARS);
      const rawBlockCount = extractBlocks(page.text).length;

      await runCompetitorSource(source, { fetchPage: async () => page, score: scoreAll(0.9) });

      const after = await reload(source.id);
      const seen = (after.watermark as { seenHashes: string[] }).seenHashes;
      expect(seen).toHaveLength(rawBlockCount - 1);
    });

    it("does not produce a signal for the shifted tail fragment when a new entry is prepended before the next truncated fetch", async () => {
      const { tenant, source } = await seed();
      const page1 = buildTruncatedFixture();
      await runCompetitorSource(source, { fetchPage: async () => page1, score: scoreAll(0.9) });

      const page2 = buildTruncatedFixture("## New Entry\nA brand-new changelog entry that was just published.");
      const second = await runCompetitorSource(await reload(source.id), {
        fetchPage: async () => page2,
        score: scoreAll(0.9),
      });

      // Exactly the genuinely new entry -- not that plus a spurious signal
      // for the tail block whose fragment text shifted because the cutoff
      // moved.
      expect(second.written).toBe(1);
      const rows = await competitorSignals(tenant.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toContain("New Entry");
    });
  });

  describe("a page that lands at exactly MAX_TEXT_CHARS without being truncated", () => {
    // Deliberately built so text.length === MAX_TEXT_CHARS by coincidence
    // (like buildTruncatedFixture above) but truncated is explicitly false --
    // this page's genuine extracted text just happens to be exactly that
    // long. The old length === MAX_TEXT_CHARS check couldn't tell this apart
    // from a real truncation and would drop its final block on every run.
    const fillerEntry = (n: number) =>
      `## Filler ${n}\nPadding text for filler entry number ${n} so it clears the block length floor comfortably.`;

    function buildFillerRaw(): string {
      let raw = "";
      let n = 0;
      while (raw.length < MAX_TEXT_CHARS - 500) {
        raw += `${fillerEntry(n)}\n\n`;
        n++;
      }
      return raw;
    }

    // `fillerRaw` is shared verbatim across both fixtures below so the filler
    // blocks hash identically run to run -- only the final block's content
    // (and therefore its hash) actually changes between page1 and page2.
    function buildExactLengthFixture(fillerRaw: string, lastBlockText: string): Extract<PageResult, { text: string }> {
      const padCount = MAX_TEXT_CHARS - fillerRaw.length - lastBlockText.length - 1;
      const text = `${fillerRaw}${lastBlockText} ${"z".repeat(padCount)}`;
      return {
        text,
        html: text,
        finalUrl: "https://rival.com/llms-full.txt",
        contentType: "text/markdown",
        truncated: false,
      };
    }

    it("keeps a genuinely new final block instead of dropping it as if it were a truncation artifact", async () => {
      const { tenant, source } = await seed();
      const fillerRaw = buildFillerRaw();

      const page1 = buildExactLengthFixture(fillerRaw, "## Old Entry\nThe original last entry before anything changed.");
      expect(page1.text.length).toBe(MAX_TEXT_CHARS);
      await runCompetitorSource(source, { fetchPage: async () => page1, score: scoreAll(0.9) });

      const page2 = buildExactLengthFixture(fillerRaw, "## New Entry\nA brand new final entry that just got published.");
      expect(page2.text.length).toBe(MAX_TEXT_CHARS);
      const second = await runCompetitorSource(await reload(source.id), {
        fetchPage: async () => page2,
        score: scoreAll(0.9),
      });

      // This is the false positive the length-based check produced: a page
      // whose text coincidentally lands at exactly MAX_TEXT_CHARS, but whose
      // fetch never actually truncated it (page.truncated is false), must not
      // have its final block silently dropped. A genuinely new final block
      // here must still produce a signal.
      expect(second.written).toBe(1);
      const rows = await competitorSignals(tenant.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toContain("New Entry");
    });
  });

  it("keeps a block that appears on every run out of eviction, even though it was the oldest hash recorded (last-seen, not first-seen, ordering)", async () => {
    const { source } = await seed();
    const stickyBlockText = "## About\nWe ship changelog updates for this product regularly, every single week.";
    const stickyHash = extractBlocks(stickyBlockText)[0].hash;

    // Seed the watermark directly as if stickyHash was recorded on day one and
    // MAX_WATERMARK_HASHES - 1 filler hashes piled up after it since -- under
    // first-seen (insertion-order) eviction, stickyHash is the very first
    // entry and therefore the first one dropped once the cap is exceeded.
    const fillerHashes = Array.from({ length: 999 }, (_, i) => `filler-hash-${i}`);
    await db
      .update(sources)
      .set({ watermark: { seenHashes: [stickyHash, ...fillerHashes] } })
      .where(eq(sources.id, source.id));

    // This run's page repeats the sticky block (it's still on the page) plus
    // enough genuinely new blocks to push the watermark past its cap and
    // force an eviction.
    const newEntries = Array.from(
      { length: 50 },
      (_, i) => `## Entry ${i}\nA changelog entry padded out with enough text to clear the floor comfortably.`
    ).join("\n\n");
    const page = body(`${stickyBlockText}\n\n${newEntries}`);

    await runCompetitorSource(await reload(source.id), { fetchPage: async () => page, score: scoreAll(0.9) });

    const after = await reload(source.id);
    const seen = (after.watermark as { seenHashes: string[] }).seenHashes;
    expect(seen).toContain(stickyHash);
  });
});
