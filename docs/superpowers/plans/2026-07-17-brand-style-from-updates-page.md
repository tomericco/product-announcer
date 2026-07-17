# Brand Style from Updates Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** During onboarding, let a tenant paste their updates-page URL; the app scrapes it (SSRF-guarded), an LLM derives their brand-style fields + a new style summary, and the result is saved to the brand profile and fed to the writing agent.

**Architecture:** A `scrape-updates-page` module (fetch + SSRF guard + HTML→text) and an `analyze-brand-style` agent feed a testable `importBrandStyleForTenant` core; a thin onboarding server action wraps it. Two new `brand_profiles` columns store the URL + style summary; `compose-prompt` and the Settings editor consume the summary.

**Tech Stack:** Next.js (App Router), Drizzle + Postgres, `ai` v7 (`generateObject`), Zod, Vitest. Node built-ins `node:dns/promises` + `node:net` for the SSRF guard (no new deps).

## Global Constraints

- **This is NOT stock Next.js** — per `AGENTS.md`. `params`/`searchParams` are Promises in this version (await them), as the drafts detail page shows.
- **SSRF guard is mandatory:** http(s) only; reject private / loopback / link-local / CGNAT / ULA / IPv4-mapped-private hosts; re-validate every redirect hop. All resolved IPs of a host must be public.
- **Bounds:** 8s timeout, 2 MB response cap, non-HTML content-type rejected, extracted text truncated to ~12k chars; < 200 chars extracted → `insufficient-content`.
- **Analysis model:** `process.env.ONBOARDING_ANALYSIS_MODEL ?? "anthropic/claude-sonnet-4-5"`. Fail-safe: on error, derive nothing.
- **Onboarding-only analysis.** Settings is manual-edit-only (no re-analyze).
- Test command: `npm test` / `npm test -- <name>`; type-check `npx tsc --noEmit`. Migrations: `npm run db:generate` then `npm run db:migrate`.
- New lib modules live under `src/lib/workspace/` (post-reorg structure). Tests: `tests/lib/workspace/`.

---

### Task 1: `brand_profiles` columns + migration

**Files:**
- Modify: `src/db/schema.ts` (add 2 columns to `brandProfiles`)
- Create: `src/db/migrations/0013_*.sql` (generated)
- Test: `tests/lib/workspace/brand-profile-columns.test.ts`

**Interfaces:**
- Produces: `brandProfiles.updatesPageUrl` (`updates_page_url` text, nullable), `brandProfiles.updatesStyleSummary` (`updates_style_summary` text, nullable). Consumed by Tasks 4, 5, 6, 7.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/workspace/brand-profile-columns.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, brandProfiles } from "../../../src/db/schema";

const NAME = "Brand Columns Test Tenant";

describe("brand_profiles updates-page columns", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, NAME));
  });

  it("defaults the new columns to null and round-trips values", async () => {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();

    const [defaulted] = await db.insert(brandProfiles).values({ tenantId: tenant.id }).returning();
    expect(defaulted.updatesPageUrl).toBeNull();
    expect(defaulted.updatesStyleSummary).toBeNull();

    const [updated] = await db
      .update(brandProfiles)
      .set({ updatesPageUrl: "https://acme.com/changelog", updatesStyleSummary: "Short, punchy, one bullet per change." })
      .where(eq(brandProfiles.id, defaulted.id))
      .returning();
    expect(updated.updatesPageUrl).toBe("https://acme.com/changelog");
    expect(updated.updatesStyleSummary).toBe("Short, punchy, one bullet per change.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- brand-profile-columns`
Expected: FAIL — `column "updates_page_url" of relation "brand_profiles" does not exist`.

- [ ] **Step 3: Add the columns**

In `src/db/schema.ts`, inside the `brandProfiles` table, after `industry` and before `userPersonas`, add:

```ts
  updatesPageUrl: text("updates_page_url"),
  updatesStyleSummary: text("updates_style_summary"),
```

- [ ] **Step 4: Generate and apply the migration**

Run: `npm run db:generate` (creates `0013_*.sql` with two `ALTER TABLE "brand_profiles" ADD COLUMN`).
Run: `npm run db:migrate`.

- [ ] **Step 5: Run test to verify it passes, then the full suite**

Run: `npm test -- brand-profile-columns` → PASS.
Run: `npm test` → all still green (additive change).

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/migrations tests/lib/workspace/brand-profile-columns.test.ts
git commit -m "feat: add updates-page columns to brand_profiles"
```

---

### Task 2: Scrape module (`scrape-updates-page.ts`)

**Files:**
- Create: `src/lib/workspace/scrape-updates-page.ts`
- Test: `tests/lib/workspace/scrape-updates-page.test.ts`

**Interfaces:**
- Produces:
  - `type ScrapeResult = { text: string } | { error: "invalid-url" | "blocked" | "fetch-failed" | "insufficient-content" }`
  - `fetchUpdatesPageText(url: string, deps?: { fetchImpl?: typeof fetch; resolveHost?: (h: string) => Promise<string[]> }): Promise<ScrapeResult>`
  - `htmlToText(html: string): string`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/workspace/scrape-updates-page.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { fetchUpdatesPageText, htmlToText } from "../../../src/lib/workspace/scrape-updates-page";

function htmlResponse(body: string, headers: Record<string, string> = {}) {
  return new Response(body, { status: 200, headers: { "content-type": "text/html", ...headers } });
}
const publicResolve = async () => ["93.184.216.34"]; // example.com, public

describe("htmlToText", () => {
  it("strips scripts/styles/tags and collapses whitespace", () => {
    const out = htmlToText("<style>a{}</style><h1>Hi</h1><script>x()</script><p>We&nbsp;shipped &amp; fixed.</p>");
    expect(out).toBe("Hi We shipped & fixed.");
  });
});

describe("fetchUpdatesPageText", () => {
  it("rejects a non-http(s) URL", async () => {
    expect(await fetchUpdatesPageText("ftp://x/y", { fetchImpl: vi.fn() as never })).toEqual({ error: "invalid-url" });
  });

  it("rejects an unparseable URL", async () => {
    expect(await fetchUpdatesPageText("not a url", { fetchImpl: vi.fn() as never })).toEqual({ error: "invalid-url" });
  });

  it("blocks a host that resolves to a private IP", async () => {
    const fetchImpl = vi.fn();
    const result = await fetchUpdatesPageText("https://internal.corp/changelog", {
      fetchImpl: fetchImpl as never,
      resolveHost: async () => ["10.0.0.5"],
    });
    expect(result).toEqual({ error: "blocked" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks an IP-literal loopback URL without resolving", async () => {
    const fetchImpl = vi.fn();
    expect(await fetchUpdatesPageText("http://127.0.0.1/x", { fetchImpl: fetchImpl as never })).toEqual({ error: "blocked" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("re-validates redirect hops and blocks a redirect to a private host", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } })
    );
    const result = await fetchUpdatesPageText("https://acme.com/changelog", {
      fetchImpl: fetchImpl as never,
      resolveHost: publicResolve,
    });
    expect(result).toEqual({ error: "blocked" });
  });

  it("returns insufficient-content when too little text is extracted", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse("<html><body>hi</body></html>"));
    const result = await fetchUpdatesPageText("https://acme.com/changelog", { fetchImpl: fetchImpl as never, resolveHost: publicResolve });
    expect(result).toEqual({ error: "insufficient-content" });
  });

  it("rejects a non-HTML content-type", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    const result = await fetchUpdatesPageText("https://acme.com/api", { fetchImpl: fetchImpl as never, resolveHost: publicResolve });
    expect(result).toEqual({ error: "fetch-failed" });
  });

  it("extracts text on success", async () => {
    const body = "<html><body><h1>Changelog</h1>" + "<p>We shipped a great new dashboard and fixed export bugs.</p>".repeat(6) + "</body></html>";
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse(body));
    const result = await fetchUpdatesPageText("https://acme.com/changelog", { fetchImpl: fetchImpl as never, resolveHost: publicResolve });
    expect(result).toHaveProperty("text");
    if ("text" in result) {
      expect(result.text).toContain("Changelog");
      expect(result.text).toContain("dashboard");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- scrape-updates-page`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/workspace/scrape-updates-page.ts`:

```ts
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type ScrapeResult = { text: string } | { error: "invalid-url" | "blocked" | "fetch-failed" | "insufficient-content" };

export type ResolveHost = (hostname: string) => Promise<string[]>;

const TIMEOUT_MS = 8000;
const MAX_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 12_000;
const MIN_TEXT_CHARS = 200;
const MAX_REDIRECTS = 3;

const defaultResolveHost: ResolveHost = async (hostname) => {
  const results = await lookup(hostname, { all: true });
  return results.map((r) => r.address);
};

function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    return false;
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return true; // unrecognized → treat as blocked
}

async function hostIsPublic(hostname: string, resolveHost: ResolveHost): Promise<boolean> {
  if (isIP(hostname)) return !isPrivateIp(hostname);
  let ips: string[];
  try {
    ips = await resolveHost(hostname);
  } catch {
    return false;
  }
  return ips.length > 0 && ips.every((ip) => !isPrivateIp(ip));
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fetches a public updates page and returns its readable text. SSRF-guarded:
 * http(s) only, every hop's host must resolve entirely to public IPs, redirects
 * are followed manually and re-validated. Bounded by timeout, size, and content
 * type; returns `insufficient-content` for JS-only shells with little text.
 */
export async function fetchUpdatesPageText(
  url: string,
  deps: { fetchImpl?: typeof fetch; resolveHost?: ResolveHost } = {}
): Promise<ScrapeResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const resolveHost = deps.resolveHost ?? defaultResolveHost;

  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return { error: "invalid-url" };
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") return { error: "invalid-url" };
    if (!(await hostIsPublic(current.hostname, resolveHost))) return { error: "blocked" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(current.toString(), { redirect: "manual", signal: controller.signal, headers: { accept: "text/html" } });
    } catch {
      return { error: "fetch-failed" };
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return { error: "fetch-failed" };
      try {
        current = new URL(location, current);
      } catch {
        return { error: "invalid-url" };
      }
      continue;
    }

    if (!res.ok) return { error: "fetch-failed" };

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) return { error: "fetch-failed" };
    if (Number(res.headers.get("content-length") ?? "0") > MAX_BYTES) return { error: "fetch-failed" };

    const html = (await res.text()).slice(0, MAX_BYTES);
    const text = htmlToText(html).slice(0, MAX_TEXT_CHARS);
    if (text.length < MIN_TEXT_CHARS) return { error: "insufficient-content" };
    return { text };
  }

  return { error: "fetch-failed" }; // too many redirects
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- scrape-updates-page` → PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/workspace/scrape-updates-page.ts tests/lib/workspace/scrape-updates-page.test.ts
git commit -m "feat: add SSRF-guarded updates-page scraper"
```

---

### Task 3: Analysis agent (`analyze-brand-style.ts`)

**Files:**
- Create: `src/lib/workspace/analyze-brand-style.ts`
- Test: `tests/lib/workspace/analyze-brand-style.test.ts`

**Interfaces:**
- Produces: `DerivedBrandProfileSchema` / `DerivedBrandProfile = { tone: string|null; readingLevel: string|null; doList: string[]; dontList: string[]; examplePhrases: string[]; industry: string|null; updatesStyleSummary: string|null }`; `buildAnalysisPrompt(text): string`; `analyzeBrandStyle(text): Promise<DerivedBrandProfile>`.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/workspace/analyze-brand-style.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));

import { generateObject } from "ai";
import { buildAnalysisPrompt, analyzeBrandStyle } from "../../../src/lib/workspace/analyze-brand-style";

describe("buildAnalysisPrompt", () => {
  it("includes the page text", () => {
    expect(buildAnalysisPrompt("We shipped dark mode.")).toContain("We shipped dark mode.");
  });
});

describe("analyzeBrandStyle", () => {
  beforeEach(() => {
    vi.mocked(generateObject).mockReset();
  });

  it("returns the parsed derived profile", async () => {
    const derived = { tone: "friendly", readingLevel: "simple", doList: ["be concise"], dontList: ["hype"], examplePhrases: ["ship"], industry: "SaaS", updatesStyleSummary: "Short bullets." };
    vi.mocked(generateObject).mockResolvedValue({ object: derived } as never);
    expect(await analyzeBrandStyle("text")).toEqual(derived);
  });

  it("returns an all-empty derivation on model error", async () => {
    vi.mocked(generateObject).mockRejectedValue(new Error("model down"));
    expect(await analyzeBrandStyle("text")).toEqual({
      tone: null, readingLevel: null, doList: [], dontList: [], examplePhrases: [], industry: null, updatesStyleSummary: null,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- analyze-brand-style`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/workspace/analyze-brand-style.ts`:

```ts
import { generateObject } from "ai";
import { z } from "zod";

export const DerivedBrandProfileSchema = z.object({
  tone: z.string().nullable(),
  readingLevel: z.string().nullable(),
  doList: z.array(z.string()),
  dontList: z.array(z.string()),
  examplePhrases: z.array(z.string()),
  industry: z.string().nullable(),
  updatesStyleSummary: z.string().nullable(),
});

export type DerivedBrandProfile = z.infer<typeof DerivedBrandProfileSchema>;

const EMPTY: DerivedBrandProfile = {
  tone: null, readingLevel: null, doList: [], dontList: [], examplePhrases: [], industry: null, updatesStyleSummary: null,
};

const ANALYSIS_SYSTEM = [
  "You analyze a company's product updates / changelog page to infer their brand writing style.",
  "Derive: tone (a few adjectives), readingLevel (e.g. simple / general / technical), doList and dontList",
  "(concrete writing guidelines), examplePhrases (short signature phrases they actually use), industry,",
  "and updatesStyleSummary (a 1-3 sentence description of how they structure updates — length, sections, voice).",
  "Infer only from evidence on the page. Leave a string field null and a list empty when you cannot infer it.",
].join(" ");

export function buildAnalysisPrompt(pageText: string): string {
  return `Here is the text of a company's product updates / changelog page. Infer their brand writing style.\n\n${pageText}`;
}

export async function analyzeBrandStyle(pageText: string): Promise<DerivedBrandProfile> {
  try {
    const { object } = await generateObject({
      model: process.env.ONBOARDING_ANALYSIS_MODEL ?? "anthropic/claude-sonnet-4-5",
      schema: DerivedBrandProfileSchema,
      system: ANALYSIS_SYSTEM,
      prompt: buildAnalysisPrompt(pageText),
    });
    return object;
  } catch {
    return EMPTY;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- analyze-brand-style` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workspace/analyze-brand-style.ts tests/lib/workspace/analyze-brand-style.test.ts
git commit -m "feat: add brand-style analysis agent"
```

---

### Task 4: Import core (`brand-import.ts`)

**Files:**
- Create: `src/lib/workspace/brand-import.ts`
- Test: `tests/lib/workspace/brand-import.test.ts`

**Interfaces:**
- Consumes: `fetchUpdatesPageText`/`ScrapeResult` (Task 2), `analyzeBrandStyle`/`DerivedBrandProfile` (Task 3), the new columns (Task 1), `getOrCreateBrandProfile`.
- Produces: `importBrandStyleForTenant(tenantId, url, deps?): Promise<{ ok: boolean; reason?: string }>` — scrapes, analyzes, and overwrites the tenant's brand profile with the derived fields + the URL. Returns `{ ok: false, reason }` (writing nothing) on a scrape error.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/workspace/brand-import.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, brandProfiles } from "../../../src/db/schema";
import { importBrandStyleForTenant } from "../../../src/lib/workspace/brand-import";

const NAME = "Brand Import Test Tenant";

describe("importBrandStyleForTenant", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, NAME));
  });

  it("scrapes, analyzes, and writes the derived brand profile + url", async () => {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();

    const result = await importBrandStyleForTenant(tenant.id, "https://acme.com/changelog", {
      scrape: async () => ({ text: "changelog text" }),
      analyze: async () => ({
        tone: "friendly", readingLevel: "simple", doList: ["be concise"], dontList: ["hype"],
        examplePhrases: ["ship"], industry: "SaaS", updatesStyleSummary: "Short bullets.",
      }),
    });

    expect(result.ok).toBe(true);
    const [profile] = await db.select().from(brandProfiles).where(eq(brandProfiles.tenantId, tenant.id));
    expect(profile.tone).toBe("friendly");
    expect(profile.doList).toEqual(["be concise"]);
    expect(profile.examplePhrases).toEqual(["ship"]);
    expect(profile.industry).toBe("SaaS");
    expect(profile.updatesStyleSummary).toBe("Short bullets.");
    expect(profile.updatesPageUrl).toBe("https://acme.com/changelog");
  });

  it("writes nothing and reports the reason on a scrape error", async () => {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();

    const result = await importBrandStyleForTenant(tenant.id, "https://acme.com/changelog", {
      scrape: async () => ({ error: "insufficient-content" }),
      analyze: async () => { throw new Error("should not be called"); },
    });

    expect(result).toEqual({ ok: false, reason: "insufficient-content" });
    const [profile] = await db.select().from(brandProfiles).where(eq(brandProfiles.tenantId, tenant.id));
    // no profile written (getOrCreate not invoked on the error path)
    expect(profile).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- brand-import`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/workspace/brand-import.ts`:

```ts
import { eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { brandProfiles } from "@/db/schema";
import { getOrCreateBrandProfile } from "@/lib/workspace/brand-profile";
import { fetchUpdatesPageText, type ScrapeResult } from "@/lib/workspace/scrape-updates-page";
import { analyzeBrandStyle, type DerivedBrandProfile } from "@/lib/workspace/analyze-brand-style";

export type ImportBrandStyleDeps = {
  scrape?: (url: string) => Promise<ScrapeResult>;
  analyze?: (text: string) => Promise<DerivedBrandProfile>;
  database?: typeof defaultDb;
};

/**
 * Scrapes the tenant's updates page, derives their brand style, and OVERWRITES
 * the brand profile with it (safe at onboarding, where the profile is fresh).
 * On a scrape error, writes nothing and returns the reason.
 */
export async function importBrandStyleForTenant(
  tenantId: string,
  url: string,
  deps: ImportBrandStyleDeps = {}
): Promise<{ ok: boolean; reason?: string }> {
  const scrape = deps.scrape ?? fetchUpdatesPageText;
  const analyze = deps.analyze ?? analyzeBrandStyle;
  const database = deps.database ?? defaultDb;

  const scraped = await scrape(url);
  if ("error" in scraped) return { ok: false, reason: scraped.error };

  const derived = await analyze(scraped.text);
  const profile = await getOrCreateBrandProfile(tenantId, database);

  await database
    .update(brandProfiles)
    .set({
      tone: derived.tone,
      readingLevel: derived.readingLevel,
      doList: derived.doList,
      dontList: derived.dontList,
      examplePhrases: derived.examplePhrases,
      industry: derived.industry,
      updatesStyleSummary: derived.updatesStyleSummary,
      updatesPageUrl: url,
      updatedAt: new Date(),
    })
    .where(eq(brandProfiles.id, profile.id));

  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- brand-import` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workspace/brand-import.ts tests/lib/workspace/brand-import.test.ts
git commit -m "feat: add brand-style import core"
```

---

### Task 5: Onboarding step (action + card)

**Files:**
- Modify: `src/app/onboarding/actions.ts` (add `importBrandStyle`)
- Modify: `src/app/onboarding/page.tsx` (add the card + read `searchParams` for the result message)

**Interfaces:**
- Consumes: `importBrandStyleForTenant` (Task 4), `requireSession`.

- [ ] **Step 1: Add the server action**

In `src/app/onboarding/actions.ts`, add (imports: `importBrandStyleForTenant` from `@/lib/workspace/brand-import`; `requireSession` and `redirect` are already imported):

```ts
export async function importBrandStyle(formData: FormData) {
  const session = await requireSession();
  const url = (formData.get("updatesPageUrl") as string)?.trim();
  if (!url) redirect("/onboarding");

  const result = await importBrandStyleForTenant(session.user.tenantId, url);
  redirect(result.ok ? "/onboarding?brandImport=success" : "/onboarding?brandImport=failed");
}
```

- [ ] **Step 2: Add the onboarding card**

In `src/app/onboarding/page.tsx`:

Accept `searchParams` (a Promise in this Next version) on the page and await it:

```ts
export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ brandImport?: string }> }) {
  const session = await requireSession();
  if (await isOnboardingComplete(session.user.tenantId)) redirect("/pending");
  const { brandImport } = await searchParams;
```

Add the import for the action (extend the existing `./actions` import to include `importBrandStyle`).

Add this card after the "1. Name your workspace" card (it's independent of GitHub):

```tsx
      <Card>
        <CardHeader>
          <CardTitle>Import your brand style (optional)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Paste the URL of your existing changelog or &ldquo;what&apos;s new&rdquo; page and we&apos;ll set up your
            brand style automatically. You can refine it later in Settings.
          </p>
          <form action={importBrandStyle} className="flex gap-2">
            <Input name="updatesPageUrl" type="url" placeholder="https://yourproduct.com/changelog" className="flex-1" />
            <Button type="submit" variant="outline">Import</Button>
          </form>
          {brandImport === "success" && (
            <p className="text-sm text-emerald-600">Brand style imported — refine it anytime in Settings.</p>
          )}
          {brandImport === "failed" && (
            <p className="text-sm text-muted-foreground">
              We couldn&apos;t read that page — you can set your brand style in Settings.
            </p>
          )}
        </CardContent>
      </Card>
```

- [ ] **Step 3: Type-check + full suite**

Run: `npx tsc --noEmit` → no errors.
Run: `npm test` → all green (no new tests here; the core is covered by Task 4).

- [ ] **Step 4: Manually verify (per the `verify` skill)**

The onboarding page is behind GitHub OAuth. If an authed/seeded environment is available: paste a real changelog URL → see the success message → confirm the brand profile is populated in Settings. If not drivable, note manual verification is pending for the coordinator.

- [ ] **Step 5: Commit**

```bash
git add src/app/onboarding/actions.ts src/app/onboarding/page.tsx
git commit -m "feat: import brand style from a changelog URL during onboarding"
```

---

### Task 6: Feed the style summary into generation

**Files:**
- Modify: `src/lib/ai/compose-prompt.ts` (`buildSystemPrompt`)
- Test: `tests/lib/ai/compose-prompt.test.ts` (add a case)

**Interfaces:**
- Consumes: `brandProfile.updatesStyleSummary` (Task 1).

- [ ] **Step 1: Write the failing test**

In `tests/lib/ai/compose-prompt.test.ts`, add to the `describe("buildSystemPrompt", …)` block:

```ts
  it("includes the house-style line when updatesStyleSummary is set, omits it otherwise", () => {
    const withSummary = buildSystemPrompt({ ...baseBrand, updatesStyleSummary: "Short bullets, one per change." } as never, [], []);
    expect(withSummary).toContain("Match the house style of their existing updates: Short bullets, one per change.");
    const without = buildSystemPrompt({ ...baseBrand, updatesStyleSummary: null } as never, [], []);
    expect(without).not.toContain("Match the house style");
  });
```

(`baseBrand` already exists in this test file; it will need the new field to be `undefined`/`null` — the spread with an explicit value covers the "with" case, and the "without" case sets it null.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- compose-prompt`
Expected: FAIL — the house-style line is not produced.

- [ ] **Step 3: Add the line to `buildSystemPrompt`**

In `src/lib/ai/compose-prompt.ts`, add to the `lines` array, immediately after the `examplePhrases` entry:

```ts
    brandProfile.updatesStyleSummary
      ? `Match the house style of their existing updates: ${brandProfile.updatesStyleSummary}.`
      : null,
```

- [ ] **Step 4: Run test to verify it passes, then the full suite**

Run: `npm test -- compose-prompt` → PASS.
Run: `npm test` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/compose-prompt.ts tests/lib/ai/compose-prompt.test.ts
git commit -m "feat: feed updates-page house style into the generation prompt"
```

---

### Task 7: Settings — edit the style summary

**Files:**
- Modify: `src/app/(dashboard)/settings/actions.ts` (`saveBrandProfile`)
- Modify: `src/app/(dashboard)/settings/page.tsx` (brand form: add the textarea + show the URL)

**Interfaces:**
- Consumes: the new columns (Task 1).

- [ ] **Step 1: Persist the field in `saveBrandProfile`**

In `src/app/(dashboard)/settings/actions.ts`, add to the `.set({ … })` in `saveBrandProfile`:

```ts
      updatesStyleSummary: (formData.get("updatesStyleSummary") as string) || null,
```

- [ ] **Step 2: Add the field to the brand form**

In `src/app/(dashboard)/settings/page.tsx`, inside the existing brand-profile `<form action={saveBrandProfile}>`, add a labeled textarea named `updatesStyleSummary` prefilled from the loaded brand profile, and — when `profile.updatesPageUrl` is set — a small read-only line linking to it (e.g. "Imported from <a href=…>your changelog</a>"). Match the surrounding form controls' markup (Label + the project's textarea/Input components already used there).

- [ ] **Step 3: Type-check + full suite**

Run: `npx tsc --noEmit` → no errors.
Run: `npm test` → all green (settings server actions follow the existing untested-action pattern; covered by manual verification + Task 4's write-path test).

- [ ] **Step 4: Manually verify (per the `verify` skill)**

In Settings, edit the style-summary field and save → reload → the value persists; the imported-URL line shows when a URL is present. If the app isn't drivable (OAuth), note manual verification pending.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/settings/actions.ts" "src/app/(dashboard)/settings/page.tsx"
git commit -m "feat: edit the updates-page style summary in settings"
```

---

## Self-Review

**Spec coverage:**
- §1 schema (2 columns + migration) → Task 1. ✓
- §2 scrape module (SSRF guard, bounds, extraction, insufficient-content) → Task 2. ✓
- §3 analysis agent (structured derive, fail-safe) → Task 3. ✓
- §4 onboarding step (scrape→analyze→auto-save, optional, failure message) → Task 4 (testable core) + Task 5 (action + card). ✓
- §5 generation wiring (house-style line) → Task 6. ✓
- §6 settings (editable field, URL shown, manual-edit-only) → Task 7. ✓
- §7 testing → Tasks 1–4, 6 (pure/DB-backed); onboarding + settings UI via manual verify (server actions follow the codebase's untested-action pattern). ✓
- Scope boundaries (no tenant few-shot, no headless browser, no settings re-analysis) → honored. ✓

**Placeholder scan:** No TBD/TODO. Every module/test is complete literal code; the two UI edits (Task 5 card, Task 7 textarea) give exact names/markup guidance plus a `tsc`/manual gate. ✓

**Type consistency:** `ScrapeResult` (Task 2) and `DerivedBrandProfile` (Task 3) are consumed with matching shapes by `importBrandStyleForTenant` (Task 4). The column names `updatesPageUrl`/`updates_page_url` and `updatesStyleSummary`/`updates_style_summary` are consistent across schema (Task 1) and all consumers (4, 5, 6, 7). The onboarding action returns to `/onboarding?brandImport=success|failed`, matched by the page's `searchParams` read (Task 5). ✓

**Ordering:** 1 → 2 → 3 → 4 → 5 → 6 → 7. Task 4 needs 1–3; Task 5 needs 4; Tasks 6 and 7 need only 1. Sequential is safe; 2/3 and 6/7 are mutually independent after their prerequisites.

**Accepted-risk note:** the response-size cap relies on the `content-length` header plus a post-read `slice` (no streaming byte-abort) — acceptable for the MVP since the SSRF host block is the primary protection; a streaming cap can be added later.
