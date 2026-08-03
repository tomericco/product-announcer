# Company Context & Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate the company-context columns spec 1 created, by crawling the company's own website and drafting the profile for a human to correct — plus a `competitors` table the source agents in spec 3 will watch.

**Architecture:** Extends an existing, working pattern rather than inventing one. `scrape-updates-page.ts` (SSRF-guarded fetch) → `analyze-brand-style.ts` (`generateObject` + zod + `recordLlmUsage`) → `brand-import.ts` (injectable deps, never overwrite hand-written values with nulls) is already the exact fetch → LLM → persist shape this needs. Spec 2 generalizes the fetcher, adds a bounded multi-page crawl on top, and mirrors the analyzer and orchestrator for company context.

**Tech Stack:** Next.js 16 (App Router), Drizzle ORM + drizzle-kit, Postgres (Supabase), AI SDK v7 + `@ai-sdk/anthropic`, Vitest against a real `_test` database, TypeScript strict.

## Global Constraints

- **This is not the Next.js you know.** Read the relevant guide in `node_modules/next/dist/docs/` before writing any App Router code. Heed deprecation notices. (`AGENTS.md`)
- Tests run against a **real Postgres database whose name must end in `_test`** (`vitest.setup.ts` hard-fails otherwise). After every schema change run `npm run db:migrate:test` before `npm run test`.
- The LLM provider is **Anthropic directly** via `@ai-sdk/anthropic`, not the Vercel AI Gateway. Do not "fix" this.
- Every LLM call records usage via `recordLlmUsage` with a distinct `operation` string. Follow `analyze-brand-style.ts:36-51`. **`recordLlmUsage`'s `operation` parameter is typed as `LlmOperation`, a closed string-literal union in `src/lib/ai/llm-usage.ts` — a new operation must be added there or the call will not type-check.** The database column is free text, so this constraint is invisible until `tsc` runs.
- Model specs come from an env var with a literal fallback, e.g. `process.env.ONBOARDING_ANALYSIS_MODEL ?? "anthropic/claude-sonnet-4-5"`, resolved through `resolveModel`.
- Follow the existing schema conventions in `src/db/schema.ts`: comments explain *why* a column exists, not what it is.
- Never edit the Vercel `DATABASE_URL` env var.
- **Deletion lists come from exports and importers, never from a module's name.** Spec 1 lost coverage five separate times by trusting that a directory or file name described all its contents. Before deleting or wholesale-replacing any file, `grep -n "^export"` it and grep its importers; if anything survives, split rather than delete.

## Decisions this plan locks in

**`industry` and `category` are both kept, and they are not duplicates.** `industry` is a controlled vocabulary backed by `IndustrySelect` and matched against `system_content_examples.industry` for few-shot selection — changing it changes which exemplars the generator sees. `category` is free-text prose ("Project management for software teams") used as relevance context by the spec 3 source agents. The bootstrap writes `category`; `industry` stays a human picklist that the brand import may also set. Neither UI should present them as alternatives.

**The `/brand-guidelines` route is renamed to `/company`.** After this spec the page holds identity, positioning, topics, competitors, personas, industry and voice — "brand guidelines" no longer describes it. This changes a URL; there is no production traffic to break, and the nav label changes with it. If you would rather keep the URL, only Task 5 changes and nothing else in this plan depends on it.

**Onboarding stays at four steps.** Step 2 (`/onboarding/brand`) becomes "Your company": one URL field, then a review screen over the drafted context. `tenants.onboardingStep` holds 1–4 and `clampStep` caps at `LAST_ONBOARDING_STEP = 4`; adding a fifth step would need a migration of that column's meaning for no user benefit.

**The bootstrap and the brand-style import stay separate calls.** They read different pages for different purposes — the company site for identity and positioning, the updates page for voice. Merging them into one analysis would make a sparse updates page degrade the company profile.

**Channels get no new column.** The design doc lists channels among the captured company context, but a channel is already a configured destination — the Webflow, LinkedIn and webhook connections on `/integrations`, which carry credentials and status. A parallel `channels` field on `company_profiles` would be a second, unauthenticated list of the same thing, immediately able to disagree with the connections that actually publish. `briefs.suggestedChannel` is plain text in the spec 5 schema for exactly this reason: it names a destination without duplicating its configuration.

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/lib/workspace/fetch-page.ts` | Renamed from `scrape-updates-page.ts`. SSRF-guarded single-page fetch; now also returns raw HTML and extracts same-origin links. | 1 |
| `src/lib/workspace/crawl-company-site.ts` | **New.** Bounded multi-page crawl: homepage + up to 3 keyword-matched same-origin pages, concatenated and capped. | 2 |
| `src/lib/workspace/analyze-company-context.ts` | **New.** `generateObject` over crawled text → identity, positioning, topics, competitors. | 3 |
| `src/lib/workspace/company-bootstrap.ts` | **New.** Orchestrator: crawl → analyze → persist profile + competitors. Mirrors `brand-import.ts`. | 4 |
| `src/lib/workspace/competitors.ts` | **New.** CRUD helpers over the `competitors` table. | 4 |
| `src/lib/workspace/parse-topics.ts` | **New.** Parses the topics textarea. In `lib`, not the actions file, because a `"use server"` module may only export async functions. | 5 |
| `src/db/schema.ts` | Adds the `competitors` table. | 4 |
| `src/app/(dashboard)/company/*` | Renamed from `brand-guidelines/`. Company-context settings surface. | 5 |
| `src/app/onboarding/brand/page.tsx` | Becomes the "Your company" step. | 6 |
| `src/app/onboarding/actions.ts` | Gains the bootstrap action. | 6 |

---

### Task 1: Generalize the page fetcher

`fetchUpdatesPageText` is not updates-specific — it is a hardened generic fetcher whose name lies about its scope, and spec 3 will want it for competitor pages too. It also discards the HTML, which the crawl in Task 2 needs for link discovery.

Only two files import it (`brand-import.ts`, `tests/lib/workspace/scrape-updates-page.test.ts`), so this rename is cheap. **Verify that with `grep -rln "scrape-updates-page\|fetchUpdatesPageText" src tests` before starting** — if the count has grown, report it rather than expanding the task silently.

**Files:**
- Rename: `src/lib/workspace/scrape-updates-page.ts` → `src/lib/workspace/fetch-page.ts` (use `git mv`)
- Rename: `tests/lib/workspace/scrape-updates-page.test.ts` → `tests/lib/workspace/fetch-page.test.ts` (use `git mv`)
- Modify: `src/lib/workspace/brand-import.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `fetchPageText(url: string, deps?: { fetchImpl?: typeof fetch; resolveHost?: ResolveHost }): Promise<PageResult>`
  - `type PageResult = { text: string; html: string } | { error: PageError }`
  - `type PageError = "invalid-url" | "blocked" | "fetch-failed" | "insufficient-content"`
  - `extractSameOriginLinks(html: string, baseUrl: string): string[]`
  - `htmlToText`, `ResolveHost` — unchanged, still exported

- [ ] **Step 1: Write the failing test for link extraction**

Add to `tests/lib/workspace/fetch-page.test.ts` (after the `git mv`):

```ts
import { extractSameOriginLinks } from "../../../src/lib/workspace/fetch-page";

describe("extractSameOriginLinks", () => {
  const base = "https://example.com/";

  it("returns absolute same-origin URLs, resolving relative hrefs", () => {
    const html = `<a href="/product">P</a><a href="about">A</a><a href="https://example.com/pricing">$</a>`;
    expect(extractSameOriginLinks(html, base)).toEqual([
      "https://example.com/product",
      "https://example.com/about",
      "https://example.com/pricing",
    ]);
  });

  it("drops cross-origin, non-http, and fragment-only links", () => {
    const html = `<a href="https://other.com/x">x</a><a href="mailto:a@b.c">m</a><a href="#top">t</a><a href="javascript:alert(1)">j</a>`;
    expect(extractSameOriginLinks(html, base)).toEqual([]);
  });

  it("deduplicates and ignores the fragment when comparing", () => {
    const html = `<a href="/product">1</a><a href="/product#features">2</a><a href="/product">3</a>`;
    expect(extractSameOriginLinks(html, base)).toEqual(["https://example.com/product"]);
  });

  it("returns an empty array for unparseable base or malformed html", () => {
    expect(extractSameOriginLinks("<a href=", "not a url")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/lib/workspace/fetch-page.test.ts`
Expected: FAIL — `extractSameOriginLinks` is not exported.

- [ ] **Step 3: Rename the module and widen the return type**

`git mv` both files. In `src/lib/workspace/fetch-page.ts`:

- Rename `fetchUpdatesPageText` → `fetchPageText`.
- Replace the `ScrapeResult` type with:

```ts
export type PageError = "invalid-url" | "blocked" | "fetch-failed" | "insufficient-content";
export type PageResult = { text: string; html: string } | { error: PageError };
```

- In the success branch, return the HTML alongside the text so callers can
  discover links without a second fetch:

```ts
      try {
        const html = await readBodyCapped(res, MAX_BYTES);
        const text = htmlToText(html).slice(0, MAX_TEXT_CHARS);
        if (text.length < MIN_TEXT_CHARS) return { error: "insufficient-content" };
        return { text, html };
      } catch {
        return { error: "fetch-failed" };
      }
```

Leave every SSRF guard, the redirect loop, the byte cap and the timeout exactly as they are. In particular **do not touch the `KNOWN RESIDUAL` comment about DNS rebinding** — it documents an accepted, tracked limitation.

- [ ] **Step 4: Add the link extractor**

Append to `src/lib/workspace/fetch-page.ts`:

```ts
/**
 * Same-origin links from a page's HTML, absolute and deduplicated.
 *
 * Deliberately a regex over raw HTML rather than a DOM parse: the crawl only
 * needs candidate hrefs, a wrong or missed link costs one page of context, and
 * pulling in a parser for this is not worth the dependency. Fragments are
 * stripped before deduplication so `/product` and `/product#features` count once.
 */
export function extractSameOriginLinks(html: string, baseUrl: string): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }

  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
    let candidate: URL;
    try {
      candidate = new URL(match[1], base);
    } catch {
      continue;
    }
    if (candidate.protocol !== "http:" && candidate.protocol !== "https:") continue;
    if (candidate.origin !== base.origin) continue;
    candidate.hash = "";
    if (candidate.href === base.href) continue;
    seen.add(candidate.href);
  }
  return [...seen];
}
```

- [ ] **Step 5: Update the one importer**

In `src/lib/workspace/brand-import.ts`, change the import to `fetchPageText` from `@/lib/workspace/fetch-page` and rename the `ScrapeResult` type reference to `PageResult`. Its `"error" in scraped` guard already narrows correctly and needs no change — the added `html` field is ignored by that call site.

- [ ] **Step 6: Verify**

```bash
npx vitest run tests/lib/workspace/fetch-page.test.ts tests/lib/workspace/brand-import.test.ts
npm run typecheck && npm run test && npm run lint
```

Expected: all green. The existing scrape tests must pass unchanged apart from the import path and the added `html` field — if an assertion needs loosening, the fetch behavior changed and that is a bug.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: generalize the updates-page scraper into fetch-page

The fetcher was never updates-specific. Returns raw HTML alongside text
so a crawl can discover links without a second request, and adds
same-origin link extraction."
```

---

### Task 2: The bounded company-site crawl

One page is not enough to infer positioning — that usually lives on a product or about page. This crawls a small, deterministic set.

**No LLM chooses which pages to fetch.** Selection is keyword matching on the URL path, which is testable, free, and predictable. A model in this loop would make the crawl non-deterministic for no benefit.

**Files:**
- Create: `src/lib/workspace/crawl-company-site.ts`
- Test: `tests/lib/workspace/crawl-company-site.test.ts`

**Interfaces:**
- Consumes: `fetchPageText`, `extractSameOriginLinks`, `PageError` (Task 1)
- Produces: `crawlCompanySite(url: string, deps?: CrawlDeps): Promise<{ text: string; pages: string[] } | { error: PageError }>`, `type CrawlDeps = { fetchPage?: typeof fetchPageText }`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/workspace/crawl-company-site.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { crawlCompanySite } from "../../../src/lib/workspace/crawl-company-site";
import type { PageResult } from "../../../src/lib/workspace/fetch-page";

const LONG = "x".repeat(300);

function fakeFetcher(pages: Record<string, PageResult>) {
  const calls: string[] = [];
  const fetchPage = async (url: string): Promise<PageResult> => {
    calls.push(url);
    return pages[url] ?? { error: "fetch-failed" };
  };
  return { fetchPage, calls };
}

describe("crawlCompanySite", () => {
  it("returns the homepage error when the homepage cannot be fetched", async () => {
    const { fetchPage } = fakeFetcher({});
    expect(await crawlCompanySite("https://acme.com/", { fetchPage })).toEqual({ error: "fetch-failed" });
  });

  it("fetches the homepage plus keyword-matched same-origin pages, homepage first", async () => {
    const home = {
      text: `home ${LONG}`,
      html: `<a href="/product">p</a><a href="/about">a</a><a href="/careers">c</a>`,
    };
    const { fetchPage, calls } = fakeFetcher({
      "https://acme.com/": home,
      "https://acme.com/product": { text: `product ${LONG}`, html: "" },
      "https://acme.com/about": { text: `about ${LONG}`, html: "" },
    });

    const result = await crawlCompanySite("https://acme.com/", { fetchPage });
    if ("error" in result) throw new Error("expected success");

    expect(calls).toEqual(["https://acme.com/", "https://acme.com/product", "https://acme.com/about"]);
    expect(result.pages).toEqual(["https://acme.com/", "https://acme.com/product", "https://acme.com/about"]);
    expect(result.text).toContain("home");
    expect(result.text).toContain("product");
    expect(result.text).toContain("about");
    expect(result.text).not.toContain("careers");
  });

  it("succeeds on the homepage alone when no secondary page matches or fetches", async () => {
    const { fetchPage } = fakeFetcher({
      "https://acme.com/": { text: `home ${LONG}`, html: `<a href="/careers">c</a>` },
    });
    const result = await crawlCompanySite("https://acme.com/", { fetchPage });
    if ("error" in result) throw new Error("expected success");
    expect(result.pages).toEqual(["https://acme.com/"]);
  });

  it("fetches at most three secondary pages", async () => {
    const html = ["/product", "/about", "/pricing", "/platform", "/features"]
      .map((p) => `<a href="${p}">${p}</a>`)
      .join("");
    const pages: Record<string, PageResult> = { "https://acme.com/": { text: `home ${LONG}`, html } };
    for (const p of ["/product", "/about", "/pricing", "/platform", "/features"]) {
      pages[`https://acme.com${p}`] = { text: `${p} ${LONG}`, html: "" };
    }
    const { fetchPage, calls } = fakeFetcher(pages);
    await crawlCompanySite("https://acme.com/", { fetchPage });
    expect(calls).toHaveLength(4); // homepage + 3
  });

  it("caps combined text length", async () => {
    const huge = "y".repeat(30_000);
    const { fetchPage } = fakeFetcher({
      "https://acme.com/": { text: huge, html: `<a href="/product">p</a>` },
      "https://acme.com/product": { text: huge, html: "" },
    });
    const result = await crawlCompanySite("https://acme.com/", { fetchPage });
    if ("error" in result) throw new Error("expected success");
    expect(result.text.length).toBeLessThanOrEqual(24_000);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/lib/workspace/crawl-company-site.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/workspace/crawl-company-site.ts`:

```ts
import { fetchPageText, extractSameOriginLinks, type PageError, type PageResult } from "@/lib/workspace/fetch-page";

export type CrawlDeps = { fetchPage?: typeof fetchPageText };

export type CrawlResult = { text: string; pages: string[] } | { error: PageError };

const MAX_SECONDARY_PAGES = 3;
const MAX_COMBINED_CHARS = 24_000;

// Path fragments that tend to carry positioning. Ordered by how reliably they
// do: a product page beats an about page beats pricing. Matching on the path
// keeps selection deterministic and free — a model choosing pages here would
// buy nothing and make the crawl irreproducible.
const PAGE_KEYWORDS = ["product", "about", "platform", "features", "pricing", "solutions", "why"];

function rank(url: string): number {
  const path = new URL(url).pathname.toLowerCase();
  const index = PAGE_KEYWORDS.findIndex((keyword) => path.includes(keyword));
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

/**
 * Reads a company's own site for enough context to draft their profile: the
 * homepage plus up to three keyword-matched same-origin pages.
 *
 * A secondary page that fails to fetch is skipped, not fatal — three pages of
 * context is better than none. Only a homepage failure aborts, because without
 * it there is nothing to analyze and no links to follow.
 */
export async function crawlCompanySite(url: string, deps: CrawlDeps = {}): Promise<CrawlResult> {
  const fetchPage = deps.fetchPage ?? fetchPageText;

  const home = await fetchPage(url);
  if ("error" in home) return { error: home.error };

  const candidates = extractSameOriginLinks(home.html, url)
    .map((href) => ({ href, score: rank(href) }))
    .filter((candidate) => candidate.score !== Number.MAX_SAFE_INTEGER)
    .sort((a, b) => a.score - b.score)
    .slice(0, MAX_SECONDARY_PAGES);

  const pages = [url];
  const parts = [home.text];
  for (const { href } of candidates) {
    const page: PageResult = await fetchPage(href);
    if ("error" in page) continue;
    pages.push(href);
    parts.push(page.text);
  }

  return { text: parts.join("\n\n---\n\n").slice(0, MAX_COMBINED_CHARS), pages };
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/lib/workspace/crawl-company-site.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: crawl a company's own site for profile context

Homepage plus up to three keyword-matched same-origin pages, capped.
Page selection is deterministic path matching, not a model call."
```

---

### Task 3: The company-context analyzer

Mirrors `analyze-brand-style.ts` exactly — same model resolution, same usage recording, same swallow-errors-to-empty behavior. Read that file before writing this one.

**Files:**
- Create: `src/lib/workspace/analyze-company-context.ts`
- Test: `tests/lib/workspace/analyze-company-context.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–2 (takes text, returns an object)
- Produces:
  - `CompanyContextSchema` (zod)
  - `type DerivedCompanyContext = z.infer<typeof CompanyContextSchema>`
  - `buildCompanyContextPrompt(pageText: string): string`
  - `analyzeCompanyContext(pageText: string, tenantId: string): Promise<DerivedCompanyContext>`

- [ ] **Step 1: Write the failing test**

The network call is not under test here; the prompt builder and the empty-fallback shape are. Create `tests/lib/workspace/analyze-company-context.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  CompanyContextSchema,
  buildCompanyContextPrompt,
  EMPTY_COMPANY_CONTEXT,
} from "../../../src/lib/workspace/analyze-company-context";

describe("company context schema", () => {
  it("accepts a fully populated context", () => {
    const parsed = CompanyContextSchema.safeParse({
      oneLiner: "Issue tracking for software teams.",
      category: "Project management",
      positioning: "Fast where incumbents are configurable.",
      topics: ["developer productivity", "issue tracking"],
      competitors: [{ name: "Jira", websiteUrl: "https://atlassian.com/jira" }],
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts nulls for prose fields the page did not support", () => {
    const parsed = CompanyContextSchema.safeParse({
      oneLiner: null,
      category: null,
      positioning: null,
      topics: [],
      competitors: [],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a competitor without a name", () => {
    const parsed = CompanyContextSchema.safeParse({
      oneLiner: null, category: null, positioning: null, topics: [],
      competitors: [{ websiteUrl: "https://atlassian.com" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("allows a competitor with no website", () => {
    const parsed = CompanyContextSchema.safeParse({
      oneLiner: null, category: null, positioning: null, topics: [],
      competitors: [{ name: "Jira", websiteUrl: null }],
    });
    expect(parsed.success).toBe(true);
  });

  it("EMPTY_COMPANY_CONTEXT is itself a valid, wholly-empty context", () => {
    expect(CompanyContextSchema.safeParse(EMPTY_COMPANY_CONTEXT).success).toBe(true);
    expect(EMPTY_COMPANY_CONTEXT.topics).toEqual([]);
    expect(EMPTY_COMPANY_CONTEXT.competitors).toEqual([]);
  });
});

describe("buildCompanyContextPrompt", () => {
  it("embeds the page text", () => {
    expect(buildCompanyContextPrompt("ACME builds widgets")).toContain("ACME builds widgets");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/lib/workspace/analyze-company-context.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/workspace/analyze-company-context.ts`:

```ts
import { generateObject } from "ai";
import { z } from "zod";
import { resolveModel, modelId } from "@/lib/ai/model";
import { recordLlmUsage } from "@/lib/ai/llm-usage";

export const CompanyContextSchema = z.object({
  oneLiner: z.string().nullable(),
  category: z.string().nullable(),
  positioning: z.string().nullable(),
  topics: z.array(z.string()),
  competitors: z.array(z.object({ name: z.string(), websiteUrl: z.string().nullable() })),
});

export type DerivedCompanyContext = z.infer<typeof CompanyContextSchema>;

export const EMPTY_COMPANY_CONTEXT: DerivedCompanyContext = {
  oneLiner: null,
  category: null,
  positioning: null,
  topics: [],
  competitors: [],
};

const CONTEXT_SYSTEM = [
  "You read a company's own website and describe the company factually, for use as context by",
  "downstream agents that decide which industry news and competitor moves are relevant to them.",
  "oneLiner: one sentence on what the company does, in their own terms.",
  "category: the market category they compete in, as a short noun phrase.",
  "positioning: what they claim makes them different, and the messages they want to own. Two or three",
  "sentences. This is the yardstick every incoming signal is scored against, so be specific about what",
  "they emphasize rather than generic about their market.",
  "topics: 3-8 subjects in their lane, as short lowercase phrases a person would search for.",
  "competitors: companies they name as alternatives, or that a buyer would obviously compare them to.",
  "Include a website only when the page gives you one or you are certain of it.",
  "Infer only from evidence on the pages. Return null for any prose field the pages do not support, and",
  "an empty array rather than guessing at topics or competitors. Do not repeat marketing superlatives as",
  "fact — describe what they sell and to whom.",
].join(" ");

export function buildCompanyContextPrompt(pageText: string): string {
  return `Here is the text of a company's website. Describe the company.\n\n${pageText}`;
}

/**
 * Drafts a company profile from crawled site text. Returns an empty context
 * rather than throwing: a failed bootstrap must leave onboarding usable, and the
 * caller distinguishes "nothing inferred" from "call failed" by the emptiness.
 */
export async function analyzeCompanyContext(pageText: string, tenantId: string): Promise<DerivedCompanyContext> {
  try {
    const spec = process.env.ONBOARDING_ANALYSIS_MODEL ?? "anthropic/claude-sonnet-4-5";
    const { object, usage } = await generateObject({
      model: resolveModel(spec),
      schema: CompanyContextSchema,
      system: CONTEXT_SYSTEM,
      prompt: buildCompanyContextPrompt(pageText),
    });
    await recordLlmUsage({ tenantId, operation: "company_context_analysis", model: modelId(spec), usage });
    return object;
  } catch {
    return EMPTY_COMPANY_CONTEXT;
  }
}
```

- [ ] **Step 4: Run the test and commit**

```bash
npx vitest run tests/lib/workspace/analyze-company-context.test.ts
git add -A
git commit -m "feat: analyze crawled site text into company context

Mirrors analyze-brand-style: generateObject with a zod schema, usage
recorded, empty context on failure so onboarding stays usable."
```

---

### Task 4: `competitors` table and the bootstrap orchestrator

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/lib/workspace/competitors.ts`
- Create: `src/lib/workspace/company-bootstrap.ts`
- Test: `tests/db/competitors-schema.test.ts`, `tests/lib/workspace/company-bootstrap.test.ts`

**Interfaces:**
- Consumes: `crawlCompanySite` (Task 2), `analyzeCompanyContext` / `DerivedCompanyContext` (Task 3), `getOrCreateCompanyProfile` (existing)
- Produces:
  - `competitors` table export
  - `listCompetitors(tenantId, database?): Promise<Competitor[]>`
  - `addCompetitor(tenantId, input: { name: string; websiteUrl: string | null }, database?): Promise<Competitor>`
  - `removeCompetitor(tenantId, id, database?): Promise<void>`
  - `bootstrapCompanyContext(tenantId, url, deps?): Promise<{ ok: boolean; reason?: string }>`

- [ ] **Step 1: Write the failing schema test**

Create `tests/db/competitors-schema.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, competitors } from "../../src/db/schema";

const TENANT = "Competitors Schema Test Tenant";

describe("competitors schema", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("stores a competitor with an optional website", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [row] = await db
      .insert(competitors)
      .values({ tenantId: tenant.id, name: "Jira" })
      .returning();
    expect(row.name).toBe("Jira");
    expect(row.websiteUrl).toBeNull();
  });

  it("rejects two competitors with the same name in one tenant", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    await db.insert(competitors).values({ tenantId: tenant.id, name: "Jira" });
    await expect(
      db.insert(competitors).values({ tenantId: tenant.id, name: "Jira" })
    ).rejects.toThrow();
  });

  it("cascades when the tenant is deleted", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    await db.insert(competitors).values({ tenantId: tenant.id, name: "Jira" });
    await db.delete(tenants).where(eq(tenants.id, tenant.id));
    const rows = await db.select().from(competitors).where(eq(competitors.tenantId, tenant.id));
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/db/competitors-schema.test.ts`
Expected: FAIL — `competitors` is not exported.

- [ ] **Step 3: Add the table**

In `src/db/schema.ts`, after `companyProfiles`:

```ts
export const competitors = pgTable(
  "competitors",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // The competitor's home page. The specific pages we watch — changelog, blog,
    // releases — are `sources` rows in spec 3, so one competitor can have several.
    websiteUrl: text("website_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The bootstrap proposes competitors and a human adds more by hand; without
    // this a re-run would silently duplicate every name it proposed before.
    uniqueIndex("competitors_tenant_name_unique").on(table.tenantId, table.name),
  ]
);

export type Competitor = typeof competitors.$inferSelect;
```

Then generate and apply. If drizzle-kit prompts interactively it will hang a non-interactive shell — this is a pure addition, so it should not prompt:

```bash
npm run db:generate && npm run db:migrate && npm run db:migrate:test
npx vitest run tests/db/competitors-schema.test.ts
```

- [ ] **Step 4: Write the CRUD helpers**

Create `src/lib/workspace/competitors.ts`:

```ts
import { and, asc, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { competitors, type Competitor } from "@/db/schema";

export async function listCompetitors(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<Competitor[]> {
  return database
    .select()
    .from(competitors)
    .where(eq(competitors.tenantId, tenantId))
    .orderBy(asc(competitors.name));
}

/**
 * Adds a competitor, or returns the existing row when the name is already
 * present for this tenant. Idempotent so a re-run of the bootstrap tops up the
 * list instead of failing on the unique index.
 */
export async function addCompetitor(
  tenantId: string,
  input: { name: string; websiteUrl: string | null },
  database: typeof defaultDb = defaultDb
): Promise<Competitor> {
  const name = input.name.trim();
  const [row] = await database
    .insert(competitors)
    .values({ tenantId, name, websiteUrl: input.websiteUrl })
    .onConflictDoNothing({ target: [competitors.tenantId, competitors.name] })
    .returning();
  if (row) return row;

  const [existing] = await database
    .select()
    .from(competitors)
    .where(and(eq(competitors.tenantId, tenantId), eq(competitors.name, name)))
    .limit(1);
  return existing;
}

/** Scoped by tenant so an id from another workspace cannot delete a row. */
export async function removeCompetitor(
  tenantId: string,
  id: string,
  database: typeof defaultDb = defaultDb
): Promise<void> {
  await database.delete(competitors).where(and(eq(competitors.tenantId, tenantId), eq(competitors.id, id)));
}
```

- [ ] **Step 5: Write the failing orchestrator test**

Create `tests/lib/workspace/company-bootstrap.test.ts`. Model it on `tests/lib/workspace/brand-import.test.ts` — read that file first and match its dependency-injection style:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, companyProfiles, competitors } from "../../../src/db/schema";
import { bootstrapCompanyContext } from "../../../src/lib/workspace/company-bootstrap";
import { EMPTY_COMPANY_CONTEXT } from "../../../src/lib/workspace/analyze-company-context";

const TENANT = "Company Bootstrap Test Tenant";

const FULL = {
  oneLiner: "Issue tracking for software teams.",
  category: "Project management",
  positioning: "Fast where incumbents are configurable.",
  topics: ["developer productivity"],
  competitors: [{ name: "Jira", websiteUrl: "https://atlassian.com/jira" }],
};

async function seedTenant() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  return tenant;
}

describe("bootstrapCompanyContext", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("persists the drafted context, the url, and the competitors", async () => {
    const tenant = await seedTenant();
    const result = await bootstrapCompanyContext(tenant.id, "https://acme.com", {
      crawl: async () => ({ text: "site text", pages: ["https://acme.com"] }),
      analyze: async () => FULL,
    });
    expect(result.ok).toBe(true);

    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile.oneLiner).toBe(FULL.oneLiner);
    expect(profile.category).toBe(FULL.category);
    expect(profile.positioning).toBe(FULL.positioning);
    expect(profile.topics).toEqual(["developer productivity"]);
    expect(profile.websiteUrl).toBe("https://acme.com");

    const rows = await db.select().from(competitors).where(eq(competitors.tenantId, tenant.id));
    expect(rows.map((r) => r.name)).toEqual(["Jira"]);
  });

  it("returns the crawl error and writes nothing", async () => {
    const tenant = await seedTenant();
    const result = await bootstrapCompanyContext(tenant.id, "https://acme.com", {
      crawl: async () => ({ error: "blocked" as const }),
      analyze: async () => FULL,
    });
    expect(result).toEqual({ ok: false, reason: "blocked" });
    const rows = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(rows).toHaveLength(0);
  });

  it("reports an empty analysis without writing", async () => {
    const tenant = await seedTenant();
    const result = await bootstrapCompanyContext(tenant.id, "https://acme.com", {
      crawl: async () => ({ text: "site text", pages: ["https://acme.com"] }),
      analyze: async () => EMPTY_COMPANY_CONTEXT,
    });
    expect(result).toEqual({ ok: false, reason: "analysis-empty" });
  });

  it("never overwrites a hand-written field with a null derivation", async () => {
    const tenant = await seedTenant();
    await db.insert(companyProfiles).values({ tenantId: tenant.id, positioning: "written by a human" });

    await bootstrapCompanyContext(tenant.id, "https://acme.com", {
      crawl: async () => ({ text: "site text", pages: ["https://acme.com"] }),
      analyze: async () => ({ ...EMPTY_COMPANY_CONTEXT, oneLiner: "Inferred." }),
    });

    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile.positioning).toBe("written by a human");
    expect(profile.oneLiner).toBe("Inferred.");
  });

  it("is idempotent on competitors across two runs", async () => {
    const tenant = await seedTenant();
    const deps = {
      crawl: async () => ({ text: "site text", pages: ["https://acme.com"] }),
      analyze: async () => FULL,
    };
    await bootstrapCompanyContext(tenant.id, "https://acme.com", deps);
    await bootstrapCompanyContext(tenant.id, "https://acme.com", deps);
    const rows = await db.select().from(competitors).where(eq(competitors.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `npx vitest run tests/lib/workspace/company-bootstrap.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement the orchestrator**

Create `src/lib/workspace/company-bootstrap.ts`:

```ts
import { eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { companyProfiles } from "@/db/schema";
import { getOrCreateCompanyProfile } from "@/lib/workspace/company-profile";
import { crawlCompanySite, type CrawlResult } from "@/lib/workspace/crawl-company-site";
import { analyzeCompanyContext, type DerivedCompanyContext } from "@/lib/workspace/analyze-company-context";
import { addCompetitor } from "@/lib/workspace/competitors";

export type BootstrapDeps = {
  crawl?: (url: string) => Promise<CrawlResult>;
  analyze?: (text: string, tenantId: string) => Promise<DerivedCompanyContext>;
  database?: typeof defaultDb;
};

/**
 * Crawls the company's own site and drafts their profile for a human to correct.
 *
 * Mirrors `importBrandStyleForTenant`: a null derived field means "the pages gave
 * the model nothing to go on", never "the user wants this cleared", so only
 * fields the analysis actually produced are written. Competitors are topped up
 * rather than replaced, since the human may have added their own.
 */
export async function bootstrapCompanyContext(
  tenantId: string,
  url: string,
  deps: BootstrapDeps = {}
): Promise<{ ok: boolean; reason?: string }> {
  const crawl = deps.crawl ?? crawlCompanySite;
  const analyze = deps.analyze ?? analyzeCompanyContext;
  const database = deps.database ?? defaultDb;

  const crawled = await crawl(url);
  if ("error" in crawled) return { ok: false, reason: crawled.error };

  const derived = await analyze(crawled.text, tenantId);

  const oneLiner = derived.oneLiner?.trim() || null;
  const category = derived.category?.trim() || null;
  const positioning = derived.positioning?.trim() || null;
  const topics = derived.topics.map((t) => t.trim()).filter(Boolean);
  const namedCompetitors = derived.competitors.filter((c) => c.name.trim().length > 0);

  const isEmpty =
    oneLiner === null && category === null && positioning === null &&
    topics.length === 0 && namedCompetitors.length === 0;
  if (isEmpty) return { ok: false, reason: "analysis-empty" };

  const profile = await getOrCreateCompanyProfile(tenantId, database);

  await database
    .update(companyProfiles)
    .set({
      ...(oneLiner !== null && { oneLiner }),
      ...(category !== null && { category }),
      ...(positioning !== null && { positioning }),
      ...(topics.length > 0 && { topics }),
      websiteUrl: url,
      updatedAt: new Date(),
    })
    .where(eq(companyProfiles.id, profile.id));

  for (const competitor of namedCompetitors) {
    await addCompetitor(tenantId, { name: competitor.name, websiteUrl: competitor.websiteUrl }, database);
  }

  return { ok: true };
}
```

- [ ] **Step 8: Verify and commit**

```bash
npm run typecheck && npm run test && npm run lint
git add -A
git commit -m "feat: competitors table and the company-context bootstrap

Crawl, analyze, then persist only the fields the analysis produced, so a
sparse site never clears something a human wrote. Competitors are topped
up rather than replaced."
```

---

### Task 5: The company settings surface

Renames `/brand-guidelines` to `/company` and adds the context fields and competitor management. **Read `src/app/(dashboard)/brand-guidelines/page.tsx` and `actions.ts` in full before editing** — they already hold industry, personas, guidelines and the brand-style import, all of which must keep working.

**Files:**
- Rename: `src/app/(dashboard)/brand-guidelines/` → `src/app/(dashboard)/company/` (use `git mv`)
- Create: `src/app/(dashboard)/company/company-context-form.tsx`, `src/app/(dashboard)/company/competitors-editor.tsx`
- Modify: `src/app/(dashboard)/company/page.tsx`, `actions.ts`
- Modify: whichever nav component links to `/brand-guidelines` — find it with `grep -rn "brand-guidelines" src`
- Test: `tests/app/company-actions.test.ts`

**Interfaces:**
- Consumes: `listCompetitors`, `addCompetitor`, `removeCompetitor`, `bootstrapCompanyContext` (Task 4)
- Produces: server actions `saveCompanyContext(formData)`, `addCompetitorAction(formData)`, `removeCompetitorAction(id)`, `bootstrapFromWebsite(url)`

- [ ] **Step 1: Write `parseTopics` and its failing test**

The topics textarea needs one parser both this form and any later caller agree on. Create `src/lib/workspace/parse-topics.ts` — it goes in `lib`, not in the actions file, because `"use server"` modules may only export async functions.

Test first, at `tests/lib/workspace/parse-topics.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseTopics } from "../../../src/lib/workspace/parse-topics";

describe("parseTopics", () => {
  it("splits on commas and newlines", () => {
    expect(parseTopics("ai agents, developer tools\nobservability")).toEqual([
      "ai agents",
      "developer tools",
      "observability",
    ]);
  });

  it("drops blanks and trims whitespace", () => {
    expect(parseTopics("  ai agents ,, \n\n , devtools  ")).toEqual(["ai agents", "devtools"]);
  });

  it("returns an empty array for empty or whitespace-only input", () => {
    expect(parseTopics("")).toEqual([]);
    expect(parseTopics("   \n  ")).toEqual([]);
  });

  it("deduplicates case-insensitively, keeping the first spelling", () => {
    expect(parseTopics("AI Agents, ai agents, AI agents")).toEqual(["AI Agents"]);
  });
});
```

Run `npx vitest run tests/lib/workspace/parse-topics.test.ts` — expect FAIL, module not found. Then implement:

```ts
/**
 * Splits a topics textarea on commas and newlines. Deduplicates case-insensitively
 * because "AI agents" and "ai agents" would otherwise both reach the news agent's
 * search in spec 4 and pay for the same query twice.
 */
export function parseTopics(raw: string): string[] {
  const seen = new Set<string>();
  const topics: string[] = [];
  for (const part of raw.split(/[,\n]/)) {
    const topic = part.trim();
    if (!topic) continue;
    const key = topic.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    topics.push(topic);
  }
  return topics;
}
```

- [ ] **Step 2: Write the failing action test**

Create `tests/app/company-actions.test.ts`. This mirrors the setup in `tests/app/notion-actions.test.ts:11-14` — note two things that are easy to get wrong: the mock specifier is a **relative path**, not the `@/` alias, and `next/cache` must be mocked too because these actions call `revalidatePath`, which has no request context under test.

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, companyProfiles, competitors } from "../../src/db/schema";

let currentTenantId = "";
vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: "user-1" } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  saveCompanyContext,
  addCompetitorAction,
  removeCompetitorAction,
} from "../../src/app/(dashboard)/company/actions";

const TENANT = "Company Actions Test Tenant";
const OTHER = "Company Actions Other Tenant";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
  await db.delete(tenants).where(eq(tenants.name, OTHER));
  vi.restoreAllMocks();
});

async function seed(name: string) {
  const [tenant] = await db.insert(tenants).values({ name }).returning();
  return tenant;
}

describe("saveCompanyContext", () => {
  it("persists the prose fields and parsed topics", async () => {
    const tenant = await seed(TENANT);
    currentTenantId = tenant.id;

    const form = new FormData();
    form.set("oneLiner", " Issue tracking for software teams. ");
    form.set("category", "Project management");
    form.set("positioning", "Fast where incumbents are configurable.");
    form.set("topics", "developer productivity, issue tracking,, ");
    await saveCompanyContext(form);

    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile.oneLiner).toBe("Issue tracking for software teams.");
    expect(profile.category).toBe("Project management");
    expect(profile.topics).toEqual(["developer productivity", "issue tracking"]);
  });

  it("stores null rather than an empty string for a cleared prose field", async () => {
    const tenant = await seed(TENANT);
    currentTenantId = tenant.id;

    const form = new FormData();
    form.set("oneLiner", "   ");
    form.set("category", "");
    form.set("positioning", "");
    form.set("topics", "");
    await saveCompanyContext(form);

    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile.oneLiner).toBeNull();
    expect(profile.topics).toEqual([]);
  });
});

describe("competitor actions", () => {
  it("refuses a blank name without inserting", async () => {
    const tenant = await seed(TENANT);
    currentTenantId = tenant.id;

    const form = new FormData();
    form.set("name", "   ");
    const result = await addCompetitorAction(form);
    expect(result).toEqual({ ok: false, reason: "empty-name" });
    const rows = await db.select().from(competitors).where(eq(competitors.tenantId, tenant.id));
    expect(rows).toHaveLength(0);
  });

  it("cannot remove a competitor belonging to another tenant", async () => {
    const mine = await seed(TENANT);
    const theirs = await seed(OTHER);
    const [victim] = await db
      .insert(competitors)
      .values({ tenantId: theirs.id, name: "Jira" })
      .returning();

    currentTenantId = mine.id;
    await removeCompetitorAction(victim.id);

    const [stillThere] = await db.select().from(competitors).where(eq(competitors.id, victim.id));
    expect(stillThere).toBeDefined();
  });
});
```

The cross-tenant deletion case is the one that matters most. `removeCompetitor` is tenant-scoped in Task 4, and this test is what stops a future refactor from dropping that scoping — the same class of bug spec 1 hit with `saveLinkedinCopyAction`, where isolation lived implicitly in a `WHERE` clause and a "simplifying" port would have removed it.

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx vitest run tests/app/company-actions.test.ts`
Expected: FAIL — actions not exported.

- [ ] **Step 4: `git mv` the route and update links — carefully**

```bash
git mv "src/app/(dashboard)/brand-guidelines" "src/app/(dashboard)/company"
grep -rn "brand-guidelines" src
```

**Do not blanket find-and-replace `brand-guidelines`.** That string has two unrelated meanings in this codebase, and conflating them is the exact failure mode that cost spec 1 five defects:

| Hit | Action |
| --- | --- |
| `src/app/(dashboard)/nav-links.tsx:23` — `{ href: "/brand-guidelines", label: "Brand guidelines" }` | **Change** to `/company` and "Company" |
| `revalidatePath("/brand-guidelines")` in the moved `actions.ts` (4 occurrences) | **Change** to `/company` |
| `src/lib/ai/compose-prompt.ts:57` — `<brand-guidelines>…</brand-guidelines>` | **LEAVE.** XML delimiters inside an LLM prompt. |
| `src/lib/ai/review-draft.ts:64,71` — same delimiters | **LEAVE.** |
| `src/lib/ai/extract-release.ts:19` — prose in a comment | **LEAVE.** |

A stale `revalidatePath` is the silent one: saves land in the database but the page renders the old value until a hard reload, which reads as "saving is broken."

- [ ] **Step 5: Add the actions**

In `src/app/(dashboard)/company/actions.ts`, keep `saveGuidelines`, `saveIndustry`, `savePersonas` and `importBrandStyleFromUrl` exactly as they are (only their `revalidatePath` target changes), and append:

```ts
import { parseTopics } from "@/lib/workspace/parse-topics";
import { addCompetitor, removeCompetitor } from "@/lib/workspace/competitors";
import { bootstrapCompanyContext } from "@/lib/workspace/company-bootstrap";

/**
 * Persists the company-context card. Scoped to its own columns for the same
 * reason `saveGuidelines` is: every card on this page saves itself, so widening
 * this would read absent fields as empty and null another card's column.
 */
export async function saveCompanyContext(formData: FormData) {
  const session = await requireSession();
  const profile = await getOrCreateCompanyProfile(session.user.tenantId);

  await db
    .update(companyProfiles)
    .set({
      oneLiner: (formData.get("oneLiner") as string)?.trim() || null,
      category: (formData.get("category") as string)?.trim() || null,
      positioning: (formData.get("positioning") as string)?.trim() || null,
      topics: parseTopics((formData.get("topics") as string) ?? ""),
      updatedAt: new Date(),
    })
    .where(eq(companyProfiles.id, profile.id));

  revalidatePath("/company");
}

export async function addCompetitorAction(formData: FormData): Promise<{ ok: boolean; reason?: string }> {
  const session = await requireSession();
  const name = (formData.get("name") as string)?.trim();
  if (!name) return { ok: false, reason: "empty-name" };

  await addCompetitor(session.user.tenantId, {
    name,
    websiteUrl: (formData.get("websiteUrl") as string)?.trim() || null,
  });

  revalidatePath("/company");
  return { ok: true };
}

/**
 * Takes `unknown`-shaped client input like `savePersonas` does: a Server Action
 * argument is public input, and the tenant scoping lives inside `removeCompetitor`
 * so an id from another workspace matches nothing.
 */
export async function removeCompetitorAction(id: string): Promise<void> {
  const session = await requireSession();
  await removeCompetitor(session.user.tenantId, id);
  revalidatePath("/company");
}

/**
 * Re-drafts the company profile from their website. Returns the outcome so the
 * client can show inline feedback, matching `importBrandStyleFromUrl`.
 */
export async function bootstrapFromWebsite(url: string): Promise<{ ok: boolean; reason?: string }> {
  const session = await requireSession();
  const trimmed = url.trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  const result = await bootstrapCompanyContext(session.user.tenantId, trimmed);
  if (result.ok) revalidatePath("/company");
  return result;
}
```

- [ ] **Step 6: Build the UI**

`company-context-form.tsx`: `websiteUrl` with a "Draft from my website" button calling `bootstrapFromWebsite`, then `oneLiner`, `category`, `positioning`, and `topics`. Follow the existing components in this directory for form and button patterns — `guidelines-editor.tsx` and `industry-select.tsx` show how this repo wires server actions to forms.

`competitors-editor.tsx`: a list with a remove control, plus a name + optional website add form.

On `page.tsx`, present company context first, then competitors, then industry, personas, and voice. **Label `industry` and `category` so they cannot be mistaken for each other** — `industry` is the picklist that selects writing exemplars; `category` is prose describing the market. That distinction is documented in `src/db/schema.ts` on both columns.

Say plainly in the bootstrap UI that it drafts and the human corrects — this is the product's copilot posture in miniature, and a screen that implies the agent decided is the wrong first impression.

- [ ] **Step 7: Verify and commit**

```bash
npm run typecheck && npm run test && npm run lint
```

Note in your report that the dashboard sits behind an OAuth wall, so this task's UI is verified by types, lint and action-level tests rather than a click-through.

```bash
git add -A
git commit -m "feat: company settings surface with context and competitors

Renames /brand-guidelines to /company now that the page holds identity,
positioning, topics and competitors alongside voice."
```

---

### Task 6: Onboarding step 2 becomes "Your company"

**Files:**
- Modify: `src/app/onboarding/brand/page.tsx`, `src/app/onboarding/actions.ts`, `src/app/onboarding/steps.tsx`
- Test: extend `tests/lib/workspace/onboarding.test.ts` or add `tests/app/onboarding-company-actions.test.ts` following the existing onboarding test style

**Interfaces:**
- Consumes: `bootstrapCompanyContext` (Task 4)
- Produces: server action `bootstrapOnboardingCompany(formData)`; step 2's label changes to "Your company"

- [ ] **Step 1: Confirm the step numbering before editing**

`src/lib/workspace/onboarding-step.ts` maps step 2 to `/onboarding/brand` — **step 2 is the brand step, step 3 is connect.** Do not reorder them. Read that file and `src/app/onboarding/steps.tsx` before touching anything, and leave `clampStep`, `LAST_ONBOARDING_STEP` and `resolveOnboardingRedirect` untouched: `tenants.onboardingStep` holds 1–4 and changing the count would misread every existing row.

- [ ] **Step 2: Write the failing test**

**Read this before writing it.** This repo mocks navigation as `vi.mock("next/navigation", () => ({ redirect: vi.fn() }))` — see `tests/app/drafts/save-draft.test.ts:19`. The mock is a **no-op spy**, not a throw. The real `redirect()` throws, so nothing after it runs in production; under the mock, everything after it *does* run. A test that asserts "the step was not advanced" would therefore fail against correct code unless the action returns explicitly. Step 3 uses `return redirect(...)` for exactly this reason; assert on the spy's arguments as well as on the database.

Create `tests/app/onboarding-company-actions.test.ts`:

```ts
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "../../src/db";
import { tenants } from "../../src/db/schema";

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

let currentTenantId = "";
vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: async () => ({ user: { id: "u1", tenantId: currentTenantId } }),
}));

const bootstrap = vi.fn(async (..._args: unknown[]) => ({ ok: true }) as { ok: boolean; reason?: string });
vi.mock("../../src/lib/workspace/company-bootstrap", () => ({
  bootstrapCompanyContext: (...args: unknown[]) => bootstrap(...args),
}));

import { bootstrapOnboardingCompany, skipBrandStep } from "../../src/app/onboarding/actions";

const TENANT = "Onboarding Company Actions Test Tenant";

async function seed() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT, onboardingStep: 2 }).returning();
  currentTenantId = tenant.id;
  return tenant;
}

async function storedStep(tenantId: string) {
  const [row] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
  return row.onboardingStep;
}

beforeEach(() => {
  vi.mocked(redirect).mockClear();
  bootstrap.mockClear();
  bootstrap.mockResolvedValue({ ok: true });
});

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
});

describe("bootstrapOnboardingCompany", () => {
  it("advances to step 3 and continues the wizard on success", async () => {
    const tenant = await seed();
    const form = new FormData();
    form.set("websiteUrl", "https://acme.com");

    await bootstrapOnboardingCompany(form);

    expect(bootstrap).toHaveBeenCalledWith(tenant.id, "https://acme.com");
    expect(await storedStep(tenant.id)).toBe(3);
    expect(redirect).toHaveBeenCalledWith("/onboarding/connect");
  });

  it("keeps the user on step 2 when the crawl fails, so a blocked site is not a dead end", async () => {
    const tenant = await seed();
    bootstrap.mockResolvedValue({ ok: false, reason: "blocked" });
    const form = new FormData();
    form.set("websiteUrl", "https://acme.com");

    await bootstrapOnboardingCompany(form);

    expect(redirect).toHaveBeenCalledWith("/onboarding/brand?bootstrap=failed");
    expect(await storedStep(tenant.id)).toBe(2);
  });

  it("rejects an empty url without spending a crawl", async () => {
    const tenant = await seed();
    const form = new FormData();
    form.set("websiteUrl", "   ");

    await bootstrapOnboardingCompany(form);

    expect(bootstrap).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith("/onboarding/brand?error=empty");
    expect(await storedStep(tenant.id)).toBe(2);
  });
});

describe("skipBrandStep", () => {
  it("still advances past the step (existing behavior must survive)", async () => {
    const tenant = await seed();
    await skipBrandStep();
    expect(await storedStep(tenant.id)).toBe(3);
    expect(redirect).toHaveBeenCalledWith("/onboarding/connect");
  });
});
```

The second and fourth cases are the ones that matter. A company whose site blocks the crawl must not be trapped on step 2, and `skipBrandStep` is pre-existing behavior this task must not break while rewriting the screen around it.

- [ ] **Step 3: Add the action**

In `src/app/onboarding/actions.ts`, add `bootstrapOnboardingCompany` alongside the existing `importBrandStyle` — **do not replace it.** The two do different things: one reads the company site for context, the other reads the updates page for voice, and a team may want both.

Copy `importBrandStyle`'s shape exactly, including the guard on its first line:

```ts
export async function bootstrapOnboardingCompany(formData: FormData) {
  const session = await requireSession();
  // Same gate as importBrandStyle, for the same reason: guardOnboardingStep(2)
  // protects the PAGE, but a server action is a public endpoint that can be
  // replayed directly — and bootstrapCompanyContext fetches up to four live
  // pages and runs an LLM derivation, so an ungated replay burns real money on
  // a tenant who is already done. The write is idempotent; the cost is not.
  if (await isOnboardingComplete(session.user.tenantId)) return redirect("/atomic-updates");

  const url = (formData.get("websiteUrl") as string)?.trim();
  if (!url) return redirect("/onboarding/brand?error=empty");

  const result = await bootstrapCompanyContext(session.user.tenantId, url);
  // A failed crawl keeps the user on step 2 so they can try another URL or skip;
  // only a success advances. A company whose site blocks us must never be trapped.
  if (!result.ok) return redirect("/onboarding/brand?bootstrap=failed");

  await advanceOnboardingStep(session.user.tenantId, 3);
  return redirect("/onboarding/connect");
}
```

Two deliberate details, neither of which is style preference:

**The cost guard is not boilerplate.** It is why the existing `importBrandStyle` has one, and this action is strictly more expensive than the one it sits beside — four page fetches instead of one, plus a derivation.

**`return redirect(...)`, not bare `redirect(...)`.** The existing actions in this file use the bare form, which is correct in production because `redirect()` throws. But the test suite mocks it as a no-op spy, so under test the bare form falls through and advances the step on a failed crawl — a passing-looking action with a test that cannot detect the bug. `redirect()` is typed `never`, so `return redirect(...)` type-checks identically and makes the control flow real in both environments. Do not "clean this up" to match the neighbours.

- [ ] **Step 4: Rebuild the step screen**

`src/app/onboarding/brand/page.tsx` becomes: one website-URL field → on submit, run the bootstrap → show the drafted `oneLiner`, `category`, `positioning`, `topics` and proposed competitors as editable fields → Continue. Keep the existing skip control so a blocked crawl is never a dead end, and keep the updates-page brand import available as a secondary action.

Update the step's label in `src/app/onboarding/steps.tsx` from its brand wording to "Your company".

- [ ] **Step 5: Verify and commit**

```bash
npm run typecheck && npm run test && npm run lint
git add -A
git commit -m "feat: onboarding step 2 drafts the company profile from their site

One URL in, a drafted profile out, editable before continuing. The
updates-page brand import stays as a secondary action - it reads a
different page for a different purpose."
```

---

## Definition of done

- `npm run typecheck`, `npm run test`, and `npm run lint` all pass.
- No reference to `scrape-updates-page`, `fetchUpdatesPageText`, or `/brand-guidelines` remains in `src/` or `tests/`.
- A tenant can enter a website URL — in onboarding or in settings — and get a drafted `oneLiner`, `category`, `positioning`, `topics` and competitor list they can edit.
- A failed or blocked crawl leaves onboarding completable and writes nothing.
- Re-running the bootstrap does not duplicate competitors and does not overwrite hand-edited profile fields.

## Notes for spec 3

`competitors` rows carry only name and site. The specific pages watched — changelog, blog, releases — become `sources` rows, so spec 3 needs a discovery step that proposes those URLs per competitor. `fetchPageText` is already the hardened fetcher it should use, and `extractSameOriginLinks` is already the link discovery.
