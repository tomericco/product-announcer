import { describe, it, expect, afterEach, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, signals, sources, companyProfiles, type Source } from "../../../src/db/schema";
import {
  runNewsSource,
  normalizeArticleUrl,
  SCORING_EXCERPT_CHARS,
  MAX_CANDIDATES_PER_RUN,
  MAX_TOPICS_PER_RUN,
  TAVILY_SCORE_FLOOR,
} from "../../../src/lib/signals/news-agent";
import type { PageResult } from "../../../src/lib/workspace/fetch-page";

const TENANT = "News Agent Test Tenant";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
  vi.restoreAllMocks();
});

async function seedTenant() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  return tenant;
}

function page(text: string, html = `<p>${text}</p>`): PageResult {
  return { text, html, finalUrl: "https://news.example.com/a", contentType: "text/html", truncated: false };
}

async function seedNewsSource(tenantId: string, topics: string[]): Promise<Source> {
  await db
    .insert(companyProfiles)
    .values({ tenantId, topics })
    .onConflictDoUpdate({ target: companyProfiles.tenantId, set: { topics } });

  const [source] = await db
    .insert(sources)
    .values({ tenantId, type: "news", url: null, label: "Industry news" })
    .returning();
  return source;
}

const hit = (url: string, title = "A headline", score = 0.9) => ({
  title,
  url,
  content: "Tavily's own extract of the article.",
  publishedAt: new Date("2026-08-04T09:00:00Z"),
  score,
});

describe("runNewsSource", () => {
  it("writes a market_news signal keyed on the article url", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);

    const result = await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({ hits: [hit("https://news.example.com/a")], credits: 1 }),
      fetchPage: vi.fn().mockResolvedValue(page("The full article body, fetched by us.")),
      select: vi
        .fn()
        .mockResolvedValue({ selections: [{ index: 0, score: 0.8, rationale: "on topic", topics: ["localization"] }] }),
    });

    expect(result.written).toBe(1);

    const rows = await db
      .select()
      .from(signals)
      .where(and(eq(signals.tenantId, tenant.id), eq(signals.kind, "market_news")));

    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe("https://news.example.com/a");
    expect(rows[0].url).toBe("https://news.example.com/a");
    expect(rows[0].sourceId).toBe(source.id);
    expect(rows[0].excerpt).toContain("fetched by us");
    expect(rows[0].occurredAt.toISOString()).toBe("2026-08-04T09:00:00.000Z");
  });

  it("uses the run time as occurredAt only when the article has no date", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);
    const before = new Date();

    await runNewsSource(source, {
      database: db,
      search: vi
        .fn()
        .mockResolvedValue({ hits: [{ ...hit("https://news.example.com/undated"), publishedAt: null }], credits: 1 }),
      fetchPage: vi.fn().mockResolvedValue(page("body")),
      select: vi.fn().mockResolvedValue({ selections: [{ index: 0, score: 0.8, rationale: "r", topics: [] }] }),
    });

    const [row] = await db
      .select()
      .from(signals)
      .where(and(eq(signals.tenantId, tenant.id), eq(signals.externalId, "https://news.example.com/undated")));

    expect(row.occurredAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it("falls back to Tavily's extract when our own fetch fails, rather than dropping the signal", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);

    const result = await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({ hits: [hit("https://news.example.com/paywalled")], credits: 1 }),
      fetchPage: vi.fn().mockResolvedValue({ error: "fetch-failed" as const }),
      select: vi.fn().mockResolvedValue({ selections: [{ index: 0, score: 0.8, rationale: "r", topics: [] }] }),
    });

    expect(result.written).toBe(1);
    const [row] = await db
      .select()
      .from(signals)
      .where(and(eq(signals.tenantId, tenant.id), eq(signals.externalId, "https://news.example.com/paywalled")));
    expect(row.excerpt).toContain("Tavily's own extract");
  });

  it("deduplicates one article returned by two different topic searches", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization", "translation"]);
    const fetchPage = vi.fn().mockResolvedValue(page("body"));
    const select = vi.fn().mockResolvedValue({ selections: [{ index: 0, score: 0.8, rationale: "r", topics: [] }] });

    const result = await runNewsSource(source, {
      database: db,
      // Same article, once per topic — with tracking params that differ.
      search: vi
        .fn()
        .mockResolvedValueOnce({ hits: [hit("https://news.example.com/dupe?utm_source=a")], credits: 1 })
        .mockResolvedValueOnce({ hits: [hit("https://news.example.com/dupe?utm_source=b")], credits: 1 }),
      fetchPage,
      select,
    });

    expect(result.written).toBe(1);
    // The saving that matters: the article is fetched once and reaches the
    // selector once, not twice.
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(select.mock.calls[0][0]).toHaveLength(1);
  });

  it("keeps the dated copy when the same article arrives dated from one topic and undated from another", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization", "translation"]);

    await runNewsSource(source, {
      database: db,
      // The undated copy arrives first. First-topic-wins would keep it and
      // silently convert a real publication date into run time.
      search: vi
        .fn()
        .mockResolvedValueOnce({
          hits: [{ ...hit("https://news.example.com/dated"), publishedAt: null }],
          credits: 1,
        })
        .mockResolvedValueOnce({ hits: [hit("https://news.example.com/dated")], credits: 1 }),
      fetchPage: vi.fn().mockResolvedValue(page("body")),
      select: vi.fn().mockResolvedValue({ selections: [{ index: 0, score: 0.8, rationale: "r", topics: [] }] }),
    });

    const [row] = await db
      .select()
      .from(signals)
      .where(and(eq(signals.tenantId, tenant.id), eq(signals.externalId, "https://news.example.com/dated")));
    expect(row.occurredAt.toISOString()).toBe("2026-08-04T09:00:00.000Z");
  });

  it("caps how much article text reaches the selector while the excerpt keeps using the full body", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);
    // Longer than SCORING_EXCERPT_CHARS. Uncapped, a full run's worth —
    // MAX_CANDIDATES_PER_RUN (20) bodies — is paid for on every tenant every
    // day, and the tail is boilerplate that dilutes the judgement. The
    // selection pass also fails *closed*, so anything that makes the call more
    // likely to fail costs the whole day's news.
    const body = "x".repeat(SCORING_EXCERPT_CHARS + 5_000);
    const select = vi.fn().mockResolvedValue({ selections: [{ index: 0, score: 0.8, rationale: "r", topics: [] }] });

    await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({ hits: [hit("https://news.example.com/long")], credits: 1 }),
      fetchPage: vi.fn().mockResolvedValue(page(body)),
      select,
    });

    expect(select.mock.calls[0][0][0].text).toHaveLength(SCORING_EXCERPT_CHARS);

    const [row] = await db
      .select()
      .from(signals)
      .where(and(eq(signals.tenantId, tenant.id), eq(signals.externalId, "https://news.example.com/long")));
    expect(row.excerpt).toHaveLength(500);
  });

  it("fetches articles in bounded batches rather than all at once", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);

    let inFlight = 0;
    let peak = 0;
    const fetchPage = vi.fn().mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return page("body");
    });

    const hits = Array.from({ length: 20 }, (_, i) => hit(`https://news.example.com/a${i}`));

    await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({ hits, credits: 1 }),
      fetchPage,
      select: vi
        .fn()
        .mockResolvedValue({ selections: hits.map((_, i) => ({ index: i, score: 0.8, rationale: "r", topics: [] })) }),
    });

    expect(fetchPage).toHaveBeenCalledTimes(20);
    // Each concurrent fetchPageText buffers up to 2MB; MAX_CANDIDATES_PER_RUN
    // (20) at once is the worst case a full run can reach.
    expect(peak).toBeLessThanOrEqual(8);
  });

  it("skips articles already held as signals without refetching or rescoring them", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);

    await db.insert(signals).values({
      tenantId: tenant.id,
      sourceId: source.id,
      kind: "market_news",
      externalId: "https://news.example.com/known",
      title: "Already have this",
      occurredAt: new Date("2026-08-01T00:00:00Z"),
    });

    const fetchPage = vi.fn().mockResolvedValue(page("body"));
    const select = vi.fn().mockResolvedValue({ selections: [] });

    const result = await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({ hits: [hit("https://news.example.com/known")], credits: 1 }),
      fetchPage,
      select,
    });

    expect(result.skipped).toBe(1);
    expect(result.written).toBe(0);
    expect(fetchPage).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it("records a search failure on the source without throwing, and marks it failing when every search failed", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);

    const result = await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({ error: "request-failed" as const }),
      fetchPage: vi.fn(),
      select: vi.fn(),
    });

    expect(result.written).toBe(0);
    const [row] = await db.select().from(sources).where(eq(sources.id, source.id));
    expect(row.lastError).toContain("request-failed");
    expect(row.lastRunAt).not.toBeNull();
    // The run reached nothing at all, so this one really is failing.
    expect(row.status).toBe("failing");
    expect(row.lastSuccessAt).toBeNull();
  });

  it("stays active when only some searches failed, matching the competitor agent's ruling", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization", "translation"]);

    const result = await runNewsSource(source, {
      database: db,
      search: vi
        .fn()
        .mockResolvedValueOnce({ error: "request-failed" as const })
        .mockResolvedValueOnce({ hits: [hit("https://news.example.com/partial")], credits: 1 }),
      fetchPage: vi.fn().mockResolvedValue(page("body")),
      select: vi.fn().mockResolvedValue({ selections: [{ index: 0, score: 0.8, rationale: "r", topics: [] }] }),
    });

    expect(result.written).toBe(1);
    const [row] = await db.select().from(sources).where(eq(sources.id, source.id));
    // A run that wrote a signal did its job. Both cards render the same badge,
    // so "Failing" here would mean something different than it does on the
    // competitor card. The partial failure surfaces in lastError instead.
    expect(row.status).toBe("active");
    expect(row.lastSuccessAt).not.toBeNull();
    expect(row.lastError).toContain("request-failed");
  });

  it("stays active on a clean run that simply found nothing new", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);

    await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({ hits: [], credits: 1 }),
      fetchPage: vi.fn(),
      select: vi.fn(),
    });

    const [row] = await db.select().from(sources).where(eq(sources.id, source.id));
    expect(row.status).toBe("active");
    expect(row.lastError).toBeNull();
    expect(row.lastSuccessAt).not.toBeNull();
  });

  it("does nothing and records a clear reason when the tenant has no topics", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, []);
    const search = vi.fn();

    const result = await runNewsSource(source, { database: db, search, fetchPage: vi.fn(), select: vi.fn() });

    expect(result.written).toBe(0);
    expect(search).not.toHaveBeenCalled();
    const [row] = await db.select().from(sources).where(eq(sources.id, source.id));
    expect(row.lastError).toContain("no topics");
    // Nothing to search means the run accomplished nothing — the one other
    // case that genuinely warrants the failing badge.
    expect(row.status).toBe("failing");
    expect(row.lastSuccessAt).toBeNull();
  });

  it("bounds how many topic searches one run performs", async () => {
    const tenant = await seedTenant();
    // Derived from the constant, never hardcoded. The previous fixture seeded
    // seven topics and asserted five searches, which silently encoded "the cap
    // is at most 7" — raising the cap to 10 broke it. Both numbers now move
    // with the constant, so the test asserts that the cap BINDS rather than
    // asserting what the cap happens to be.
    const topics = Array.from({ length: MAX_TOPICS_PER_RUN + 3 }, (_, i) => `topic-${i}`);
    const source = await seedNewsSource(tenant.id, topics);
    const search = vi.fn().mockResolvedValue({ hits: [], credits: 1 });

    await runNewsSource(source, { database: db, search, fetchPage: vi.fn(), select: vi.fn() });

    expect(search).toHaveBeenCalledTimes(MAX_TOPICS_PER_RUN);
    // And the ones it did search are the profile's first N, in order.
    expect(search.mock.calls.map((c) => c[0])).toEqual(topics.slice(0, MAX_TOPICS_PER_RUN));
  });

  it("writes at most MAX_SIGNALS_PER_RUN signals however many clear the bar", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);
    const hits = Array.from({ length: 12 }, (_, i) => hit(`https://news.example.com/a${i}`));

    const result = await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({ hits, credits: 1 }),
      fetchPage: vi.fn().mockResolvedValue(page("body")),
      // The selector is capped internally; this asserts the agent honours it.
      select: vi.fn().mockResolvedValue({
        selections: Array.from({ length: 5 }, (_, i) => ({
          index: i,
          score: 0.8,
          rationale: "r",
          topics: [],
        })),
      }),
    });

    expect(result.written).toBe(5);
    const rows = await db
      .select()
      .from(signals)
      .where(and(eq(signals.tenantId, tenant.id), eq(signals.kind, "market_news")));
    expect(rows).toHaveLength(5);
  });

  it("writes nothing and marks the source failing when selection fails", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);

    const result = await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({ hits: [hit("https://news.example.com/a")], credits: 1 }),
      fetchPage: vi.fn().mockResolvedValue(page("body")),
      select: vi.fn().mockResolvedValue({ error: "Error: rate limited" }),
    });

    expect(result.written).toBe(0);
    const rows = await db
      .select()
      .from(signals)
      .where(and(eq(signals.tenantId, tenant.id), eq(signals.kind, "market_news")));
    expect(rows).toHaveLength(0);

    const [row] = await db.select().from(sources).where(eq(sources.id, source.id));
    expect(row.status).toBe("failing");
    expect(row.lastError).toContain("rate limited");
  });

  it("drops candidates below the Tavily score floor before fetching them", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);
    const fetchPage = vi.fn().mockResolvedValue(page("body"));
    const select = vi.fn().mockResolvedValue({ selections: [] });

    await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({
        hits: [
          hit("https://news.example.com/strong", "Strong", 0.9),
          hit("https://news.example.com/weak", "Weak", 0.001),
        ],
        credits: 1,
      }),
      fetchPage,
      select,
    });

    const fetched = fetchPage.mock.calls.map((c) => c[0]);
    expect(fetched).toContain("https://news.example.com/strong");
    expect(fetched).not.toContain("https://news.example.com/weak");
  });

  it("caps how many candidates reach the fetch stage, keeping the highest scored", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);
    const fetchPage = vi.fn().mockResolvedValue(page("body"));
    // 30 candidates, all above the floor, with ascending scores. Derived from
    // the constant, never hardcoded: the previous fixture started at a literal
    // 0.3, which silently encoded "the floor is at most 0.3" and became an
    // exact boundary case the moment the floor was raised to that value.
    const hits = Array.from({ length: 30 }, (_, i) =>
      hit(`https://news.example.com/c${i}`, `C${i}`, TAVILY_SCORE_FLOOR + 0.01 + i * 0.02)
    );

    await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({ hits, credits: 1 }),
      fetchPage,
      select: vi.fn().mockResolvedValue({ selections: [] }),
    });

    expect(fetchPage.mock.calls).toHaveLength(MAX_CANDIDATES_PER_RUN);
    // The highest-scored candidate must survive the truncation.
    expect(fetchPage.mock.calls.map((c) => c[0])).toContain("https://news.example.com/c29");
  });

  it("passes recently-held titles to the selector so novelty can be judged", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);

    await db.insert(signals).values({
      tenantId: tenant.id,
      sourceId: source.id,
      kind: "market_news",
      externalId: "https://news.example.com/old",
      title: "A story we already covered",
      occurredAt: new Date(),
    });

    const select = vi.fn().mockResolvedValue({ selections: [] });
    await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({ hits: [hit("https://news.example.com/new")], credits: 1 }),
      fetchPage: vi.fn().mockResolvedValue(page("body")),
      select,
    });

    const recentTitles = select.mock.calls[0][2] as string[];
    expect(recentTitles).toContain("A story we already covered");
  });

  it("maps a selection index to the candidate at that RANK, not its arrival order", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);

    // `fresh` is sorted by score before `candidates` is built, so
    // `selection.index` is rank order, not arrival order. Arrival here is
    // [low, high, mid]; rank is [high, mid, low], so index 1 is "mid" only if
    // the mapping follows the sort. Every other test in this file uses one
    // uniform score, so a refactor that built `candidates` from
    // `byUrl.values()`, or that sorted after mapping, would pass all of them
    // while writing every row's url, title, rationale and excerpt against the
    // wrong article.
    const hits = [
      hit("https://news.example.com/low", "Low", 0.3),
      hit("https://news.example.com/high", "High", 0.95),
      hit("https://news.example.com/mid", "Mid", 0.6),
    ];

    const select = vi.fn().mockResolvedValue({
      selections: [{ index: 1, score: 0.8, rationale: "the middle-ranked one", topics: ["localization"] }],
    });

    const result = await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({ hits, credits: 1 }),
      fetchPage: vi.fn().mockImplementation(async (url: string) => page(`Body of ${url}`)),
      select,
    });

    expect(select.mock.calls[0][0].map((c: { url: string }) => c.url)).toEqual([
      "https://news.example.com/high",
      "https://news.example.com/mid",
      "https://news.example.com/low",
    ]);

    expect(result.written).toBe(1);
    const rows = await db
      .select()
      .from(signals)
      .where(and(eq(signals.tenantId, tenant.id), eq(signals.kind, "market_news")));

    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe("https://news.example.com/mid");
    expect(rows[0].title).toBe("Mid");
    expect(rows[0].relevanceRationale).toBe("the middle-ranked one");
    // The body comes from a parallel array indexed the same way, so it catches
    // the same class of mistake independently.
    expect(rows[0].excerpt).toContain("https://news.example.com/mid");
  });

  it("keeps a scoreless hit past the floor but ranks it last", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);
    const select = vi.fn().mockResolvedValue({ selections: [] });

    await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({
        hits: [
          // Tavily gave no score at all. Treating that as 0 would put it below
          // TAVILY_SCORE_FLOOR and drop it — so a benign upstream rename of
          // `score` would empty this agent permanently behind a green badge.
          { ...hit("https://news.example.com/unscored", "Unscored"), score: null },
          hit("https://news.example.com/scored", "Scored", 0.5),
        ],
        credits: 1,
      }),
      fetchPage: vi.fn().mockResolvedValue(page("body")),
      select,
    });

    expect(select.mock.calls[0][0].map((c: { url: string }) => c.url)).toEqual([
      "https://news.example.com/scored",
      "https://news.example.com/unscored",
    ]);
  });

  it("records that every candidate was filtered out rather than reporting a clean run", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);
    const select = vi.fn();

    await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({
        hits: [
          // Just under the floor, derived from it. Hardcoded values here would
          // stop exercising the filter the moment the floor moved.
          hit("https://news.example.com/w1", "Weak one", TAVILY_SCORE_FLOOR - 0.02),
          hit("https://news.example.com/w2", "Weak two", TAVILY_SCORE_FLOOR - 0.01),
        ],
        credits: 1,
      }),
      fetchPage: vi.fn(),
      select,
    });

    expect(select).not.toHaveBeenCalled();
    const [row] = await db.select().from(sources).where(eq(sources.id, source.id));
    // A null lastError here is indistinguishable from a genuinely quiet day,
    // which is how a permanently-dead agent stays invisible.
    expect(row.lastError).toContain("2 candidates were below the relevance floor");
  });

  it("dates a signal from the article's own HTML when the index gave none", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);

    await runNewsSource(source, {
      database: db,
      // General-index results are always undated.
      search: vi.fn().mockResolvedValue({
        hits: [{ ...hit("https://phrase.com/blog/guide", "A guide", 0.8), publishedAt: null }],
        credits: 1,
      }),
      fetchPage: vi.fn().mockResolvedValue(
        page("body", `<meta property="article:published_time" content="${new Date(Date.now() - 86_400_000).toISOString()}">`)
      ),
      select: vi.fn().mockResolvedValue({
        selections: [{ index: 0, score: 0.8, rationale: "r", topics: [] }],
      }),
    });

    const [row] = await db
      .select()
      .from(signals)
      .where(and(eq(signals.tenantId, tenant.id), eq(signals.kind, "market_news")));
    // Yesterday, from the page — not the run time.
    expect(Date.now() - row.occurredAt.getTime()).toBeGreaterThan(60_000);
  });

  it("drops an article whose page date is older than the recency window", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);
    const select = vi.fn().mockResolvedValue({ selections: [] });

    const result = await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({
        hits: [{ ...hit("https://example.com/ancient", "Ancient", 0.9), publishedAt: null }],
        credits: 1,
      }),
      fetchPage: vi.fn().mockResolvedValue(
        page("body", `<meta property="article:published_time" content="2024-01-01T00:00:00Z">`)
      ),
      select,
    });

    expect(result.stale).toBe(1);
    // The stale article never reaches the model: `select` is still invoked
    // (its own empty-candidates short-circuit is what avoids the model call),
    // but with nothing left to judge.
    expect(select.mock.calls[0][0]).toHaveLength(0);
  });

  it("records why a run that found only stale articles produced nothing", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);

    await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({
        hits: [{ ...hit("https://example.com/old", "Old", 0.9), publishedAt: null }],
        credits: 1,
      }),
      fetchPage: vi.fn().mockResolvedValue(
        page("body", `<meta property="article:published_time" content="2024-01-01T00:00:00Z">`)
      ),
      select: vi.fn().mockResolvedValue({ selections: [] }),
    });

    const [row] = await db.select().from(sources).where(eq(sources.id, source.id));
    expect(row.lastError).toContain("older than");
  });

  it("keeps an undated article rather than dropping it", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);
    const select = vi.fn().mockResolvedValue({ selections: [] });

    const result = await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({
        hits: [{ ...hit("https://phrase.com/blog/guide", "Undated guide", 0.8), publishedAt: null }],
        credits: 1,
      }),
      // No date metadata anywhere.
      fetchPage: vi.fn().mockResolvedValue(page("body", "<p>no date</p>")),
      select,
    });

    expect(result.stale).toBe(0);
    // Kept: dropping undated articles would discard most professional writing,
    // which is the content this change exists to surface.
    expect(select.mock.calls[0][0]).toHaveLength(1);
  });

  it("ranks dated articles ahead of undated ones for the selector", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);
    const select = vi.fn().mockResolvedValue({ selections: [] });
    const recent = new Date(Date.now() - 86_400_000).toISOString();

    await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({
        hits: [
          // Higher Tavily score but undated.
          { ...hit("https://example.com/undated", "Undated", 0.9), publishedAt: null },
          // Lower score but carries a real date.
          { ...hit("https://example.com/dated", "Dated", 0.4), publishedAt: null },
        ],
        credits: 1,
      }),
      fetchPage: vi.fn().mockImplementation(async (url: string) =>
        url.includes("/dated")
          ? page("body", `<meta property="article:published_time" content="${recent}">`)
          : page("body", "<p>no date</p>")
      ),
      select,
    });

    const candidates = select.mock.calls[0][0] as { url: string }[];
    expect(candidates[0].url).toBe("https://example.com/dated");
    expect(candidates[1].url).toBe("https://example.com/undated");
  });

  it("writes the article the selector actually chose after the dated-first sort reorders them", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);
    const recent = new Date(Date.now() - 86_400_000).toISOString();

    // The hazard this covers: `kept` is sorted, while `fresh` and `bodies` stay
    // in pre-sort order. Every other test either has one candidate, or a sort
    // that is a no-op, or an empty selection — so a write loop that indexed
    // `fresh[selection.index]` would pass all of them while attaching one
    // article's url, title and rationale to another article's row.
    //
    // Here the DATED article has the LOWER Tavily score, so the dated-first
    // tiebreak genuinely reverses the order: arrival and score rank both put
    // "undated" at index 0, the sort puts "dated" there.
    const select = vi.fn().mockResolvedValue({
      selections: [{ index: 0, score: 0.8, rationale: "the dated one", topics: ["localization"] }],
    });

    const result = await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({
        hits: [
          { ...hit("https://example.com/undated", "Undated", 0.9), publishedAt: null },
          { ...hit("https://example.com/dated", "Dated", 0.4), publishedAt: null },
        ],
        credits: 1,
      }),
      fetchPage: vi.fn().mockImplementation(async (url: string) =>
        url.includes("/dated")
          ? page(`Body of ${url}`, `<meta property="article:published_time" content="${recent}">`)
          : page(`Body of ${url}`, "<p>no date</p>")
      ),
      select,
    });

    expect(result.written).toBe(1);
    const rows = await db
      .select()
      .from(signals)
      .where(and(eq(signals.tenantId, tenant.id), eq(signals.kind, "market_news")));

    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe("https://example.com/dated");
    expect(rows[0].title).toBe("Dated");
    expect(rows[0].relevanceRationale).toBe("the dated one");
    // The body is carried on the same record, so it catches the same mistake
    // independently of the article fields.
    expect(rows[0].excerpt).toContain("https://example.com/dated");
  });

  it("keeps a stale article whose only date came from a bare <time> element", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);
    const select = vi.fn().mockResolvedValue({ selections: [] });

    const result = await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({
        hits: [{ ...hit("https://vendor.example.com/blog/guide", "Vendor guide", 0.8), publishedAt: null }],
        credits: 1,
      }),
      // No OG tag, no JSON-LD — a custom CMS whose only <time> belongs to a
      // "recent posts" widget. That guess must not be able to delete the
      // article; a wrong-but-recent date is harmless, a wrong-and-old one is
      // destructive.
      fetchPage: vi.fn().mockResolvedValue(
        page("body", `<aside><time datetime="2024-01-01">Jan 1 2024</time></aside>`)
      ),
      select,
    });

    expect(result.stale).toBe(0);
    expect(select.mock.calls[0][0]).toHaveLength(1);
  });

  it("still drops a stale article the page itself dates in a meta tag", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);
    const select = vi.fn().mockResolvedValue({ selections: [] });

    const result = await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({
        hits: [{ ...hit("https://example.com/jsonld-old", "Old", 0.8), publishedAt: null }],
        credits: 1,
      }),
      // JSON-LD is the page asserting its own publication date, not a guess.
      fetchPage: vi.fn().mockResolvedValue(
        page("body", `<script type="application/ld+json">{"datePublished":"2024-01-01T00:00:00Z"}</script>`)
      ),
      select,
    });

    expect(result.stale).toBe(1);
    expect(select.mock.calls[0][0]).toHaveLength(0);
  });

  it("records partial staleness, not only the all-stale case", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);
    const recent = new Date(Date.now() - 86_400_000).toISOString();

    await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({
        hits: [
          { ...hit("https://example.com/fresh", "Fresh", 0.9), publishedAt: null },
          { ...hit("https://example.com/old", "Old", 0.8), publishedAt: null },
        ],
        credits: 1,
      }),
      fetchPage: vi.fn().mockImplementation(async (url: string) =>
        page(
          "body",
          `<meta property="article:published_time" content="${url.includes("/old") ? "2024-01-01T00:00:00Z" : recent}">`
        )
      ),
      select: vi.fn().mockResolvedValue({ selections: [] }),
    });

    const [row] = await db.select().from(sources).where(eq(sources.id, source.id));
    // A run that drops most of what it fetched is one article away from the
    // all-stale case; without this it reads as completely clean.
    expect(row.lastError).toContain("1 of 2 fetched articles were older than");
    // The run still did its job, so the badge stays green — same ruling as a
    // partial search failure.
    expect(row.status).toBe("active");
  });
});

describe("normalizeArticleUrl", () => {
  it("strips tracking parameters so one article has one identity", () => {
    expect(normalizeArticleUrl("https://n.example.com/a?utm_source=x&utm_medium=y&id=7")).toBe(
      "https://n.example.com/a?id=7"
    );
  });

  it("strips the ref and source referral params but keeps load-bearing query", () => {
    expect(normalizeArticleUrl("https://n.example.com/a?ref=hn&source=newsletter&id=7")).toBe(
      "https://n.example.com/a?id=7"
    );
    expect(normalizeArticleUrl("https://n.example.com/a?fbclid=x&gclid=y&mc_eid=z")).toBe("https://n.example.com/a");
  });

  it("drops a trailing slash and the fragment", () => {
    expect(normalizeArticleUrl("https://n.example.com/a/#section")).toBe("https://n.example.com/a");
  });

  it("collapses www, host case, and http into one identity", () => {
    // Each of these was a separate externalId before, costing a fetch, a
    // scoring slot and a row for what is one article.
    const canonical = "https://n.example.com/a";
    expect(normalizeArticleUrl("https://www.n.example.com/a")).toBe(canonical);
    expect(normalizeArticleUrl("https://N.Example.COM/a")).toBe(canonical);
    expect(normalizeArticleUrl("http://n.example.com/a")).toBe(canonical);
    expect(normalizeArticleUrl("http://WWW.N.Example.com/a/?utm_source=x#top")).toBe(canonical);
  });

  it("leaves the path case alone, since paths are case-sensitive", () => {
    expect(normalizeArticleUrl("https://n.example.com/Article/Ships-AI")).toBe("https://n.example.com/Article/Ships-AI");
  });

  it("returns an unparseable url unchanged rather than throwing", () => {
    expect(normalizeArticleUrl("not a url")).toBe("not a url");
  });

  it("searches the bare topic, without a literal 'news' suffix", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["developer cli"]);
    const search = vi.fn().mockResolvedValue({ hits: [], credits: 1 });

    await runNewsSource(source, { database: db, search, fetchPage: vi.fn(), select: vi.fn() });

    // `searchNews` already scopes the search via `topic: "general"`. Appending
    // the word "news" biased results toward wire copy — on the first live run
    // "developer cli news" returned a crypto-brokerage press release — and
    // fights the general index's whole purpose, which is the professional
    // writing that never appears on a wire.
    expect(search).toHaveBeenCalledWith("developer cli");
  });

  it("keeps hits Tavily scored below the old 0.2 floor", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);
    const fetchPage = vi.fn().mockResolvedValue(page("body"));

    await runNewsSource(source, {
      database: db,
      // 0.12 is a real observed score from the first live run. Under the
      // original floor of 0.2 it was discarded before anything looked at it.
      search: vi.fn().mockResolvedValue({ hits: [hit("https://news.example.com/mid", "Mid", 0.12)], credits: 1 }),
      fetchPage,
      select: vi.fn().mockResolvedValue({ selections: [] }),
    });

    expect(fetchPage.mock.calls.map((c) => c[0])).toContain("https://news.example.com/mid");
  });

});
