# News Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daily per-tenant agent that searches industry news against the company's own topics, fetches each article, scores it for relevance, and writes `market_news` signals.

**Architecture:** Tavily's `/search` endpoint with `topic: "news"` supplies candidate articles for each of the tenant's topics. Candidates are deduped by normalized URL within the run, checked against `signals` rows we already hold, fetched through the existing SSRF-guarded `fetchPageText`, scored by the existing batched `scoreRelevance`, and written as `market_news` signals keyed on the article URL. Unlike the competitor agent there is **no watermark and no block diffing** — a news article is a whole item with its own identity and publication date, so the `signals_tenant_kind_external_unique` index is the dedupe mechanism.

**Tech Stack:** Next.js 16 App Router, Drizzle ORM + Postgres, AI SDK v7 with `@ai-sdk/anthropic`, Vitest, Tavily Search API over plain `fetch` (no new npm dependency).

## Global Constraints

- **This is NOT the Next.js you know.** Next.js 16 with breaking changes from common training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any App Router code.
- Tests run against a **real Postgres database whose name must end in `_test`** (`vitest.setup.ts` hard-fails otherwise). 146 test files run **in parallel against one shared database** with no rollback wrapper.
- **No test may execute a real unscoped sweep against the shared test database** unless that sweep is what it is testing — and where it is, assertions must be scoped to rows the test seeded, never to raw call counts. Other files insert `active` sources concurrently.
- **Every fetch of an article URL goes through `fetchPageText`.** Article URLs come from a search engine and are attacker-influenced by definition: a hostile page can rank for a topic. `fetchPageText` carries IP-literal blocking, per-hop redirect re-validation, private/loopback/link-local/CGNAT/ULA rejection, a byte cap, a live timeout through body read, and the `MAX_SCAN_CHARS` clamp. Calling `fetch` directly on an article URL is a security bug, not a shortcut.
- **`recordLlmUsage`'s `operation` is a closed string-literal union** in `src/lib/ai/llm-usage.ts`. This plan needs **no new value** — news relevance reuses the existing `"signal_relevance"`, because it is the same operation on different inputs. Do not add one.
- **The tests are the contract.** If a task's prose and its code sample disagree, **stop and report** — that is a plan bug, not something to resolve by picking one.
- **A comment that promises behaviour the code does not implement is a bug.** Do not write a comment describing a mechanism you did not build.
- LLM calls go to **Anthropic directly** via `@ai-sdk/anthropic`. This is deliberate and cost-driven. Do not route through the Vercel AI Gateway.

## Test conventions in this repo

These were read from the existing tests. **Match them exactly** — the test samples below already do, and deviating breaks against the shared parallel database.

- **Tests import by relative path, not the `@/` alias.** `import { db } from "../../src/db"` from `tests/app/`, `"../../../src/db"` from `tests/lib/signals/`. There is no alias resolution in the test config.
- **There is no shared tenant helper and you must not create one.** Each file declares a unique tenant-name constant and seeds inline:

  ```typescript
  const TENANT = "News Agent Test Tenant";

  async function seed(name: string) {
    const [tenant] = await db.insert(tenants).values({ name }).returning();
    return tenant;
  }
  ```

- **Every file cleans up by tenant name in `afterEach`.** This is what keeps 146 parallel test files from colliding; without it rows leak into every other file's queries.

  ```typescript
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
    vi.restoreAllMocks();
  });
  ```

- **Server actions take no tenant argument.** Tenant isolation is carried implicitly via `requireSession()` from `src/lib/workspace/session`. Tests mock it with a mutable id, per `tests/app/company-actions.test.ts`:

  ```typescript
  let currentTenantId = "";
  vi.mock("../../src/lib/workspace/session", () => ({
    requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: "user-1" } })),
  }));
  vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
  ```

  **Never add a tenant parameter to an action to make it testable.** That is the shape that nearly opened a cross-tenant write in spec 2.

## Verified facts this plan depends on

Each was read from the source before this plan was written. If one turns out false, stop and report rather than working around it.

- `sourceTypeEnum` already contains `"news"`; `signalKindEnum` already contains `"market_news"`. **No enum migration is needed.**
- `sources.url` is nullable, and `sources_tenant_url_unique` is **partial** (`WHERE url IS NOT NULL`). Null-url news sources therefore have **no uniqueness at all** today. Task 2 adds it.
- `signals.externalId`'s own schema comment already states *"news uses the article URL."*
- `signals_tenant_kind_external_unique` is on `(tenantId, kind, externalId)`.
- `scoreRelevance(items, profile, tenantId, deps)` is in `src/lib/signals/relevance.ts`, takes `ScorableItem = { title, text, url: string | null }`, returns `ScoredItem = { score: number | null, rationale, topics }`, and **fails open** — a thrown error leaves every item unscored rather than dropping any.
- `fetchPageText(url)` returns `PageResult = { text, html, finalUrl, contentType, truncated } | { error }`. `MAX_TEXT_CHARS = 12_000` is exported from the same module.
- `companyProfiles.topics` is `text[] NOT NULL DEFAULT []`.
- The cron handler is `src/app/api/cron/scheduler/route.ts`; it checks `Bearer ${process.env.CRON_SECRET}` and then awaits its steps sequentially with ordering comments.
- Tavily: `POST https://api.tavily.com/search`, header `Authorization: Bearer tvly-...`. Request takes `query`, `topic` (`"news"` includes `published_date` metadata), `time_range`, `search_depth` (`"basic"` = 1 credit), `max_results` (0–20). Response is `{ query, results: [{ title, url, content, score }], response_time, usage: { credits }, request_id }`, with `published_date` present on results under the news topic.

---

## File Structure

**Create:**
- `src/lib/signals/tavily.ts` — the vendor client. One function, injected `fetch`, no database and no business rules.
- `src/lib/signals/news-agent.ts` — `runNewsSource`: build queries → search → dedupe → skip-known → fetch → score → write.
- `src/lib/signals/news-sweep.ts` — `sweepNewsSources`, mirroring `sweep.ts`'s per-source isolation.
- `tests/lib/signals/tavily.test.ts`, `tests/lib/signals/news-agent.test.ts`, `tests/lib/signals/news-sweep.test.ts`

**Modify:**
- `src/db/schema.ts` — a partial unique index giving null-url sources a `(tenantId, type)` identity.
- `src/app/api/cron/scheduler/route.ts` — one more sweep call.
- `src/app/(dashboard)/company/` — a "Industry news" section: enable/disable and source health.

---

### Task 1: The Tavily search client

A thin, honest wrapper. It knows the vendor's wire format and nothing else — no database, no scoring, no policy. That boundary is what lets every later task test against a stub instead of the network.

**Files:**
- Create: `src/lib/signals/tavily.ts`
- Test: `tests/lib/signals/tavily.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type NewsHit = { title: string; url: string; content: string; publishedAt: Date | null }`
  - `type TavilyResult = { hits: NewsHit[]; credits: number } | { error: TavilyError }`
  - `type TavilyError = "no-api-key" | "request-failed" | "bad-response"`
  - `type TavilyFetch = typeof fetch`
  - `async function searchNews(query: string, deps?: { fetchImpl?: TavilyFetch }): Promise<TavilyResult>`
  - `const TAVILY_MAX_RESULTS = 10`

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/signals/tavily.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchNews, TAVILY_MAX_RESULTS } from "../../../src/lib/signals/tavily";

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const SAMPLE = {
  query: "localization tooling",
  results: [
    {
      title: "Acme ships AI translation memory",
      url: "https://news.example.com/acme-tm",
      content: "Acme announced a translation memory built on...",
      score: 0.91,
      published_date: "2026-08-04T09:00:00Z",
    },
  ],
  response_time: 1.2,
  usage: { credits: 1 },
  request_id: "req_1",
};

describe("searchNews", () => {
  const originalKey = process.env.TAVILY_API_KEY;

  beforeEach(() => {
    process.env.TAVILY_API_KEY = "tvly-test-key";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = originalKey;
  });

  it("returns hits with parsed publication dates", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(SAMPLE));

    const result = await searchNews("localization tooling", { fetchImpl });

    expect("hits" in result).toBe(true);
    if (!("hits" in result)) return;
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].title).toBe("Acme ships AI translation memory");
    expect(result.hits[0].url).toBe("https://news.example.com/acme-tm");
    expect(result.hits[0].publishedAt?.toISOString()).toBe("2026-08-04T09:00:00.000Z");
    expect(result.credits).toBe(1);
  });

  it("sends the news topic, a bounded result count, and the bearer key", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(SAMPLE));

    await searchNews("localization tooling", { fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.tavily.com/search");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tvly-test-key");
    const body = JSON.parse(init.body as string);
    expect(body.query).toBe("localization tooling");
    // The news topic is what makes published_date available at all; a plain
    // search would leave every signal's occurredAt guessed.
    expect(body.topic).toBe("news");
    expect(body.search_depth).toBe("basic");
    expect(body.max_results).toBe(TAVILY_MAX_RESULTS);
  });

  it("treats a missing or unparseable published_date as unknown, not as now", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({
        ...SAMPLE,
        results: [
          { title: "No date", url: "https://news.example.com/a", content: "x", score: 0.5 },
          {
            title: "Bad date",
            url: "https://news.example.com/b",
            content: "y",
            score: 0.5,
            published_date: "not a date",
          },
        ],
      })
    );

    const result = await searchNews("q", { fetchImpl });

    expect("hits" in result).toBe(true);
    if (!("hits" in result)) return;
    expect(result.hits[0].publishedAt).toBeNull();
    expect(result.hits[1].publishedAt).toBeNull();
  });

  it("drops results missing a title or url rather than writing empty signals", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({
        ...SAMPLE,
        results: [
          { title: "", url: "https://news.example.com/a", content: "x", score: 0.5 },
          { title: "Fine", url: "", content: "y", score: 0.5 },
          { title: "Good", url: "https://news.example.com/c", content: "z", score: 0.5 },
        ],
      })
    );

    const result = await searchNews("q", { fetchImpl });

    expect("hits" in result).toBe(true);
    if (!("hits" in result)) return;
    expect(result.hits.map((h) => h.url)).toEqual(["https://news.example.com/c"]);
  });

  it("reports a missing api key without calling the network", async () => {
    delete process.env.TAVILY_API_KEY;
    const fetchImpl = vi.fn();

    const result = await searchNews("q", { fetchImpl });

    expect(result).toEqual({ error: "no-api-key" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a non-2xx response as request-failed", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 429 }));

    const result = await searchNews("q", { fetchImpl });

    expect(result).toEqual({ error: "request-failed" });
  });

  it("reports a thrown fetch as request-failed rather than propagating", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("socket hang up"));

    const result = await searchNews("q", { fetchImpl });

    expect(result).toEqual({ error: "request-failed" });
  });

  it("reports a response whose shape does not match as bad-response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ nope: true }));

    const result = await searchNews("q", { fetchImpl });

    expect(result).toEqual({ error: "bad-response" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/signals/tavily.test.ts`
Expected: FAIL — `Cannot find module '@/lib/signals/tavily'`.

- [ ] **Step 3: Implement the client**

Create `src/lib/signals/tavily.ts`:

```typescript
import { z } from "zod";

/**
 * The Tavily Search API, narrowed to the one call the news agent makes.
 *
 * Deliberately dependency-free: this is a single POST to a fixed, known host,
 * so it needs neither an SDK nor `fetchPageText`'s SSRF guards (the host is
 * ours to trust, unlike the article URLs it returns — those are
 * attacker-influenced and MUST go through `fetchPageText`).
 *
 * Every failure is returned, never thrown. A news run that loses one query to
 * a rate limit should still write the other queries' articles.
 */

const TAVILY_URL = "https://api.tavily.com/search";

/** Bounded so one topic cannot dominate a run's fetch budget. Tavily's cap is 20. */
export const TAVILY_MAX_RESULTS = 10;

export type NewsHit = {
  title: string;
  url: string;
  /** Tavily's own extract from the page. Used as the excerpt fallback when we cannot fetch the article ourselves. */
  content: string;
  /** Null when absent or unparseable. Never defaulted to "now" — see `occurredAt` in news-agent.ts. */
  publishedAt: Date | null;
};

export type TavilyError = "no-api-key" | "request-failed" | "bad-response";

export type TavilyResult = { hits: NewsHit[]; credits: number } | { error: TavilyError };

export type TavilyFetch = typeof fetch;

const ResponseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      content: z.string().default(""),
      published_date: z.string().optional(),
    })
  ),
  usage: z.object({ credits: z.number() }).optional(),
});

function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function searchNews(
  query: string,
  deps: { fetchImpl?: TavilyFetch } = {}
): Promise<TavilyResult> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return { error: "no-api-key" };

  const fetchImpl = deps.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(TAVILY_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query,
        // The news topic is what makes `published_date` available. Without it
        // every signal's occurredAt would be first-seen time, and spec 5's
        // decay ranking would read a week-old article as breaking.
        topic: "news",
        // One credit per search. `advanced` costs two and buys deeper page
        // extraction we do not use — we fetch the article ourselves.
        search_depth: "basic",
        time_range: "week",
        max_results: TAVILY_MAX_RESULTS,
      }),
    });
  } catch {
    return { error: "request-failed" };
  }

  if (!response.ok) return { error: "request-failed" };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { error: "bad-response" };
  }

  const parsed = ResponseSchema.safeParse(payload);
  if (!parsed.success) return { error: "bad-response" };

  const hits: NewsHit[] = parsed.data.results
    // A result without a title or URL cannot become a signal: the title is
    // NOT NULL and the URL is the idempotency key.
    .filter((r) => r.title.trim().length > 0 && r.url.trim().length > 0)
    .map((r) => ({
      title: r.title.trim(),
      url: r.url.trim(),
      content: r.content,
      publishedAt: parseDate(r.published_date),
    }));

  return { hits, credits: parsed.data.usage?.credits ?? 0 };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/signals/tavily.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Document the new environment variable**

Add `TAVILY_API_KEY` to whatever env documentation the repo already keeps (check for `.env.example` or a README env section; if neither exists, skip this step rather than inventing a file). The key format is `tvly-...`. Note in one line that the free tier is 1,000 credits/month and this agent spends one credit per topic per tenant per day.

- [ ] **Step 6: Commit**

```bash
git add src/lib/signals/tavily.ts tests/lib/signals/tavily.test.ts
git commit -m "feat: add the Tavily news search client"
```

---

### Task 2: Give null-url sources an identity

`sources_tenant_url_unique` is partial on `url IS NOT NULL`, and Postgres treats NULLs as distinct from one another — so today a tenant could accumulate unlimited identical news source rows. This task closes that before anything creates one.

**Files:**
- Modify: `src/db/schema.ts` (the `sources` table's index list, and the `watermark` column comment)
- Create: a Drizzle migration via `npm run db:generate`
- Test: `tests/db/news-source-identity.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the DB guarantee that `(tenantId, type)` is unique among sources with a null URL. Task 3 and Task 5 both rely on `onConflictDoNothing`/`onConflictDoUpdate` against it.

- [ ] **Step 1: Write the failing test**

Create `tests/db/news-source-identity.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, sources } from "../../src/db/schema";

const TENANT = "News Source Identity Test Tenant";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
});

async function seed() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  return tenant;
}

describe("null-url source identity", () => {
  it("permits only one news source per tenant", async () => {
    const tenant = await seed();

    await db.insert(sources).values({
      tenantId: tenant.id,
      type: "news",
      url: null,
      label: "Industry news",
    });

    await expect(
      db.insert(sources).values({
        tenantId: tenant.id,
        type: "news",
        url: null,
        label: "Industry news again",
      })
    ).rejects.toThrow();
  });

  it("still permits two competitor sources with distinct urls", async () => {
    const tenant = await seed();

    await db.insert(sources).values({
      tenantId: tenant.id,
      type: "competitor_web",
      url: "https://rival.example.com/changelog",
      label: "Rival changelog",
    });

    await expect(
      db.insert(sources).values({
        tenantId: tenant.id,
        type: "competitor_web",
        url: "https://rival.example.com/blog",
        label: "Rival blog",
      })
    ).resolves.toBeDefined();
  });
});
```

> Note the `afterEach` cleanup: without it this file's tenants leak into every other parallel test file's queries.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/db/news-source-identity.test.ts`
Expected: FAIL — the second insert resolves instead of rejecting.

- [ ] **Step 3: Add the index and correct the watermark comment**

In `src/db/schema.ts`, add a second entry to the `sources` table's index array, beside the existing `sources_tenant_url_unique`:

```typescript
    // The mirror of the index above, for the null-url half of the table.
    // Postgres treats NULLs as distinct from one another, so the partial
    // unique index above gives null-url rows no uniqueness whatsoever — a
    // tenant could accumulate unlimited identical news sources. A topic-driven
    // news source has no URL to be identified by; its identity is simply
    // "this tenant's news source", so that is what this enforces.
    uniqueIndex("sources_tenant_type_null_url_unique")
      .on(table.tenantId, table.type)
      .where(sql`${table.url} IS NULL`),
```

Then update the `watermark` column comment. It currently ends by predicting that spec 4's news sources "will need their own cursor shape here" — that prediction turned out to be wrong, and leaving it would send a future reader looking for a cursor that does not exist. Replace that final sentence with:

```
    // News sources (news-agent.ts) deliberately leave this empty: an article
    // has its own durable identity (its URL) and its own date, so dedupe is
    // the `signals_tenant_kind_external_unique` index rather than a cursor.
    // Nothing here needs to be remembered between runs.
```

- [ ] **Step 4: Generate and inspect the migration**

Run: `npm run db:generate`

Open the generated SQL and confirm it contains exactly one new `CREATE UNIQUE INDEX ... WHERE "url" IS NULL` and no unrelated drops. **If the migration contains anything else — a dropped index, a column change — stop and report.** A migration that rewrites unrelated schema is a generator disagreement, not something to accept.

- [ ] **Step 5: Apply and run the tests**

Run: `npm run db:migrate && npx vitest run tests/db/news-source-identity.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Run the full suite**

Run: `npm run test`
Expected: all pass. A new unique index can surface duplicate rows that existing tests were creating without noticing — if a previously-passing test now fails, that test was relying on the missing constraint, and the fix is the test, not the index.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/db/migrations tests/db/news-source-identity.test.ts
git commit -m "fix: give null-url sources a tenant+type identity"
```

---

### Task 3: The per-tenant news agent

The core. One tenant in, `market_news` signals out.

**Files:**
- Create: `src/lib/signals/news-agent.ts`
- Test: `tests/lib/signals/news-agent.test.ts`

**Interfaces:**
- Consumes: `searchNews`, `NewsHit`, `TavilyResult` (Task 1); `fetchPageText`, `PageResult` (existing); `scoreRelevance`, `RelevanceProfile`, `ScorableItem`, `ScoredItem`, `RelevanceDeps` (existing).
- Produces:
  - `type NewsAgentDeps = { search?: SearchFn; fetchPage?: FetchPage; score?: ScoreFn; database?: typeof defaultDb }`
  - `type NewsRunResult = { written: number; dropped: number; skipped: number; credits: number }`
  - `async function runNewsSource(source: Source, deps?: NewsAgentDeps): Promise<NewsRunResult>`
  - `const MAX_TOPICS_PER_RUN = 5`
  - `export function normalizeArticleUrl(raw: string): string`

**Design notes the implementer must not re-derive:**

- **No watermark.** Dedupe is `signals_tenant_kind_external_unique` plus a pre-flight query against `signals` for the URLs this run found. That query exists to avoid *paying* to re-fetch and re-score articles already held; the unique index is what guarantees correctness. Do not add a cursor to `source.watermark`.
- **`occurredAt` is the article's `published_date` when Tavily gives one, and the run time when it does not.** This differs from the competitor agent, where first-seen was the only honest answer. Never substitute "now" for a date that parsed — spec 5's ranking decays on this field, and a month-old article dated today would outrank genuinely fresh news.
- **The excerpt prefers our own fetch and falls back to Tavily's `content`.** Both are real page text; neither is model-generated. A failed fetch must not drop the signal — a paywalled or slow article is still news.
- **`RELEVANCE_FLOOR` is 0.3, matching the competitor agent.** A `null` score is a scoring *failure*, not a low score, and is always written so a human sees it.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/signals/news-agent.test.ts`:

```typescript
import { describe, it, expect, afterEach, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, signals, sources, companyProfiles, type Source } from "../../../src/db/schema";
import { runNewsSource, normalizeArticleUrl } from "../../../src/lib/signals/news-agent";
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

function page(text: string): PageResult {
  return {
    text,
    html: `<p>${text}</p>`,
    finalUrl: "https://news.example.com/a",
    contentType: "text/html",
    truncated: false,
  };
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

const hit = (url: string, title = "A headline") => ({
  title,
  url,
  content: "Tavily's own extract of the article.",
  publishedAt: new Date("2026-08-04T09:00:00Z"),
});

describe("runNewsSource", () => {
  it("writes a market_news signal keyed on the article url", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);

    const result = await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({ hits: [hit("https://news.example.com/a")], credits: 1 }),
      fetchPage: vi.fn().mockResolvedValue(page("The full article body, fetched by us.")),
      score: vi.fn().mockResolvedValue([{ score: 0.8, rationale: "on topic", topics: ["localization"] }]),
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
      score: vi.fn().mockResolvedValue([{ score: 0.8, rationale: "r", topics: [] }]),
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
      score: vi.fn().mockResolvedValue([{ score: 0.8, rationale: "r", topics: [] }]),
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
    const score = vi.fn().mockResolvedValue([{ score: 0.8, rationale: "r", topics: [] }]);

    const result = await runNewsSource(source, {
      database: db,
      // Same article, once per topic — with tracking params that differ.
      search: vi
        .fn()
        .mockResolvedValueOnce({ hits: [hit("https://news.example.com/dupe?utm_source=a")], credits: 1 })
        .mockResolvedValueOnce({ hits: [hit("https://news.example.com/dupe?utm_source=b")], credits: 1 }),
      fetchPage,
      score,
    });

    expect(result.written).toBe(1);
    // The saving that matters: the article is fetched and scored once, not twice.
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(score.mock.calls[0][0]).toHaveLength(1);
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
    const score = vi.fn().mockResolvedValue([]);

    const result = await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({ hits: [hit("https://news.example.com/known")], credits: 1 }),
      fetchPage,
      score,
    });

    expect(result.skipped).toBe(1);
    expect(result.written).toBe(0);
    expect(fetchPage).not.toHaveBeenCalled();
    expect(score).not.toHaveBeenCalled();
  });

  it("drops articles below the relevance floor but always writes unscored ones", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);

    const result = await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({
        hits: [hit("https://news.example.com/low"), hit("https://news.example.com/unscored")],
        credits: 1,
      }),
      fetchPage: vi.fn().mockResolvedValue(page("body")),
      score: vi.fn().mockResolvedValue([
        { score: 0.1, rationale: "off topic", topics: [] },
        { score: null, rationale: "Relevance scoring failed for this item.", topics: [] },
      ]),
    });

    expect(result.written).toBe(1);
    expect(result.dropped).toBe(1);

    const rows = await db
      .select()
      .from(signals)
      .where(and(eq(signals.tenantId, tenant.id), eq(signals.kind, "market_news")));
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe("https://news.example.com/unscored");
    expect(rows[0].relevanceScore).toBeNull();
  });

  it("records a search failure on the source without throwing", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);

    const result = await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({ error: "request-failed" as const }),
      fetchPage: vi.fn(),
      score: vi.fn(),
    });

    expect(result.written).toBe(0);
    const [row] = await db.select().from(sources).where(eq(sources.id, source.id));
    expect(row.lastError).toContain("request-failed");
    expect(row.lastRunAt).not.toBeNull();
  });

  it("does nothing and records a clear reason when the tenant has no topics", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, []);
    const search = vi.fn();

    const result = await runNewsSource(source, { database: db, search, fetchPage: vi.fn(), score: vi.fn() });

    expect(result.written).toBe(0);
    expect(search).not.toHaveBeenCalled();
    const [row] = await db.select().from(sources).where(eq(sources.id, source.id));
    expect(row.lastError).toContain("no topics");
  });

  it("bounds how many topic searches one run performs", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["a", "b", "c", "d", "e", "f", "g"]);
    const search = vi.fn().mockResolvedValue({ hits: [], credits: 1 });

    await runNewsSource(source, { database: db, search, fetchPage: vi.fn(), score: vi.fn() });

    expect(search).toHaveBeenCalledTimes(5);
  });
});

describe("normalizeArticleUrl", () => {
  it("strips tracking parameters so one article has one identity", () => {
    expect(normalizeArticleUrl("https://n.example.com/a?utm_source=x&utm_medium=y&id=7")).toBe(
      "https://n.example.com/a?id=7"
    );
  });

  it("drops a trailing slash and the fragment", () => {
    expect(normalizeArticleUrl("https://n.example.com/a/#section")).toBe("https://n.example.com/a");
  });

  it("returns an unparseable url unchanged rather than throwing", () => {
    expect(normalizeArticleUrl("not a url")).toBe("not a url");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/signals/news-agent.test.ts`
Expected: FAIL — `Cannot find module '@/lib/signals/news-agent'`.

- [ ] **Step 3: Implement the agent**

Create `src/lib/signals/news-agent.ts`:

```typescript
import { and, eq, inArray } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { signals, sources, companyProfiles, tenants, type Source } from "@/db/schema";
import { fetchPageText, type PageResult } from "@/lib/workspace/fetch-page";
import { searchNews, type NewsHit, type TavilyResult } from "@/lib/signals/tavily";
import {
  scoreRelevance,
  type RelevanceProfile,
  type ScorableItem,
  type ScoredItem,
  type RelevanceDeps,
} from "@/lib/signals/relevance";

type SearchFn = (query: string, deps?: { fetchImpl?: typeof fetch }) => Promise<TavilyResult>;
type FetchPage = (url: string) => Promise<PageResult>;
type ScoreFn = (
  items: ScorableItem[],
  profile: RelevanceProfile,
  tenantId: string,
  deps?: RelevanceDeps
) => Promise<ScoredItem[]>;

export type NewsAgentDeps = {
  search?: SearchFn;
  fetchPage?: FetchPage;
  score?: ScoreFn;
  database?: typeof defaultDb;
};

export type NewsRunResult = {
  written: number;
  /** Scored below the floor. */
  dropped: number;
  /** Already held as signals — not fetched, not scored, not billed. */
  skipped: number;
  credits: number;
};

/** Matches the competitor agent. A null score is a failure, not a low score, and bypasses this. */
const RELEVANCE_FLOOR = 0.3;

/**
 * Caps searches per run. Each is one Tavily credit, so this is the cost dial:
 * at 5, a tenant costs 5 credits/day — roughly 150/month against a 1,000-credit
 * free tier. Topics beyond this are not dropped forever, they are simply not
 * searched this run; the profile's topic order decides priority.
 */
export const MAX_TOPICS_PER_RUN = 5;

/** Params that identify a referral, not an article. */
const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_[ce]id$|ref$|source$)/i;

/**
 * One article, one identity.
 *
 * `signals.externalId` is the article URL, so anything that varies per
 * referral would split one story into several signals — and spec 5 would read
 * the duplicates as independent corroboration for a cluster when they are one
 * event. Strips tracking params, the fragment, and a trailing slash; leaves
 * everything else alone, because a query string can be load-bearing (`?id=7`).
 *
 * Returns the input unchanged when it will not parse. A URL we cannot
 * normalize is still a usable idempotency key — it just gets no help.
 */
export function normalizeArticleUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }

  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) parsed.searchParams.delete(key);
  }
  parsed.hash = "";
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }
  return parsed.toString().replace(/\?$/, "");
}

async function loadProfile(tenantId: string, database: typeof defaultDb): Promise<RelevanceProfile> {
  const [tenant] = await database.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
  const [profile] = await database.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenantId));

  return {
    name: tenant?.name ?? "",
    oneLiner: profile?.oneLiner ?? null,
    positioning: profile?.positioning ?? null,
    topics: profile?.topics ?? [],
  };
}

async function finish(
  database: typeof defaultDb,
  sourceId: string,
  error: string | null
): Promise<void> {
  const now = new Date();
  await database
    .update(sources)
    .set({
      lastRunAt: now,
      lastSuccessAt: error === null ? now : undefined,
      lastError: error,
      // `failing` is advisory, never terminal: the next run reconsiders it.
      // Only a human setting `disabled` retires a source.
      status: error === null ? "active" : "failing",
    })
    .where(eq(sources.id, sourceId));
}

/**
 * One tenant's daily news run.
 *
 * Deliberately has no watermark. A news article carries its own durable
 * identity (its URL) and its own date, so there is nothing to remember between
 * runs: `signals_tenant_kind_external_unique` guarantees we never write the
 * same article twice, and the pre-flight query below is purely a cost saving
 * so we do not re-fetch and re-score what we already hold.
 *
 * Does not throw for the failures it expects. A dead search, an unreachable
 * article, a failed write: each is recorded and the run continues.
 */
export async function runNewsSource(source: Source, deps: NewsAgentDeps = {}): Promise<NewsRunResult> {
  const database = deps.database ?? defaultDb;
  const search = deps.search ?? searchNews;
  const fetchPage = deps.fetchPage ?? fetchPageText;
  const score = deps.score ?? scoreRelevance;

  const empty: NewsRunResult = { written: 0, dropped: 0, skipped: 0, credits: 0 };

  const profile = await loadProfile(source.tenantId, database);
  const topics = profile.topics.slice(0, MAX_TOPICS_PER_RUN);

  if (topics.length === 0) {
    // Not a failure of ours, but the operator has to be able to see why this
    // source produces nothing — otherwise it reads as broken.
    await finish(database, source.id, "Company profile has no topics to search on.");
    return empty;
  }

  // ── Search ────────────────────────────────────────────────────────────
  const byUrl = new Map<string, NewsHit>();
  const errors: string[] = [];
  let credits = 0;

  for (const topic of topics) {
    const result = await search(`${topic} news`);
    if ("error" in result) {
      errors.push(`${topic}: ${result.error}`);
      continue;
    }
    credits += result.credits;
    for (const raw of result.hits) {
      const url = normalizeArticleUrl(raw.url);
      // First topic to surface an article wins; later duplicates are dropped
      // before they cost a fetch or a scoring slot.
      if (!byUrl.has(url)) byUrl.set(url, { ...raw, url });
    }
  }

  if (byUrl.size === 0) {
    await finish(database, source.id, errors.length > 0 ? errors.join("; ") : null);
    return { ...empty, credits };
  }

  // ── Skip what we already hold ─────────────────────────────────────────
  const candidateUrls = [...byUrl.keys()];
  const existing = await database
    .select({ externalId: signals.externalId })
    .from(signals)
    .where(
      and(
        eq(signals.tenantId, source.tenantId),
        eq(signals.kind, "market_news"),
        inArray(signals.externalId, candidateUrls)
      )
    );
  for (const row of existing) byUrl.delete(row.externalId);
  const skipped = existing.length;

  if (byUrl.size === 0) {
    await finish(database, source.id, errors.length > 0 ? errors.join("; ") : null);
    return { ...empty, skipped, credits };
  }

  // ── Fetch each article through the guarded fetcher ─────────────────────
  // These URLs came from a search engine and are attacker-influenced: a
  // hostile page can rank for a topic. `fetchPageText` is what makes that safe.
  const fresh = [...byUrl.values()];
  const bodies = await Promise.all(
    fresh.map(async (article) => {
      const result = await fetchPage(article.url);
      // Tavily's own extract is real page text, not a model's paraphrase, so
      // falling back to it keeps the evidence honest. A paywalled or slow
      // article is still news worth surfacing.
      return "error" in result ? article.content : result.text;
    })
  );

  // ── Score ─────────────────────────────────────────────────────────────
  const items: ScorableItem[] = fresh.map((article, i) => ({
    title: article.title,
    text: bodies[i],
    url: article.url,
  }));
  const scores = await score(items, profile, source.tenantId);

  // ── Write ─────────────────────────────────────────────────────────────
  const now = new Date();
  let written = 0;
  let dropped = 0;

  for (const [i, article] of fresh.entries()) {
    const scored = scores[i] ?? { score: null, rationale: "Relevance scoring failed for this item.", topics: [] };

    if (scored.score !== null && scored.score < RELEVANCE_FLOOR) {
      dropped++;
      continue;
    }

    try {
      const inserted = await database
        .insert(signals)
        .values({
          tenantId: source.tenantId,
          sourceId: source.id,
          kind: "market_news",
          externalId: article.url,
          url: article.url,
          title: article.title,
          excerpt: bodies[i].slice(0, 500),
          // The article's own date when it has one. Only an undated article
          // falls back to now — spec 5's ranking decays on this, so dating a
          // month-old story today would outrank genuinely fresh news.
          occurredAt: article.publishedAt ?? now,
          relevanceScore: scored.score,
          relevanceRationale: scored.rationale,
          topics: scored.topics,
        })
        .onConflictDoNothing()
        .returning({ id: signals.id });

      if (inserted.length > 0) written++;
    } catch (error) {
      // A failed write must stay visible: without this the source would sit
      // `active` with a null error while silently losing articles every run.
      errors.push(`write failed for ${article.url}: ${String(error)}`);
    }
  }

  await finish(database, source.id, errors.length > 0 ? errors.join("; ") : null);
  return { written, dropped, skipped, credits };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/signals/news-agent.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Prove the dedupe test would fail without normalization**

Temporarily change `normalizeArticleUrl` to `return raw;` and re-run. The "deduplicates one article returned by two different topic searches" test must **fail** (two writes, two fetches). Restore the function. If it still passes, the fixture's two URLs are not actually differing in a tracking param — fix the fixture, because a test that cannot fail is worse than none.

- [ ] **Step 6: Commit**

```bash
git add src/lib/signals/news-agent.ts tests/lib/signals/news-agent.test.ts
git commit -m "feat: add the per-tenant news agent"
```

---

### Task 4: Sweep and cron wiring

**Files:**
- Create: `src/lib/signals/news-sweep.ts`
- Modify: `src/app/api/cron/scheduler/route.ts`
- Test: `tests/lib/signals/news-sweep.test.ts`

**Interfaces:**
- Consumes: `runNewsSource`, `NewsAgentDeps` (Task 3).
- Produces: `async function sweepNewsSources(deps?: SweepNewsSourcesDeps): Promise<void>`, with `SweepNewsSourcesDeps = { database?: typeof defaultDb; runSource?: (source: Source, deps?: NewsAgentDeps) => ReturnType<typeof runNewsSource> }`.

**This sweep must mirror `sweepCompetitorSources` exactly in shape**, because that shape is the product of a review that corrected two defects: the candidate select gets its own try/catch (a throw would reject the whole cron handler and undo earlier steps), and the per-source try/catch is **per source, not per tenant** (one broken source must not stop the others).

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/signals/news-sweep.test.ts`:

```typescript
import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, sources, type Source } from "../../../src/db/schema";
import { sweepNewsSources } from "../../../src/lib/signals/news-sweep";

const TENANT = "News Sweep Test Tenant";
const OTHER = "News Sweep Other Test Tenant";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
  await db.delete(tenants).where(eq(tenants.name, OTHER));
  vi.restoreAllMocks();
});

async function seedTenant(name: string) {
  const [tenant] = await db.insert(tenants).values({ name }).returning();
  return tenant;
}

async function seedNews(tenantId: string, status: "active" | "failing" | "disabled" = "active"): Promise<Source> {
  const [row] = await db
    .insert(sources)
    .values({ tenantId, type: "news", url: null, label: "Industry news", status })
    .returning();
  return row;
}

// NOTE: this sweep reads the whole shared test database, and other test files
// insert sources concurrently. Every assertion below is scoped to ids this
// test created — never to a raw call count.
describe("sweepNewsSources", () => {
  it("runs a tenant's active news source", async () => {
    const tenant = await seedTenant(TENANT);
    await seedNews(tenant.id);
    const seen: string[] = [];

    await sweepNewsSources({
      database: db,
      runSource: async (source) => {
        seen.push(source.tenantId);
        return { written: 0, dropped: 0, skipped: 0, credits: 0 };
      },
    });

    expect(seen).toContain(tenant.id);
  });

  it("skips disabled sources", async () => {
    const tenant = await seedTenant(TENANT);
    await seedNews(tenant.id, "disabled");
    const seen: string[] = [];

    await sweepNewsSources({
      database: db,
      runSource: async (source) => {
        seen.push(source.tenantId);
        return { written: 0, dropped: 0, skipped: 0, credits: 0 };
      },
    });

    expect(seen).not.toContain(tenant.id);
  });

  it("still runs a failing source, so one that recovers is picked up again", async () => {
    const tenant = await seedTenant(TENANT);
    await seedNews(tenant.id, "failing");
    const seen: string[] = [];

    await sweepNewsSources({
      database: db,
      runSource: async (source) => {
        seen.push(source.tenantId);
        return { written: 0, dropped: 0, skipped: 0, credits: 0 };
      },
    });

    expect(seen).toContain(tenant.id);
  });

  it("does not touch competitor sources", async () => {
    const tenant = await seedTenant(TENANT);
    const [competitorSource] = await db
      .insert(sources)
      .values({ tenantId: tenant.id, type: "competitor_web", url: "https://rival.example.com/x", label: "Rival" })
      .returning();
    const seen: string[] = [];

    await sweepNewsSources({
      database: db,
      runSource: async (source) => {
        seen.push(source.id);
        return { written: 0, dropped: 0, skipped: 0, credits: 0 };
      },
    });

    expect(seen).not.toContain(competitorSource.id);
  });

  it("one source's failure does not stop another tenant's", async () => {
    const angry = await seedTenant(TENANT);
    const calm = await seedTenant(OTHER);
    const angrySource = await seedNews(angry.id);
    await seedNews(calm.id);
    const seen: string[] = [];

    await expect(
      sweepNewsSources({
        database: db,
        runSource: async (source) => {
          if (source.id === angrySource.id) throw new Error("boom");
          seen.push(source.tenantId);
          return { written: 0, dropped: 0, skipped: 0, credits: 0 };
        },
      })
    ).resolves.toBeUndefined();

    expect(seen).toContain(calm.id);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/signals/news-sweep.test.ts`
Expected: FAIL — `Cannot find module '@/lib/signals/news-sweep'`.

- [ ] **Step 3: Implement the sweep**

Create `src/lib/signals/news-sweep.ts`:

```typescript
import { and, eq, ne, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { sources, type Source } from "@/db/schema";
import { runNewsSource, type NewsAgentDeps } from "./news-agent";

export type SweepNewsSourcesDeps = {
  database?: typeof defaultDb;
  runSource?: (source: Source, deps?: NewsAgentDeps) => ReturnType<typeof runNewsSource>;
};

/**
 * Cron sweep for the per-tenant news agent, deliberately the same shape as
 * `sweepCompetitorSources` in `sweep.ts`.
 *
 * `failing` sources are included on purpose: a source that recovers (the API
 * key is fixed, the rate limit clears) gets picked up again instead of sitting
 * red forever. Only a human setting `disabled` retires one.
 *
 * The candidate select gets its own try/catch that logs and returns — a throw
 * here would reject the whole cron handler and undo the steps that ran before
 * it, and there is nothing to sweep if the select itself failed.
 *
 * Past that, the try/catch is per *source*, not per tenant, so one tenant's
 * broken run cannot stop the rest of the sweep.
 */
export async function sweepNewsSources(deps: SweepNewsSourcesDeps = {}): Promise<void> {
  const database = deps.database ?? defaultDb;
  const runSource = deps.runSource ?? runNewsSource;

  let candidates: Source[];
  try {
    candidates = await database
      .select()
      .from(sources)
      .where(and(eq(sources.type, "news"), ne(sources.status, "disabled")))
      // Never-run first, then least-recently-run, so if this sweep is ever cut
      // short the starvation rotates fairly instead of always favouring the
      // same tenants.
      .orderBy(sql`${sources.lastRunAt} ASC NULLS FIRST`);
  } catch (error) {
    console.error("[news-sweep] failed to load candidate sources:", error);
    return;
  }

  for (const source of candidates) {
    try {
      await runSource(source, { database });
    } catch (error) {
      console.error(`[news-sweep] failed for source ${source.id} (tenant ${source.tenantId}):`, error);
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/signals/news-sweep.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire it into the cron handler**

In `src/app/api/cron/scheduler/route.ts`, add the import beside the existing sweep import and append one call after `sweepCompetitorSources()`:

```typescript
  // Runs after the competitor sweep for the same reason that one runs after
  // the shipped-work reconcile: each producer sees a signals table the
  // previous one has finished with. Both are per-source isolated, so a
  // failure in either leaves the other's work intact.
  await sweepNewsSources();
```

Do not change the `CRON_SECRET` check, the existing calls, or their order.

- [ ] **Step 6: Verify the whole suite and the types**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: all pass, lint errors 0.

- [ ] **Step 7: Commit**

```bash
git add src/lib/signals/news-sweep.ts tests/lib/signals/news-sweep.test.ts src/app/api/cron/scheduler/route.ts
git commit -m "feat: sweep news sources on the daily cron"
```

---

### Task 5: The settings surface

Nothing has created a news source row yet — that is deliberate. News costs money per run, so a tenant opts in rather than being enrolled silently.

**Files:**
- Modify: `src/app/(dashboard)/company/` — the page and its server actions (match the existing file layout for competitors; read it before adding files)
- Test: extend the existing company-settings action tests

**Interfaces:**
- Consumes: the `(tenantId, type)` null-url unique index (Task 2).
- Produces: `setNewsWatching(enabled: boolean)` server action and a `getNewsSource()` read, both tenant-scoped from the session.

- [ ] **Step 1: Read the existing surface first**

Read `src/app/(dashboard)/company/actions.ts`, `competitors-editor.tsx`, and `page.tsx` end to end before writing anything, and match their patterns: every action starts `const session = await requireSession();` (imported from `@/lib/workspace/session`), takes no tenant argument, and ends with `revalidatePath("/company")`. Source health is already rendered for competitor sources — reuse that markup rather than inventing a second treatment.

- [ ] **Step 2: Write the failing action tests**

Add to `tests/app/company-actions.test.ts`. That file **already** declares the `currentTenantId` session mock, the `next/cache` mock, its `TENANT`/`OTHER` constants, the `afterEach` cleanup, and a `seed(name)` helper — reuse all of them. Add `setNewsWatching` to the file's existing import list from `../../src/app/(dashboard)/company/actions`, add `sources` to its existing schema import, and append only this block:

```typescript
describe("setNewsWatching", () => {
  it("creates exactly one news source when enabled twice", async () => {
    const tenant = await seed(TENANT);
    currentTenantId = tenant.id;

    await setNewsWatching(true);
    await setNewsWatching(true);

    const rows = await db
      .select()
      .from(sources)
      .where(and(eq(sources.tenantId, tenant.id), eq(sources.type, "news")));

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("active");
    expect(rows[0].url).toBeNull();
  });

  it("disables rather than deletes, so lastRunAt and lastError survive", async () => {
    const tenant = await seed(TENANT);
    currentTenantId = tenant.id;
    await setNewsWatching(true);

    await setNewsWatching(false);

    const [row] = await db
      .select()
      .from(sources)
      .where(and(eq(sources.tenantId, tenant.id), eq(sources.type, "news")));
    expect(row.status).toBe("disabled");
  });

  it("re-enabling a disabled source reactivates the same row", async () => {
    const tenant = await seed(TENANT);
    currentTenantId = tenant.id;
    await setNewsWatching(true);
    const [before] = await db
      .select()
      .from(sources)
      .where(and(eq(sources.tenantId, tenant.id), eq(sources.type, "news")));

    await setNewsWatching(false);
    await setNewsWatching(true);

    const rows = await db
      .select()
      .from(sources)
      .where(and(eq(sources.tenantId, tenant.id), eq(sources.type, "news")));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(before.id);
    expect(rows[0].status).toBe("active");
  });

  it("does not touch another tenant's news source", async () => {
    const mine = await seed(TENANT);
    const theirs = await seed(OTHER);

    currentTenantId = theirs.id;
    await setNewsWatching(true);

    currentTenantId = mine.id;
    await setNewsWatching(true);
    await setNewsWatching(false);

    const [theirRow] = await db
      .select()
      .from(sources)
      .where(and(eq(sources.tenantId, theirs.id), eq(sources.type, "news")));
    expect(theirRow.status).toBe("active");
  });
});
```

> `setNewsWatching` takes **no tenant argument** — it reads `requireSession()` like every other action in that file, and the tests steer it by assigning `currentTenantId`. Adding a tenant parameter to make it easier to test is exactly the shape that nearly opened a cross-tenant write in spec 2.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/app/company-actions.test.ts`
Expected: FAIL — `setNewsWatching` is not exported from the actions module.

- [ ] **Step 4: Implement the action**

Add to `src/app/(dashboard)/company/actions.ts`. `requireSession` and `revalidatePath` are already imported there; add `sources` to the existing schema import.

```typescript
export async function setNewsWatching(enabled: boolean) {
  const session = await requireSession();

  await db
    .insert(sources)
    .values({
      tenantId: session.user.tenantId,
      type: "news",
      url: null,
      label: "Industry news",
      status: enabled ? "active" : "disabled",
    })
    .onConflictDoUpdate({
      // The null-url identity index from task 2. Enabling twice must top up,
      // not duplicate; disabling must not delete, so lastError and lastRunAt
      // survive for the operator to read.
      target: [sources.tenantId, sources.type],
      targetWhere: sql`${sources.url} IS NULL`,
      set: { status: enabled ? "active" : "disabled" },
    });

  revalidatePath("/company");
}
```

> `targetWhere` is supported in the installed Drizzle (0.45.2 — verified in `node_modules/drizzle-orm/pg-core/query-builders/insert.d.ts`). **Do not drop that predicate**: the conflict target must match the partial index from task 2 exactly, or Postgres finds no matching arbiter and the upsert fails at runtime rather than at typecheck. Note the deprecated bare `where` in the same type — use `targetWhere`, not `where`.

- [ ] **Step 5: Add the UI section**

Add an "Industry news" section to the company settings page, matching the competitors section's markup and spacing:

- A toggle bound to `setNewsWatching`.
- When enabled, the source's health: `lastRunAt`, `lastSuccessAt`, and `lastError` when set — the same three the competitor sources already render.
- One line of explanatory copy: **"Searches news each day against the topics in your company profile. Add topics above to change what it looks for."** This is load-bearing, not decoration: a tenant with no topics gets a source that runs and writes nothing, and without this line that reads as broken.

- [ ] **Step 6: Verify**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: all pass.

The dashboard sits behind an OAuth wall, so the UI cannot be exercised in a browser from here. Types, lint, and the action-level tests are the evidence — **say so plainly in the task report rather than implying the screen was seen working.**

- [ ] **Step 7: Commit**

```bash
git add "src/app/(dashboard)/company" tests/app/company-actions.test.ts
git commit -m "feat: let a tenant opt in to industry news watching"
```

---

## Notes for spec 5 (the brief agent)

- `market_news` signals carry a real `occurredAt` from the article's publication date, unlike `competitor_move` signals where it is first-seen time. Ranking that decays on `occurredAt` will behave correctly for news and conservatively for competitor moves. Do not "fix" the competitor agent to match — first-seen is the honest answer there.
- One article is one signal, deduped on normalized URL, so a cluster citing three `market_news` signals genuinely has three sources rather than three referrals to one story.
- `relevanceScore` is null when scoring failed. Spec 5 must not treat null as zero — `listSignals`'s existing null-score carve-out is the pattern to follow.

## Known gaps, accepted

- **Topic searches are capped at `MAX_TOPICS_PER_RUN` (5) and always take the first five topics in profile order.** A tenant with eight topics never searches the last three. Deliberate: it is the cost dial, and topic order is user-editable. Revisit by rotating the window across runs if it becomes a real complaint.
- **`credits` is returned by `runNewsSource` and then discarded by the sweep.** There is no spend telemetry — the number exists so a future task can aggregate it without re-plumbing. Do not report cost from anything until that lands.
- **No per-tenant spend cap.** A tenant with five topics costs ~150 credits/month against Tavily's 1,000-credit free tier, so roughly six tenants fit free. Before onboarding more than that, either add a cap or move to a paid plan — this plan does neither.
