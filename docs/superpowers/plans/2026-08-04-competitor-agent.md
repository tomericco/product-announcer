# Competitor Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the signals layer its first external producer — a daily agent that watches each competitor's changelog and blog, preferring agent-facing pages over rendered HTML, and writes `competitor_move` signals.

**Scope:** This is the second half of the design doc's spec 3. The signals layer (schema, shipped-work reconciler, browser) is already built and on the branch.

**Architecture:** Five stages, matching the contract the design doc sets for every source agent — **fetch → extract → tier-1 drop → tier-2 relevance → write signal**.

Acquisition prefers **agent-facing pages** — `llms.txt`, `llms-full.txt`, and `.md` variants — and falls back to rendered HTML. Those pages are written to be read by machines: clean prose with no nav, cookie banners, or marketing chrome, which makes both extraction and relevance scoring materially better than scraping.

Because there are no feeds, the unit of change is not an entry but a **block of text that was not there last time.** Each run extracts blocks, compares their hashes against a per-source watermark, and turns genuinely new blocks into signals. Every external fetch goes through spec 2's SSRF-guarded `fetchPageText`. The sweep copies `resolve-sweep.ts`: per-tenant isolation, log and continue, never throw out of the cron.

**Tech Stack:** Next.js 16 (App Router), Drizzle ORM + drizzle-kit, Postgres (Supabase), AI SDK v7 + `@ai-sdk/anthropic`, Vitest against a real `_test` database, TypeScript strict. **No new runtime dependencies.**

## Global Constraints

- **This is not the Next.js you know.** Read the relevant guide in `node_modules/next/dist/docs/` before writing any App Router code. Heed deprecation notices. (`AGENTS.md`)
- Tests run against a **real Postgres database whose name must end in `_test`** (`vitest.setup.ts` hard-fails otherwise). After every schema change run `npm run db:migrate:test` before `npm run test`.
- The LLM provider is **Anthropic directly** via `@ai-sdk/anthropic`, not the Vercel AI Gateway. Do not "fix" this.
- Every LLM call records usage via `recordLlmUsage`. **`operation` is typed as `LlmOperation`, a closed string-literal union in `src/lib/ai/llm-usage.ts`** — a new operation must be added there or the call will not type-check. The database column is free text, so this is invisible until `tsc` runs.
- **Every external fetch goes through `fetchPageText`.** It carries redirect re-validation, private-IP rejection, a hard byte cap, a timeout, and a `MAX_SCAN_CHARS` clamp against quadratic regex backtracking. A competitor URL is attacker-influenced input by definition. There is no exception anywhere in this plan.
- **No test may execute a real unscoped sweep against the shared test database** unless that sweep is what it is testing. Vitest runs 140 files in parallel against one database and the sweeps here operate across all tenants. Mock them everywhere else.
- Follow the existing schema conventions in `src/db/schema.ts`: comments explain *why*, not what.
- Never edit the Vercel `DATABASE_URL` env var.
- **Where this plan gives both prose and a code sample, the code sample is authoritative — and if they contradict each other, stop and report it rather than picking one.** A previous plan's prose said "match this file's error-handling posture" while its code sample did something coarser; the implementer transcribed the sample faithfully and shipped a cross-tenant failure blast radius. Disagreement between the two is a plan bug, and catching it is worth more than guessing right.
- **The tests in this plan are the contract; several implementation steps are prose rather than full code, deliberately.** Earlier plans in this series gave complete implementations and implementers transcribed them faithfully — including the bugs in them. Where behaviour is fully pinned by the test code above it, the prose says what to build and leaves *how* to you. If a test and its prose disagree, the test wins and you tell me. If you cannot satisfy a test from the prose, that is a plan gap worth reporting rather than improvising around.

## Decisions this plan locks in

**No RSS or Atom, and no new dependency.** An earlier draft parsed feeds with `fast-xml-parser`. Agent-facing pages are the better acquisition surface: they exist precisely so machines can read them, they carry no nav or boilerplate to filter, and they are plain text rather than a second markup dialect to parse. Dropping feeds removes the dependency question entirely.

**Acquisition order, per watched page:** the page's `.md` variant, then the site's `llms.txt` / `llms-full.txt`, then the rendered HTML. Resolved once at discovery and stored on the source, not re-probed every run — re-discovery is what picks up a competitor who adds `llms.txt` later.

**The unit of change is a text block, not an entry.** Without feeds there are no entry boundaries or publication dates. Each run splits the fetched document into blocks, hashes each, and treats blocks whose hash is not in the source's watermark as new. That gives per-item granularity — one signal for a new changelog section, not one coarse "the page changed".

**The first run of a source is a baseline and emits nothing.** An empty watermark means every block looks new; emitting them would dump a competitor's entire back catalogue as today-dated signals. The first run records hashes and writes no signals. **Consequence worth stating plainly: a newly added competitor produces nothing until they next publish.** That is the correct behaviour — the product watches for changes, not for history — but it will look like a broken integration to anyone who does not know, so the settings UI must say so.

**`occurredAt` is first-seen time, and that is honest here.** Diffing only ever observes *forward* changes, so there is no backfill problem: a block first seen today genuinely appeared since yesterday's run. This is different from the shipped-work reconciler, where `occurredAt` had to be derived from change events precisely because a year of history could be imported at once. Record the reasoning on the write, and never present first-seen as a publication date in the UI.

**`htmlToText` gains newline preservation.** It currently collapses all whitespace to single spaces, which destroys the line structure block-splitting depends on and applies even to `text/plain`. Block-level tags become newlines before stripping, so HTML and markdown paths produce comparably splittable text. This changes input to two existing LLM callers (`analyze-brand-style`, `analyze-company-context`) — for the better, since paragraph structure survives — but their tests must be checked.

**Relevance scoring is batched, fails open, and gets its own model variable.** One `generateObject` call scores a run's surviving blocks, matched back by an explicit `index` field, never by array position. A classifier error writes every item unscored rather than dropping any: a missed competitor move is invisible, an unscored row announces itself, and `listSignals` already keeps null-scored rows through a minimum-score filter. Uses `RELEVANCE_MODEL`, not `ONBOARDING_ANALYSIS_MODEL`, which already drives two operations.

**Source health flips on a single failure.** `status` goes to `failing` on any failed run and back to `active` on the next success. No consecutive-failure counter — that would need state in `watermark` for little gain at daily cadence. One transient blip shows as `failing` until the next day's run clears it, which is the right direction to err for a surface whose job is making silent rot visible.

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/lib/workspace/fetch-page.ts` | `finalUrl`, `contentType`, markdown support, newline-preserving `htmlToText` | 1 |
| `src/lib/signals/agent-page.ts` | Probe for `.md` / `llms.txt`; split text into hashed blocks | 2 |
| `src/db/schema.ts` | `sources.feedUrl` → `agentUrl` | 3 |
| `src/lib/signals/discover-sources.ts` | Propose watchable URLs, resolve their agent-facing variants | 3 |
| `src/lib/signals/relevance.ts` | Batched tier-2 relevance scoring | 4 |
| `src/lib/signals/competitor-agent.ts` | One source: fetch → diff → tier-2 → write | 5 |
| `src/lib/signals/sweep.ts` | All sources, per-tenant isolation | 6 |
| `src/app/api/cron/scheduler/route.ts` | Runs the sweep | 6 |
| `src/app/(dashboard)/company/*` | Discovery and source health | 3, 6 |

---

### Task 1: Teach the fetcher about agent-facing pages

Three changes, all of which the rest of the plan depends on and two of which fail silently if missed.

**Files:**
- Modify: `src/lib/workspace/fetch-page.ts`
- Modify: `src/lib/workspace/brand-import.ts`, `src/lib/signals/crawl-company-site.ts` (only where `PageResult` literals are built)
- Test: `tests/lib/workspace/fetch-page.test.ts`; update `PageResult` literals in `tests/lib/workspace/brand-import.test.ts` and `tests/lib/workspace/crawl-company-site.test.ts`

**Interfaces:**
- Produces: `PageResult` success shape becomes `{ text: string; html: string; finalUrl: string; contentType: string }`; `htmlToText` preserves block boundaries as newlines

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/workspace/fetch-page.test.ts`:

```ts
describe("htmlToText — block structure", () => {
  it("turns block-level boundaries into newlines instead of spaces", () => {
    const html = `<h2>v2.4.0</h2><p>Added SSO.</p><ul><li>One</li><li>Two</li></ul>`;
    const text = htmlToText(html);
    expect(text.split("\n").map((l) => l.trim()).filter(Boolean)).toEqual([
      "v2.4.0",
      "Added SSO.",
      "One",
      "Two",
    ]);
  });

  it("still collapses runs of inline whitespace within a block", () => {
    expect(htmlToText("<p>a   \n  b</p>")).toBe("a b");
  });

  it("does not emit blank-line runs for nested block tags", () => {
    const text = htmlToText("<div><div><p>only</p></div></div>");
    expect(text).toBe("only");
  });
});
```

**This file already has `htmlResponse(body, headers)` and `publicResolve` — use them.** `htmlResponse` hardcodes `content-type: text/html`, so add one sibling helper beside it rather than a second stubbing style:

```ts
function textResponse(body: string, contentType: string) {
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}
```

Then, in the `fetchPageText` describe block:

```ts
  it("accepts text/markdown and returns the body unflattened", async () => {
    // llms.txt and .md variants are usually served as text/markdown. The old
    // allowlist rejected them outright, and htmlToText would have flattened
    // the newlines that block-splitting depends on.
    const body = "# Changelog\n\n## v2.4.0\n\n- SSO for all plans\n";
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(body, "text/markdown"));
    const result = await fetchPageText("https://acme.com/llms.txt", {
      fetchImpl: fetchImpl as never,
      resolveHost: publicResolve,
    });

    if ("error" in result) throw new Error("expected success");
    expect(result.contentType).toContain("text/markdown");
    expect(result.text).toContain("## v2.4.0");
    expect(result.text.split("\n").length).toBeGreaterThan(1);
  });

  it("still rejects a content type that is neither html, plain, nor markdown", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse("%PDF-1.4", "application/pdf"));
    const result = await fetchPageText("https://acme.com/x.pdf", {
      fetchImpl: fetchImpl as never,
      resolveHost: publicResolve,
    });
    expect(result).toEqual({ error: "fetch-failed" });
  });
```

The markdown body must clear `MIN_TEXT_CHARS` — pad it if the constant is above its length, or the test fails with `insufficient-content` for the wrong reason.

Also extend the redirect test at `tests/lib/workspace/fetch-page.test.ts:41` so a *successful* redirect chain asserts `finalUrl` is where the fetch **landed**, not what was requested. That existing test only covers a redirect to a private host being blocked, so you will need a second one following a redirect to a public host through to a 200. If `finalUrl` equals the requested URL after a redirect, the field is wired to the wrong variable.

**One existing test will certainly fail, and that is correct.** `tests/lib/workspace/fetch-page.test.ts:10` asserts `htmlToText("<style>…</style><h1>Hi</h1><script>…</script><p>We&nbsp;shipped &amp; fixed.</p>")` equals `"Hi We shipped & fixed."`. With block boundaries preserved that becomes `"Hi\nWe shipped & fixed."`. Update the expectation — it encodes the flattening this task removes. It is the only direct `htmlToText` assertion in the suite.

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/lib/workspace/fetch-page.test.ts`
Expected: FAIL on all four — `contentType` missing, markdown rejected, newlines collapsed.

- [ ] **Step 3: Implement**

Make `htmlToText` insert `\n` at block boundaries — closing `</p>`, `</div>`, `</li>`, `</h1>`–`</h6>`, `</tr>`, and `<br>` — **before** the tag stripper runs, then collapse only horizontal whitespace within lines and squeeze runs of blank lines to one. The existing entity decoding stays.

Extend the content-type allowlist with `text/markdown`. Return `contentType` on the success shape, and:

```ts
        const scanned = html.slice(0, MAX_SCAN_CHARS);
        // Only HTML goes through the tag stripper. A markdown or plain-text
        // body is already text, and running htmlToText over it would destroy
        // exactly the line structure the block splitter needs.
        const isHtml = contentType.includes("text/html");
        const text = (isHtml ? htmlToText(scanned) : scanned).slice(0, MAX_TEXT_CHARS);
        if (text.length < MIN_TEXT_CHARS) return { error: "insufficient-content" };
        return { text, html: scanned, finalUrl: current.toString(), contentType };
```

Add a comment on `finalUrl` noting it is for recording and relative resolution only — **the same-origin check in `crawlCompanySite` must keep anchoring on the requested URL**, which is what stops a homepage redirecting to a hostile host from steering the crawl onto that host's links.

- [ ] **Step 4: Update the affected callers and their tests**

`grep -rn "html:" tests/lib/workspace/` to find `PageResult` literals needing `finalUrl` and `contentType`. These are mechanical.

Then check `analyze-brand-style` and `analyze-company-context`'s tests: their prompts now receive newline-structured text. **If a test asserts on flattened text, that assertion encodes the old bug — update it. If a test fails for any other reason, stop and report.**

- [ ] **Step 5: Verify and commit**

```bash
npm run typecheck && npm run test && npm run lint
git add -A
git commit -m "feat: agent-facing page support in the fetcher

Accepts text/markdown, returns the body unflattened for non-HTML, and
preserves block boundaries as newlines so extracted text can be split
into units. Adds finalUrl and contentType."
```

---

### Task 2: Agent-page probing and block extraction

**Files:**
- Create: `src/lib/signals/agent-page.ts`
- Test: `tests/lib/signals/agent-page.test.ts`

**Interfaces:**
- Consumes: `fetchPageText`, `PageResult`
- Produces: `probeAgentPage(pageUrl, deps?): Promise<string | null>`; `type Block = { hash: string; text: string; title: string }`; `extractBlocks(text: string): Block[]`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/signals/agent-page.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { probeAgentPage, extractBlocks } from "../../../src/lib/signals/agent-page";
import type { PageResult } from "../../../src/lib/workspace/fetch-page";

const LONG = "x".repeat(300);
const ok = (text: string): PageResult => ({
  text,
  html: text,
  finalUrl: "https://rival.com/x",
  contentType: "text/markdown",
});

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

describe("probeAgentPage", () => {
  it("prefers the page's own .md variant", async () => {
    const { fetchPage, calls } = fakeFetcher({
      "https://rival.com/changelog.md": ok(`# Changelog ${LONG}`),
    });
    expect(await probeAgentPage("https://rival.com/changelog", { fetchPage })).toBe(
      "https://rival.com/changelog.md"
    );
    expect(calls[0]).toBe("https://rival.com/changelog.md");
  });

  it("falls back to the site's llms.txt when no .md variant exists", async () => {
    const { fetchPage } = fakeFetcher({
      "https://rival.com/llms.txt": ok(`# Rival ${LONG}`),
    });
    expect(await probeAgentPage("https://rival.com/changelog", { fetchPage })).toBe(
      "https://rival.com/llms.txt"
    );
  });

  it("returns null when nothing agent-facing is published", async () => {
    const { fetchPage } = fakeFetcher({});
    expect(await probeAgentPage("https://rival.com/changelog", { fetchPage })).toBeNull();
  });

  it("does not probe a .md variant for a url that already ends in .md or .txt", async () => {
    const { fetchPage, calls } = fakeFetcher({});
    await probeAgentPage("https://rival.com/llms.txt", { fetchPage });
    expect(calls).not.toContain("https://rival.com/llms.txt.md");
  });

  it("bounds itself — at most three probes for one page", async () => {
    const { fetchPage, calls } = fakeFetcher({});
    await probeAgentPage("https://rival.com/changelog", { fetchPage });
    expect(calls.length).toBeLessThanOrEqual(3);
  });
});

describe("extractBlocks", () => {
  it("splits on blank lines and titles each block from its first line", () => {
    const blocks = extractBlocks(
      "## v2.4.0\nAdded SAML SSO for every plan, including free.\n\n## v2.3.0\nFixed a crash when loading large workspaces."
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0].title).toBe("## v2.4.0");
    expect(blocks[0].text).toContain("SAML SSO");
    expect(blocks[1].title).toBe("## v2.3.0");
  });

  it("starts a new block at a markdown heading even without a blank line", () => {
    const blocks = extractBlocks(
      "## First\nA first section with enough text to clear the floor.\n## Second\nA second section with enough text as well."
    );
    expect(blocks.map((b) => b.title)).toEqual(["## First", "## Second"]);
  });

  it("hashes block content, so identical text in two places collapses to one hash", () => {
    const [a, b] = extractBlocks(
      "An identical changelog entry appears twice here.\n\nAn identical changelog entry appears twice here."
    );
    expect(a.hash).toBe(b.hash);
  });

  it("gives different hashes to different content", () => {
    const [a, b] = extractBlocks(
      "One changelog entry with plenty of text in it.\n\nA different changelog entry entirely, also long."
    );
    expect(a.hash).not.toBe(b.hash);
  });

  it("is insensitive to trailing whitespace changes, so reformatting is not a new block", () => {
    // Two lines on purpose, with the padding on the FIRST one. A single-line
    // fixture cannot fail: the outer trim strips it regardless, so the test
    // would pass even with the per-line normalization deleted — which is the
    // regression this test exists to catch.
    const [padded] = extractBlocks("Line one with padding.   \nLine two of the same block.\n\nnext");
    const [plain] = extractBlocks("Line one with padding.\nLine two of the same block.\n\nnext");
    expect(padded.hash).toBe(plain.hash);
  });

  it("drops a heading with no body, and keeps the one that has content", () => {
    const blocks = extractBlocks("## First\n## Second\nA section with enough body text to count.");
    expect(blocks.map((b) => b.title)).toEqual(["## Second"]);
  });

  it("drops nav-sized fragments while keeping a real changelog line", () => {
    // The floor exists because HTML-extracted text carries nav and footer
    // remnants. Each one that later changes would cost a slot in the relevance
    // batch and a row in the browser, for text that can never be a competitor
    // move. A genuine changelog line clears 30 characters; "Pricing" does not.
    const blocks = extractBlocks("Pricing\n\nSign in\n\nAdded SAML SSO for every plan.");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain("SAML SSO");
  });

  it("drops blocks too short to carry meaning", () => {
    expect(extractBlocks("ok\n\nA genuinely substantial block of changelog text.")).toHaveLength(1);
  });

  it("returns an empty array for empty or whitespace-only input", () => {
    expect(extractBlocks("")).toEqual([]);
    expect(extractBlocks("   \n\n  \n")).toEqual([]);
  });

  it("caps the number of blocks it returns", () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `Block number ${i} with enough text.`).join("\n\n");
    expect(extractBlocks(huge).length).toBeLessThanOrEqual(500);
  });
});
```

- [ ] **Step 2: Run to confirm failure, then implement**

`probeAgentPage` tries, in order and stopping at the first success: the page's `.md` variant (skipped when the URL already ends `.md` or `.txt`), then `{origin}/llms.txt`, then `{origin}/llms-full.txt`. Each probe goes through the injected `fetchPage`. Return the URL that worked, or null.

`extractBlocks` normalizes line endings, splits on blank lines, further splits any chunk at markdown headings (`#`–`######`), trims trailing whitespace per line, drops blocks under `MIN_BLOCK_LENGTH = 30`, caps the count, and hashes each block's normalized text with `node:crypto` `sha256`. `title` is the block's first line, truncated.

The trailing-whitespace test matters: without per-line trimming before hashing, a competitor reformatting their page produces a full page of "new" blocks and a flood of junk signals.

- [ ] **Step 3: Verify and commit**

---

### Task 3: Source discovery, agent-page aware

**Files:**
- Modify: `src/db/schema.ts` (`sources.feedUrl` → `agentUrl`)
- Create: `src/lib/signals/discover-sources.ts`
- Modify: `src/app/(dashboard)/company/actions.ts`, `competitors-editor.tsx`
- Test: `tests/lib/signals/discover-sources.test.ts`

**Interfaces:**
- Consumes: `fetchPageText`, `extractSameOriginLinks`, `probeAgentPage`
- Produces: `discoverCompetitorSources(tenantId, competitorId, websiteUrl, deps?): Promise<Source[]>`; server action `discoverSourcesAction(competitorId)`

- [ ] **Step 1: Rename the column**

`sources.feedUrl` → `agentUrl`, with the comment rewritten:

```ts
    // The agent-facing representation of `url` when the competitor publishes
    // one — a `.md` variant, or the site's llms.txt. Preferred at fetch time
    // because those pages are written for machines: no nav, no cookie banner,
    // no marketing chrome, so both block extraction and relevance scoring get
    // cleaner input. Resolved once at discovery rather than probed every run;
    // re-running discovery is what picks up a competitor who adds one later.
    agentUrl: text("agent_url"),
```

Generate and apply. No production data, and nothing reads the old column yet.

- [ ] **Step 2: Write the failing test**

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

const page = (html: string, finalUrl: string): PageResult => ({
  text: `content ${LONG}`,
  html,
  finalUrl,
  contentType: "text/html",
});

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

  it("stores the agent-facing variant when the competitor publishes one", async () => {
    const { tenant, rival } = await seed();
    const md: PageResult = {
      text: `# Changelog ${LONG}`,
      html: `# Changelog ${LONG}`,
      finalUrl: "https://rival.com/changelog.md",
      contentType: "text/markdown",
    };
    const { fetchPage } = fakeFetcher({
      "https://rival.com": page(`<a href="/changelog">Changelog</a>`, "https://rival.com"),
      "https://rival.com/changelog": page("<html></html>", "https://rival.com/changelog"),
      "https://rival.com/changelog.md": md,
    });

    const [source] = await discoverCompetitorSources(tenant.id, rival.id, "https://rival.com", { fetchPage });
    expect(source.url).toBe("https://rival.com/changelog");
    expect(source.agentUrl).toBe("https://rival.com/changelog.md");
  });

  it("leaves agentUrl null when nothing agent-facing is published", async () => {
    const { tenant, rival } = await seed();
    const { fetchPage } = fakeFetcher({
      "https://rival.com": page(`<a href="/changelog">Changelog</a>`, "https://rival.com"),
      "https://rival.com/changelog": page("<html></html>", "https://rival.com/changelog"),
    });

    const [source] = await discoverCompetitorSources(tenant.id, rival.id, "https://rival.com", { fetchPage });
    expect(source.agentUrl).toBeNull();
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
    expect(await db.select().from(sources).where(eq(sources.tenantId, tenant.id))).toHaveLength(0);
  });

  it("routes every request through the injected fetcher — no bare fetch", async () => {
    const { tenant, rival } = await seed();
    const { fetchPage, calls } = fakeFetcher({
      "https://rival.com": page(`<a href="/changelog">Changelog</a>`, "https://rival.com"),
      "https://rival.com/changelog": page("<html></html>", "https://rival.com/changelog"),
    });

    await discoverCompetitorSources(tenant.id, rival.id, "https://rival.com", { fetchPage });
    expect(calls.every((c) => c.startsWith("https://rival.com"))).toBe(true);
    expect(calls[0]).toBe("https://rival.com");
  });
});
```

- [ ] **Step 3: Run to confirm failure, then implement**

Rank candidate links by matching **path segments exactly** against, in priority order: `changelog`, `release-notes`, `releases`, `whats-new`, `news`, `blog`, `updates`. Split the pathname on `/`, drop empties, require an exact segment match — that is what makes the `/blog/why-we-left-jira` test pass. **Write a new ranker here; leave `crawl-company-site.ts`'s substring `rank()` alone**, since changing it is out of scope and harmless for a one-shot bootstrap.

Take the top three, fetch each through the injected `fetchPage`, call `probeAgentPage` for each, and insert a `sources` row with `type: "competitor_web"`, the competitor id, the page URL, the resolved `agentUrl` (nullable), and a `label` from the matched segment. Use `onConflictDoUpdate` against `sources_tenant_url_unique` — mirror `addCompetitor` in `src/lib/workspace/competitors.ts`, which was amended in an earlier spec to backfill on conflict for exactly this reason.

**On conflict, set `agentUrl` only when the newly-discovered value is non-null**, and touch nothing else. A competitor who moves their `llms.txt` should be followed; a transient probe failure must not discard a working mapping and silently downgrade the source to HTML scraping. `label`, `watermark`, `status`, `lastRunAt`, `lastSuccessAt` and `lastError` belong to the agent's run history — resetting them on a re-discovery would make the source look freshly added and re-baseline it, losing a run's worth of change detection.

This is what makes the `agentUrl` schema comment true: without it, "re-running discovery is what picks up a competitor who adds one later" describes a mechanism that does not exist.

- [ ] **Step 4: Surface it in settings**

Add a "Find pages to watch" control per competitor, backed by `discoverSourcesAction(competitorId)` in `company/actions.ts`. Follow the existing actions there for the session pattern, and scope the competitor lookup by `session.user.tenantId` so an id from another workspace finds nothing — the guard `removeCompetitorAction` already uses.

- [ ] **Step 5: Verify and commit**

---

### Task 4: The batched relevance pass

**Files:**
- Create: `src/lib/signals/relevance.ts`
- Modify: `src/lib/ai/llm-usage.ts`
- Test: `tests/lib/signals/relevance.test.ts`

**Interfaces:**
- Produces: `type ScorableItem = { title: string; text: string; url: string | null }`; `type ScoredItem = { score: number | null; rationale: string; topics: string[] }`; `scoreRelevance(items, profile, tenantId, deps?): Promise<ScoredItem[]>`

- [ ] **Step 1: Write the failing test**

The model call is injected so the mapping logic — where this can silently corrupt data — is tested without the network. Create `tests/lib/signals/relevance.test.ts`:

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
  { title: "SSO everywhere", text: "Now on all plans.", url: "https://rival.com/a" },
  { title: "Dark mode", text: "Theme support.", url: "https://rival.com/b" },
  { title: "Patch release", text: "Bug fixes.", url: "https://rival.com/c" },
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

Number the items in the prompt and require the model to echo each `index`. Build the result by starting from an all-unscored array and filling in the in-range indices the model returned — that construction is what makes the omitted-index and phantom-index tests pass without extra branching.

Score against `positioning` and `topics`. Add `"signal_relevance"` to `LlmOperation`. Use `process.env.RELEVANCE_MODEL ?? "anthropic/claude-haiku-4-5"`. The unscored rationale must contain "failed" — the tests assert on it, and the browser shows it instead of a blank.

- [ ] **Step 3: Verify and commit**

---

### Task 5: The per-source agent

**Files:**
- Create: `src/lib/signals/competitor-agent.ts`
- Test: `tests/lib/signals/competitor-agent.test.ts`

**Interfaces:**
- Consumes: `fetchPageText`, `probeAgentPage`, `extractBlocks`, `scoreRelevance`, `sources`, `signals`, `companyProfiles`
- Produces: `runCompetitorSource(source, deps?): Promise<{ written: number; dropped: number; baseline: boolean }>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, competitors, sources, signals, companyProfiles } from "../../../src/db/schema";
import { runCompetitorSource } from "../../../src/lib/signals/competitor-agent";
import type { PageResult } from "../../../src/lib/workspace/fetch-page";

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
```

- [ ] **Step 2: Run to confirm failure, then implement**

Fetch `source.agentUrl ?? source.url` through `fetchPage`. On error: set `lastRunAt`, `status: "failing"`, `lastError`, return zeros and write nothing.

`extractBlocks` the text. Read `seenHashes` from `source.watermark`. **If it is empty, this is the baseline run:** store every hash, set the success fields, return `{ written: 0, dropped: 0, baseline: true }` without scoring or writing. Scoring on a baseline would also burn a model call on a competitor's entire archive.

Otherwise the new blocks are those whose hash is not in `seenHashes`. If none, update the timestamps and return. Score the new blocks in one `scoreRelevance` call, then write those at or above `RELEVANCE_FLOOR = 0.3` **plus every unscored one**; count the rest as dropped.

Each signal: `kind: "competitor_move"`, `externalId: ${source.id}:${blockHash}`, `title` from the block title, `excerpt` from the block text, `url: source.url` (the human-readable page, not the agent variant), `occurredAt` = now, `sourceId`, `competitorId`. Note in `relevanceRationale` — or a comment at the write — that `occurredAt` is first-seen rather than published, since diffing only observes forward changes.

Finally merge the new hashes into the watermark, **capped** (keep the most recent ~1000, oldest dropped), and set `lastRunAt`, `lastSuccessAt`, `status: "active"`, `lastError: null`.

- [ ] **Step 3: Verify and commit**

---

### Task 6: The sweep, the cron, and source health

**Files:**
- Create: `src/lib/signals/sweep.ts`
- Modify: `src/app/api/cron/scheduler/route.ts`, `src/app/(dashboard)/company/*`
- Test: `tests/lib/signals/sweep.test.ts`, `tests/app/api/cron/scheduler/route.test.ts`

**Interfaces:**
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
      return { written: 1, dropped: 0, baseline: false };
    });

    await expect(sweepCompetitorSources({ runSource: run })).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("skips disabled sources", async () => {
    const tenant = await seedTenantWithSource(A, "https://a.com/changelog");
    await db.update(sources).set({ status: "disabled" }).where(eq(sources.tenantId, tenant.id));

    const run = vi.fn(async () => ({ written: 0, dropped: 0, baseline: false }));
    await sweepCompetitorSources({ runSource: run });
    expect(run).not.toHaveBeenCalled();
  });

  it("still runs sources previously marked failing, so they can recover", async () => {
    const tenant = await seedTenantWithSource(A, "https://a.com/changelog");
    await db.update(sources).set({ status: "failing" }).where(eq(sources.tenantId, tenant.id));

    const run = vi.fn(async () => ({ written: 0, dropped: 0, baseline: false }));
    await sweepCompetitorSources({ runSource: run });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Implement the sweep**

Select `competitor_web` sources whose status is not `disabled`, group per tenant, run each tenant's sources inside its own try/catch that logs and continues. **Read `src/lib/change-events/resolve-sweep.ts` and match it** — the candidate select gets its own try/catch that logs and returns, because a sweep that throws would reject the cron handler and undo the steps that already succeeded.

- [ ] **Step 3: Wire the cron and update its test**

Add `await sweepCompetitorSources();` after `syncShippedWorkSignals()`. **Update `tests/app/api/cron/scheduler/route.test.ts`:** mock `sweepCompetitorSources` and extend the ordering assertion to the full four-step sequence. That test already mocks the other three steps for a reason — an unmocked sweep would run for real across all tenants against the shared test database while other files are running.

- [ ] **Step 4: Surface source health**

In the competitors section of `/company`, show each competitor's sources with status, last successful run, last error, and whether an agent-facing page was found. Follow the existing integration-status treatment for tone.

**Say plainly that a newly added source produces nothing until the competitor next publishes.** The first run is a baseline by design, and without that sentence a working integration looks broken on day one — which is the most likely support question this feature will generate.

- [ ] **Step 5: Verify and commit**

The dashboard sits behind an OAuth wall, so state in your report that the UI is verified by types, lint and action-level tests rather than a click-through.

---

## Definition of done

- `npm run typecheck`, `npm run test`, and `npm run lint` all pass.
- "Find pages to watch" discovers a competitor's changelog and blog, storing an agent-facing variant where one is published, and running it twice creates no duplicates.
- A source's first cron run records a baseline and writes no signals; the next run writes one signal per genuinely new block.
- Blocks below the relevance floor are not written; blocks whose scoring failed **are** written, unscored.
- A source that cannot be fetched shows as `failing` with its error in settings, and recovers on the next successful run.
- No external URL is fetched by anything other than `fetchPageText`.
- No test executes a real sweep against the shared test database.

## Notes for spec 4 and spec 5

- **Spec 4 (news agent)** reuses `sources` with `type: "news"` and a null `url`, searching `companyProfiles.topics`. `scoreRelevance` and `extractBlocks` are both reusable; only acquisition differs. It needs its own idempotency story, because `sources_tenant_url_unique` is partial (`WHERE url IS NOT NULL`) and gives null-url rows no uniqueness.
- **Spec 5** must reuse `signalWindowCondition()` from `window.ts` rather than re-deriving the window, and must extend the deferred deletion with the accepted-brief exemption before `brief_signals` can cascade.
- **`occurredAt` on `competitor_move` signals is first-seen, not published.** Spec 5's ranking decays on it, which is correct here because diffing only observes forward changes — but any UI that labels it "published on" would be lying.
- The **quiet-week spike result** in the design doc is the brief agent's requirement, not a suggestion: the prompt must license returning zero briefs, and `weekAssessment` should reach the UI as the empty state.
