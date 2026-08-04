# Competitor Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the signals layer its first external producer — a daily agent that watches each competitor's changelog and blog and writes `competitor_move` signals.

**Scope:** This is the second half of the design doc's spec 3. The signals layer (schema, shipped-work reconciler, browser) is already built and on the branch.

**Architecture:** Five stages, matching the contract the design doc sets for every source agent — **fetch → extract → tier-1 drop → tier-2 relevance → write signal**. Acquisition prefers RSS/Atom over scraping because feed entries carry real ids and dates. Every external fetch goes through spec 2's SSRF-guarded `fetchPageText`. The sweep copies `resolve-sweep.ts`'s posture: per-tenant isolation, log and continue, never throw out of the cron.

**Tech Stack:** Next.js 16 (App Router), Drizzle ORM + drizzle-kit, Postgres (Supabase), AI SDK v7 + `@ai-sdk/anthropic`, `fast-xml-parser`, Vitest against a real `_test` database, TypeScript strict.

## Global Constraints

- **This is not the Next.js you know.** Read the relevant guide in `node_modules/next/dist/docs/` before writing any App Router code. Heed deprecation notices. (`AGENTS.md`)
- Tests run against a **real Postgres database whose name must end in `_test`** (`vitest.setup.ts` hard-fails otherwise). After every schema change run `npm run db:migrate:test` before `npm run test`.
- The LLM provider is **Anthropic directly** via `@ai-sdk/anthropic`, not the Vercel AI Gateway. Do not "fix" this.
- Every LLM call records usage via `recordLlmUsage`. **`operation` is typed as `LlmOperation`, a closed string-literal union in `src/lib/ai/llm-usage.ts`** — a new operation must be added there or the call will not type-check. The database column is free text, so this is invisible until `tsc` runs.
- **Every external fetch goes through `fetchPageText`.** It carries redirect re-validation, private-IP rejection, a hard byte cap, a timeout, and a `MAX_SCAN_CHARS` clamp against quadratic regex backtracking. A competitor URL is attacker-influenced input by definition. There is no exception anywhere in this plan.
- **No test may execute a real unscoped sweep against the shared test database** unless that sweep is what it is testing. Vitest runs 140 files in parallel against one database, and the sweeps here operate across all tenants. Mock them everywhere else.
- Follow the existing schema conventions in `src/db/schema.ts`: comments explain *why*, not what.
- Never edit the Vercel `DATABASE_URL` env var.
- **Deletion lists come from exports and importers, never from a module's name.** Before deleting or wholesale-replacing any file, `grep -n "^export"` it and grep its importers.
- **Where this plan gives both prose and a code sample, the code sample is authoritative — and if they contradict each other, stop and report it rather than picking one.** A previous plan's prose said "match this file's error-handling posture" while its code sample did something coarser; the implementer transcribed the sample faithfully and shipped a cross-tenant failure blast radius. Disagreement between the two is a plan bug, and catching it is worth more than guessing right.
- **The tests in this plan are the contract; several implementation steps are prose rather than full code, deliberately.** Earlier plans in this series gave complete implementations, and implementers transcribed them faithfully — including the bugs in them. Where the behaviour is fully pinned by the test code above it, the prose says what to build and leaves *how* to you. If a test and its prose ever disagree, the test wins, and tell me. If you find yourself unable to satisfy a test from the prose, that is a plan gap worth reporting rather than improvising around.

## Decisions this plan locks in

**One new runtime dependency: `fast-xml-parser`.** Most changelogs and blogs publish RSS or Atom, which gives structured entries with real ids, titles and dates — far better signal quality than scraping list pages, where entry boundaries and dates have to be guessed. Hand-rolling XML with regexes is how spec 2's ReDoS got introduced, so this is not a place to economise. `fast-xml-parser` is small, pure JS, and has no native dependencies.

*If you would rather not add it:* only Task 2 changes. Drop feed parsing entirely and treat every source as the HTML-plus-content-hash case from Task 5. The cost is one coarse "this page changed" signal per source per run instead of one signal per actual entry, with no real dates — which materially degrades spec 5's ranking, since it decays on `occurredAt`.

**Never invent a date.** An unparseable or absent feed date becomes `null`, and the agent falls back to the fetch time only when writing the signal, recording that it did. Spec 5's ranking decays on `occurredAt`; a fabricated "now" makes every old entry look fresh, which is the exact failure the `occurredAt` column comment forbids and which the shipped-work reconciler was already fixed for once.

**Path matching is by segment, not substring.** `crawl-company-site.ts`'s `rank()` uses `path.includes()`, which its own review flagged: `/blog/why-we-left-jira` scores as a blog index. Source discovery needs segment-exact matching. Write a new ranker here and **leave `crawl-company-site.ts` alone** — its substring matching is harmless for a one-shot bootstrap, and changing it is out of scope.

**Relevance scoring is batched, fails open, and gets its own model variable.** One `generateObject` call scores a whole run's surviving items. Results are matched back by an explicit `index` field, never by array position. A classifier error writes every item unscored rather than dropping any — a missed competitor move is invisible, an unscored row in the browser announces itself, and `listSignals` already keeps null-scored rows through a minimum-score filter. It uses `RELEVANCE_MODEL`, not `ONBOARDING_ANALYSIS_MODEL`, which already drives two operations.

**Source health flips on a single failure.** `status` goes to `failing` on any failed run and back to `active` on the next success. No consecutive-failure counter — that would need state in `watermark` for little gain at a daily cadence. The tradeoff, stated so nobody treats it as a bug: one transient blip shows as `failing` in settings until the next day's run clears it. That is the right direction to err for a surface whose whole job is making silent rot visible.

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/lib/workspace/fetch-page.ts` | Gains `finalUrl` and `discoverFeedUrl` | 1 |
| `src/lib/signals/feed.ts` | RSS/Atom → normalized `FeedEntry[]` | 2 |
| `src/lib/signals/discover-sources.ts` | Propose watchable URLs for a competitor | 3 |
| `src/lib/signals/relevance.ts` | Batched tier-2 relevance scoring | 4 |
| `src/lib/signals/competitor-agent.ts` | One source: fetch → tier-1 → tier-2 → write | 5 |
| `src/lib/signals/sweep.ts` | All sources, per-tenant isolation | 6 |
| `src/app/api/cron/scheduler/route.ts` | Runs the sweep | 6 |
| `src/app/(dashboard)/company/*` | Source discovery and health | 3, 6 |

---

### Task 1: `finalUrl` and feed autodiscovery

**Files:**
- Modify: `src/lib/workspace/fetch-page.ts`, `src/lib/workspace/brand-import.ts`, `src/lib/signals/crawl-company-site.ts` (import path only if needed)
- Test: `tests/lib/workspace/fetch-page.test.ts`, and update `tests/lib/workspace/brand-import.test.ts` and `tests/lib/workspace/crawl-company-site.test.ts` where they construct `PageResult` literals

**Interfaces:**
- Consumes: nothing
- Produces: `PageResult` success shape becomes `{ text: string; html: string; finalUrl: string }`; `discoverFeedUrl(html: string, baseUrl: string): string | null`

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/workspace/fetch-page.test.ts`:

```ts
import { discoverFeedUrl } from "../../../src/lib/workspace/fetch-page";

describe("discoverFeedUrl", () => {
  const base = "https://acme.com/blog";

  it("finds an advertised RSS feed and resolves it against the base", () => {
    const html = `<link rel="alternate" type="application/rss+xml" href="/blog/feed.xml">`;
    expect(discoverFeedUrl(html, base)).toBe("https://acme.com/blog/feed.xml");
  });

  it("finds an advertised Atom feed", () => {
    const html = `<link rel="alternate" type="application/atom+xml" href="https://acme.com/atom.xml">`;
    expect(discoverFeedUrl(html, base)).toBe("https://acme.com/atom.xml");
  });

  it("tolerates attributes in any order and single quotes", () => {
    const html = `<link type='application/rss+xml' title='Feed' rel='alternate' href='/f.xml'>`;
    expect(discoverFeedUrl(html, base)).toBe("https://acme.com/f.xml");
  });

  it("returns the first when a page advertises both", () => {
    const html = `
      <link rel="alternate" type="application/rss+xml" href="/rss.xml">
      <link rel="alternate" type="application/atom+xml" href="/atom.xml">`;
    expect(discoverFeedUrl(html, base)).toBe("https://acme.com/rss.xml");
  });

  it("ignores alternate links that are not feeds", () => {
    const html = `<link rel="alternate" hreflang="de" href="/de/blog">`;
    expect(discoverFeedUrl(html, base)).toBeNull();
  });

  it("ignores a feed type on a link that is not rel=alternate", () => {
    const html = `<link rel="preload" type="application/rss+xml" href="/rss.xml">`;
    expect(discoverFeedUrl(html, base)).toBeNull();
  });

  it("returns null for no feed, malformed html, or an unparseable base", () => {
    expect(discoverFeedUrl("<p>nothing</p>", base)).toBeNull();
    expect(discoverFeedUrl("<link rel=", base)).toBeNull();
    expect(discoverFeedUrl(`<link rel="alternate" type="application/rss+xml" href="/f.xml">`, "not a url")).toBeNull();
  });
});
```

For `finalUrl`, extend the existing redirect test in `fetch-page.test.ts` — find it with `grep -n "redirect" tests/lib/workspace/fetch-page.test.ts` — so that after following a redirect it also asserts:

```ts
    if ("error" in result) throw new Error("expected success");
    expect(result.finalUrl).toBe("https://example.com/final");
```

using whatever destination that test's redirect chain actually ends at. The point is that `finalUrl` is where the fetch **landed**, not what was requested — if it equals the requested URL after a redirect, the field is wired to the wrong variable.

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/lib/workspace/fetch-page.test.ts`
Expected: FAIL — `discoverFeedUrl` is not exported.

- [ ] **Step 3: Add `finalUrl`**

Change the type and the success return:

```ts
export type PageResult = { text: string; html: string; finalUrl: string } | { error: PageError };
```

```ts
        return { text, html, finalUrl: current.toString() };
```

**Do not change the origin check in `crawlCompanySite`.** It anchors on the *requested* URL, and spec 2's review confirmed that is what stops a homepage redirecting to a hostile host from steering the crawl onto that host's links. `finalUrl` is for recording and relative resolution only, never for the origin decision. Add a one-line comment on the field saying so.

Then update every `PageResult` literal in the test suite — `tests/lib/workspace/brand-import.test.ts` has four mocks and `tests/lib/workspace/crawl-company-site.test.ts` has several. Find them with `grep -rn "html:" tests/lib/workspace/`. These are mechanical additions; if any *assertion* needs changing, stop and report, because the fetch behaviour did not change.

- [ ] **Step 4: Add `discoverFeedUrl`**

```ts
// Bounded quantifier plus the MAX_SCAN_CHARS clamp below: this regex runs over
// attacker-influenced third-party HTML, and an unbounded `[^>]*` on input full
// of unclosed tags is exactly the quadratic backtracking that had to be fixed
// in extractSameOriginLinks. Two stages — find bounded <link> tags, then test
// each one — is also clearer than one regex trying to handle attribute order.
const LINK_TAG = /<link\b[^>]{0,500}>/gi;
const REL_ALTERNATE = /\brel\s*=\s*["']?alternate\b/i;
const FEED_TYPE = /\btype\s*=\s*["']application\/(?:rss|atom)\+xml/i;
const HREF = /\bhref\s*=\s*["']([^"']+)["']/i;

/**
 * The feed a page advertises, if any. Preferred over scraping the page itself
 * because feed entries carry real ids and dates; a changelog list page gives
 * neither reliably, and spec 5's ranking decays on the date.
 */
export function discoverFeedUrl(html: string, baseUrl: string): string | null {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }

  const scanned = html.slice(0, MAX_SCAN_CHARS);
  for (const [tag] of scanned.matchAll(LINK_TAG)) {
    if (!REL_ALTERNATE.test(tag) || !FEED_TYPE.test(tag)) continue;
    const href = tag.match(HREF)?.[1];
    if (!href) continue;
    try {
      return new URL(href, base).toString();
    } catch {
      continue;
    }
  }
  return null;
}
```

- [ ] **Step 5: Verify and commit**

```bash
npm run typecheck && npm run test && npm run lint
git add -A
git commit -m "feat: finalUrl and feed autodiscovery on the page fetcher

Signals need canonical post-redirect URLs, and feeds beat scraping
because their entries carry real ids and dates."
```

---

### Task 2: RSS and Atom parsing

**Files:**
- Modify: `package.json` (adds `fast-xml-parser`)
- Create: `src/lib/signals/feed.ts`
- Test: `tests/lib/signals/feed.test.ts`

**Interfaces:**
- Consumes: `htmlToText` from `fetch-page.ts`
- Produces: `type FeedEntry = { id: string; title: string; url: string | null; publishedAt: Date | null; excerpt: string | null }`; `parseFeed(xml: string, baseUrl: string): FeedEntry[]`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/signals/feed.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseFeed } from "../../../src/lib/signals/feed";

const BASE = "https://rival.com/changelog";

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Rival changelog</title>
  <item>
    <title>SSO for all plans</title>
    <link>https://rival.com/changelog/sso</link>
    <guid>https://rival.com/changelog/sso</guid>
    <pubDate>Wed, 15 Jul 2026 10:00:00 GMT</pubDate>
    <description>&lt;p&gt;Every plan now includes &lt;b&gt;SAML&lt;/b&gt; SSO.&lt;/p&gt;</description>
  </item>
  <item>
    <title>Dark mode</title>
    <link>/changelog/dark-mode</link>
    <pubDate>not a date</pubDate>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Ambiguity prediction</title>
    <link href="https://rival.com/blog/ambiguity"/>
    <id>tag:rival.com,2026:blog/ambiguity</id>
    <updated>2026-06-15T09:30:00Z</updated>
    <summary>Flags strings that would be ambiguous without context.</summary>
  </entry>
</feed>`;

const SINGLE_ITEM_RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item><title>Only one</title><link>https://rival.com/one</link><guid>g1</guid></item>
</channel></rss>`;

describe("parseFeed — RSS", () => {
  it("normalizes entries, decoding and stripping HTML from the description", () => {
    const [first] = parseFeed(RSS, BASE);
    expect(first.id).toBe("https://rival.com/changelog/sso");
    expect(first.title).toBe("SSO for all plans");
    expect(first.url).toBe("https://rival.com/changelog/sso");
    expect(first.publishedAt?.toISOString()).toBe("2026-07-15T10:00:00.000Z");
    expect(first.excerpt).toBe("Every plan now includes SAML SSO.");
  });

  it("falls back to the link as id when guid is absent, and resolves relative links", () => {
    const [, second] = parseFeed(RSS, BASE);
    expect(second.url).toBe("https://rival.com/changelog/dark-mode");
    expect(second.id).toBe("https://rival.com/changelog/dark-mode");
  });

  it("returns null for an unparseable date rather than inventing one", () => {
    const [, second] = parseFeed(RSS, BASE);
    expect(second.publishedAt).toBeNull();
  });

  it("handles a feed with exactly one item", () => {
    // fast-xml-parser returns an object rather than an array for a single
    // child unless told otherwise — the classic way this breaks in production
    // on a competitor who has published once.
    const entries = parseFeed(SINGLE_ITEM_RSS, BASE);
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe("Only one");
  });
});

describe("parseFeed — Atom", () => {
  it("normalizes entries using id, link href, and updated", () => {
    const [entry] = parseFeed(ATOM, BASE);
    expect(entry.id).toBe("tag:rival.com,2026:blog/ambiguity");
    expect(entry.title).toBe("Ambiguity prediction");
    expect(entry.url).toBe("https://rival.com/blog/ambiguity");
    expect(entry.publishedAt?.toISOString()).toBe("2026-06-15T09:30:00.000Z");
    expect(entry.excerpt).toBe("Flags strings that would be ambiguous without context.");
  });
});

describe("parseFeed — resilience", () => {
  it("returns an empty array for malformed XML rather than throwing", () => {
    expect(parseFeed("<rss><channel><item>", BASE)).toEqual([]);
    expect(parseFeed("not xml at all", BASE)).toEqual([]);
    expect(parseFeed("", BASE)).toEqual([]);
  });

  it("skips entries with no usable id and no link", () => {
    const xml = `<rss><channel><item><title>Orphan</title></item></channel></rss>`;
    expect(parseFeed(xml, BASE)).toEqual([]);
  });

  it("skips entries with no title", () => {
    const xml = `<rss><channel><item><guid>g</guid><link>https://rival.com/x</link></item></channel></rss>`;
    expect(parseFeed(xml, BASE)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/lib/signals/feed.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Install and implement**

```bash
npm install fast-xml-parser
```

Create `src/lib/signals/feed.ts`. The parser configuration is the one part given as code, because getting it wrong fails silently on real feeds rather than loudly:

```ts
import { XMLParser } from "fast-xml-parser";

// isArray: fast-xml-parser collapses a single child to an object rather than a
// one-element array, so a competitor who has published exactly once would
// otherwise parse to something the entry loop skips entirely — silently, and
// only for the sources with the least content. ignoreAttributes: false is what
// makes Atom's <link href="..."> readable at all.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => name === "item" || name === "entry" || name === "link",
});
```

Normalize per entry:
- **id**: RSS `guid` (text or `#text`) → else the resolved link → else skip the entry
- **title**: required; skip the entry without one
- **url**: RSS `link` text, or Atom `link@href`; resolved against `baseUrl`; null if unusable
- **publishedAt**: RSS `pubDate`, Atom `updated` then `published`. Parse with `new Date(...)` and **return null when `Number.isNaN(date.getTime())`** — never substitute the current time
- **excerpt**: RSS `description`, Atom `summary` then `content`, run through `htmlToText` and capped at ~500 chars

Wrap the whole parse in try/catch returning `[]`. A competitor serving broken XML must not throw into the agent.

- [ ] **Step 4: Verify and commit**

---

### Task 3: Source discovery for competitors

**Files:**
- Create: `src/lib/signals/discover-sources.ts`
- Modify: `src/app/(dashboard)/company/actions.ts`, `src/app/(dashboard)/company/competitors-editor.tsx`
- Test: `tests/lib/signals/discover-sources.test.ts`

**Interfaces:**
- Consumes: `fetchPageText`, `extractSameOriginLinks`, `discoverFeedUrl`
- Produces: `discoverCompetitorSources(tenantId, competitorId, websiteUrl, deps?): Promise<Source[]>`; server action `discoverSourcesAction(competitorId)`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/signals/discover-sources.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, competitors, sources } from "../../../src/db/schema";
import { discoverCompetitorSources } from "../../../src/lib/signals/discover-sources";
import type { PageResult } from "../../../src/lib/workspace/fetch-page";

const TENANT = "Discover Sources Test Tenant";
const LONG = "x".repeat(300);

function page(html: string, finalUrl: string): PageResult {
  return { text: `content ${LONG}`, html, finalUrl };
}

function fakeFetcher(pages: Record<string, PageResult>) {
  const calls: string[] = [];
  return {
    calls,
    fetchPage: async (url: string): Promise<PageResult> => {
      calls.push(url);
      return pages[url] ?? { error: "fetch-failed" };
    },
  };
}

async function seed() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  const [rival] = await db
    .insert(competitors)
    .values({ tenantId: tenant.id, name: "Rival", websiteUrl: "https://rival.com" })
    .returning();
  return { tenant, rival };
}

describe("discoverCompetitorSources", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("proposes changelog and blog pages linked from the homepage", async () => {
    const { tenant, rival } = await seed();
    const { fetchPage } = fakeFetcher({
      "https://rival.com": page(
        `<a href="/changelog">Changelog</a><a href="/blog">Blog</a><a href="/careers">Careers</a>`,
        "https://rival.com"
      ),
      "https://rival.com/changelog": page("<html></html>", "https://rival.com/changelog"),
      "https://rival.com/blog": page("<html></html>", "https://rival.com/blog"),
    });

    const created = await discoverCompetitorSources(tenant.id, rival.id, "https://rival.com", { fetchPage });

    expect(created.map((s) => s.url).sort()).toEqual([
      "https://rival.com/blog",
      "https://rival.com/changelog",
    ]);
    expect(created.every((s) => s.type === "competitor_web")).toBe(true);
    expect(created.every((s) => s.competitorId === rival.id)).toBe(true);
  });

  it("stores a discovered feed url alongside the page url", async () => {
    const { tenant, rival } = await seed();
    const { fetchPage } = fakeFetcher({
      "https://rival.com": page(`<a href="/changelog">Changelog</a>`, "https://rival.com"),
      "https://rival.com/changelog": page(
        `<link rel="alternate" type="application/rss+xml" href="/changelog/feed.xml">`,
        "https://rival.com/changelog"
      ),
    });

    const [source] = await discoverCompetitorSources(tenant.id, rival.id, "https://rival.com", { fetchPage });
    expect(source.url).toBe("https://rival.com/changelog");
    expect(source.feedUrl).toBe("https://rival.com/changelog/feed.xml");
  });

  it("matches path SEGMENTS, so an article under /blog is not mistaken for the blog index", async () => {
    const { tenant, rival } = await seed();
    const { fetchPage, calls } = fakeFetcher({
      "https://rival.com": page(`<a href="/blog/why-we-left-jira">A post</a>`, "https://rival.com"),
    });

    const created = await discoverCompetitorSources(tenant.id, rival.id, "https://rival.com", { fetchPage });

    expect(created).toEqual([]);
    expect(calls).toEqual(["https://rival.com"]);
  });

  it("creates at most three sources", async () => {
    const { tenant, rival } = await seed();
    const paths = ["/changelog", "/blog", "/news", "/releases", "/updates"];
    const pages: Record<string, PageResult> = {
      "https://rival.com": page(paths.map((p) => `<a href="${p}">${p}</a>`).join(""), "https://rival.com"),
    };
    for (const p of paths) pages[`https://rival.com${p}`] = page("<html></html>", `https://rival.com${p}`);

    const created = await discoverCompetitorSources(tenant.id, rival.id, "https://rival.com", {
      fetchPage: fakeFetcher(pages).fetchPage,
    });
    expect(created).toHaveLength(3);
  });

  it("is idempotent — a second run creates no duplicates", async () => {
    const { tenant, rival } = await seed();
    const pages = {
      "https://rival.com": page(`<a href="/changelog">Changelog</a>`, "https://rival.com"),
      "https://rival.com/changelog": page("<html></html>", "https://rival.com/changelog"),
    };
    const deps = { fetchPage: fakeFetcher(pages).fetchPage };

    await discoverCompetitorSources(tenant.id, rival.id, "https://rival.com", deps);
    await discoverCompetitorSources(tenant.id, rival.id, "https://rival.com", deps);

    const rows = await db.select().from(sources).where(eq(sources.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
  });

  it("writes nothing when the homepage cannot be fetched", async () => {
    const { tenant, rival } = await seed();
    const created = await discoverCompetitorSources(tenant.id, rival.id, "https://rival.com", {
      fetchPage: fakeFetcher({}).fetchPage,
    });

    expect(created).toEqual([]);
    const rows = await db.select().from(sources).where(eq(sources.tenantId, tenant.id));
    expect(rows).toHaveLength(0);
  });

  it("routes every request through the injected fetcher — no bare fetch", async () => {
    const { tenant, rival } = await seed();
    const { fetchPage, calls } = fakeFetcher({
      "https://rival.com": page(`<a href="/changelog">Changelog</a>`, "https://rival.com"),
      "https://rival.com/changelog": page("<html></html>", "https://rival.com/changelog"),
    });

    await discoverCompetitorSources(tenant.id, rival.id, "https://rival.com", { fetchPage });
    expect(calls).toEqual(["https://rival.com", "https://rival.com/changelog"]);
  });
});
```

- [ ] **Step 2: Run to confirm failure, then implement**

Rank candidates by matching **path segments exactly** against, in priority order: `changelog`, `release-notes`, `releases`, `whats-new`, `news`, `blog`, `updates`. Split the pathname on `/`, drop empties, and require an exact segment match — that is what makes the `/blog/why-we-left-jira` test pass.

Take the top three, fetch each **through the injected `fetchPage`**, call `discoverFeedUrl` on the result, and insert a `sources` row with `type: "competitor_web"`, the competitor id, the page URL, the feed URL (nullable) and a human `label` derived from the matched segment. Use `onConflictDoNothing` against `sources_tenant_url_unique` and re-select, mirroring `addCompetitor` in `src/lib/workspace/competitors.ts` — read that first and match its shape.

- [ ] **Step 3: Surface it in settings**

Add a "Find pages to watch" control per competitor in `competitors-editor.tsx`, backed by a `discoverSourcesAction(competitorId)` server action in `company/actions.ts`. Follow the existing actions in that file for the session and tenant pattern, and scope the competitor lookup by `session.user.tenantId` so an id from another workspace finds nothing — the same guard `removeCompetitorAction` uses.

- [ ] **Step 4: Verify and commit**

---

### Task 4: The batched relevance pass

**Files:**
- Create: `src/lib/signals/relevance.ts`
- Modify: `src/lib/ai/llm-usage.ts`
- Test: `tests/lib/signals/relevance.test.ts`

**Interfaces:**
- Consumes: `resolveModel`, `modelId`, `recordLlmUsage`, `companyProfiles`
- Produces: `type ScorableItem = { title: string; excerpt: string | null; url: string | null }`; `type ScoredItem = { score: number | null; rationale: string; topics: string[] }`; `scoreRelevance(items, profile, tenantId, deps?): Promise<ScoredItem[]>`

- [ ] **Step 1: Write the failing test**

The model call is injected so the mapping logic — which is where this can silently corrupt data — is tested without the network. Create `tests/lib/signals/relevance.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { scoreRelevance, type ScorableItem } from "../../../src/lib/signals/relevance";

const PROFILE = {
  name: "Acme",
  oneLiner: "Issue tracking for software teams.",
  positioning: "Fast where incumbents are configurable.",
  topics: ["developer productivity", "issue tracking"],
};

const ITEMS: ScorableItem[] = [
  { title: "They shipped SSO", excerpt: "Now on all plans.", url: "https://rival.com/a" },
  { title: "Dark mode", excerpt: null, url: "https://rival.com/b" },
  { title: "Patch release", excerpt: "Bug fixes.", url: "https://rival.com/c" },
];

describe("scoreRelevance", () => {
  it("maps scores back by index, not array position", async () => {
    const generate = vi.fn(async () => ({
      object: {
        scores: [
          { index: 2, score: 0.1, rationale: "routine patch", topics: [] },
          { index: 0, score: 0.9, rationale: "direct competitor capability", topics: ["sso"] },
          { index: 1, score: 0.4, rationale: "cosmetic", topics: [] },
        ],
      },
      usage: undefined,
    }));

    const scored = await scoreRelevance(ITEMS, PROFILE, "t1", { generate });

    expect(scored[0].score).toBe(0.9);
    expect(scored[1].score).toBe(0.4);
    expect(scored[2].score).toBe(0.1);
    expect(scored[0].topics).toEqual(["sso"]);
  });

  it("treats an omitted index as a scoring failure, not a zero", async () => {
    const generate = vi.fn(async () => ({
      object: { scores: [{ index: 0, score: 0.9, rationale: "ok", topics: [] }] },
      usage: undefined,
    }));

    const scored = await scoreRelevance(ITEMS, PROFILE, "t1", { generate });

    expect(scored[0].score).toBe(0.9);
    expect(scored[1].score).toBeNull();
    expect(scored[2].score).toBeNull();
    expect(scored[1].rationale).toMatch(/fail/i);
  });

  it("ignores an index the model invented", async () => {
    const generate = vi.fn(async () => ({
      object: {
        scores: [
          { index: 0, score: 0.5, rationale: "ok", topics: [] },
          { index: 99, score: 1, rationale: "phantom", topics: [] },
        ],
      },
      usage: undefined,
    }));

    const scored = await scoreRelevance(ITEMS, PROFILE, "t1", { generate });
    expect(scored).toHaveLength(3);
    expect(scored[0].score).toBe(0.5);
  });

  it("fails open — a thrown error leaves every item unscored, none dropped", async () => {
    const generate = vi.fn(async () => {
      throw new Error("model unavailable");
    });

    const scored = await scoreRelevance(ITEMS, PROFILE, "t1", { generate });

    expect(scored).toHaveLength(3);
    expect(scored.every((s) => s.score === null)).toBe(true);
    expect(scored[0].rationale).toMatch(/fail/i);
  });

  it("makes no model call for an empty item list", async () => {
    const generate = vi.fn();
    expect(await scoreRelevance([], PROFILE, "t1", { generate })).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to confirm failure, then implement**

```ts
export const RelevanceSchema = z.object({
  scores: z.array(
    z.object({
      index: z.number().int(),
      score: z.number().min(0).max(1),
      rationale: z.string(),
      topics: z.array(z.string()),
    })
  ),
});
```

Number the items in the prompt and require the model to echo each `index`. Build the result by starting from an all-unscored array and filling in the indices the model returned that are in range — that construction is what makes the omitted-index and phantom-index tests pass without extra branching.

Scoring is against `positioning` and `topics`. Add `"signal_relevance"` to `LlmOperation`. Use `process.env.RELEVANCE_MODEL ?? "anthropic/claude-haiku-4-5"`.

The unscored rationale must contain the word "failed" so the browser shows something honest rather than a blank — the tests assert on it.

- [ ] **Step 3: Verify and commit**

---

### Task 5: The per-source agent

**Files:**
- Create: `src/lib/signals/competitor-agent.ts`
- Test: `tests/lib/signals/competitor-agent.test.ts`

**Interfaces:**
- Consumes: `fetchPageText`, `parseFeed`, `scoreRelevance`, `signalWindowStart`, `sources`, `signals`, `companyProfiles`
- Produces: `runCompetitorSource(source, deps?): Promise<{ written: number; dropped: number; skipped: number }>`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/signals/competitor-agent.test.ts`. Inject `fetchPage` and `score` so nothing touches the network or a model:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, competitors, sources, signals, companyProfiles } from "../../../src/db/schema";
import { runCompetitorSource } from "../../../src/lib/signals/competitor-agent";
import type { PageResult } from "../../../src/lib/workspace/fetch-page";

const TENANT = "Competitor Agent Test Tenant";

const FEED = (items: string) => `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`;
const ITEM = (id: string, title: string, date: string) =>
  `<item><guid>${id}</guid><title>${title}</title><link>https://rival.com/${id}</link><pubDate>${date}</pubDate></item>`;

async function seed(feedUrl: string | null = "https://rival.com/feed.xml") {
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
      feedUrl,
      label: "Rival changelog",
    })
    .returning();
  return { tenant, rival, source };
}

function fetcherReturning(body: string): (url: string) => Promise<PageResult> {
  return async () => ({ text: body, html: body, finalUrl: "https://rival.com/feed.xml" });
}

const scoreAll = (score: number | null) => async (items: unknown[]) =>
  items.map(() => ({ score, rationale: score === null ? "scoring failed" : "relevant", topics: [] }));

async function competitorSignals(tenantId: string) {
  return db
    .select()
    .from(signals)
    .where(and(eq(signals.tenantId, tenantId), eq(signals.kind, "competitor_move")));
}

describe("runCompetitorSource", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("writes a signal per new feed entry, carrying the entry's real date", async () => {
    const { tenant, source } = await seed();
    const result = await runCompetitorSource(source, {
      fetchPage: fetcherReturning(FEED(ITEM("a", "SSO everywhere", "Wed, 15 Jul 2026 10:00:00 GMT"))),
      score: scoreAll(0.8),
    });

    expect(result.written).toBe(1);
    const rows = await competitorSignals(tenant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("SSO everywhere");
    expect(rows[0].externalId).toBe("a");
    expect(rows[0].competitorId).toBe(source.competitorId);
    expect(rows[0].sourceId).toBe(source.id);
    expect(rows[0].relevanceScore).toBeCloseTo(0.8);
    expect(rows[0].occurredAt.toISOString()).toBe("2026-07-15T10:00:00.000Z");
  });

  it("skips entries already seen, so a re-run writes nothing new", async () => {
    const { tenant, source } = await seed();
    const deps = {
      fetchPage: fetcherReturning(FEED(ITEM("a", "SSO everywhere", "Wed, 15 Jul 2026 10:00:00 GMT"))),
      score: scoreAll(0.8),
    };
    await runCompetitorSource(source, deps);
    const second = await runCompetitorSource(source, deps);

    expect(second.written).toBe(0);
    expect(await competitorSignals(tenant.id)).toHaveLength(1);
  });

  it("drops entries below the relevance floor without writing them", async () => {
    const { tenant, source } = await seed();
    const result = await runCompetitorSource(source, {
      fetchPage: fetcherReturning(FEED(ITEM("a", "Patch release", "Wed, 15 Jul 2026 10:00:00 GMT"))),
      score: scoreAll(0.05),
    });

    expect(result.written).toBe(0);
    expect(result.dropped).toBe(1);
    expect(await competitorSignals(tenant.id)).toHaveLength(0);
  });

  it("WRITES unscored entries — a scoring failure must stay visible, not vanish", async () => {
    const { tenant, source } = await seed();
    const result = await runCompetitorSource(source, {
      fetchPage: fetcherReturning(FEED(ITEM("a", "Something", "Wed, 15 Jul 2026 10:00:00 GMT"))),
      score: scoreAll(null),
    });

    expect(result.written).toBe(1);
    const [row] = await competitorSignals(tenant.id);
    expect(row.relevanceScore).toBeNull();
    expect(row.relevanceRationale).toMatch(/fail/i);
  });

  it("skips entries older than the signal window", async () => {
    const { tenant, source } = await seed();
    const result = await runCompetitorSource(source, {
      fetchPage: fetcherReturning(FEED(ITEM("old", "Ancient news", "Mon, 01 Jan 2024 10:00:00 GMT"))),
      score: scoreAll(0.9),
    });

    expect(result.written).toBe(0);
    expect(await competitorSignals(tenant.id)).toHaveLength(0);
  });

  it("marks the source failing and records the error when the fetch fails", async () => {
    const { tenant, source } = await seed();
    await runCompetitorSource(source, {
      fetchPage: async () => ({ error: "blocked" as const }),
      score: scoreAll(0.9),
    });

    const [after] = await db.select().from(sources).where(eq(sources.id, source.id));
    expect(after.status).toBe("failing");
    expect(after.lastError).toMatch(/blocked/);
    expect(after.lastRunAt).not.toBeNull();
    expect(after.lastSuccessAt).toBeNull();
    expect(await competitorSignals(tenant.id)).toHaveLength(0);
  });

  it("clears failing status and lastError on the next successful run", async () => {
    const { source } = await seed();
    await runCompetitorSource(source, { fetchPage: async () => ({ error: "blocked" as const }), score: scoreAll(0.9) });
    const [failed] = await db.select().from(sources).where(eq(sources.id, source.id));

    await runCompetitorSource(failed, {
      fetchPage: fetcherReturning(FEED(ITEM("a", "Back up", "Wed, 15 Jul 2026 10:00:00 GMT"))),
      score: scoreAll(0.9),
    });

    const [after] = await db.select().from(sources).where(eq(sources.id, source.id));
    expect(after.status).toBe("active");
    expect(after.lastError).toBeNull();
    expect(after.lastSuccessAt).not.toBeNull();
  });

  it("falls back to the page URL when the source has no feed, writing one signal per content change", async () => {
    const { tenant, source } = await seed(null);
    const deps = { fetchPage: fetcherReturning("<html><body>Changelog v2</body></html>"), score: scoreAll(0.8) };

    const first = await runCompetitorSource(source, deps);
    expect(first.written).toBe(1);

    const [reloaded] = await db.select().from(sources).where(eq(sources.id, source.id));
    const second = await runCompetitorSource(reloaded, deps);
    expect(second.written).toBe(0);
    expect(await competitorSignals(tenant.id)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to confirm failure, then implement**

Fetch `source.feedUrl ?? source.url` through `fetchPage`. On error: set `lastRunAt`, `status: "failing"`, `lastError`, return zeros — **write no signals**.

With a feed, `parseFeed`. Without one, treat the page as a single entry whose `externalId` is `${source.id}:${sha256(text)}`, title from the source label, excerpt from the page text — and skip entirely when that hash matches the stored watermark.

Tier 1 drops, before any model call:
- an `externalId` that already exists for this `(tenantId, kind: "competitor_move")`
- an entry whose `publishedAt` is older than `signalWindowStart(new Date())`

An entry with a null `publishedAt` is **not** dropped — use the fetch time as `occurredAt` and say so in `relevanceRationale`, because a feed without dates is common and losing those entries is worse than a slightly wrong recency.

Score the survivors in one `scoreRelevance` call. Write those at or above `RELEVANCE_FLOOR = 0.3` **plus every unscored one**; count the rest as dropped. Then set `lastRunAt`, `lastSuccessAt`, `status: "active"`, `lastError: null`, and the watermark.

- [ ] **Step 3: Verify and commit**

---

### Task 6: The sweep, the cron, and source health

**Files:**
- Create: `src/lib/signals/sweep.ts`
- Modify: `src/app/api/cron/scheduler/route.ts`, `src/app/(dashboard)/company/page.tsx`, `competitors-editor.tsx`
- Test: `tests/lib/signals/sweep.test.ts`, `tests/app/api/cron/scheduler/route.test.ts`

**Interfaces:**
- Consumes: `runCompetitorSource`, `sources`
- Produces: `sweepCompetitorSources(deps?): Promise<void>`

- [ ] **Step 1: Write the failing sweep test**

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, competitors, sources } from "../../../src/db/schema";
import { sweepCompetitorSources } from "../../../src/lib/signals/sweep";

const A = "Sweep Test Tenant A";
const B = "Sweep Test Tenant B";

async function seedTenantWithSource(name: string, url: string) {
  const [tenant] = await db.insert(tenants).values({ name }).returning();
  const [rival] = await db.insert(competitors).values({ tenantId: tenant.id, name: "Rival" }).returning();
  await db.insert(sources).values({
    tenantId: tenant.id,
    type: "competitor_web",
    competitorId: rival.id,
    url,
    label: "Changelog",
  });
  return tenant;
}

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, A));
  await db.delete(tenants).where(eq(tenants.name, B));
});

describe("sweepCompetitorSources", () => {
  it("one tenant's failure does not stop another tenant's sources", async () => {
    const tenantA = await seedTenantWithSource(A, "https://a.com/changelog");
    await seedTenantWithSource(B, "https://b.com/changelog");

    const run = vi.fn(async (source: { tenantId: string }) => {
      if (source.tenantId === tenantA.id) throw new Error("boom");
      return { written: 1, dropped: 0, skipped: 0 };
    });

    await expect(sweepCompetitorSources({ runSource: run })).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("skips disabled sources", async () => {
    const tenant = await seedTenantWithSource(A, "https://a.com/changelog");
    await db.update(sources).set({ status: "disabled" }).where(eq(sources.tenantId, tenant.id));

    const run = vi.fn(async () => ({ written: 0, dropped: 0, skipped: 0 }));
    await sweepCompetitorSources({ runSource: run });
    expect(run).not.toHaveBeenCalled();
  });

  it("still runs sources previously marked failing, so they can recover", async () => {
    const tenant = await seedTenantWithSource(A, "https://a.com/changelog");
    await db.update(sources).set({ status: "failing" }).where(eq(sources.tenantId, tenant.id));

    const run = vi.fn(async () => ({ written: 0, dropped: 0, skipped: 0 }));
    await sweepCompetitorSources({ runSource: run });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Implement the sweep**

Select `competitor_web` sources whose status is not `disabled`, group per tenant, and run each tenant's sources inside its own try/catch that logs and continues. **Read `src/lib/change-events/resolve-sweep.ts` and match it** — the candidate select gets its own try/catch that logs and returns, because a sweep that throws would reject the cron handler and undo the steps that already succeeded.

- [ ] **Step 3: Wire the cron and update its test**

Add `await sweepCompetitorSources();` to the cron route after `syncShippedWorkSignals()`. Signals from external sources should land after the shipped-work reconcile so a single run leaves the table consistent.

**Update `tests/app/api/cron/scheduler/route.test.ts`:** mock `sweepCompetitorSources` and extend the existing ordering assertion to the full four-step sequence. That test already mocks the other three steps for a reason — an unmocked sweep would run for real against the shared test database across all tenants while other files are running.

- [ ] **Step 4: Surface source health**

In the competitors section of `/company`, show each competitor's sources with status, last successful run, and last error. A silently dead source is the failure this whole layer is most exposed to, and the `status`/`lastError` columns exist precisely so it is visible. Follow the existing integration-status treatment for tone and layout rather than inventing one.

- [ ] **Step 5: Verify and commit**

The dashboard sits behind an OAuth wall, so state in your report that the UI is verified by types, lint and action-level tests rather than a click-through.

---

## Definition of done

- `npm run typecheck`, `npm run test`, and `npm run lint` all pass.
- "Find pages to watch" on a competitor discovers its changelog and blog, storing feed URLs where advertised, and running it twice creates no duplicates.
- A cron run turns new feed entries into `competitor_move` signals with the entries' real dates, visible in the signals browser.
- Entries below the relevance floor are not written; entries whose scoring failed **are** written, unscored.
- A source that cannot be fetched shows as `failing` with its error in settings, and recovers to `active` on the next successful run.
- No external URL is fetched by anything other than `fetchPageText`.
- No test executes a real sweep against the shared test database.

## Notes for spec 4 and spec 5

- **Spec 4 (news agent)** reuses `sources` with `type: "news"` and a null `url`, searching `companyProfiles.topics`. `scoreRelevance` is shared unchanged; only acquisition differs. It will need its own idempotency story, because `sources_tenant_url_unique` is partial (`WHERE url IS NOT NULL`) and gives null-url rows no uniqueness at all.
- **Spec 5** must reuse `signalWindowCondition()` from `window.ts` rather than re-deriving the window, and must extend the deferred deletion with the accepted-brief exemption before `brief_signals` can cascade.
- The **quiet-week spike result** in the design doc is the brief agent's requirement, not a suggestion: the prompt must license returning zero briefs, and `weekAssessment` should reach the UI as the empty state.
