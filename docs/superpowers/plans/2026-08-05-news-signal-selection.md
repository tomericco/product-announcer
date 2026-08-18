# News Signal Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap the news agent at 5 signals per tenant per day, choosing them for novelty against what we already hold and for whether they would survive a review by the company's audience — and discard the rest as early and as cheaply as possible.

**Architecture:** Three filters in increasing order of cost. First, Tavily's own per-result relevance score (already returned, currently discarded) sorts and truncates candidates before a single article is fetched. Second, a hard candidate cap bounds what reaches the model. Third, one LLM pass replaces the generic `scoreRelevance` for news only: it receives the surviving candidates plus the titles of recent `market_news` signals, and returns **at most 5** with a score, a rationale, and topics. It fails **closed** — an article that was never judged cannot have passed the bar, so a failed pass writes nothing and marks the source failing.

**Tech Stack:** Next.js 16 App Router, Drizzle ORM + Postgres, AI SDK v7 with `@ai-sdk/anthropic`, Vitest.

## Global Constraints

- **This is NOT the Next.js you know.** Next.js 16 with breaking changes from common training data. Read `node_modules/next/dist/docs/` before writing any App Router code. This plan should not need any.
- Tests run against a **real Postgres database whose name must end in `_test`**; 150 files run **in parallel against one shared database** with no rollback wrapper. Tests seed tenants inline with a file-unique name constant and clean up in `afterEach`. **There is no shared tenant helper and you must not create one.**
- Tests import by **relative path**, not the `@/` alias (`../../../src/...` from `tests/lib/signals/`). Source files under `src/` DO use `@/`.
- **`recordLlmUsage`'s `operation` is a CLOSED string-literal union** in `src/lib/ai/llm-usage.ts`, currently ending at `"signal_relevance"`. **Task 2 adds `"news_selection"` to it.** The database column is free text, so a missing union member fails only at `tsc`, never at runtime.
- LLM calls go to **Anthropic directly** via `@ai-sdk/anthropic`. Do not route through the Vercel AI Gateway.
- **Every article URL goes through `fetchPageText`.** Never a bare `fetch`.
- **The tests are the contract.** If a task's prose and its code sample disagree, **stop and report** — that is a plan bug.
- **A comment that promises behaviour the code does not implement is a bug.**
- **When a task adds a call to an existing orchestrator, that orchestrator's test is a file to modify.** This plan changes no orchestrator, but the rule stands.

## Two decisions already made — do not re-litigate

1. **On selection failure the run writes nothing** and marks the source `failing`. This **reverses** the fail-open behaviour `scoreRelevance` uses. That behaviour was written when there was no cap and the risk was a missed story; with a cap of 5, fail-open means writing up to 20 unjudged articles, which is precisely what the cap exists to prevent. The settings health block already surfaces `lastError`, so the outage is visible.
2. **The cap is news-only.** `shipped_work` and `competitor_move` signals are untouched — they are first-party facts, individually meaningful, and low-volume. Do not add a cap to `competitor-agent.ts` or `shipped-work.ts`.

## Verified facts this plan depends on

Read from source before this plan was written. If one is false, stop and report.

- `src/lib/signals/tavily.ts`'s `ResponseSchema` currently parses `title`, `url`, `content`, `published_date`, and `usage.credits`. It does **not** parse the per-result `score` Tavily returns.
- `NewsHit` is `{ title, url, content, publishedAt }`.
- `src/lib/signals/news-agent.ts` calls `scoreRelevance(items, profile, tenantId)` and writes every item whose score is null or ≥ `RELEVANCE_FLOOR` (0.3).
- `finish(database, sourceId, error, productive)` is the source-row update helper; `productive` false ⇒ `status: "failing"` and `lastSuccessAt` withheld.
- `NewsRunResult` is `{ written, dropped, skipped, credits }`.
- `signals_tenant_kind_occurred_idx` is on `(tenantId, kind, occurredAt)`, so a recent-titles query filtered by tenant + kind and ordered by `occurredAt` is indexed.
- `LlmOperation` ends at `"signal_relevance"`.

---

## File Structure

**Create:**
- `src/lib/signals/news-selection.ts` — `selectNewsSignals`: the one model call, its prompt, and its schema. No database access.
- `tests/lib/signals/news-selection.test.ts`

**Modify:**
- `src/lib/signals/tavily.ts` — parse and expose the per-result score.
- `src/lib/ai/llm-usage.ts` — add `"news_selection"` to the closed union.
- `src/lib/signals/news-agent.ts` — pre-filter, candidate cap, swap the scorer, fail closed.
- `tests/lib/signals/tavily.test.ts`, `tests/lib/signals/news-agent.test.ts`

---

### Task 1: Keep the relevance score Tavily already gives us

The cheapest filter available, currently thrown away. Sorting by it and truncating before the fetch stage removes most of the run's cost with no model call and no extra request.

**Files:**
- Modify: `src/lib/signals/tavily.ts`
- Test: `tests/lib/signals/tavily.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `NewsHit` gains `score: number` — Tavily's own 0–1 relevance for the query that found it. Task 3 sorts and filters on it.

- [ ] **Step 1: Write the failing tests**

Add to `tests/lib/signals/tavily.test.ts` (the file already has `SAMPLE`, `okResponse`, and the env-var `beforeEach`/`afterEach` — reuse them):

```typescript
  it("keeps Tavily's own relevance score for each hit", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(SAMPLE));

    const result = await searchNews("localization tooling", { fetchImpl });

    expect("hits" in result).toBe(true);
    if (!("hits" in result)) return;
    expect(result.hits[0].score).toBe(0.91);
  });

  it("treats a missing score as zero rather than dropping the hit", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({
        ...SAMPLE,
        results: [{ title: "No score", url: "https://news.example.com/a", content: "x" }],
      })
    );

    const result = await searchNews("q", { fetchImpl });

    expect("hits" in result).toBe(true);
    if (!("hits" in result)) return;
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].score).toBe(0);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/signals/tavily.test.ts`
Expected: FAIL — `score` is `undefined` on `NewsHit`.

- [ ] **Step 3: Parse and expose the score**

In `src/lib/signals/tavily.ts`, add the field to `NewsHit`:

```typescript
  /**
   * Tavily's own 0–1 relevance for the query that found this hit. Free — it
   * arrives with every result — and it is the only filter available before we
   * spend a fetch or a model call on an article. Absent scores become 0 rather
   * than dropping the hit: a scoreless result is unranked, not irrelevant, and
   * the caller's floor decides what to do with it.
   */
  score: number;
```

Add it to `ResponseSchema`'s result object:

```typescript
      score: z.number().default(0),
```

And to the mapped hit:

```typescript
      score: r.score,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/signals/tavily.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/signals/tavily.ts tests/lib/signals/tavily.test.ts
git commit -m "feat: keep Tavily's per-result relevance score"
```

---

### Task 2: The selection pass

One model call. It receives candidates and the titles of news we already hold, and returns at most 5.

**Files:**
- Create: `src/lib/signals/news-selection.ts`
- Modify: `src/lib/ai/llm-usage.ts`
- Test: `tests/lib/signals/news-selection.test.ts`

**Interfaces:**
- Consumes: `resolveModel`, `modelId` from `@/lib/ai/model`; `recordLlmUsage`, `LlmOperation` from `@/lib/ai/llm-usage`; `RelevanceProfile` from `@/lib/signals/relevance` (reuse the type — do not define a second profile shape).
- Produces:
  - `type NewsCandidate = { title: string; text: string; url: string }`
  - `type NewsSelection = { index: number; score: number; rationale: string; topics: string[] }`
  - `type SelectionResult = { selections: NewsSelection[] } | { error: string }`
  - `type SelectionGenerate = …` (a test seam matching the `generateObject` call actually made)
  - `type NewsSelectionDeps = { generate?: SelectionGenerate }`
  - `async function selectNewsSignals(candidates, profile, recentTitles, tenantId, deps?): Promise<SelectionResult>`
  - `const MAX_SIGNALS_PER_RUN = 5`

**Design notes the implementer must not re-derive:**

- **It returns a result object, never throws, and never falls back to "write everything."** The caller fails closed on `{ error }`.
- **Indices are echoed and matched explicitly**, exactly as `scoreRelevance` does — never by array position. A model that returns items out of order, omits one, or invents one must not misattribute a selection. Out-of-range indices are dropped; duplicates keep the first.
- **The prompt states a bar and gives explicit licence to return fewer than 5, including zero.** This is the lesson of the quiet-week spike recorded in the design doc: an agent asked to fill a quota fills it, and one asked first whether anything clears the bar will decline. Returning nothing on a dull day is correct.
- `MAX_SIGNALS_PER_RUN` is enforced in **code** after the model returns, not merely requested in the prompt. A model that ignores the instruction must not be able to exceed the cap.

- [ ] **Step 1: Add the operation to the closed union**

In `src/lib/ai/llm-usage.ts`, add one member to `LlmOperation`:

```typescript
  | "news_selection";
```

It goes after `"signal_relevance"`. **This is required before the module below will typecheck** — the union is closed and the DB column is free text, so omitting it fails at `tsc` rather than at runtime.

- [ ] **Step 2: Write the failing tests**

Create `tests/lib/signals/news-selection.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import {
  selectNewsSignals,
  MAX_SIGNALS_PER_RUN,
  type NewsCandidate,
} from "../../../src/lib/signals/news-selection";
import type { RelevanceProfile } from "../../../src/lib/signals/relevance";

vi.mock("../../../src/lib/ai/llm-usage", () => ({ recordLlmUsage: vi.fn(async () => {}) }));

const PROFILE: RelevanceProfile = {
  name: "Acme",
  oneLiner: "Localization tooling for product teams.",
  positioning: "Fast where incumbents are configurable.",
  topics: ["localization", "translation"],
};

const candidate = (n: number): NewsCandidate => ({
  title: `Article ${n}`,
  text: `Body of article ${n}.`,
  url: `https://news.example.com/${n}`,
});

function generateReturning(selections: unknown) {
  return vi.fn().mockResolvedValue({ object: { selections }, usage: { inputTokens: 10, outputTokens: 5 } });
}

describe("selectNewsSignals", () => {
  it("returns the model's selections matched back by echoed index", async () => {
    const candidates = [candidate(0), candidate(1), candidate(2)];
    const generate = generateReturning([
      { index: 2, score: 0.9, rationale: "new angle", topics: ["localization"] },
      { index: 0, score: 0.7, rationale: "solid", topics: [] },
    ]);

    const result = await selectNewsSignals(candidates, PROFILE, [], "t1", { generate });

    expect("selections" in result).toBe(true);
    if (!("selections" in result)) return;
    expect(result.selections.map((s) => s.index)).toEqual([2, 0]);
    expect(result.selections[0].rationale).toBe("new angle");
  });

  it("enforces the cap in code even when the model returns more", async () => {
    const candidates = Array.from({ length: 10 }, (_, i) => candidate(i));
    const generate = generateReturning(
      Array.from({ length: 10 }, (_, i) => ({ index: i, score: 0.9, rationale: "r", topics: [] }))
    );

    const result = await selectNewsSignals(candidates, PROFILE, [], "t1", { generate });

    expect("selections" in result).toBe(true);
    if (!("selections" in result)) return;
    expect(result.selections).toHaveLength(MAX_SIGNALS_PER_RUN);
  });

  it("drops an index the model invented and keeps the first of a duplicate", async () => {
    const candidates = [candidate(0), candidate(1)];
    const generate = generateReturning([
      { index: 1, score: 0.8, rationale: "first", topics: [] },
      { index: 1, score: 0.4, rationale: "duplicate", topics: [] },
      { index: 7, score: 0.9, rationale: "phantom", topics: [] },
      { index: -1, score: 0.9, rationale: "negative", topics: [] },
    ]);

    const result = await selectNewsSignals(candidates, PROFILE, [], "t1", { generate });

    expect("selections" in result).toBe(true);
    if (!("selections" in result)) return;
    expect(result.selections).toHaveLength(1);
    expect(result.selections[0].index).toBe(1);
    expect(result.selections[0].rationale).toBe("first");
  });

  it("accepts an empty selection — a dull day is a correct outcome", async () => {
    const generate = generateReturning([]);

    const result = await selectNewsSignals([candidate(0)], PROFILE, [], "t1", { generate });

    expect(result).toEqual({ selections: [] });
  });

  it("returns an error rather than throwing when the model call fails", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("rate limited"));

    const result = await selectNewsSignals([candidate(0)], PROFILE, [], "t1", { generate });

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("rate limited");
  });

  it("short-circuits an empty candidate list without calling the model", async () => {
    const generate = vi.fn();

    const result = await selectNewsSignals([], PROFILE, [], "t1", { generate });

    expect(result).toEqual({ selections: [] });
    expect(generate).not.toHaveBeenCalled();
  });

  it("puts the already-held titles in the prompt so novelty can be judged", async () => {
    const generate = generateReturning([]);

    await selectNewsSignals([candidate(0)], PROFILE, ["Acme ships SSO", "Rival raises Series B"], "t1", {
      generate,
    });

    const prompt = generate.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("Acme ships SSO");
    expect(prompt).toContain("Rival raises Series B");
  });

  it("tells the model it may return nothing and what never qualifies", async () => {
    const generate = generateReturning([]);

    await selectNewsSignals([candidate(0)], PROFILE, [], "t1", { generate });

    const system = generate.mock.calls[0][0].system as string;
    // The quiet-week spike showed an agent asked to fill a quota fills it.
    expect(system).toMatch(/empty|nothing|none/i);
    expect(system).toMatch(/routine|incremental|minor/i);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/signals/news-selection.test.ts`
Expected: FAIL — `Cannot find module '../../../src/lib/signals/news-selection'`.

- [ ] **Step 4: Implement the selection pass**

Create `src/lib/signals/news-selection.ts`:

```typescript
import { generateObject } from "ai";
import { z } from "zod";
import { resolveModel, modelId } from "@/lib/ai/model";
import { recordLlmUsage } from "@/lib/ai/llm-usage";
import type { RelevanceProfile } from "@/lib/signals/relevance";

/**
 * The news agent's selection pass, which replaces the generic `scoreRelevance`
 * for `market_news` only.
 *
 * Relevance alone is the wrong question for news: a generic topic search
 * returns many articles that are all relevant and all worthless — routine
 * funding rounds, incremental version notes, rewrites of a story we already
 * hold. This pass asks the harder question instead, and answers it under a
 * hard cap.
 *
 * Returns a result object and never throws. The caller fails CLOSED on an
 * error: an article that was never judged cannot have passed the bar, and
 * writing it would defeat the cap this module exists to enforce.
 */

/** The hard ceiling on signals one run may write. Enforced in code, not only asked for in the prompt. */
export const MAX_SIGNALS_PER_RUN = 5;

export type NewsCandidate = { title: string; text: string; url: string };

export type NewsSelection = { index: number; score: number; rationale: string; topics: string[] };

export type SelectionResult = { selections: NewsSelection[] } | { error: string };

export const SelectionSchema = z.object({
  /**
   * Answered before the list, deliberately. The quiet-week spike found that a
   * model asked straight for items produces items; one asked first whether the
   * day merits anything will decline when it does not.
   */
  dayAssessment: z.string(),
  selections: z.array(
    z.object({
      index: z.number().int(),
      score: z.number().min(0).max(1),
      rationale: z.string(),
      topics: z.array(z.string()),
    })
  ),
});

/** Matches the shape of `generateObject` actually used here, so a test double can stand in. */
export type SelectionGenerate = (args: {
  model: ReturnType<typeof resolveModel>;
  schema: typeof SelectionSchema;
  system: string;
  prompt: string;
}) => Promise<{
  object: z.infer<typeof SelectionSchema>;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}>;

export type NewsSelectionDeps = { generate?: SelectionGenerate };

function buildSystem(profile: RelevanceProfile): string {
  return [
    `You are the news editor for ${profile.name}.`,
    profile.oneLiner ? `${profile.name} is: ${profile.oneLiner}` : null,
    profile.positioning ? `${profile.name}'s positioning: ${profile.positioning}` : null,
    profile.topics.length > 0 ? `Topics ${profile.name} cares about: ${profile.topics.join(", ")}.` : null,
    `Your job is to pick at most ${MAX_SIGNALS_PER_RUN} items from today's candidates that are genuinely`,
    "worth this company's attention. There is no target number.",
    "",
    "First assess the day in one sentence: is there anything here worth noting at all?",
    "",
    "THE BAR. Select an item only if you would defend it to this company's own audience.",
    "Two things must both be true: it brings a NEW topic or a NEW angle — not a restatement of",
    "something in the already-covered list below — and it is substantial enough that a reader",
    "would be glad they read it.",
    "",
    "Returning an empty list is a correct and common outcome. Most days are routine.",
    "Padding the list is the worst thing you can do: it teaches the reader to ignore the feed,",
    "and that is not recoverable. Two strong items beat five weak ones; zero beats one weak one.",
    "",
    "NEVER qualifying on their own: routine version bumps, incremental feature notes, maintenance",
    "and patch releases, generic market-size statistics and analyst forecasts, listicles and",
    "roundups, press releases with no substance, and any item whose only claim is that it exists",
    "rather than that something happened.",
    "",
    "Score each selection 0–1 on how strongly you would recommend it, echo its exact index, give a",
    "one-sentence rationale, and list the topics it touches. Only use indices you were given.",
  ]
    .filter(Boolean)
    .join(" ");
}

function buildPrompt(candidates: NewsCandidate[], recentTitles: string[]): string {
  const covered =
    recentTitles.length > 0
      ? `Already covered — do NOT select an item that repeats any of these:\n${recentTitles
          .map((t) => `- ${t}`)
          .join("\n")}\n\n`
      : "Nothing has been covered recently.\n\n";

  const numbered = candidates
    .map((c, index) => `[${index}] ${c.title}\n${c.url}\n${c.text}`)
    .join("\n\n");

  return `${covered}Today's candidates:\n\n${numbered}`;
}

export async function selectNewsSignals(
  candidates: NewsCandidate[],
  profile: RelevanceProfile,
  recentTitles: string[],
  tenantId: string,
  deps: NewsSelectionDeps = {}
): Promise<SelectionResult> {
  if (candidates.length === 0) return { selections: [] };

  const generate = deps.generate ?? (generateObject as unknown as SelectionGenerate);

  try {
    const spec = process.env.RELEVANCE_MODEL ?? "anthropic/claude-haiku-4-5";
    const { object, usage } = await generate({
      model: resolveModel(spec),
      schema: SelectionSchema,
      system: buildSystem(profile),
      prompt: buildPrompt(candidates, recentTitles),
    });

    await recordLlmUsage({ tenantId, operation: "news_selection", model: modelId(spec), usage });

    const seen = new Set<number>();
    const selections: NewsSelection[] = [];
    for (const entry of object.selections) {
      // Matched back by the echoed index, never by array position: a model that
      // reorders, omits, or invents must not misattribute a selection to the
      // wrong article.
      if (entry.index < 0 || entry.index >= candidates.length) continue;
      if (seen.has(entry.index)) continue;
      seen.add(entry.index);
      selections.push(entry);
      // Enforced here, not only asked for in the prompt — a model that ignores
      // the instruction must still not be able to exceed the cap.
      if (selections.length === MAX_SIGNALS_PER_RUN) break;
    }

    return { selections };
  } catch (error) {
    return { error: String(error) };
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/signals/news-selection.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Prove the cap is enforced in code, not just requested**

Temporarily delete the `if (selections.length === MAX_SIGNALS_PER_RUN) break;` line and re-run. The "enforces the cap in code" test must **fail** (10 selections returned). Restore it. If it still passes, the test is not exercising what it claims — report rather than moving on.

- [ ] **Step 7: Commit**

```bash
git add src/lib/ai/llm-usage.ts src/lib/signals/news-selection.ts tests/lib/signals/news-selection.test.ts
git commit -m "feat: add the news selection pass"
```

---

### Task 3: Wire selection into the news agent

**Files:**
- Modify: `src/lib/signals/news-agent.ts`
- Test: `tests/lib/signals/news-agent.test.ts`

**Interfaces:**
- Consumes: `NewsHit.score` (Task 1); `selectNewsSignals`, `NewsCandidate`, `SelectionResult`, `MAX_SIGNALS_PER_RUN` (Task 2).
- Produces: `NewsRunResult` gains `selected: number`. `NewsAgentDeps` swaps `score?: ScoreFn` for `select?: SelectFn`. Two new constants: `TAVILY_SCORE_FLOOR`, `MAX_CANDIDATES_PER_RUN`.

**The pipeline after this task:**

1. search per topic → dedupe by normalized URL → skip already-held *(unchanged)*
2. **new:** drop candidates below `TAVILY_SCORE_FLOOR`, sort by Tavily score descending, truncate to `MAX_CANDIDATES_PER_RUN`
3. fetch the survivors through `fetchPageText` *(unchanged mechanics, far fewer articles)*
4. **new:** load recent `market_news` titles for the tenant
5. **new:** `selectNewsSignals` replaces `scoreRelevance`
6. write **only** selected items; on `{ error }` write nothing and mark the source failing

`scoreRelevance` is no longer used by this file. **Leave `src/lib/signals/relevance.ts` exactly as it is** — the competitor agent still uses it.

- [ ] **Step 1: Write the failing tests**

Add to `tests/lib/signals/news-agent.test.ts`. The file already has `seedTenant`, `seedNewsSource`, `page`, `hit`, and its `afterEach` — reuse them. Add `MAX_CANDIDATES_PER_RUN` to its existing import from `../../../src/lib/signals/news-agent`. Note `hit()` must now supply a `score`; update the existing helper to take one with a default of `0.9` so existing tests keep passing.

```typescript
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
          hit("https://news.example.com/weak", "Weak", 0.05),
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
    // 30 candidates, all above the floor, with ascending scores.
    const hits = Array.from({ length: 30 }, (_, i) =>
      hit(`https://news.example.com/c${i}`, `C${i}`, 0.3 + i * 0.02)
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
```

Existing tests in this file that stub `score:` must be updated to stub `select:` returning `{ selections: [...] }`. Update them mechanically — **do not change what any existing test asserts.** If an existing assertion can no longer hold (for example one that relied on writing an unscored item), **stop and report**; that is a behaviour change worth my ruling, not something to quietly rewrite.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/signals/news-agent.test.ts`
Expected: FAIL — `select` is not a recognised dep; `MAX_CANDIDATES_PER_RUN` not exported.

- [ ] **Step 3: Fix the imports first**

`src/lib/signals/news-agent.ts` currently imports `{ and, eq, inArray }` from `drizzle-orm`. The recent-titles query in Step 4 needs `desc` as well, and the samples below reference four types this file does not yet import. Make these three edits before anything else, or the samples will not compile:

```typescript
import { and, desc, eq, inArray } from "drizzle-orm";
```

```typescript
import {
  selectNewsSignals,
  type NewsCandidate,
  type NewsSelectionDeps,
  type SelectionResult,
} from "@/lib/signals/news-selection";
```

`RelevanceProfile` is already imported from `@/lib/signals/relevance` — keep that import, but drop `scoreRelevance`, `ScorableItem`, `ScoredItem`, and `RelevanceDeps` from it once Step 4 removes their last use. **`tsc` is what tells you when that is true — run it rather than guessing which are still referenced.**

- [ ] **Step 4: Add the constants and the candidate pre-filter**

In `src/lib/signals/news-agent.ts`, add beside the existing constants:

```typescript
/**
 * Tavily's own relevance below which a hit is not worth a fetch, let alone a
 * model call. The cheapest filter in the pipeline: it arrives free with every
 * search result and costs nothing to apply.
 */
export const TAVILY_SCORE_FLOOR = 0.2;

/**
 * Hard ceiling on how many articles reach the fetch and selection stages.
 * `MAX_TOPICS_PER_RUN × TAVILY_MAX_RESULTS` is 50; this bounds the run's real
 * cost — 50 fetches and a 50-item prompt — to something predictable regardless
 * of how many topics a tenant configures. Candidates are sorted by Tavily
 * score first, so truncation drops the weakest, not an arbitrary slice.
 */
export const MAX_CANDIDATES_PER_RUN = 20;
```

Replace the line `const fresh = [...byUrl.values()];` with:

```typescript
  // ── Cheap filtering, before anything expensive ────────────────────────
  // Tavily's own score is free and already in hand. Applying it here removes
  // most of a run's cost before a single HTTP request, and the sort means the
  // cap below drops the weakest candidates rather than an arbitrary slice.
  const fresh = [...byUrl.values()]
    .filter((article) => article.score >= TAVILY_SCORE_FLOOR)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES_PER_RUN);

  if (fresh.length === 0) {
    await finish(database, source.id, errors.length > 0 ? errors.join("; ") : null, productive);
    return { ...empty, skipped, credits };
  }
```

- [ ] **Step 5: Swap the scorer for the selector**

Change the deps type — replace the `score?: ScoreFn` member with:

```typescript
type SelectFn = (
  candidates: NewsCandidate[],
  profile: RelevanceProfile,
  recentTitles: string[],
  tenantId: string,
  deps?: NewsSelectionDeps
) => Promise<SelectionResult>;
```

so `NewsAgentDeps` reads `{ search?, fetchPage?, select?, database? }`. Add `selected: number` to `NewsRunResult`, and `selected: 0` to the `empty` literal.

Replace the whole `// ── Score ──` block and the write loop's gating with:

```typescript
  // ── Recent titles, so novelty can be judged ───────────────────────────
  const recent = await database
    .select({ title: signals.title })
    .from(signals)
    .where(and(eq(signals.tenantId, source.tenantId), eq(signals.kind, "market_news")))
    .orderBy(desc(signals.occurredAt))
    .limit(RECENT_TITLES_FOR_NOVELTY);
  const recentTitles = recent.map((r) => r.title);

  // ── Select ────────────────────────────────────────────────────────────
  const candidates: NewsCandidate[] = fresh.map((article, i) => ({
    title: article.title,
    text: bodies[i].slice(0, SCORING_EXCERPT_CHARS),
    url: article.url,
  }));
  const outcome = await select(candidates, profile, recentTitles, source.tenantId);

  if ("error" in outcome) {
    // Fail CLOSED. An article nobody judged cannot have passed the bar, and
    // writing the batch anyway is exactly what the cap exists to prevent. The
    // settings health block surfaces `lastError`, so this is visible rather
    // than a silent gap.
    errors.push(`selection failed: ${outcome.error}`);
    await finish(database, source.id, errors.join("; "), false);
    return { ...empty, skipped, credits };
  }

  const dropped = fresh.length - outcome.selections.length;
```

Add the constant beside the others:

```typescript
/** How many recent headlines the selector sees when judging novelty. */
const RECENT_TITLES_FOR_NOVELTY = 40;
```

Then change the write loop to iterate the selections rather than every article:

```typescript
  for (const selection of outcome.selections) {
    const article = fresh[selection.index];
    const body = bodies[selection.index];
```

…using `selection.score`, `selection.rationale`, and `selection.topics` in the insert where `scored.*` was used, and `body` where `bodies[i]` was used. Delete the `RELEVANCE_FLOOR` check — the selector is the filter now. **Remove the now-unused `RELEVANCE_FLOOR` constant and the `scoreRelevance` import**, and return `selected: outcome.selections.length` alongside `written`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/signals/news-agent.test.ts`
Expected: PASS.

- [ ] **Step 7: Prove the fail-closed path is real**

Temporarily change the `"error" in outcome` branch to fall through and write everything. The "writes nothing and marks the source failing" test must **fail**. Restore it. This is the decision that reverses previously-shipped behaviour, so it must be genuinely guarded.

- [ ] **Step 8: Full verification**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: all pass, lint 0 errors. Baseline before this plan: 150 files, 1080 tests, 9 lint warnings.

The competitor agent's tests must still pass untouched — `relevance.ts` was not to change.

- [ ] **Step 9: Commit**

```bash
git add src/lib/signals/news-agent.ts tests/lib/signals/news-agent.test.ts
git commit -m "feat: cap news at five selected signals per run"
```

---

## Tunable knobs, deliberately

All five are constants so they can be adjusted from observation rather than argument, which is the stated intent:

| Constant | Value | What it trades |
|---|---|---|
| `TAVILY_SCORE_FLOOR` | 0.2 | Free filter; raise it to cut fetches, lower it if good articles are being lost before anyone sees them |
| `MAX_CANDIDATES_PER_RUN` | 20 | Bounds fetch and prompt cost per run |
| `MAX_SIGNALS_PER_RUN` | 5 | The user-facing cap |
| `RECENT_TITLES_FOR_NOVELTY` | 40 | How much history the novelty judgment sees |
| `SCORING_EXCERPT_CHARS` | 2,000 | Existing; how much of each article the selector reads |

## Known gaps, accepted

- **No spend telemetry still.** `NewsRunResult.credits` and now `selected` are returned and discarded by the sweep. Nothing reports cost.
- **Rejected candidates are recorded nowhere**, so an article rejected today can be re-fetched tomorrow. Bounded by `time_range: "day"`, and the Tavily-score pre-filter now removes most of them before the fetch.
- **`listSignals` still has no LIMIT.** This plan reduces how fast the table grows but does not cap the read. That belongs with spec 5, which is the first consumer that will feel it.
