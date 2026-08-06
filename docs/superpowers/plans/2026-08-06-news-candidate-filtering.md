# News Agent Candidate Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the news agent re-fetching articles it already judged, and stop it treating the company's own blog as industry news.

**Architecture:** A `rejected_articles` table records what the selector turned down and what the recency rule dropped; the existing pre-flight query gains a second lookup so remembered articles free a candidate slot before anything is fetched. Separately, the company's own host is derived from `companyProfiles.websiteUrl`, sent to Tavily so those result slots come back filled with other articles, and re-checked locally as a hard guarantee.

**Tech Stack:** TypeScript, Drizzle ORM 0.45.2, Postgres, Vitest, Tavily Search API.

**Spec:** `docs/superpowers/specs/2026-08-06-news-candidate-filtering-design.md`

## Global Constraints

- **Read `node_modules/next/dist/docs/` before writing any App Router code.** This repo's Next.js differs from training data. No task here touches App Router, but the rule stands.
- **The tests are the contract. If prose and a code sample in this plan disagree, STOP and report it.** Do not guess which one is right.
- **A comment that promises behaviour the code does not implement is a bug.** If you write a comment describing a mechanism, verify the code does it.
- **Never hardcode a value that a constant already expresses.** Derive test fixtures from the exported constant. Three fixtures in this repo were recently found silently encoding constants.
- **When you add a test meant to guard a behaviour, delete the guard and confirm the test fails.** Then confirm it passes for reasons that hold in a full parallel run — the suite runs ~156 files against one shared Postgres.
- **After any schema change run BOTH `npm run db:migrate:test` and `npm run db:migrate`.** A dev database left one migration behind previously produced a `42P10` error that was misdiagnosed as a code defect.
- **Every article URL must go through `fetchPageText`**, never a bare `fetch`. Search-result URLs are attacker-influenced.
- Tests must run against a database whose name ends in `_test`. `npm run test` enforces this.
- Commit after each task. Do not push. Do not merge.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/db/schema.ts` | `rejectedArticleReasonEnum`, `rejectedArticles` table | 1 |
| `src/db/migrations/*.sql` | generated migration | 1 |
| `src/lib/signals/news-agent.ts` | `rememberRejections` helper, two write points | 2 |
| `src/lib/signals/news-agent.ts` | pre-flight read, `alreadyRejected` counter | 3 |
| `src/lib/signals/tavily.ts` | options object, merged exclusions | 4 |
| `src/lib/signals/news-agent.ts` | `companyHost`, `isOwnContent`, `loadProfile`, local filter | 5 |
| `tests/lib/signals/news-agent.test.ts` | tasks 1–3, 5 | |
| `tests/lib/signals/tavily.test.ts` | task 4 | |

---

### Task 1: The `rejected_articles` table

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/db/migrations/<generated>.sql`
- Test: `tests/lib/signals/rejected-articles.test.ts`

**Interfaces:**
- Produces: `rejectedArticles` table with columns `id`, `tenantId`, `url`, `title`, `reason`, `rejectedAt`; `rejectedArticleReasonEnum` with values `"not_selected" | "stale"`; unique index `rejected_articles_tenant_url_unique` on `(tenantId, url)`.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/signals/rejected-articles.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, rejectedArticles } from "../../../src/db/schema";

const TENANT = "Rejected Articles Test Tenant";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
});

async function seedTenant() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  return tenant;
}

describe("rejectedArticles", () => {
  it("treats a repeat rejection of the same url as a no-op", async () => {
    const tenant = await seedTenant();
    const row = { tenantId: tenant.id, url: "https://a.example.com/x", title: "X", reason: "stale" as const };

    await db.insert(rejectedArticles).values(row);
    // The agent re-records on every run it sees the article again. This must
    // not raise — if it does, one repeat rejection kills a whole run.
    await db
      .insert(rejectedArticles)
      .values({ ...row, reason: "not_selected" as const })
      .onConflictDoNothing({ target: [rejectedArticles.tenantId, rejectedArticles.url] });

    const rows = await db.select().from(rejectedArticles).where(eq(rejectedArticles.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
    // First write wins: the conflict is ignored, not merged.
    expect(rows[0].reason).toBe("stale");
  });

  it("scopes a rejection to one tenant", async () => {
    const a = await seedTenant();
    const [b] = await db.insert(tenants).values({ name: TENANT }).returning();

    await db.insert(rejectedArticles).values([
      { tenantId: a.id, url: "https://a.example.com/shared", title: "Shared", reason: "stale" },
      { tenantId: b.id, url: "https://a.example.com/shared", title: "Shared", reason: "stale" },
    ]);

    // The same article rejected by two tenants is two rows. A unique index on
    // url alone would let one tenant's judgement hide an article from another.
    const rows = await db.select().from(rejectedArticles).where(eq(rejectedArticles.tenantId, a.id));
    expect(rows).toHaveLength(1);
  });

  it("drops a tenant's rejections when the tenant is deleted", async () => {
    const tenant = await seedTenant();
    await db
      .insert(rejectedArticles)
      .values({ tenantId: tenant.id, url: "https://a.example.com/y", title: "Y", reason: "not_selected" });

    await db.delete(tenants).where(eq(tenants.id, tenant.id));

    const rows = await db.select().from(rejectedArticles).where(eq(rejectedArticles.tenantId, tenant.id));
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/lib/signals/rejected-articles.test.ts
```

Expected: FAIL — `rejectedArticles` is not exported from `src/db/schema.ts`.

- [ ] **Step 3: Add the enum and table to `src/db/schema.ts`**

Put the enum beside the other `pgEnum` declarations near the top (the file groups them around lines 75–90), and the table after `briefSignals` at the end of the file:

```typescript
export const rejectedArticleReasonEnum = pgEnum("rejected_article_reason", ["not_selected", "stale"]);
```

```typescript
/**
 * Articles the news agent has already judged and will not reconsider.
 *
 * Deliberately NOT a status on `signals`. A rejected article is not a signal,
 * and putting it there would make every reader — `listSignals`, the signals
 * browser, `runIdeation` — responsible for excluding it. A miss in any one of
 * them puts junk in front of the brief agent. A separate table cannot leak.
 *
 * Written for two different reasons, distinguished by `reason`: the selector
 * turned it down (`not_selected`), or the article's own page dated it outside
 * RECENCY_WINDOW_DAYS (`stale`). Both are permanent — re-judging reaches the
 * same answer, and at ~15 rejections per tenant per day this table grows by
 * roughly 5k rows a year.
 *
 * `url` is stored NORMALIZED, via `normalizeArticleUrl`. That makes this the
 * second persisted consumer of that function alongside `signals.externalId`,
 * so it is doubly a data contract: changing normalization makes both the skip
 * query and this one miss, and re-admits every already-handled article.
 *
 * A rejection survives a company-profile edit. An article turned down under
 * old topics is not reconsidered under new ones — accepted deliberately,
 * because clearing on every edit re-opens the re-fetch flood this table exists
 * to close.
 */
export const rejectedArticles = pgTable(
  "rejected_articles",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    // Already in hand when the rejection is recorded. Without it the table is
    // a list of opaque URLs and nobody can tell a bad article from an old one.
    title: text("title").notNull(),
    reason: rejectedArticleReasonEnum("reason").notNull(),
    // No expiry is enforced. Stored so a purge can be added later without a
    // migration — NOT read by any query today.
    rejectedAt: timestamp("rejected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Tenant-scoped: the same article rejected by two tenants is two rows.
    // Keying on url alone would let one tenant's judgement hide an article
    // from every other tenant.
    uniqueIndex("rejected_articles_tenant_url_unique").on(table.tenantId, table.url),
  ]
);
```

- [ ] **Step 4: Generate and apply the migration**

```bash
npm run db:generate
```

Then apply to **both** databases — the test database and the dev database. Skipping the second is what produced a `42P10` misdiagnosis previously:

```bash
npm run db:migrate:test && npm run db:migrate
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run tests/lib/signals/rejected-articles.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 6: Prove the tenant-scoping guard bites**

Temporarily change the unique index to `.on(table.url)` only, regenerate nothing — just edit the schema and re-run. The "scopes a rejection to one tenant" test must FAIL. Restore the index afterwards and re-run to confirm green.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/db/migrations tests/lib/signals/rejected-articles.test.ts
git commit -m "feat: add rejected_articles, a per-tenant memory of judged articles"
```

---

### Task 2: Record rejections

**Files:**
- Modify: `src/lib/signals/news-agent.ts`
- Test: `tests/lib/signals/news-agent.test.ts`

**Interfaces:**
- Consumes: `rejectedArticles`, `rejectedArticleReasonEnum` from Task 1.
- Produces: module-private `rememberRejections(database, tenantId, entries)` where `entries: { url: string; title: string; reason: "not_selected" | "stale" }[]`. Nothing outside this module calls it.

**Context you need:** `runNewsSource` builds `byUrl: Map<string, NewsHit>` keyed by **normalized** URL, and stores `{ ...raw, url }` — so `article.url` is already normalized everywhere downstream. Do not normalize again.

- [ ] **Step 1: Write the failing tests**

Add to `tests/lib/signals/news-agent.test.ts` inside the `describe("runNewsSource")` block. Add `rejectedArticles` to the schema import at the top of the file.

```typescript
  it("records the articles the selector turned down", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);

    await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({
        hits: [
          hit("https://news.example.com/picked", "Picked"),
          hit("https://news.example.com/passed", "Passed over"),
        ],
        credits: 1,
      }),
      fetchPage: vi.fn().mockResolvedValue(page("body")),
      select: vi.fn().mockResolvedValue({
        selections: [{ index: 0, score: 0.8, rationale: "r", topics: [] }],
      }),
    });

    const rows = await db.select().from(rejectedArticles).where(eq(rejectedArticles.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe("https://news.example.com/passed");
    expect(rows[0].title).toBe("Passed over");
    expect(rows[0].reason).toBe("not_selected");
  });

  it("records an article dropped for being outside the recency window", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);
    const old = new Date(Date.now() - (RECENCY_WINDOW_DAYS + 5) * 24 * 60 * 60 * 1000).toISOString();

    await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({
        hits: [hit("https://news.example.com/ancient", "Ancient")],
        credits: 1,
      }),
      // A real <meta> date, not a bare <time> guess — only a page-asserted date
      // may trigger the stale drop, so only that may be recorded.
      fetchPage: vi
        .fn()
        .mockResolvedValue(page("body", `<meta property="article:published_time" content="${old}">`)),
      select: vi.fn().mockResolvedValue({ selections: [] }),
    });

    const rows = await db.select().from(rejectedArticles).where(eq(rejectedArticles.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe("https://news.example.com/ancient");
    expect(rows[0].reason).toBe("stale");
  });

  it("records NOTHING when the selection call fails", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);

    await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({
        hits: [hit("https://news.example.com/unjudged", "Unjudged")],
        credits: 1,
      }),
      fetchPage: vi.fn().mockResolvedValue(page("body")),
      select: vi.fn().mockResolvedValue({ error: "model timeout" }),
    });

    // An article nobody judged has not been rejected. Recording these would
    // permanently bury up to MAX_CANDIDATES_PER_RUN articles because of one
    // API timeout — the exact damage the fail-closed branch exists to prevent.
    const rows = await db.select().from(rejectedArticles).where(eq(rejectedArticles.tenantId, tenant.id));
    expect(rows).toHaveLength(0);
  });

  it("does not record candidates that lost the truncation, only those judged", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);
    // More candidates than the cap, so some are cut by the slice rather than
    // by any judgement. Derived from the constant, never hardcoded.
    const hits = Array.from({ length: MAX_CANDIDATES_PER_RUN + 6 }, (_, i) =>
      hit(`https://news.example.com/t${i}`, `T${i}`, TAVILY_SCORE_FLOOR + 0.01 + i * 0.01)
    );

    await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({ hits, credits: 1 }),
      fetchPage: vi.fn().mockResolvedValue(page("body")),
      select: vi.fn().mockResolvedValue({ selections: [] }),
    });

    // Truncated candidates were read by nobody and may rank into the top 20
    // tomorrow. Only what reached the selector counts as rejected.
    const rows = await db.select().from(rejectedArticles).where(eq(rejectedArticles.tenantId, tenant.id));
    expect(rows).toHaveLength(MAX_CANDIDATES_PER_RUN);
  });
```

Add `RECENCY_WINDOW_DAYS` and `TAVILY_SCORE_FLOOR` to the `news-agent` import list if not already present.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run tests/lib/signals/news-agent.test.ts -t "records"
```

Expected: FAIL — no rows are written.

- [ ] **Step 3: Add the helper**

Add `rejectedArticles` to the `@/db/schema` import in `src/lib/signals/news-agent.ts`, then add near `finish`:

```typescript
/**
 * Records articles this tenant will not be offered again.
 *
 * Never throws. A failed memory write must not cost a run its signals, so the
 * caller records the failure in `errors` and carries on — the worst case is
 * that these articles are re-judged next run, which is the behaviour that
 * existed before this table.
 *
 * `url` must already be normalized. `runNewsSource` stores normalized URLs in
 * `byUrl`, so every caller inside this module satisfies that by construction.
 */
async function rememberRejections(
  database: typeof defaultDb,
  tenantId: string,
  entries: { url: string; title: string; reason: "not_selected" | "stale" }[]
): Promise<void> {
  if (entries.length === 0) return;
  await database
    .insert(rejectedArticles)
    .values(entries.map((e) => ({ tenantId, url: e.url, title: e.title, reason: e.reason })))
    // A repeat rejection is expected, not exceptional: an article stays in the
    // search window for weeks. First write wins.
    .onConflictDoNothing({ target: [rejectedArticles.tenantId, rejectedArticles.url] });
}
```

- [ ] **Step 4: Record stale drops**

In the recency loop (currently `news-agent.ts:421-430`), collect as you go:

```typescript
  const cutoff = new Date(Date.now() - RECENCY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const kept: { article: NewsHit; body: string; date: Date | null }[] = [];
  const staleRejections: { url: string; title: string; reason: "stale" }[] = [];
  let stale = 0;
  for (const [i, article] of fresh.entries()) {
    const date = dates[i];
    if (date !== null && !guessed[i] && date < cutoff) {
      stale++;
      staleRejections.push({ url: article.url, title: article.title, reason: "stale" });
      continue;
    }
    kept.push({ article, body: bodies[i], date });
  }
```

Then immediately after the existing `if (stale > 0) { ... errors.push(...) }` block:

```typescript
  // Recorded here rather than with the selector's rejections below, because
  // staleness is a complete judgement on its own: it does not depend on the
  // selection call, so a later selection failure must not discard it. It is
  // also permanent in a way selection is not — an article only gets older.
  try {
    await rememberRejections(database, source.tenantId, staleRejections);
  } catch (e) {
    errors.push(`could not record stale articles: ${e instanceof Error ? e.message : String(e)}`);
  }
```

- [ ] **Step 5: Record selector rejections**

Replace the `const dropped = ...` line (currently `news-agent.ts:501`) with:

```typescript
  // The set, not the count, is the authority for what gets recorded: if the
  // model ever returned a duplicate index, arithmetic on lengths would
  // disagree with the actual complement. `dropped` is left as-is because it is
  // an existing reported number and this task does not change its contract.
  const selectedIndices = new Set(outcome.selections.map((s) => s.index));
  const notSelected = kept
    .filter((_, i) => !selectedIndices.has(i))
    .map((k) => ({ url: k.article.url, title: k.article.title, reason: "not_selected" as const }));
  const dropped = kept.length - outcome.selections.length;
```

Then, **after** the write loop that inserts signals (so a memory-write failure cannot cost the run its signals), and still inside the success path:

```typescript
  // MUST stay after the `"error" in outcome` branch above, which returns early.
  // An article nobody judged has not been rejected, and recording these on a
  // failed selection would bury up to MAX_CANDIDATES_PER_RUN articles
  // permanently because of one API timeout. Do not hoist this to "keep the
  // write path together".
  try {
    await rememberRejections(database, source.tenantId, notSelected);
  } catch (e) {
    errors.push(`could not record rejected articles: ${e instanceof Error ? e.message : String(e)}`);
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run tests/lib/signals/news-agent.test.ts
```

Expected: PASS, all tests in the file.

- [ ] **Step 7: Prove the fail-closed guard bites**

Temporarily move the `rememberRejections(database, source.tenantId, notSelected)` call to **before** the `if ("error" in outcome)` branch, using `outcome.selections ?? []`. The test `records NOTHING when the selection call fails` must FAIL. Restore and re-run.

- [ ] **Step 8: Commit**

```bash
git add src/lib/signals/news-agent.ts tests/lib/signals/news-agent.test.ts
git commit -m "feat: record selector rejections and stale drops"
```

---

### Task 3: Skip remembered articles before spending anything

**Files:**
- Modify: `src/lib/signals/news-agent.ts:326-344` (pre-flight), `:32-43` (`NewsRunResult`), `:292` (`empty`)
- Test: `tests/lib/signals/news-agent.test.ts`

**Interfaces:**
- Consumes: `rejectedArticles` (Task 1), rejections written by Task 2.
- Produces: `NewsRunResult.alreadyRejected: number`.

- [ ] **Step 1: Write the failing tests**

```typescript
  it("skips a remembered article before fetching or scoring it", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["localization"]);
    await db.insert(rejectedArticles).values({
      tenantId: tenant.id,
      url: "https://news.example.com/known",
      title: "Known",
      reason: "not_selected",
    });
    const fetchPage = vi.fn().mockResolvedValue(page("body"));
    const select = vi.fn().mockResolvedValue({ selections: [] });

    const result = await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({
        hits: [hit("https://news.example.com/known", "Known"), hit("https://news.example.com/new", "New")],
        credits: 1,
      }),
      fetchPage,
      select,
    });

    // The point of the memory is freeing a candidate slot, not merely avoiding
    // a duplicate row — so assert it was never FETCHED, not just never written.
    expect(fetchPage.mock.calls.map((c) => c[0])).toEqual(["https://news.example.com/new"]);
    expect(select.mock.calls[0][0].map((c: { url: string }) => c.url)).toEqual(["https://news.example.com/new"]);
    expect(result.alreadyRejected).toBe(1);
  });

  it("does not let one tenant's rejection hide an article from another", async () => {
    const mine = await seedTenant();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const source = await seedNewsSource(mine.id, ["localization"]);
    await db.insert(rejectedArticles).values({
      tenantId: other.id,
      url: "https://news.example.com/shared",
      title: "Shared",
      reason: "not_selected",
    });
    const fetchPage = vi.fn().mockResolvedValue(page("body"));

    const result = await runNewsSource(source, {
      database: db,
      search: vi.fn().mockResolvedValue({ hits: [hit("https://news.example.com/shared")], credits: 1 }),
      fetchPage,
      select: vi.fn().mockResolvedValue({ selections: [] }),
    });

    expect(fetchPage).toHaveBeenCalledWith("https://news.example.com/shared");
    expect(result.alreadyRejected).toBe(0);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run tests/lib/signals/news-agent.test.ts -t "remembered"
```

Expected: FAIL — `alreadyRejected` is `undefined` and the article is fetched.

- [ ] **Step 3: Extend the result type**

In `NewsRunResult` (`news-agent.ts:32-43`):

```typescript
  /**
   * Already judged and turned down — not fetched, not scored, not billed.
   * Distinct from `skipped`, which is "we already wrote this". Both are
   * returned and BOTH ARE CURRENTLY DISCARDED by `sweepNewsSources`; the
   * signature of a pool crowded out by repeats is this number staying high
   * while `written` falls toward zero, and nothing surfaces that yet.
   */
  alreadyRejected: number;
```

And in `empty` (`news-agent.ts:292`):

```typescript
  const empty: NewsRunResult = {
    written: 0,
    dropped: 0,
    skipped: 0,
    credits: 0,
    selected: 0,
    stale: 0,
    alreadyRejected: 0,
  };
```

- [ ] **Step 4: Add the second pre-flight lookup**

Immediately after the existing signals skip and its `byUrl.size === 0` early return (`news-agent.ts:338-344`), add:

```typescript
  // ── Skip what we already judged ───────────────────────────────────────
  // Deliberately BEFORE the score filter, the truncation and every fetch: a
  // remembered article must free a candidate slot for new material, not merely
  // avoid a duplicate row. Queried against what survived the signals skip, so
  // it never asks about URLs already removed.
  const remainingUrls = [...byUrl.keys()];
  const rejectedRows = await database
    .select({ url: rejectedArticles.url })
    .from(rejectedArticles)
    .where(
      and(eq(rejectedArticles.tenantId, source.tenantId), inArray(rejectedArticles.url, remainingUrls))
    );
  for (const row of rejectedRows) byUrl.delete(row.url);
  const alreadyRejected = rejectedRows.length;

  if (byUrl.size === 0) {
    await finish(database, source.id, errors.length > 0 ? errors.join("; ") : null, productive);
    return { ...empty, skipped, alreadyRejected, credits };
  }
```

- [ ] **Step 5: Thread the counter through every return**

`runNewsSource` has several `return { ...empty, ... }` sites. Every return **after** the block added in Step 4 must include `alreadyRejected`. Returns *before* it correctly inherit `0` from `empty`. Find them all:

```bash
grep -n "return {" src/lib/signals/news-agent.ts
```

Check each against its position relative to the new block. The final success return must include it too.

- [ ] **Step 6: Run the full file to verify**

```bash
npx vitest run tests/lib/signals/news-agent.test.ts
npm run typecheck
```

Expected: PASS, and typecheck clean. `NewsRunResult` gaining a required field will surface any construction site that missed it.

- [ ] **Step 7: Prove the placement guard bites**

Move the new lookup to *after* the `slice(0, MAX_CANDIDATES_PER_RUN)`. The test `skips a remembered article before fetching or scoring it` must still pass on the write assertion but FAIL on `fetchPage.mock.calls` — that is the assertion doing the real work. Restore and re-run.

- [ ] **Step 8: Commit**

```bash
git add src/lib/signals/news-agent.ts tests/lib/signals/news-agent.test.ts
git commit -m "feat: skip remembered articles before fetch and scoring"
```

---

### Task 4: `searchNews` accepts extra excluded domains

**Files:**
- Modify: `src/lib/signals/tavily.ts:171-243`
- Test: `tests/lib/signals/tavily.test.ts`

**Interfaces:**
- Produces: `searchNews(query: string, options?: { excludeDomains?: string[]; fetchImpl?: TavilyFetch })`. All 19 existing call sites in `tavily.test.ts` pass `{ fetchImpl }` and are unaffected by the rename of the parameter's role.

- [ ] **Step 1: Write the failing test**

Add to `tests/lib/signals/tavily.test.ts`:

```typescript
  it("merges caller-supplied domains into the static exclusion list", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200 })
    );

    await searchNews("ux writing", { fetchImpl, excludeDomains: ["frontitude.com"] });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    expect(body.exclude_domains).toContain("frontitude.com");
    // The static list is a floor, not a default the caller replaces.
    for (const domain of EXCLUDED_DOMAINS) expect(body.exclude_domains).toContain(domain);
  });

  it("sends the static list unchanged when the caller supplies none", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200 })
    );

    await searchNews("ux writing", { fetchImpl });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    expect(body.exclude_domains).toEqual(EXCLUDED_DOMAINS);
  });
```

Ensure `EXCLUDED_DOMAINS` is imported in the test file.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/lib/signals/tavily.test.ts -t "exclusion list"
```

Expected: FAIL — `exclude_domains` does not contain `frontitude.com`.

- [ ] **Step 3: Widen the signature**

In `src/lib/signals/tavily.ts`:

```typescript
export type SearchOptions = {
  /**
   * Per-tenant exclusions, merged with the static EXCLUDED_DOMAINS. Used for
   * the searching company's own domain: its blog ranks for exactly the topics
   * it configured, so without this it consumes result slots the industry
   * should have — and could become a `market_news` signal about itself.
   */
  excludeDomains?: string[];
  fetchImpl?: TavilyFetch;
};

export async function searchNews(query: string, options: SearchOptions = {}): Promise<TavilyResult> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return { error: "no-api-key" };

  const fetchImpl = options.fetchImpl ?? fetch;
  // Set, not concat: a caller-supplied domain already in the static list would
  // otherwise be sent twice.
  const excludeDomains = [...new Set([...EXCLUDED_DOMAINS, ...(options.excludeDomains ?? [])])];
```

and in the request body, replace `exclude_domains: EXCLUDED_DOMAINS` with `exclude_domains: excludeDomains`.

The rest of the function is unchanged. **Do not** alter `deps` naming anywhere else — the only other consumer is the `SearchFn` type in `news-agent.ts`, handled in Task 5.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run tests/lib/signals/tavily.test.ts
npm run typecheck
```

Expected: PASS, all tests in the file. Typecheck may report an error in `news-agent.ts` if `SearchFn` is structurally incompatible — if so, note it and leave it for Task 5 rather than patching it here.

- [ ] **Step 5: Commit**

```bash
git add src/lib/signals/tavily.ts tests/lib/signals/tavily.test.ts
git commit -m "feat: let searchNews take per-tenant excluded domains"
```

---

### Task 5: Exclude the company's own content

**Files:**
- Modify: `src/lib/signals/news-agent.ts:15` (`SearchFn`), `:231-241` (`loadProfile`), `:294-295`, `:311-315` (search loop)
- Modify: `tests/lib/signals/news-agent.test.ts` — `seedNewsSource`, and the existing test `searches the bare topic, without a literal 'news' suffix`
- Test: `tests/lib/signals/news-agent.test.ts`

**Interfaces:**
- Consumes: `searchNews(query, { excludeDomains, fetchImpl })` from Task 4.
- Produces: exported `companyHost(websiteUrl: string | null): string | null` and `isOwnContent(url: string, ownHost: string | null): boolean`. `loadProfile` returns `{ profile: RelevanceProfile; ownHost: string | null }`.

**Why `loadProfile` changes shape rather than `RelevanceProfile` gaining a field:** `RelevanceProfile` is defined in `src/lib/signals/relevance.ts` and shared with the competitor relevance pass. It must not grow a news-only field.

- [ ] **Step 1: Update the test seed helper**

`seedNewsSource` currently writes only `topics`. Give it an optional website:

```typescript
async function seedNewsSource(tenantId: string, topics: string[], websiteUrl?: string): Promise<Source> {
  await db
    .insert(companyProfiles)
    .values({ tenantId, topics, websiteUrl })
    .onConflictDoUpdate({ target: companyProfiles.tenantId, set: { topics, websiteUrl } });

  const [source] = await db
    .insert(sources)
    .values({ tenantId, type: "news", url: null, label: "Industry news" })
    .returning();
  return source;
}
```

- [ ] **Step 2: Write the failing tests**

```typescript
describe("companyHost", () => {
  it("reduces a website url to a bare lowercase host", () => {
    expect(companyHost("https://www.Frontitude.com/blog")).toBe("frontitude.com");
    expect(companyHost("https://frontitude.com")).toBe("frontitude.com");
  });

  it("accepts a bare domain with no scheme, as stored profiles sometimes are", () => {
    expect(companyHost("frontitude.com")).toBe("frontitude.com");
  });

  it("returns null rather than throwing on absent or unusable input", () => {
    // Must never throw and must never yield "" — an empty host would make
    // isOwnContent match everything and silently empty every run.
    expect(companyHost(null)).toBeNull();
    expect(companyHost("")).toBeNull();
    expect(companyHost("   ")).toBeNull();
  });
});

describe("isOwnContent", () => {
  it("matches the host and its subdomains", () => {
    expect(isOwnContent("https://frontitude.com/blog/x", "frontitude.com")).toBe(true);
    expect(isOwnContent("https://blog.frontitude.com/x", "frontitude.com")).toBe(true);
    expect(isOwnContent("https://www.frontitude.com/x", "frontitude.com")).toBe(true);
  });

  it("does not match a host that merely contains the name", () => {
    // Guards against a substring or endsWith check without the dot separator.
    expect(isOwnContent("https://notfrontitude.com/x", "frontitude.com")).toBe(false);
    expect(isOwnContent("https://frontitude.com.evil.example/x", "frontitude.com")).toBe(false);
  });

  it("matches nothing when the company has no known host", () => {
    expect(isOwnContent("https://anything.example.com/x", null)).toBe(false);
  });
});
```

And in `describe("runNewsSource")`:

```typescript
  it("asks Tavily to exclude the company's own domain", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["ux writing"], "https://www.frontitude.com");
    const search = vi.fn().mockResolvedValue({ hits: [], credits: 1 });

    await runNewsSource(source, { database: db, search, fetchPage: vi.fn(), select: vi.fn() });

    expect(search.mock.calls[0][1]).toEqual({ excludeDomains: ["frontitude.com"] });
  });

  it("drops the company's own article even when the search returns it", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["ux writing"], "https://frontitude.com");
    const fetchPage = vi.fn().mockResolvedValue(page("body"));

    await runNewsSource(source, {
      database: db,
      // Tavily's exclude_domains is not a contract we control, and its
      // subdomain semantics are unverified. This is the belt-and-braces case.
      search: vi.fn().mockResolvedValue({
        hits: [
          hit("https://blog.frontitude.com/our-post", "Our own post"),
          hit("https://other.example.com/theirs", "Someone else's"),
        ],
        credits: 1,
      }),
      fetchPage,
      select: vi.fn().mockResolvedValue({ selections: [] }),
    });

    expect(fetchPage.mock.calls.map((c) => c[0])).toEqual(["https://other.example.com/theirs"]);
  });

  it("excludes nothing when the profile has no website url", async () => {
    const tenant = await seedTenant();
    const source = await seedNewsSource(tenant.id, ["ux writing"]);
    const search = vi.fn().mockResolvedValue({ hits: [hit("https://a.example.com/x")], credits: 1 });
    const fetchPage = vi.fn().mockResolvedValue(page("body"));

    await runNewsSource(source, {
      database: db,
      search,
      fetchPage,
      select: vi.fn().mockResolvedValue({ selections: [] }),
    });

    expect(search.mock.calls[0][1]).toEqual({ excludeDomains: [] });
    expect(fetchPage).toHaveBeenCalledWith("https://a.example.com/x");
  });
```

- [ ] **Step 3: Fix the test this task breaks**

`news-agent.test.ts` contains:

```typescript
    expect(search).toHaveBeenCalledWith("developer cli");
```

This is an exact-arguments assertion and **will fail** once the agent passes a second argument. Change it to:

```typescript
    expect(search.mock.calls[0][0]).toBe("developer cli");
```

It must keep testing what it was written for — that no literal `" news"` suffix is appended. Do **not** weaken it to `expect.anything()` on the query itself, and do not delete it.

- [ ] **Step 4: Run the tests to verify they fail**

```bash
npx vitest run tests/lib/signals/news-agent.test.ts
```

Expected: FAIL — `companyHost` and `isOwnContent` are not exported.

- [ ] **Step 5: Add the two helpers**

In `src/lib/signals/news-agent.ts`, near `normalizeArticleUrl`:

```typescript
/**
 * The company's own bare host, or null if it has none we can use.
 *
 * Returns null — never `""` — for anything unusable. An empty host would make
 * `isOwnContent` match every article and silently empty every run behind a
 * green badge, which is the worst failure this module can have.
 */
export function companyHost(websiteUrl: string | null): string | null {
  if (!websiteUrl || websiteUrl.trim().length === 0) return null;
  const raw = websiteUrl.trim();
  // Profiles are hand-editable and are sometimes stored without a scheme,
  // which `new URL` rejects outright.
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const host = new URL(candidate).hostname.toLowerCase();
    if (host.length === 0) return null;
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null;
  }
}

/**
 * Whether an article belongs to the searching company itself.
 *
 * The agent searches `companyProfiles.topics` — by construction the subjects
 * the company publishes about — so its own blog ranks highly for its own
 * topics. Without this, the company's posts consume result, fetch and scoring
 * slots, and one could become a `market_news` signal telling the brief agent
 * that the company's own writing is an industry development.
 *
 * Matches subdomains via a dot-anchored suffix. `endsWith(ownHost)` alone would
 * match `notfrontitude.com`; the leading dot is what makes it a boundary.
 */
export function isOwnContent(url: string, ownHost: string | null): boolean {
  if (!ownHost) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    const bare = host.startsWith("www.") ? host.slice(4) : host;
    return bare === ownHost || bare.endsWith(`.${ownHost}`);
  } catch {
    return false;
  }
}
```

- [ ] **Step 6: Widen `SearchFn` and `loadProfile`**

```typescript
type SearchFn = (
  query: string,
  options?: { excludeDomains?: string[]; fetchImpl?: typeof fetch }
) => Promise<TavilyResult>;
```

```typescript
async function loadProfile(
  tenantId: string,
  database: typeof defaultDb
): Promise<{ profile: RelevanceProfile; ownHost: string | null }> {
  const [tenant] = await database.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
  const [profile] = await database.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenantId));

  return {
    // `RelevanceProfile` is shared with the competitor relevance pass and must
    // not grow a news-only field, so the host rides alongside it.
    profile: {
      name: tenant?.name ?? "",
      oneLiner: profile?.oneLiner ?? null,
      positioning: profile?.positioning ?? null,
      topics: profile?.topics ?? [],
    },
    ownHost: companyHost(profile?.websiteUrl ?? null),
  };
}
```

- [ ] **Step 7: Use both at the call sites**

At the top of `runNewsSource` (`news-agent.ts:294-295`):

```typescript
  const { profile, ownHost } = await loadProfile(source.tenantId, database);
  const topics = profile.topics.slice(0, MAX_TOPICS_PER_RUN);
  const excludeDomains = ownHost ? [ownHost] : [];
```

In the search loop, replace `const result = await search(topic);` with:

```typescript
    const result = await search(topic, { excludeDomains });
```

And in the hit loop (`news-agent.ts:311-315`), before the dedupe:

```typescript
    for (const raw of result.hits) {
      const url = normalizeArticleUrl(raw.url);
      // Belt and braces with the `excludeDomains` sent above. Tavily's matching
      // is not a contract we control and its subdomain behaviour is unverified,
      // so this is the guarantee: no `market_news` signal is ever created from
      // the company's own writing.
      if (isOwnContent(url, ownHost)) continue;
      const held = byUrl.get(url);
```

- [ ] **Step 8: Run the tests to verify they pass**

```bash
npx vitest run tests/lib/signals/news-agent.test.ts tests/lib/signals/tavily.test.ts
npm run typecheck
npx eslint src/lib/signals/news-agent.ts src/lib/signals/tavily.ts tests/lib/signals/news-agent.test.ts
```

Expected: all PASS, typecheck clean, no new lint errors.

- [ ] **Step 9: Prove the subdomain-boundary guard bites**

Change `isOwnContent`'s return to `bare === ownHost || bare.endsWith(ownHost)` — dropping the dot. The test `does not match a host that merely contains the name` must FAIL. Restore and re-run.

- [ ] **Step 10: Run the full suite twice**

The suite is flaky — ~156 files against one shared Postgres. A single green run is not evidence.

```bash
npm run test 2>&1 | tail -20
npm run test 2>&1 | tail -20
```

If a file fails, check whether it is one this plan touched. If it is not, it is pre-existing flakiness — report it, do not fix it here.

- [ ] **Step 11: Commit**

```bash
git add src/lib/signals/news-agent.ts tests/lib/signals/news-agent.test.ts
git commit -m "feat: exclude the company's own content from industry news"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| `rejected_articles` table, `reason` enum, tenant-scoped unique | 1 |
| No retention/TTL, `rejected_at` stored unused | 1 |
| Stale drops recorded | 2 |
| Selector rejections recorded | 2 |
| Insert after the fail-closed branch | 2 (step 5 + step 7 proof) |
| Truncated candidates never recorded | 2 (test 4) |
| Pre-flight read before fetch and score | 3 |
| `alreadyRejected` counted separately | 3 |
| `searchNews` options object, merged exclusions | 4 |
| Host derivation, `www.` stripping, null-safe | 5 |
| Server-side exclusion | 5 (step 7) |
| Local filter | 5 (step 7) |
| Subdomain matching, substring guard | 5 (tests + step 9) |
| The `toHaveBeenCalledWith` test that breaks | 5 (step 3) |
| Both migrate commands | 1 (step 4) |
| No orchestrator/cron test changes | — verified: both features live inside `runNewsSource`, which the cron route test already mocks |

**Type consistency:** `rejectedArticles` columns (`tenantId`, `url`, `title`, `reason`, `rejectedAt`) are used identically in tasks 1, 2 and 3. `rememberRejections`'s `entries` type matches both call sites' literals, including `as const` on `reason`. `companyHost` / `isOwnContent` signatures match between task 5's tests and implementation. `SearchFn`'s widened second parameter matches `SearchOptions` in task 4 structurally.

**Known gaps carried forward, not fixed here:**

- `sweepNewsSources` discards `alreadyRejected` and `dropped`, so pool stagnation remains unobservable.
- `EXCLUDED_DOMAINS` does not cover whatever served the Capital One job posting (0.838) and social post (0.902) in the 2026-08-06 probe. Needs a probe capturing hostnames.
