# Industry Content Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Broaden the news agent from news *events* to recent professional and opinion articles on the company's topics — the trade guides, practitioner essays and vendor deep-dives that make up a company's actual industry reading.

**Architecture:** Three changes. Tavily moves from its news index to the general index with job-board and aggregator domains excluded, because that is where professional writing lives. Since the general index returns no publication dates, dates are extracted from each article's own HTML during the fetch we already perform. Undated articles are kept but ranked below dated ones, and the selection prompt stops requiring that "something happened".

**Tech Stack:** Next.js 16 App Router, Drizzle ORM + Postgres, AI SDK v7 with `@ai-sdk/anthropic`, Vitest, Tavily Search API over plain `fetch`.

## Global Constraints

- **This is NOT the Next.js you know.** Next.js 16 with breaking changes from common training data. Read `node_modules/next/dist/docs/` before writing any App Router code. This plan should need none.
- Tests run against a **real Postgres database whose name must end in `_test`**; 155 files run **in parallel against one shared database**. Tests seed tenants inline with a file-unique name constant and clean up in `afterEach`. **There is no shared tenant helper and you must not create one.**
- **The suite is currently flaky** — runs at the same commit have given 4 failures, then 0, then 1, with the failing *files differing each time* (`review-draft`, `competitor-agent`, `news-agent`, `publish-idempotency`). If a run fails, check whether the failing file is one you changed before concluding anything, and run the suite twice before calling it green.
- **Tests import by relative path, not the `@/` alias** (`../../../src/...` from `tests/lib/signals/`). Source files under `src/` DO use `@/`.
- **Every article URL goes through `fetchPageText`.** These URLs come from a search engine and are attacker-influenced. Never a bare `fetch`.
- LLM calls go to **Anthropic directly** via `@ai-sdk/anthropic`. Do not route through the Vercel AI Gateway.
- `recordLlmUsage`'s `operation` is a closed union. **This plan needs no new value.**
- **The tests are the contract.** If a task's prose and its code sample disagree, **stop and report** — that is a plan bug.
- **A comment that promises behaviour the code does not implement is a bug.**

## Why each change — measured, not assumed

Every decision below came from live probes run on 2026-08-06 against the real Tavily key. Do not "restore" any of it without re-probing.

**The news index is unusable for this niche.** `topic: "news"` with `time_range: "week"` on "design localization" returned scores of 0.11, 0.04, 0.02, 0.01 — LiDAR perception stacks, the World Gold Council, payment failures — and **every result's URL was `www.google.com`**, i.e. Google News aggregator redirects rather than article links. Those would collapse under `normalizeArticleUrl` (one host), defeat `externalId` uniqueness, and have us fetching google.com.

**The general index returns exactly the target content.** `topic: "general"`, `time_range: "month"`, job domains excluded, same query:

```
0.78  phrase.com          How to Create Good Multilingual UX Design
0.75  webflow.com         A step-by-step guide to effective website localization
0.70  lilt.com            Figma Translation Integration
0.62  simplelocalize.io   API-Driven localization: Designing scalable translation infrastructure
```

**Job boards dominate without exclusions.** The un-excluded week-windowed run returned Google Careers, Target and an edtech UX Writer posting in its top three.

**Every general-index result is undated.** `published_date` was `NONE` on all of them, across every probe. Page-level extraction is mandatory, not a nicety.

## Decisions already made by the product owner — do not re-litigate

1. **Undated articles are kept, ranked below dated ones.** Dropping them would discard most of the professional content, which is the point of the change.
2. **The window stays one week.** Noted risk, accepted: the week-windowed probe returned job postings, and the job-board exclusion added here is what should remove them. `TAVILY_TIME_RANGE` and `RECENCY_WINDOW_DAYS` are both one-line constants precisely so the *pair* can be widened after the next live run — see Task 3's Interfaces block for why widening either one alone does nothing useful.
3. **A dated article older than the window is dropped.** Recency is enforced only where we actually know it.

---

## File Structure

**Create:**
- `src/lib/signals/published-date.ts` — `extractPublishedDate`: HTML in, `Date | null` out. Pure, no network, no database.
- `tests/lib/signals/published-date.test.ts`

**Modify:**
- `src/lib/signals/tavily.ts` — general index, week window, excluded domains.
- `src/lib/signals/news-agent.ts` — extract the date after fetching, enforce the window where known, rank dated first.
- `src/lib/signals/news-selection.ts` — stop requiring an event; welcome professional and opinion writing.
- `tests/lib/signals/tavily.test.ts`, `news-agent.test.ts`, `news-selection.test.ts`

---

### Task 1: Extract a publication date from an article's own HTML

**Files:**
- Create: `src/lib/signals/published-date.ts`
- Test: `tests/lib/signals/published-date.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function extractPublishedDate(html: string): Date | null` and `export const MAX_DATE_SCAN_CHARS = 200_000`.

**Design notes the implementer must not re-derive:**

- **Every pattern must be bounded.** This branch shipped a ReDoS in `extractSameOriginLinks` measured at 841ms on 32KB, in exactly this kind of attribute-scanning code. Character classes are negated and explicit (`[^"']*`), never `.*`, and the input is clamped to `MAX_DATE_SCAN_CHARS` first. A hostile page is a normal input here.
- **Order matters:** `article:published_time` is the most specific and most reliable, then `og:published_time`, then JSON-LD `datePublished`, then a `<time datetime=…>` element. First match wins.
- **A future date is rejected.** Pages carry template placeholders and scheduled-publish stamps; an article "published" next year is a parsing artefact, not news.
- **A date before 2000 is rejected** for the same reason — `0001-01-01` and Unix-epoch defaults are common in bad templates.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/signals/published-date.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { extractPublishedDate, MAX_DATE_SCAN_CHARS } from "../../../src/lib/signals/published-date";

const iso = (d: Date | null) => d?.toISOString() ?? null;

describe("extractPublishedDate", () => {
  it("reads article:published_time, the most reliable source", () => {
    const html = `<html><head><meta property="article:published_time" content="2026-08-01T09:30:00Z"></head></html>`;
    expect(iso(extractPublishedDate(html))).toBe("2026-08-01T09:30:00.000Z");
  });

  it("falls back to og:published_time", () => {
    const html = `<meta property="og:published_time" content="2026-07-15T00:00:00Z">`;
    expect(iso(extractPublishedDate(html))).toBe("2026-07-15T00:00:00.000Z");
  });

  it("falls back to JSON-LD datePublished", () => {
    const html = `<script type="application/ld+json">{"@type":"Article","datePublished":"2026-06-02T12:00:00Z"}</script>`;
    expect(iso(extractPublishedDate(html))).toBe("2026-06-02T12:00:00.000Z");
  });

  it("falls back to a time element's datetime attribute", () => {
    const html = `<article><time datetime="2026-05-20">May 20</time></article>`;
    expect(extractPublishedDate(html)?.getUTCFullYear()).toBe(2026);
  });

  it("prefers article:published_time over the later sources", () => {
    const html = `
      <meta property="article:published_time" content="2026-08-01T00:00:00Z">
      <meta property="og:published_time" content="2020-01-01T00:00:00Z">
      <time datetime="1999-01-01">old</time>`;
    expect(iso(extractPublishedDate(html))).toBe("2026-08-01T00:00:00.000Z");
  });

  it("accepts single-quoted attributes and reversed attribute order", () => {
    const html = `<meta content='2026-04-04T00:00:00Z' property='article:published_time'>`;
    expect(iso(extractPublishedDate(html))).toBe("2026-04-04T00:00:00.000Z");
  });

  it("returns null when the page carries no date at all", () => {
    expect(extractPublishedDate("<html><body><p>No date here.</p></body></html>")).toBeNull();
  });

  it("rejects an unparseable value rather than returning an invalid Date", () => {
    const html = `<meta property="article:published_time" content="not a date">`;
    expect(extractPublishedDate(html)).toBeNull();
  });

  it("rejects a future date as a template artefact", () => {
    const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 400).toISOString();
    expect(extractPublishedDate(`<meta property="article:published_time" content="${future}">`)).toBeNull();
  });

  it("rejects a pre-2000 date as a template artefact", () => {
    expect(extractPublishedDate(`<meta property="article:published_time" content="0001-01-01T00:00:00Z">`)).toBeNull();
  });

  it("is bounded: a large hostile page returns quickly", () => {
    // The pattern that shipped a ReDoS on this branch was attribute-scanning
    // code just like this one, measured at 841ms on 32KB.
    const hostile = `<meta property="article:published_time" content="${'"'.repeat(50_000)}`.padEnd(400_000, "<");
    const start = Date.now();
    extractPublishedDate(hostile);
    expect(Date.now() - start).toBeLessThan(200);
  });

  it("only scans the first MAX_DATE_SCAN_CHARS", () => {
    const buried = "x".repeat(MAX_DATE_SCAN_CHARS + 100) +
      `<meta property="article:published_time" content="2026-08-01T00:00:00Z">`;
    expect(extractPublishedDate(buried)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/signals/published-date.test.ts`
Expected: FAIL — `Cannot find module '../../../src/lib/signals/published-date'`.

- [ ] **Step 3: Implement the extractor**

Create `src/lib/signals/published-date.ts`:

```typescript
/**
 * Reads an article's publication date out of its own HTML.
 *
 * Needed because Tavily's general index — the one that actually carries
 * professional and opinion writing — returns no `published_date` at all, on any
 * result. The news index does supply dates, but a live probe found it returns
 * Google News aggregator URLs and near-zero relevance for this domain, so it is
 * not an option. The page itself is also a better authority than a search index.
 *
 * Pure: no network, no database. The caller has already fetched the HTML through
 * `fetchPageText`, which is what makes the fetch safe.
 */

/**
 * Article HTML arrives from a search result and is attacker-influenced, so every
 * pattern below is bounded and the input is clamped before any of them run.
 * This branch has already shipped one ReDoS in attribute-scanning code
 * (`extractSameOriginLinks`, measured at 841ms on 32KB) — do not relax this.
 */
export const MAX_DATE_SCAN_CHARS = 200_000;

/** Below this, a date is a template artefact (`0001-01-01`, Unix-epoch defaults). */
const EARLIEST_PLAUSIBLE_YEAR = 2000;

/**
 * Ordered most-reliable first; first match wins. `article:published_time` is
 * the only one of these that means "this article was published at", which is
 * why it outranks the rest even when they disagree.
 *
 * Each accepts either quote style and either attribute order — publishers emit
 * both — using negated character classes so there is no backtracking.
 */
const PATTERNS: RegExp[] = [
  /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']{4,64})["']/i,
  /<meta[^>]+content=["']([^"']{4,64})["'][^>]+property=["']article:published_time["']/i,
  /<meta[^>]+property=["']og:published_time["'][^>]+content=["']([^"']{4,64})["']/i,
  /<meta[^>]+content=["']([^"']{4,64})["'][^>]+property=["']og:published_time["']/i,
  /"datePublished"\s*:\s*"([^"]{4,64})"/i,
  /<time[^>]+datetime=["']([^"']{4,64})["']/i,
];

export function extractPublishedDate(html: string): Date | null {
  const scanned = html.length > MAX_DATE_SCAN_CHARS ? html.slice(0, MAX_DATE_SCAN_CHARS) : html;

  for (const pattern of PATTERNS) {
    const match = pattern.exec(scanned);
    if (!match) continue;

    const parsed = new Date(match[1].trim());
    if (Number.isNaN(parsed.getTime())) continue;

    // A page claiming to be published in the future is a scheduled-publish
    // stamp or a template placeholder, not an article date. A day of slack
    // absorbs timezone skew between us and the publisher.
    if (parsed.getTime() > Date.now() + 24 * 60 * 60 * 1000) continue;
    if (parsed.getUTCFullYear() < EARLIEST_PLAUSIBLE_YEAR) continue;

    return parsed;
  }

  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/signals/published-date.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Prove the clamp is load-bearing**

Temporarily change `const scanned = …` to `const scanned = html;` and re-run. The "only scans the first MAX_DATE_SCAN_CHARS" test must **fail**. Restore it. If it still passes, the fixture is not actually burying the meta tag past the limit — fix the fixture and say so.

- [ ] **Step 6: Commit**

```bash
git add src/lib/signals/published-date.ts tests/lib/signals/published-date.test.ts
git commit -m "feat: extract publication dates from article HTML"
```

---

### Task 2: Search the general index, minus job boards

**Files:**
- Modify: `src/lib/signals/tavily.ts`
- Test: `tests/lib/signals/tavily.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export const TAVILY_TOPIC = "general"`, `export const TAVILY_TIME_RANGE = "week"`, `export const EXCLUDED_DOMAINS: string[]`. `NewsHit` is unchanged — `publishedAt` stays on the type and will simply be `null` for every general-index result, which Task 3 handles.

- [ ] **Step 1: Write the failing tests**

Add to `tests/lib/signals/tavily.test.ts`, reusing the file's existing `SAMPLE`, `okResponse` and env-var `beforeEach`/`afterEach`:

```typescript
  it("searches the general index, where professional writing actually lives", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(SAMPLE));

    await searchNews("design localization", { fetchImpl });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    // A live probe found topic:"news" returns Google News aggregator URLs and
    // near-zero relevance for this domain. See the plan's "Why each change".
    expect(body.topic).toBe("general");
    expect(body.time_range).toBe("week");
  });

  it("excludes job boards and aggregators, which otherwise dominate", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(SAMPLE));

    await searchNews("ux content management", { fetchImpl });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    // Without this the top three results were Google Careers, Target and an
    // edtech UX Writer posting.
    expect(body.exclude_domains).toContain("careers.google.com");
    expect(body.exclude_domains).toContain("indeed.com");
    expect(body.exclude_domains).toContain("news.google.com");
  });

  it("still yields hits when the general index omits published_date", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({
        results: [{ title: "A guide", url: "https://phrase.com/blog/guide", content: "x", score: 0.78 }],
      })
    );

    const result = await searchNews("q", { fetchImpl });

    expect("hits" in result).toBe(true);
    if (!("hits" in result)) return;
    expect(result.hits).toHaveLength(1);
    // Every general-index result is undated. Task 3 reads the date off the page.
    expect(result.hits[0].publishedAt).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/signals/tavily.test.ts`
Expected: FAIL — `body.topic` is `"news"`, `body.time_range` is `"day"`, `body.exclude_domains` is undefined.

- [ ] **Step 3: Implement**

In `src/lib/signals/tavily.ts`, add above `searchNews`:

```typescript
/**
 * The general index, not the news index.
 *
 * A live probe on 2026-08-06 found `topic: "news"` unusable for this product's
 * niche: on "design localization" it returned relevance scores of 0.11 down to
 * 0.01 (LiDAR perception, the World Gold Council, payment failures) and every
 * result's URL was `www.google.com` — Google News aggregator redirects, not
 * article links. Those collapse under `normalizeArticleUrl` into one host and
 * defeat `externalId` uniqueness.
 *
 * The same query on the general index returned Phrase, Webflow, Lilt and
 * SimpleLocalize writing substantively about multilingual UX. That is the
 * material this product exists to surface.
 *
 * The cost of the switch: the general index returns no `published_date` on any
 * result, so dates come from the article's own HTML instead — see
 * `published-date.ts`.
 */
export const TAVILY_TOPIC = "general";

/**
 * Matches the daily cron loosely rather than exactly: professional articles
 * keep their value for longer than news events, so a piece published on
 * Thursday is still worth surfacing on Monday.
 *
 * Known risk, accepted deliberately: the week-windowed probe returned job
 * postings, and `EXCLUDED_DOMAINS` below is what should remove them. That exact
 * combination has not been observed live. This is a one-line constant so it can
 * be widened to "month" — which is what produced the best probe results — once
 * a real run says whether the exclusions did their job.
 */
export const TAVILY_TIME_RANGE = "week";

/**
 * Job boards and search aggregators. Both are noise for this product but for
 * different reasons: job postings match the topic vocabulary exactly while
 * carrying no editorial content, and aggregators return their own URLs rather
 * than the article's, which breaks URL-keyed identity downstream.
 */
export const EXCLUDED_DOMAINS = [
  "careers.google.com",
  "corporate.target.com",
  "indeed.com",
  "glassdoor.com",
  "ziprecruiter.com",
  "lever.co",
  "greenhouse.io",
  "workday.com",
  "news.google.com",
  "google.com",
];
```

Then change the request body — replace the `topic` and `time_range` lines and add the exclusion:

```typescript
        topic: TAVILY_TOPIC,
        search_depth: "basic",
        time_range: TAVILY_TIME_RANGE,
        exclude_domains: EXCLUDED_DOMAINS,
        max_results: TAVILY_MAX_RESULTS,
```

**Delete the old comment above `topic`** — the one saying the news topic is what makes `published_date` available. It described the previous design and is now false, which this codebase treats as a bug.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/signals/tavily.test.ts`
Expected: PASS. Existing tests that assert `topic: "news"` or `time_range: "day"` will need their expectations updated — **that is expected and correct here**, since the behaviour deliberately changed. Update those assertions. **Do not weaken any assertion that is not about the topic or the window**; if one needs to change for another reason, stop and report.

- [ ] **Step 5: Commit**

```bash
git add src/lib/signals/tavily.ts tests/lib/signals/tavily.test.ts
git commit -m "feat: search the general index, excluding job boards"
```

---

### Task 3: Date the articles, rank dated first, and stop demanding an event

**Files:**
- Modify: `src/lib/signals/news-agent.ts`
- Modify: `src/lib/signals/news-selection.ts`
- Test: `tests/lib/signals/news-agent.test.ts`, `tests/lib/signals/news-selection.test.ts`

**Interfaces:**
- Consumes: `extractPublishedDate` (Task 1). From Task 2, `TAVILY_TIME_RANGE` — the two windows
  are **coupled, not independent**. Tavily's `time_range` is the outer window, a coarse
  index-side filter deciding what is fetched at all; `RECENCY_WINDOW_DAYS` is the inner window,
  our own rule applied to the real page date. Widening `TAVILY_TIME_RANGE` alone admits 8–30-day-old
  articles that `RECENCY_WINDOW_DAYS` then discards after paying for the fetch, so only *undated*
  articles would benefit; widening `RECENCY_WINDOW_DAYS` alone has nothing new to admit, because
  Tavily never returned it. They must be changed together, and each constant's comment must
  cross-reference the other.
- Produces: `export const RECENCY_WINDOW_DAYS = 7`. `NewsRunResult` gains `stale: number` — articles dropped because their extracted date was outside the window.

**The pipeline after this task:**

1. search → dedupe → skip-held → Tavily-score filter → truncate → **fetch** *(unchanged)*
2. **new:** extract each article's date from the HTML we just fetched
3. **new:** drop articles whose extracted date is older than `RECENCY_WINDOW_DAYS`. Undated articles are **kept** — that is a product decision, not an oversight
4. **new:** re-order dated articles ahead of undated ones before the selector sees them
5. select → write, with `occurredAt` preferring the extracted date

- [ ] **Step 1: Write the failing tests**

Add to `tests/lib/signals/news-agent.test.ts`. The file already has `seedTenant`, `seedNewsSource`, `page`, `hit` and its `afterEach` — reuse them. These tests need control over the fetched HTML, so widen the file's existing `page()` helper with an optional second parameter rather than adding a second helper. It currently reads `function page(text: string): PageResult` and builds `html: \`<p>${text}</p>\``; change it to:

```typescript
function page(text: string, html = `<p>${text}</p>`): PageResult {
  return { text, html, finalUrl: "https://news.example.com/a", contentType: "text/html", truncated: false };
}
```

Every existing call passes one argument and keeps its current behaviour.

```typescript
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
    // It never reaches the model — that is the point of enforcing it here.
    expect(select.mock.calls[0][0]).toHaveLength(0);
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
```

And add to `tests/lib/signals/news-selection.test.ts`:

```typescript
  it("welcomes professional and opinion writing rather than demanding an event", async () => {
    const generate = generateReturning([]);

    await selectNewsSignals([candidate(0)], PROFILE, [], "t1", { generate });

    const system = generate.mock.calls[0][0].system as string;
    // The old rule — "any item whose only claim is that it exists rather than
    // that something happened" — rejected exactly the trade essays and
    // practitioner guides this feed is meant to carry.
    expect(system).not.toMatch(/something happened/i);
    expect(system).toMatch(/opinion|analysis|guide/i);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/signals/news-agent.test.ts tests/lib/signals/news-selection.test.ts`
Expected: FAIL — `result.stale` is undefined, ordering is by Tavily score, and the system prompt still contains "something happened".

- [ ] **Step 3: Add the constant and the imports**

In `src/lib/signals/news-agent.ts`, add one import:

```typescript
import { extractPublishedDate } from "@/lib/signals/published-date";
```

`NewsHit` is **already imported** in that file (`import { searchNews, type NewsHit, type TavilyResult } …`), so the `kept` declaration below needs no new type import. Do not add a duplicate.

and add beside the other constants:

```typescript
/**
 * How recent an article must be to be worth surfacing, when we can tell.
 *
 * Enforced here rather than left to Tavily's `time_range` because the general
 * index returns no dates at all — its window filters on its own crawl notion of
 * recency, which is how a two-year-old evergreen guide can arrive inside a
 * one-week window. This is the only place a real publication date is known.
 *
 * Applies ONLY to articles we could date. An undated article is kept and ranked
 * below dated ones: dropping them would discard most professional writing,
 * which is the content this agent exists to surface.
 */
export const RECENCY_WINDOW_DAYS = 7;
```

Add `stale` to `NewsRunResult`:

```typescript
  /** Dropped because the article's own page date was outside RECENCY_WINDOW_DAYS. */
  stale: number;
```

and `stale: 0` to the `empty` literal.

- [ ] **Step 4: Date, filter and re-rank after the fetch**

In `src/lib/signals/news-agent.ts`, the fetch loop currently collects `bodies: string[]`. Replace it so it collects the HTML too, then dates and re-ranks. Replace the block from `const bodies: string[] = [];` through the end of the fetch loop with:

```typescript
  const bodies: string[] = [];
  const dates: (Date | null)[] = [];
  for (let i = 0; i < fresh.length; i += FETCH_CONCURRENCY) {
    const batch = await Promise.all(
      fresh.slice(i, i + FETCH_CONCURRENCY).map(async (article) => {
        const result = await fetchPage(article.url);
        if ("error" in result) {
          // Tavily's own extract is real page text, not a model's paraphrase, so
          // falling back to it keeps the evidence honest. A paywalled or slow
          // article is still worth surfacing — but we cannot date it.
          return { body: article.content, date: article.publishedAt };
        }
        // The page is the authority on its own date; the index gave us none.
        return { body: result.text, date: extractPublishedDate(result.html) ?? article.publishedAt };
      })
    );
    for (const b of batch) {
      bodies.push(b.body);
      dates.push(b.date);
    }
  }

  // ── Recency, enforced only where it is actually known ──────────────────
  const cutoff = new Date(Date.now() - RECENCY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const kept: { article: NewsHit; body: string; date: Date | null }[] = [];
  let stale = 0;
  for (const [i, article] of fresh.entries()) {
    const date = dates[i];
    if (date !== null && date < cutoff) {
      stale++;
      continue;
    }
    kept.push({ article, body: bodies[i], date });
  }

  if (kept.length === 0) {
    errors.push(`All ${fresh.length} fetched articles were older than ${RECENCY_WINDOW_DAYS} days.`);
    await finish(database, source.id, errors.join("; "), productive);
    return { ...empty, skipped, credits };
  }

  // Dated articles first, each group by Tavily score. An undated article is not
  // rejected, just outranked — the model reads in order, so this is how "we know
  // when this was written" earns its place without becoming a filter.
  kept.sort((a, b) => {
    const aDated = a.date !== null ? 1 : 0;
    const bDated = b.date !== null ? 1 : 0;
    if (aDated !== bDated) return bDated - aDated;
    return (b.article.score ?? 0) - (a.article.score ?? 0);
  });
```

Then rewrite the candidate construction and the write loop to read from `kept` instead of the parallel `fresh`/`bodies` arrays:

```typescript
  const candidates: NewsCandidate[] = kept.map((k) => ({
    title: k.article.title,
    text: k.body.slice(0, SCORING_EXCERPT_CHARS),
    url: k.article.url,
  }));
```

and in the write loop, replace `fresh[selection.index]` / `bodies[selection.index]` with a single lookup:

```typescript
  for (const selection of outcome.selections) {
    const chosen = kept[selection.index];
    if (!chosen) continue;
    const article = chosen.article;
    const body = chosen.body;
```

using `chosen.date ?? now` for `occurredAt`. Update `dropped` to `kept.length - outcome.selections.length`, and return `stale` alongside the other counts.

> **`kept` is now the single ordered source of truth.** `fresh` and `bodies` must not be indexed by `selection.index` anywhere after the sort — they are in a different order. If you find a remaining use, that is the bug this note exists to prevent.

- [ ] **Step 5: Soften the selection prompt**

In `src/lib/signals/news-selection.ts`'s `buildSystem`, replace the clause requiring an event. The line currently ending `"…rather than that something happened."` becomes:

```typescript
    "NEVER qualifying on their own: routine version bumps, incremental feature notes, maintenance",
    "and patch releases, generic market-size statistics and analyst forecasts, listicles and",
    "roundups, press releases with no substance, job postings, and SEO filler that restates",
    "common knowledge.",
    "",
    "A substantive opinion piece, analysis, or practitioner guide DOES qualify — it does not have",
    "to report an event. What matters is whether someone in this company's field would be glad",
    "they read it, not whether something happened.",
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/signals/news-agent.test.ts tests/lib/signals/news-selection.test.ts`
Expected: PASS.

- [ ] **Step 7: Prove the re-rank is real**

Temporarily delete the `kept.sort(...)` call and re-run. The "ranks dated articles ahead of undated ones" test must **fail** (the undated 0.9 article would come first). Restore it.

- [ ] **Step 8: Full verification**

Run: `npm run test && npm run typecheck && npm run lint`

Baseline: 155 test files / 1136 tests, typecheck clean, lint 0 errors / 9 warnings. **Run the suite twice** — it is flaky, and a failure in a file you did not touch is very likely contention rather than a defect.

- [ ] **Step 9: Commit**

```bash
git add src/lib/signals/news-agent.ts src/lib/signals/news-selection.ts tests/lib/signals
git commit -m "feat: date articles from their own pages and rank dated first"
```

---

## Tunable knobs

| Constant | Value | What it trades |
|---|---|---|
| `TAVILY_TOPIC` | `"general"` | Index breadth. `"news"` is measured-unusable for this niche |
| `TAVILY_TIME_RANGE` | `"week"` | Tavily-side coarse window. `"month"` produced the best probe results |
| `EXCLUDED_DOMAINS` | 10 hosts | Job boards and aggregators. Expect to grow from observation |
| `RECENCY_WINDOW_DAYS` | 7 | Our own recency rule, applied only to datable articles |
| `TAVILY_SCORE_FLOOR` | 0.05 | Existing; general-index scores run higher than news-index ones, so revisit |

## Known gaps, accepted

- **Undated articles enter the feed as "seen now"**, so they rank fresh under spec 5's decay. That is the direct consequence of keeping them, and it is the chosen trade.
- **`MAX_TOPICS_PER_RUN` still takes the first five topics in profile order**, which for the test tenant means the two broadest terms dominate and the most distinctive ones are never searched. Unchanged here; it wants either rotation or a deliberate ordering, and neither is in this plan.
- **Rejected articles are still recorded nowhere**, so a below-bar article is re-fetched each day it stays inside the window. Widening `TAVILY_TIME_RANGE` multiplies that directly.
- **`TAVILY_SCORE_FLOOR` was calibrated against news-index scores.** General-index scores in the probes ran higher (0.44–0.78 versus 0.02–0.42), so the floor is now doing less work than it was tuned to do.
