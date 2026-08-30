# Product Update Structure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a generated product update follow the shape of the company's own changelog, by deriving a literal markdown template from their updates page and composing and reviewing against it.

**Architecture:** A new `product_update_template` column on `company_profiles`, derived at brand-import time from the same scraped page `analyzeBrandStyle` already reads. At compose time the template is parsed (leading H1 = title pattern) and its `{count}`/`{month}` variables are substituted **in code**, then fenced into the prompt with the changes listed alongside; the model places changes into the template's literal sections. The reviewer then gets the draft and the substituted template and is asked whether one follows the other. Two supporting changes: a shared prompt-rules module that ends four copy-pasted rubrics and closes a grounding hole in `reviseDraft`, and three fixes to grouping so near-duplicate changes stop reaching the composer as two items.

**Spec:** `docs/superpowers/specs/2026-08-30-product-update-structure-design.md` — read it before Task 1. Its Non-goals section is load-bearing; several attractive-looking additions were considered and rejected there.

**Tech Stack:** Next.js App Router, Drizzle ORM + Postgres, Vitest 4 (node + jsdom projects), `@ai-sdk/anthropic` via `generateObject`, Base UI + shadcn cards.

## Global Constraints

- **Read the relevant guide in `node_modules/next/dist/docs/` before writing route or server-action code.** This Next.js differs from training data.
- **`"use server"` files may export ONLY async functions.** No `const`, no type alias, no re-exported type. `company/actions.ts` is one.
- **Never import a runtime value from a server module into a `"use client"` file** — type-only is safe.
- **No test may reach the real Anthropic API.** Every model call in scope has a dependency seam or is reached through `vi.mock("ai")`. Use them.
- **Every save action on `/company` is scoped to its own column.** See the comment at `src/app/(dashboard)/company/actions.ts:29` — widening a save reads absent fields as empty and nulls another card's column.
- **`null` must stay distinguishable from `""`** for `product_update_template`, exactly as for `guidelines`. Null means never configured and selects the fallback path. Blank strings normalize to null at every write.
- Tenant scoping is the security boundary; it belongs in the WHERE clause of every query.
- Tests live in `tests/`, mirroring `src/`. Two Vitest projects — check `vitest.config.ts` globs. `tests/helpers/fixtures.ts` provides `seedTenant`/`dropTenant`.
- **The suite is flaky against one shared Postgres — re-run a failing file once before believing it.** Baseline measured on this branch at plan time: **304 files / 3765 tests, all passing, ~79s.** If a file you did not touch fails, re-run it before investigating.
- The UI cannot be visually verified — the dev preview is behind an OAuth wall. `npm run typecheck` and `npm run lint` are the gates for UI work.
- Commands: `npm test`, `npm run typecheck`, `npm run lint`, `npm run db:generate`, `npm run db:migrate`, `npm run db:migrate:test`.
- Branch is `product-update-template`, already created. The only uncommitted file at plan time is the spec itself.

---

### Task 1: `prompt-rules.ts` — the shared module

**Files:**
- Create: `src/lib/ai/prompt-rules.ts`
- Test: `tests/lib/ai/prompt-rules.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SIZE_BANDS`, `SizeKey`, `SIZE_RANK`, `SIZE_RUBRIC`, `CATEGORIES`, `CATEGORY_RUBRIC`, `TITLE_SUMMARY_STYLE`, `GROUNDING_RULE`, `NO_INVENTED_LINKS_RULE`, `fenceGuidelines(guidelines: string | null): string | null`, `truncateForPrompt(text: string, maxChars?: number): string`.

**Before starting, confirm the baseline:** run `npm test`. It should report **304 files / 3765 tests passing**. If it does not, reconcile that before writing any code — you cannot attribute a later failure to your own change without a known-good starting point.

This task creates the module and nothing else. No call site changes — those are Task 2, deliberately separate so a reviewer can reject the wording choices without rejecting the module.

- [ ] **Step 1: Write the failing test**

`tests/lib/ai/prompt-rules.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  SIZE_BANDS,
  SIZE_RANK,
  SIZE_RUBRIC,
  CATEGORY_RUBRIC,
  fenceGuidelines,
  truncateForPrompt,
} from "../../../src/lib/ai/prompt-rules";

// The exact string this replaces, copied from resolve-atomic-updates.ts:57-61
// and regenerate-atomic-summary.ts:29-33 (byte-identical in both). This
// extraction MUST NOT change behaviour, so the snapshot is the whole point of
// the test — if you change SIZE_BANDS' glosses, this fails and that is correct.
const CURRENT_SIZE_RUBRIC = [
  "Also pick a size by USER-FACING SIGNIFICANCE (not amount of code): 's' (a minor fix, tweak, or polish —",
  "small individual user impact), 'm' (a standard improvement or small feature noticeable to users of that",
  "area), 'l' (a significant feature or major improvement worth calling out to many users), 'xl' (a flagship",
  "or headline change — a major new capability or overhaul you would lead an announcement with).",
].join(" ");

describe("SIZE_RUBRIC", () => {
  it("renders byte-identically to the text it replaces", () => {
    expect(SIZE_RUBRIC).toBe(CURRENT_SIZE_RUBRIC);
  });
});

describe("SIZE_RANK", () => {
  it("ranks descending by significance, matching SIZE_BANDS order", () => {
    expect(SIZE_RANK.xl).toBeGreaterThan(SIZE_RANK.l);
    expect(SIZE_RANK.l).toBeGreaterThan(SIZE_RANK.m);
    expect(SIZE_RANK.m).toBeGreaterThan(SIZE_RANK.s);
  });

  it("has an entry for every band and nothing else", () => {
    expect(Object.keys(SIZE_RANK).sort()).toEqual(SIZE_BANDS.map((b) => b.key).sort());
  });
});

describe("CATEGORY_RUBRIC", () => {
  it("names every category with its gloss", () => {
    for (const key of ["new", "improvement", "fix", "announcement"]) {
      expect(CATEGORY_RUBRIC).toContain(`'${key}'`);
    }
  });
});

describe("fenceGuidelines", () => {
  it("returns null for null, empty, and whitespace-only input", () => {
    expect(fenceGuidelines(null)).toBeNull();
    expect(fenceGuidelines("")).toBeNull();
    expect(fenceGuidelines("   \n  ")).toBeNull();
  });

  it("wraps trimmed guidelines in the brand-guidelines fence", () => {
    expect(fenceGuidelines("  Be brief.  ")).toBe("<brand-guidelines>\nBe brief.\n</brand-guidelines>");
  });

  it("truncates a very long document inside the fence", () => {
    const fenced = fenceGuidelines("x".repeat(7000));
    expect(fenced).toContain("…(truncated)");
    expect(fenced!.length).toBeLessThan(7000);
  });
});

describe("truncateForPrompt", () => {
  it("returns short text unchanged", () => {
    expect(truncateForPrompt("hello", 100)).toBe("hello");
  });

  it("returns text at exactly the limit unchanged", () => {
    expect(truncateForPrompt("abcde", 5)).toBe("abcde");
  });

  it("appends the truncation marker when over the limit", () => {
    expect(truncateForPrompt("abcdef", 5)).toBe("abcde\n…(truncated)");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/lib/ai/prompt-rules.test.ts`
Expected: FAIL — cannot resolve `../../../src/lib/ai/prompt-rules`.

- [ ] **Step 3: Write the module**

`src/lib/ai/prompt-rules.ts`:

```ts
/**
 * Rules stated in more than one system prompt, in one place.
 *
 * The precedent is `src/lib/briefs/signal-fence.ts`, which already does this
 * for `ideate` and `propose`. Deliberately NOT a prompt framework: no registry,
 * no builder, no per-call configuration. Call sites still compose their own
 * system prompts — they just stop restating shared clauses and drifting apart
 * while doing it.
 *
 * `ideate` and `propose` are deliberately NOT customers of GROUNDING_RULE. They
 * lack a grounding rule too, and adding one is a real behaviour change to two
 * prompts tuned against recorded spike results — a separate decision, not a
 * cleanup. See the spec's Part 0, rule 3.
 */

/** Chars of a body/excerpt a prompt will carry before truncation. */
export const DEFAULT_MAX_PROMPT_CHARS = 24000;

/** Chars of the brand guidelines document a prompt will carry. */
const MAX_GUIDELINES_CHARS = 6000;

/**
 * Size bands, most significant FIRST. This order is load-bearing twice: it is
 * the order the composer lists changes in, and it is what `SIZE_RUBRIC`
 * describes to the model. One array, so the two can never disagree.
 *
 * A shared string constant would have satisfied the two prompts and left the
 * composer's sort free to hardcode its own ordering — precisely the divergence
 * this module exists to prevent, just moved somewhere harder to see.
 */
export const SIZE_BANDS = [
  { key: "xl", gloss: "a flagship or headline change — a major new capability or overhaul you would lead an announcement with" },
  { key: "l", gloss: "a significant feature or major improvement worth calling out to many users" },
  { key: "m", gloss: "a standard improvement or small feature noticeable to users of that area" },
  { key: "s", gloss: "a minor fix, tweak, or polish — small individual user impact" },
] as const;

export type SizeKey = (typeof SIZE_BANDS)[number]["key"];

/** Descending significance. The composer sorts its item list on this. */
export const SIZE_RANK: Record<SizeKey, number> = Object.fromEntries(
  SIZE_BANDS.map((band, index) => [band.key, SIZE_BANDS.length - index])
) as Record<SizeKey, number>;

/**
 * Rendered ASCENDING, which is the order the two prompts already used. The
 * array is descending because that is what `SIZE_RANK` needs; reversing here
 * rather than there keeps the emitted string byte-identical to what it
 * replaces. A snapshot test enforces that — this extraction is the one in this
 * change set that must not alter behaviour at all.
 */
export const SIZE_RUBRIC = `Also pick a size by USER-FACING SIGNIFICANCE (not amount of code): ${[...SIZE_BANDS]
  .reverse()
  .map((band) => `'${band.key}' (${band.gloss})`)
  .join(", ")}.`;

export const CATEGORIES = [
  { key: "new", gloss: "a new capability" },
  { key: "improvement", gloss: "better existing behavior" },
  { key: "fix", gloss: "a bug fix" },
  { key: "announcement", gloss: "a user-facing notice rather than a feature/fix: a deprecation, a sunset/removal, a pricing/policy change, or an availability heads-up" },
] as const;

/**
 * Canonicalised on `resolve-atomic-updates`' wording, which both groups and
 * names where `enrich-change-item` only classifies. `enrich-change-item` keeps
 * its own extra caveat ("pick this only when the change is fundamentally an
 * announcement, not a code capability") — that is a real instruction to a
 * weaker model, not noise to tidy away. Share the mechanism, not the policy.
 */
export const CATEGORY_RUBRIC = CATEGORIES.map((c) => `'${c.key}' (${c.gloss})`).join(", ");

/** Canonicalised on `resolve-atomic-updates`' wording, for the same reason. */
export const TITLE_SUMMARY_STYLE =
  "Write title as a short noun phrase and summary as one plain sentence describing the user-visible benefit.";

/** Verbatim from `compose-prompt.ts`, which was the only place it existed. */
export const GROUNDING_RULE =
  "Ground every statement strictly in the source material you are given. Only describe changes that appear in that material; never invent or embellish features, capabilities, benefits, use cases, metrics, numbers, dates, version names, quotes, or any other specifics. If a detail is not in the source, leave it out rather than guessing — an omission is always better than a fabrication.";

/** Verbatim from `compose-prompt.ts`, which was the only place it existed. */
export const NO_INVENTED_LINKS_RULE =
  "Never fabricate links. Only include a URL if it appears verbatim in the source material; do not construct, complete, shorten, or recall a URL from memory, and do not guess a plausible one. If a link would be helpful but no verified URL is present in the source, write the literal placeholder [add link] in its place so an editor can fill it in — never emit a made-up or guessed URL.";

/**
 * Truncates text destined for a prompt. Replaces four inline copies of this
 * expression in `compose-prompt.ts`.
 */
export function truncateForPrompt(text: string, maxChars = DEFAULT_MAX_PROMPT_CHARS): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(truncated)` : text;
}

/**
 * The team's guidelines document, trimmed, capped, and wrapped in the
 * delimiters that keep their prose from reading as instructions to the model.
 * Returns null when nothing is configured, so callers omit the block entirely
 * rather than injecting an empty one.
 *
 * Shares the FENCE, not the framing. `buildSystemPrompt` varies its framing
 * sentence by content type and `brandRubric` has a "no requirements configured"
 * fallback — both stay at their call sites.
 */
export function fenceGuidelines(guidelines: string | null): string | null {
  const trimmed = guidelines?.trim();
  if (!trimmed) return null;
  return `<brand-guidelines>\n${truncateForPrompt(trimmed, MAX_GUIDELINES_CHARS)}\n</brand-guidelines>`;
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/lib/ai/prompt-rules.test.ts`
Expected: PASS, all cases.

If the `SIZE_RUBRIC` snapshot fails, do **not** edit the test. Fix the module until the produced string matches byte for byte — including the em dashes, which are U+2014.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/lib/ai/prompt-rules.ts tests/lib/ai/prompt-rules.test.ts
git commit -m "feat: shared prompt rules module"
```

---

### Task 2: Adopt the shared rules at every call site

**Files:**
- Modify: `src/lib/ai/resolve-atomic-updates.ts` (RESOLVER_SYSTEM)
- Modify: `src/lib/ai/regenerate-atomic-summary.ts` (SUMMARY_SYSTEM)
- Modify: `src/lib/ai/enrich-change-item.ts` (ENRICHMENT_SYSTEM)
- Modify: `src/lib/ai/compose-prompt.ts` (lines 62-63, 106, and the four truncations at 223/258/283/315)
- Modify: `src/lib/ai/review-draft.ts` (`brandRubric`, `REVISION_SYSTEM`)
- Modify: `src/lib/ai/linkedin-copy.ts` (its grounding paraphrase)
- Test: `tests/lib/ai/review-draft.test.ts` (extend)

**Interfaces:**
- Consumes: everything Task 1 produced.
- Produces: no new signatures. `truncateGuidelines` is **removed** from `compose-prompt.ts` — `review-draft.ts` imports it today, so both must change together.

**The one real behaviour change in this task** is `REVISION_SYSTEM` gaining the grounding and link rules. `reviseDraft` rewrites the whole body under a three-line system prompt that has neither, so today a revision pass can introduce an unsupported claim or a fabricated URL that the original generation was forbidden from writing. That is the regression this task closes, and Step 1 tests it.

Two smaller intended changes: `enrich-change-item`'s category glosses and `regenerate-atomic-summary`'s title/summary sentence both adopt `resolve-atomic-updates`' wording. Expect existing prompt-snapshot tests in those files to need updating — read each failure and confirm it is only the canonicalised wording before touching a test.

- [ ] **Step 1: Write the failing test**

Append to `tests/lib/ai/review-draft.test.ts`:

```ts
import { GROUNDING_RULE, NO_INVENTED_LINKS_RULE } from "../../../src/lib/ai/prompt-rules";
import { buildRevisionPrompt, REVISION_SYSTEM } from "../../../src/lib/ai/review-draft";

describe("REVISION_SYSTEM", () => {
  it("carries the grounding rule", () => {
    expect(REVISION_SYSTEM).toContain(GROUNDING_RULE);
  });

  it("carries the no-invented-links rule", () => {
    expect(REVISION_SYSTEM).toContain(NO_INVENTED_LINKS_RULE);
  });
});
```

`REVISION_SYSTEM` is module-private today. Export it — a constant, not a function, so it is safe to export from this module (`review-draft.ts` is not a `"use server"` file).

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/lib/ai/review-draft.test.ts`
Expected: FAIL — `REVISION_SYSTEM` is not exported, then FAIL on the two `toContain` assertions.

- [ ] **Step 3: Update `review-draft.ts`**

```ts
import {
  fenceGuidelines,
  GROUNDING_RULE,
  NO_INVENTED_LINKS_RULE,
} from "./prompt-rules";

export const REVISION_SYSTEM = [
  "You are a product-update editor.",
  "Rewrite the draft to fix the listed brand-compliance issues while keeping the same facts.",
  GROUNDING_RULE,
  NO_INVENTED_LINKS_RULE,
  "Return only the revised title and body.",
].join(" ");

// The framing stays here; only the fence is shared. A tenant with no
// guidelines still needs this fallback sentence, which prompt-rules has no
// business knowing about.
function brandRubric(brandProfile: BrandProfileRow): string {
  return fenceGuidelines(brandProfile.guidelines) ?? "No specific brand requirements are configured.";
}
```

Delete the now-unused `truncateGuidelines` import.

- [ ] **Step 4: Update the remaining five call sites**

`resolve-atomic-updates.ts` — in `RESOLVER_SYSTEM`, replace the category lines with `` `When you create a new atomic update, also pick category: ${CATEGORY_RUBRIC}.` ``, the title line with `TITLE_SUMMARY_STYLE`, and the four size lines with `SIZE_RUBRIC`.

`regenerate-atomic-summary.ts` — in `SUMMARY_SYSTEM`, replace the title/summary line with `TITLE_SUMMARY_STYLE` and the four size lines with `SIZE_RUBRIC`.

`enrich-change-item.ts` — in `ENRICHMENT_SYSTEM`, replace the category enumeration with `` `and pick suggestedCategory: ${CATEGORY_RUBRIC};` `` and **keep** the existing caveat sentence "pick this only when the change is fundamentally an announcement, not a code capability" immediately after it.

`compose-prompt.ts` — replace the two rule literals at lines 62-63 with `GROUNDING_RULE` and `NO_INVENTED_LINKS_RULE`; replace the `<brand-guidelines>` construction with `fenceGuidelines`, keeping the content-type-varying framing sentence where it is; replace all four `x.length > DEFAULT_MAX_PROMPT_CHARS ? … : x` expressions with `truncateForPrompt(x)`; delete the local `DEFAULT_MAX_PROMPT_CHARS`, `MAX_GUIDELINES_CHARS` and the exported `truncateGuidelines`, importing `DEFAULT_MAX_PROMPT_CHARS` from `prompt-rules` for the two serializer default parameters.

`linkedin-copy.ts` — replace its grounding paraphrase with `GROUNDING_RULE`.

- [ ] **Step 5: Run the affected tests and reconcile**

Run: `npx vitest run tests/lib/ai tests/lib/change-events`

Some prompt assertions will fail on the canonicalised wording. For each: read the diff, confirm it is only the wording change this task intends, then update the test. If a failure is anything else, it is a bug in your edit — fix the source, not the test.

- [ ] **Step 6: Full suite, typecheck, commit**

```bash
npm test
npm run typecheck
git add -u
git commit -m "refactor: adopt shared prompt rules; give reviseDraft grounding rules"
```

Compare the suite result against the 304/3765 baseline. Re-run any single failing file once before investigating — the suite is flaky against one shared Postgres.

---

### Task 3: The `product_update_template` column and its constants

**Files:**
- Create: `src/lib/workspace/product-update-template.ts`
- Modify: `src/db/schema.ts` (`companyProfiles`)
- Create: a generated migration under `src/db/migrations/`
- Test: `tests/lib/workspace/product-update-template.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TEMPLATE_VARIABLES`, `TemplateVariable`, `DEFAULT_PRODUCT_UPDATE_TEMPLATE`, and `companyProfiles.productUpdateTemplate` (`text`, nullable).

- [ ] **Step 1: Write the failing test**

`tests/lib/workspace/product-update-template.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  TEMPLATE_VARIABLES,
  DEFAULT_PRODUCT_UPDATE_TEMPLATE,
} from "../../../src/lib/workspace/product-update-template";

describe("TEMPLATE_VARIABLES", () => {
  it("lists every variable the composer substitutes", () => {
    expect([...TEMPLATE_VARIABLES]).toEqual([
      "count",
      "count_new",
      "count_improvement",
      "count_fix",
      "count_announcement",
      "count_s",
      "count_rounded",
      "month",
      "year",
    ]);
  });
});

describe("DEFAULT_PRODUCT_UPDATE_TEMPLATE", () => {
  it("opens with an H1 so the title pattern is demonstrated", () => {
    expect(DEFAULT_PRODUCT_UPDATE_TEMPLATE.startsWith("# ")).toBe(true);
  });

  it("demonstrates at least one variable", () => {
    expect(DEFAULT_PRODUCT_UPDATE_TEMPLATE).toContain("{month}");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/lib/workspace/product-update-template.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

`src/lib/workspace/product-update-template.ts`:

```ts
/**
 * The product update template: a literal markdown skeleton of the company's own
 * changelog, derived from their updates page and hand-editable in Company
 * settings.
 *
 * Separate from `guidelines` because the two have different jobs. Guidelines are
 * voice — prose, read as advice. The template is structure — an artifact, read
 * as a form to fill. Folding the skeleton into the guidelines document would put
 * it back through the "model describes a format to a model" hop that this whole
 * change exists to remove.
 */

/**
 * Variables a template may contain. All are substituted IN CODE before the
 * prompt is built — the model never sees one and never produces a count or a
 * date itself. Models miscount, and a wrong number in a headline is a visible
 * factual error where a debatable choice of lead is not.
 */
export const TEMPLATE_VARIABLES = [
  "count",
  "count_new",
  "count_improvement",
  "count_fix",
  "count_announcement",
  "count_s",
  "count_rounded",
  "month",
  "year",
] as const;

export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

/**
 * Seeded into the editor when a workspace has no template yet, so people edit
 * rather than face a blank page. Deliberately not written to the database on
 * load — the column stays null until the user saves, which is what lets the
 * composer tell "never configured" (fall back to SIZE_GUIDANCE) apart from
 * "configured". Mirrors GUIDELINES_TEMPLATE exactly.
 */
export const DEFAULT_PRODUCT_UPDATE_TEMPLATE = `# What's new in {month}

## Highlights

## Improvements

## Fixes

`;
```

- [ ] **Step 4: Add the column**

In `src/db/schema.ts`, inside `companyProfiles`, immediately after `guidelines`:

```ts
  // A literal markdown skeleton of this company's own changelog: headings,
  // section order, sign-off, and {variable} placeholders. Derived from their
  // updates page at brand-import time and hand-editable in Company settings.
  // Null until derived or saved, and null is meaningful — the composer falls
  // back to SIZE_GUIDANCE-only prompting, which is today's behaviour and the
  // live path for every existing tenant. Same "never configured" semantics as
  // `guidelines` above.
  productUpdateTemplate: text("product_update_template"),
```

- [ ] **Step 5: Generate and apply the migration**

```bash
npm run db:generate
npm run db:migrate
npm run db:migrate:test
```

Open the generated SQL and confirm it is a single `ALTER TABLE "company_profiles" ADD COLUMN "product_update_template" text;` with no other statement. If drizzle produced anything else, stop and investigate before continuing.

- [ ] **Step 6: Test, typecheck, commit**

```bash
npx vitest run tests/lib/workspace/product-update-template.test.ts
npm run typecheck
git add src/lib/workspace/product-update-template.ts tests/lib/workspace/product-update-template.test.ts src/db/schema.ts src/db/migrations
git commit -m "feat: product_update_template column and constants"
```

---

### Task 4: Derive the template at brand import

**Files:**
- Create: `src/lib/workspace/derive-update-template.ts`
- Modify: `src/lib/workspace/brand-import.ts`
- Test: `tests/lib/workspace/derive-update-template.test.ts`, `tests/lib/workspace/brand-import.test.ts` (extend)

**Interfaces:**
- Consumes: `TEMPLATE_VARIABLES` (Task 3), `companyProfiles.productUpdateTemplate` (Task 3).
- Produces: `deriveUpdateTemplate(pageText: string, tenantId: string): Promise<string | null>`, and `ImportBrandStyleDeps` gains an optional `deriveTemplate` seam of that shape.

`analyze-brand-style.ts` is the model to copy: Sonnet via `ONBOARDING_ANALYSIS_MODEL`, `generateObject`, `recordLlmUsage`, and a `catch` that returns the empty value rather than throwing.

- [ ] **Step 1: Write the failing test**

`tests/lib/workspace/derive-update-template.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("../../../src/lib/ai/llm-usage", () => ({ recordLlmUsage: vi.fn() }));

import { generateObject } from "ai";
import { deriveUpdateTemplate } from "../../../src/lib/workspace/derive-update-template";

describe("deriveUpdateTemplate", () => {
  afterEach(() => vi.mocked(generateObject).mockReset());

  it("returns the derived skeleton", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { template: "# What's new in {month}\n\n## Highlights\n" },
      usage: {},
    } as never);

    expect(await deriveUpdateTemplate("page text", "tenant-1")).toBe(
      "# What's new in {month}\n\n## Highlights\n"
    );
  });

  it("returns null when the page shows no consistent structure", async () => {
    vi.mocked(generateObject).mockResolvedValue({ object: { template: null }, usage: {} } as never);
    expect(await deriveUpdateTemplate("page text", "tenant-1")).toBeNull();
  });

  it("normalizes a blank derivation to null", async () => {
    vi.mocked(generateObject).mockResolvedValue({ object: { template: "   \n " }, usage: {} } as never);
    expect(await deriveUpdateTemplate("page text", "tenant-1")).toBeNull();
  });

  it("returns null rather than throwing when the model call fails", async () => {
    vi.mocked(generateObject).mockRejectedValue(new Error("boom"));
    expect(await deriveUpdateTemplate("page text", "tenant-1")).toBeNull();
  });
});
```

Append to `tests/lib/workspace/brand-import.test.ts`:

```ts
it("writes the derived template", async () => {
  const tenant = await seedTenant("Brand Import Template Tenant");
  await importBrandStyleForTenant(tenant.id, "https://acme.com/changelog", {
    scrape: async () => ({ text: "page", html: "", finalUrl: "u", contentType: "text/html", truncated: false }),
    analyze: async () => ({ guidelines: "Be brief.", industry: "SaaS" }),
    deriveTemplate: async () => "# What's new\n\n## Highlights\n",
  });

  const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
  expect(profile.productUpdateTemplate).toBe("# What's new\n\n## Highlights\n");
});

it("a null derivation never clears an existing template", async () => {
  const tenant = await seedTenant("Brand Import Keep Template Tenant");
  const profile = await getOrCreateCompanyProfile(tenant.id);
  await db
    .update(companyProfiles)
    .set({ productUpdateTemplate: "# Hand written\n" })
    .where(eq(companyProfiles.id, profile.id));

  await importBrandStyleForTenant(tenant.id, "https://acme.com/changelog", {
    scrape: async () => ({ text: "page", html: "", finalUrl: "u", contentType: "text/html", truncated: false }),
    analyze: async () => ({ guidelines: "Be brief.", industry: "SaaS" }),
    deriveTemplate: async () => null,
  });

  const [after] = await db.select().from(companyProfiles).where(eq(companyProfiles.id, profile.id));
  expect(after.productUpdateTemplate).toBe("# Hand written\n");
});
```

- [ ] **Step 2: Run and watch both fail**

Run: `npx vitest run tests/lib/workspace/derive-update-template.test.ts tests/lib/workspace/brand-import.test.ts`
Expected: FAIL — module not found; unknown dep `deriveTemplate`.

- [ ] **Step 3: Write the analyzer**

`src/lib/workspace/derive-update-template.ts`:

```ts
import { generateObject } from "ai";
import { z } from "zod";
import { resolveModel, modelId } from "@/lib/ai/model";
import { recordLlmUsage } from "@/lib/ai/llm-usage";
import { TEMPLATE_VARIABLES } from "@/lib/workspace/product-update-template";

export const DerivedTemplateSchema = z.object({ template: z.string().nullable() });

const TEMPLATE_SYSTEM = [
  "You analyze a company's product updates / changelog page and extract the STRUCTURE their updates follow,",
  "as a reusable markdown skeleton.",
  "Emit the skeleton itself, not a description of it. Reproduce their heading levels, section order, and any",
  "sign-off VERBATIM, and leave every section empty — the content of a future update is written elsewhere and",
  "your job is only the shape it will be poured into.",
  "The first line must be a level-1 heading giving the pattern their update TITLES follow. If their titles have",
  "no consistent pattern, omit the H1 entirely rather than inventing one.",
  `Where the page shows a count or a date, use one of these placeholders instead of a literal: ${TEMPLATE_VARIABLES.map((v) => `{${v}}`).join(", ")}.`,
  "{count_rounded} is for the '20+ updates' idiom; {month} and {year} are the period the update covers.",
  "Include no other placeholder and no instructional prose — a reader must be able to fill this in by hand.",
  "Return null if the page shows no consistent structure. An invented template is worse than none.",
].join(" ");

export function buildTemplatePrompt(pageText: string): string {
  return `Here is the text of a company's product updates / changelog page. Extract the markdown skeleton their updates follow.\n\n${pageText}`;
}

export async function deriveUpdateTemplate(pageText: string, tenantId: string): Promise<string | null> {
  try {
    const spec = process.env.ONBOARDING_ANALYSIS_MODEL ?? "anthropic/claude-sonnet-4-5";
    const { object, usage } = await generateObject({
      model: resolveModel(spec),
      schema: DerivedTemplateSchema,
      system: TEMPLATE_SYSTEM,
      prompt: buildTemplatePrompt(pageText),
    });
    await recordLlmUsage({ tenantId, operation: "template_derivation", model: modelId(spec), usage });
    // Blank folds to null at the source, for the reason importBrandStyleForTenant
    // documents: a blank string reads as "configured" to both the write guard
    // below and the editor's `?? DEFAULT` seeding.
    return object.template?.trim() || null;
  } catch {
    // Matches analyzeBrandStyle: a failed derivation is "no template", which
    // falls back to behaviour we already understand. Never throw — this runs
    // inside onboarding.
    return null;
  }
}
```

- [ ] **Step 4: Wire it into `brand-import.ts`**

Add `deriveTemplate?: (text: string, tenantId: string) => Promise<string | null>` to `ImportBrandStyleDeps`, resolve it as `deps.deriveTemplate ?? deriveUpdateTemplate`, call it on the same `scraped.text`, and add to the update's `set`:

```ts
      ...(productUpdateTemplate !== null && { productUpdateTemplate }),
```

Follow the existing conditional-spread rule exactly: a null derivation means "the model couldn't infer this", never "the user wants it cleared".

**Do not add the template to `isEmptyDerivation`.** That guard returns early when guidelines *and* industry are both null, and widening it would let a page that yielded only a template still be treated as a failed import.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/lib/workspace/derive-update-template.test.ts tests/lib/workspace/brand-import.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npm run typecheck
git add src/lib/workspace/derive-update-template.ts src/lib/workspace/brand-import.ts tests/lib/workspace
git commit -m "feat: derive the product update template at brand import"
```

---

### Task 5: Parse the template and substitute its variables

**Files:**
- Create: `src/lib/ai/template.ts`
- Test: `tests/lib/ai/template.test.ts`

**Interfaces:**
- Consumes: `TEMPLATE_VARIABLES` (Task 3), `SIZE_RANK` (Task 1).
- Produces:
  ```ts
  export type ParsedTemplate = { titlePattern: string | null; bodySkeleton: string };
  export function parseTemplate(template: string): ParsedTemplate;
  export type TemplateFacts = {
    items: { category: string | null; size: string | null }[];
    latestEvidenceAt: Date | null;
    now?: Date;
  };
  export function substituteVariables(template: string, facts: TemplateFacts): string;
  export function roundDownToTen(count: number): number;
  ```

Pure functions, no database and no model. Task 6 consumes them.

- [ ] **Step 1: Write the failing test**

`tests/lib/ai/template.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseTemplate, substituteVariables, roundDownToTen } from "../../../src/lib/ai/template";

const AUG = new Date("2026-08-20T00:00:00Z");
const SEP = new Date("2026-09-02T00:00:00Z");

describe("parseTemplate", () => {
  it("splits a leading H1 into the title pattern", () => {
    expect(parseTemplate("# Updates in {month}\n\n## Highlights\n")).toEqual({
      titlePattern: "Updates in {month}",
      bodySkeleton: "## Highlights",
    });
  });

  it("leaves the title untemplated when there is no leading H1", () => {
    expect(parseTemplate("## Highlights\n\n## Fixes\n")).toEqual({
      titlePattern: null,
      bodySkeleton: "## Highlights\n\n## Fixes",
    });
  });

  it("does not treat a later H1 as the title pattern", () => {
    const parsed = parseTemplate("## Highlights\n\n# Not the title\n");
    expect(parsed.titlePattern).toBeNull();
    expect(parsed.bodySkeleton).toContain("# Not the title");
  });

  it("tolerates leading blank lines before the H1", () => {
    expect(parseTemplate("\n\n# Title\n\n## Body\n").titlePattern).toBe("Title");
  });
});

describe("roundDownToTen", () => {
  it("returns the exact count below ten", () => {
    expect(roundDownToTen(0)).toBe(0);
    expect(roundDownToTen(9)).toBe(9);
  });

  it("rounds down to the nearest ten at and above ten", () => {
    expect(roundDownToTen(10)).toBe(10);
    expect(roundDownToTen(23)).toBe(20);
    expect(roundDownToTen(29)).toBe(20);
    expect(roundDownToTen(30)).toBe(30);
  });
});

describe("substituteVariables", () => {
  const facts = {
    items: [
      { category: "new", size: "xl" },
      { category: "new", size: "m" },
      { category: "fix", size: "s" },
      { category: "improvement", size: "s" },
      { category: null, size: null },
    ],
    latestEvidenceAt: AUG,
    now: SEP,
  };

  it("substitutes counts", () => {
    expect(substituteVariables("{count} / {count_new} / {count_fix} / {count_s}", facts)).toBe("5 / 2 / 1 / 2");
  });

  it("substitutes the rounded count", () => {
    expect(substituteVariables("{count_rounded}+", facts)).toBe("5+");
  });

  it("takes the period from the latest evidence date, not from now", () => {
    expect(substituteVariables("{month} {year}", facts)).toBe("August 2026");
  });

  it("falls back to now when no item carries an evidence date", () => {
    expect(substituteVariables("{month}", { ...facts, latestEvidenceAt: null })).toBe("September");
  });

  it("leaves an unrecognised token untouched", () => {
    expect(substituteVariables("{count} {not_a_variable}", facts)).toBe("5 {not_a_variable}");
  });

  it("returns a template using no variables unchanged", () => {
    expect(substituteVariables("## Highlights\n", facts)).toBe("## Highlights\n");
  });

  it("substitutes every occurrence, not only the first", () => {
    expect(substituteVariables("{count} and {count}", facts)).toBe("5 and 5");
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/lib/ai/template.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

`src/lib/ai/template.ts`:

```ts
import { TEMPLATE_VARIABLES } from "@/lib/workspace/product-update-template";

export type ParsedTemplate = {
  /** The H1's text, without the leading `# `. Null when the template has none. */
  titlePattern: string | null;
  bodySkeleton: string;
};

/**
 * Splits a template into its title pattern and body skeleton.
 *
 * Only a LEADING H1 counts — a template whose first content line is `## …`
 * leaves the title untemplated (generated as it was before this feature), which
 * is the degradation path for a derivation that only recovered body structure.
 * A later H1 is body content and must survive as-is, so this deliberately does
 * not scan the whole document for one.
 */
export function parseTemplate(template: string): ParsedTemplate {
  const trimmed = template.trim();
  const newline = trimmed.indexOf("\n");
  const firstLine = newline === -1 ? trimmed : trimmed.slice(0, newline);
  const h1 = /^#\s+(.+)$/.exec(firstLine);
  if (!h1) return { titlePattern: null, bodySkeleton: trimmed };
  const rest = newline === -1 ? "" : trimmed.slice(newline + 1);
  return { titlePattern: h1[1].trim(), bodySkeleton: rest.trim() };
}

Line-based rather than one regex over the whole document, deliberately: a
single-regex version whose tail was `\s*(?:\n([\s\S]*))?$` let the greedy
`\s*` swallow the blank line after the H1, leaving the body empty. Splitting on
the first newline and testing only that line makes "leading H1 or nothing"
literal, which is exactly the rule.

export type TemplateFacts = {
  items: { category: string | null; size: string | null }[];
  /** The most recent real-world date across the items' evidence. */
  latestEvidenceAt: Date | null;
  /** Injectable for tests; the composition date otherwise. */
  now?: Date;
};

/**
 * Rounds down to the nearest ten for the "20+ updates" idiom: 23 and 29 both
 * give 20, which is what makes the `+` honest. Below ten it returns the exact
 * count — "0+ updates" is absurd, and a template using this form in a thin
 * month should read oddly rather than lie.
 */
export function roundDownToTen(count: number): number {
  return count < 10 ? count : Math.floor(count / 10) * 10;
}

/**
 * Replaces every recognised `{variable}` with its value.
 *
 * Substitution happens IN CODE, before the prompt is built, because a wrong
 * number in a headline is a visible factual error and models miscount. The
 * model never sees one of these placeholders.
 *
 * An unrecognised `{token}` is left untouched and treated as the template
 * author's own literal text. A template is a human-edited document and must
 * never fail to render because someone wrote a brace.
 */
export function substituteVariables(template: string, facts: TemplateFacts): string {
  const now = facts.now ?? new Date();
  const count = facts.items.length;
  const byCategory = (key: string) => facts.items.filter((i) => i.category === key).length;
  // The period is the work's, not the publication's: a changelog published on
  // 2 September covering August work says August.
  const period = facts.latestEvidenceAt ?? now;

  const values: Record<string, string> = {
    count: String(count),
    count_new: String(byCategory("new")),
    count_improvement: String(byCategory("improvement")),
    count_fix: String(byCategory("fix")),
    count_announcement: String(byCategory("announcement")),
    count_s: String(facts.items.filter((i) => i.size === "s").length),
    count_rounded: String(roundDownToTen(count)),
    month: period.toLocaleString("en-US", { month: "long", timeZone: "UTC" }),
    year: String(period.getUTCFullYear()),
  };

  let out = template;
  for (const name of TEMPLATE_VARIABLES) {
    out = out.split(`{${name}}`).join(values[name]);
  }
  return out;
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/lib/ai/template.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add src/lib/ai/template.ts tests/lib/ai/template.test.ts
git commit -m "feat: template parsing and variable substitution"
```

---

### Task 6: Compose against the template

**Files:**
- Modify: `src/lib/ai/compose-prompt.ts` (`composeReleasePrompt`, `composeMergePrompt`, `buildSystemPrompt`, `serializeAtomicUpdates`)
- Modify: `src/lib/ai/generation.ts` (`generateReleaseDraft`, `mergeReleaseDraft`)
- Modify: `src/lib/briefs/draft.ts` (`loadShippedWorkAtomicUpdates`, the release branch, `prepareGenerationContext` call)
- Modify: `src/lib/change-events/catch-up.ts` (`toPromptItem`, `loadPromptContext`, both entry points)
- Modify: `src/lib/ai/generation-context.ts` (drop the `categories` argument)
- Modify: `src/lib/drafting/draft-progress.ts` (the `"preparing"` label)
- Test: `tests/lib/ai/compose-prompt.test.ts` (extend), `tests/lib/ai/generation.test.ts` (extend)

**Interfaces:**
- Consumes: `parseTemplate`, `substituteVariables`, `TemplateFacts` (Task 5); `SIZE_RANK` (Task 1).
- Produces:
  - `AtomicUpdateForPrompt` gains `sizeEditedAt: Date | null` and `latestEvidenceAt: Date | null`.
  - `composeReleasePrompt(args: { items; brandProfile; personas; examples; evidence?; template: string | null })`
  - `composeMergePrompt(args: { …existing…, template: string | null })`
  - `generateReleaseDraft(items, brandProfile, personas, examples, evidence, template)` — sixth positional parameter, defaulting to `null`. `ReleaseDraftGenerator` in `draft.ts` must gain it too.

**The null-template path must render today's prompt byte-for-byte.** It is the live path for every existing tenant, and Step 1 pins it.

- [ ] **Step 1: Write the failing test**

Append to `tests/lib/ai/compose-prompt.test.ts`:

```ts
import { composeReleasePrompt } from "../../../src/lib/ai/compose-prompt";

const ITEM = {
  id: "a1",
  title: "Shared dashboards",
  summary: "Share a dashboard with your team.",
  category: "new" as const,
  size: "l" as const,
  sizeEditedAt: null,
  latestEvidenceAt: new Date("2026-08-20T00:00:00Z"),
};

describe("composeReleasePrompt with a template", () => {
  const base = { items: [ITEM], brandProfile: PROFILE, personas: [], examples: [] };

  it("fences the template", () => {
    const { prompt } = composeReleasePrompt({ ...base, template: "# Updates\n\n## Highlights\n" });
    expect(prompt).toContain("<template>");
    expect(prompt).toContain("</template>");
    expect(prompt).toContain("## Highlights");
  });

  it("substitutes variables before the model sees them", () => {
    const { prompt } = composeReleasePrompt({ ...base, template: "# {count} updates in {month}\n" });
    expect(prompt).toContain("1 updates in August");
    expect(prompt).not.toContain("{count}");
    expect(prompt).not.toContain("{month}");
  });

  it("orders items most-significant-first", () => {
    const small = { ...ITEM, id: "a2", title: "Tiny fix", size: "s" as const };
    const { prompt } = composeReleasePrompt({ ...base, items: [small, ITEM], template: "## Highlights\n" });
    expect(prompt.indexOf("Shared dashboards")).toBeLessThan(prompt.indexOf("Tiny fix"));
  });

  it("tells the model the numbers are authoritative", () => {
    const { prompt } = composeReleasePrompt({ ...base, template: "# {count} updates\n" });
    expect(prompt.toLowerCase()).toContain("authoritative");
  });

  it("lets a human-pinned size win a tie against an unpinned one", () => {
    const pinned = { ...ITEM, id: "a3", title: "Pinned change", sizeEditedAt: new Date("2026-08-01T00:00:00Z") };
    const { prompt } = composeReleasePrompt({ ...base, items: [ITEM, pinned], template: "## Highlights\n" });
    expect(prompt.indexOf("Pinned change")).toBeLessThan(prompt.indexOf("Shared dashboards"));
  });
});

describe("composeMergePrompt with a template", () => {
  it("fences the template and frames it as the shape the body already follows", () => {
    const { system, prompt } = composeMergePrompt({
      currentBody: "## Highlights\n\nExisting text.",
      newItems: [ITEM],
      changedItems: [],
      brandProfile: PROFILE,
      personas: [],
      examples: [],
      template: "## Highlights\n\n## Fixes\n",
    });
    expect(prompt + system).toContain("## Fixes");
  });

  it("renders today's prompt when no template is configured", () => {
    const { prompt } = composeMergePrompt({
      currentBody: "body", newItems: [ITEM], changedItems: [],
      brandProfile: PROFILE, personas: [], examples: [], template: null,
    });
    expect(prompt).not.toContain("<template>");
  });
});

describe("composeReleasePrompt without a template", () => {
  it("renders exactly what it rendered before templates existed", () => {
    const withNull = composeReleasePrompt({
      items: [ITEM], brandProfile: PROFILE, personas: [], examples: [], template: null,
    });
    expect(withNull.prompt).toContain("Here are the changes to summarize into one product update.");
    expect(withNull.prompt).not.toContain("<template>");
  });
});

describe("buildSystemPrompt for product updates", () => {
  it("no longer carries few-shot examples", () => {
    const { system } = composeReleasePrompt({
      items: [ITEM], brandProfile: PROFILE, personas: [], examples: [EXAMPLE], template: null,
    });
    expect(system).not.toContain(EXAMPLE.body);
  });
});
```

Reuse the file's existing `PROFILE` and example fixtures; add them if absent.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/lib/ai/compose-prompt.test.ts`
Expected: FAIL — `template` is not a known property; the ordering and example assertions fail.

- [ ] **Step 3: Widen `AtomicUpdateForPrompt` and both loaders**

In `compose-prompt.ts`:

```ts
export type AtomicUpdateForPrompt = {
  id: string;
  title: string;
  summary: string;
  category: "new" | "improvement" | "fix" | "announcement" | null;
  size: "s" | "m" | "l" | "xl" | null;
  // Non-null means a human set the size. Breaks ties in the composer's sort:
  // a human who picked a size is a stronger signal than a Haiku call on a
  // one-line summary.
  sizeEditedAt: Date | null;
  // The most recent real-world date among this update's evidence. Feeds
  // {month}/{year}, which must describe the work's period, not the
  // composition date.
  latestEvidenceAt: Date | null;
};
```

In `draft.ts`'s `loadShippedWorkAtomicUpdates`, add `sizeEditedAt: atomicUpdates.sizeEditedAt` to the select and derive the evidence date with the same aggregate `syncShippedWorkSignals` uses:

```ts
      latestEvidenceAt: sql<Date | null>`max(coalesce(${changeEvents.mergedAt}, ${changeEvents.committedAt}, ${changeEvents.completedAt}, ${changeEvents.releasedAt}))`,
```

This requires a `leftJoin(changeEvents, eq(changeEvents.atomicUpdateId, atomicUpdates.id))` and a `groupBy` over every non-aggregated column, exactly as `shipped-work.ts` does. **The raw `sql<>` aggregate is not decoded through drizzle's column mapper** — the driver can hand back a string, so normalize with `new Date(value)` before use, as `shipped-work.ts` documents.

In `catch-up.ts`'s `toPromptItem`, add both fields; it selects whole rows, so `sizeEditedAt` is already present, and `latestEvidenceAt` needs the same join or `null` if the surrounding query cannot carry it. If you pass `null`, the period falls back to the composition date, which the tests in Task 5 already cover.

- [ ] **Step 4: Sort, then compose**

In `compose-prompt.ts`:

```ts
import { SIZE_RANK, type SizeKey } from "./prompt-rules";
import { parseTemplate, substituteVariables } from "./template";

/**
 * Most significant first. A sort, not an assignment: which change leads is the
 * model's editorial call, but it should read them in the order that matters.
 * An earlier design assigned items to named template slots deterministically —
 * cut, because a template with fixed sections already prevents the failure that
 * motivated it. See the spec's Part 1.
 */
function bySignificance(a: AtomicUpdateForPrompt, b: AtomicUpdateForPrompt): number {
  const rank = (item: AtomicUpdateForPrompt) => SIZE_RANK[(item.size ?? "m") as SizeKey];
  return (
    rank(b) - rank(a) ||
    Number(Boolean(b.sizeEditedAt)) - Number(Boolean(a.sizeEditedAt))
  );
}
```

`composeReleasePrompt` gains `template: string | null`. When it is null, return exactly what the function returns today. When it is not:

```ts
  const sorted = [...args.items].sort(bySignificance);
  const latestEvidenceAt = sorted.reduce<Date | null>(
    (max, i) => (i.latestEvidenceAt && (!max || i.latestEvidenceAt > max) ? i.latestEvidenceAt : max),
    null
  );
  const filled = substituteVariables(args.template, { items: sorted, latestEvidenceAt });
  const { titlePattern, bodySkeleton } = parseTemplate(filled);

  const instruction = [
    "Write one product update following the template below.",
    "Reproduce the template's structure exactly — its sections, their order, its headings and any sign-off —",
    "placing each change where it belongs. Omit a section you have nothing to put in rather than inventing filler,",
    "and add no section the template does not have.",
    titlePattern
      ? `The title must follow this pattern: ${titlePattern}`
      : "Write a title in the company's usual style; the template does not prescribe one.",
    "Any number already present in the template is authoritative: never recompute it, and never adjust it to match your own prose.",
  ].join(" ");
```

The prompt is then the instruction, the fenced `<template>` block carrying `bodySkeleton`, and the changes via `serializeAtomicUpdates(sorted)`. Keep the existing `evidence` `<sources>` block unchanged.

**Put the substitution behind a named export, not inline.** Task 7 needs the same substituted string for the reviewer, and substituting twice with independently-derived facts is how the composer and the reviewer end up disagreeing about what `{count}` was. Export from `compose-prompt.ts`:

```ts
/** The template as the model will see it: variables replaced from these items. */
export function fillTemplate(template: string, items: AtomicUpdateForPrompt[]): string;
```

`composeReleasePrompt` calls it, and Task 7's caller calls it on the same sorted item list.

`composeMergePrompt` gains the same parameter and, when non-null, appends one sentence to its system prompt: the template is the structure the current body already follows, and folded-in material goes into its existing sections. Its "preserve existing wording" stance is unchanged.

- [ ] **Step 5: Stop passing examples on this path**

In `composeReleasePrompt` and `composeMergePrompt`, call `buildSystemPrompt(args.brandProfile, args.personas, [], "product_update")`. Leave the parameter and `selectExamples` in place — blog and social still use them.

Then delete, since their only callers are these paths: `atomicUpdateCategories` (`draft.ts`), `distinctCategories` (`catch-up.ts`), and the `categories` argument on `prepareGenerationContext`. Update `DRAFT_STEPS`' `"preparing"` label from `"Preparing brand profile & examples"` to `"Preparing brand profile"`.

- [ ] **Step 6: Thread the template through both entry points**

`generateReleaseDraft` and `mergeReleaseDraft` take the template and pass it to their composer. `draft.ts`'s release branch reads `brandProfile.productUpdateTemplate` and passes it to both `generateRelease` calls (the initial one and the retry). `catch-up.ts` does the same in `startOverRelease` and `catchUpRelease`. Widen `ReleaseDraftGenerator` in `draft.ts` to match.

- [ ] **Step 7: Run everything**

```bash
npx vitest run tests/lib/ai tests/lib/briefs tests/lib/change-events
npm test
npm run typecheck
npm run lint
```

Existing tests that construct `AtomicUpdateForPrompt` literals will fail to typecheck until they carry the two new fields. Add `sizeEditedAt: null, latestEvidenceAt: null` to each.

- [ ] **Step 8: Commit**

```bash
git add -u
git commit -m "feat: compose product updates against the company template"
```

---

### Task 7: Review against the template

**Files:**
- Modify: `src/lib/ai/review-draft.ts`
- Modify: `src/lib/briefs/draft.ts` (the `review` call and `DraftReviewer` seam)
- Test: `tests/lib/ai/review-draft.test.ts` (extend)

**Interfaces:**
- Consumes: `parseTemplate`, `substituteVariables` (Task 5).
- Produces:
  - `reviewDraft(draft, brandProfile, template: string | null)`
  - `reviseDraft(draft, issues, brandProfile, template: string | null)`
  - `reviewAndReconcile(draft, brandProfile, template: string | null, onProgress?)`
  - `DraftReviewer` in `draft.ts` gains the third parameter.

**The reviewer receives the SUBSTITUTED template and no change list.** Both are deliberate. Raw would make it flag every draft for omitting `{count}` literals; the change list would let it raise "the headline doesn't mention the MCP server", which is an editorial call the composer already made and not the reviewer's business.

Pass the **substituted** string, not `brandProfile.productUpdateTemplate`. Task 6 exported `fillTemplate(template, items)` for exactly this — call it on the same sorted item list the composer used, so the composer and the reviewer can never disagree about what `{count}` was.

- [ ] **Step 1: Write the failing test**

Append to `tests/lib/ai/review-draft.test.ts`:

```ts
describe("buildReviewPrompt with a template", () => {
  it("includes the template", () => {
    const prompt = buildReviewPrompt(DRAFT, PROFILE, "## Highlights\n\n## Fixes\n");
    expect(prompt).toContain("## Highlights");
    expect(prompt).toContain("## Fixes");
  });

  it("asks whether the draft follows the template", () => {
    expect(buildReviewPrompt(DRAFT, PROFILE, "## Highlights\n").toLowerCase()).toContain("template");
  });

  it("omits the template block entirely when none is configured", () => {
    expect(buildReviewPrompt(DRAFT, PROFILE, null)).not.toContain("<template>");
  });
});

describe("reviewAndReconcile with a template", () => {
  it("passes the template to both the review and the revision", async () => {
    const seen: (string | null)[] = [];
    vi.mocked(generateObject)
      .mockImplementationOnce(async (args: never) => {
        seen.push((args as { prompt: string }).prompt);
        return { object: { compliant: false, issues: ["Missing the Fixes section"] }, usage: {} } as never;
      })
      .mockImplementationOnce(async (args: never) => {
        seen.push((args as { prompt: string }).prompt);
        return { object: { title: "t", body: "b" }, usage: {} } as never;
      })
      .mockImplementationOnce(async () => ({ object: { compliant: true, issues: [] }, usage: {} } as never));

    const outcome = await reviewAndReconcile(DRAFT, PROFILE, "## Fixes\n");
    expect(outcome.status).toBe("passed");
    expect(seen[0]).toContain("## Fixes");
    expect(seen[1]).toContain("## Fixes");
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/lib/ai/review-draft.test.ts`
Expected: FAIL — `buildReviewPrompt` takes two arguments.

- [ ] **Step 3: Update `review-draft.ts`**

```ts
const REVIEW_SYSTEM = [
  "You are a brand-compliance reviewer for product update announcements.",
  "Check the draft against the brand requirements.",
  "If a template is given, also check whether the draft FOLLOWS it, and name every gap you find specifically",
  "enough for an editor to act on. The template is the shape the company's updates take; the draft should",
  "match its sections, their order, its headings and any sign-off.",
  "Judge only the shape. Which change the draft leads with, and how much space each gets, are editorial",
  "decisions already made — do not second-guess them, and do not ask for content the template cannot tell you",
  "is missing.",
  "If it fully complies, set compliant true and issues [].",
  "If it violates any requirement, set compliant false and list the specific issues to fix.",
  "Do not rewrite the draft — only critique it.",
].join(" ");
```

`buildReviewPrompt` and `buildRevisionPrompt` each gain a `template: string | null` parameter and append, when non-null:

```ts
`\n\nTemplate the update should follow:\n<template>\n${template}\n</template>`
```

Thread it through `reviewDraft`, `reviseDraft` and `reviewAndReconcile`.

- [ ] **Step 4: Update the caller**

In `draft.ts`, pass the substituted template to `review(...)`. Widen `DraftReviewer` to `(draft, brandProfile, template) => Promise<ReviewOutcome>`.

- [ ] **Step 5: Run and commit**

```bash
npx vitest run tests/lib/ai/review-draft.test.ts tests/lib/briefs
npm test
npm run typecheck
git add -u
git commit -m "feat: review the draft against the company template"
```

---

### Task 8: The `/company` template editor

**Files:**
- Create: `src/app/(dashboard)/company/product-update-template-editor.tsx`
- Modify: `src/app/(dashboard)/company/actions.ts` (add `saveProductUpdateTemplate`)
- Modify: `src/app/(dashboard)/company/page.tsx` (add the card)
- Test: `tests/components/settings/product-update-template-editor.test.tsx`

**Interfaces:**
- Consumes: `DEFAULT_PRODUCT_UPDATE_TEMPLATE` (Task 3), `companyProfiles.productUpdateTemplate` (Task 3).
- Produces: `saveProductUpdateTemplate(formData: FormData): Promise<void>`.

`guidelines-editor.tsx` is the model. Copy its structure, including the **untouched-template trick**: when `defaultValue` is null and the user has not touched the field, submit `""` so `saveProductUpdateTemplate` writes null and the column stays null. Without this, the first unrelated save on the page permanently persists the placeholder skeleton, and the composer can no longer tell "never configured" from "configured".

- [ ] **Step 1: Write the failing test**

`tests/components/settings/product-update-template-editor.test.tsx`. There is no existing guidelines-editor test to mirror — `tests/components/settings/` contains only `ai-engines-card.test.tsx`. Assert the submitted hidden-input value:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProductUpdateTemplateEditor } from "../../../src/app/(dashboard)/company/product-update-template-editor";

describe("ProductUpdateTemplateEditor", () => {
  it("submits an empty value while the seeded template is untouched", () => {
    render(<ProductUpdateTemplateEditor defaultValue={null} />);
    expect(screen.getByTestId("product-update-template-input")).toHaveValue("");
  });

  it("submits the stored template when one exists", () => {
    render(<ProductUpdateTemplateEditor defaultValue={"# Stored\n"} />);
    expect(screen.getByTestId("product-update-template-input")).toHaveValue("# Stored\n");
  });
});
```

`tests/components/**` is the jsdom project (`vitest.config.ts:42`), so this path routes correctly with no config change. **No `UnsavedChangesProvider` wrapper is needed:** `UnsavedChangesContext` is created with a complete default value (`src/app/(dashboard)/unsaved-changes.tsx:57`), so `useUnsavedChanges` works outside a provider.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/components/settings/product-update-template-editor.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the editor**

Copy `guidelines-editor.tsx` verbatim and change: the import to `DEFAULT_PRODUCT_UPDATE_TEMPLATE`, the hidden input's `name` to `productUpdateTemplate` (plus `data-testid="product-update-template-input"`), the `setSectionDirty` key to `"productUpdateTemplate"`, and the placeholder text. Keep the `touched` state, the `submittedValue` computation, the baseline re-anchoring on `cleanToken`, and the unmount cleanup exactly as they are — each has a comment explaining a bug it fixes.

- [ ] **Step 4: Add the action**

In `company/actions.ts`, beside `saveGuidelines`:

```ts
/**
 * Persists the product update template. Scoped to that one column for the same
 * reason `saveGuidelines` is — see its comment: every card on this page saves
 * itself, so widening this would read another card's absent fields as empty and
 * null its column.
 */
export async function saveProductUpdateTemplate(formData: FormData) {
  const session = await requireSession();
  const profile = await getOrCreateCompanyProfile(session.user.tenantId);

  await db
    .update(companyProfiles)
    .set({
      productUpdateTemplate: (formData.get("productUpdateTemplate") as string)?.trim() || null,
      updatedAt: new Date(),
    })
    .where(eq(companyProfiles.id, profile.id));

  revalidatePath("/company");
}
```

- [ ] **Step 5: Add the card**

In `company/page.tsx`, immediately after the Guidelines card, copying its structure including the `key` and the comment explaining why the editor is keyed on the server value (an import overwrites the column and the editor seeds `useState` once):

```tsx
      <Card id="product-update-template">
        <CardHeader>
          <CardTitle>Product update template</CardTitle>
          <CardDescription>
            The shape your product updates take — headings, section order, sign-off. Written as Markdown.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ToastForm
            action={saveProductUpdateTemplate}
            successMessage="Product update template saved"
            className="space-y-4"
          >
            <ProductUpdateTemplateEditor
              key={brandProfile.productUpdateTemplate ?? ""}
              defaultValue={brandProfile.productUpdateTemplate}
            />
            <Button type="submit" variant="outline">
              Save
            </Button>
          </ToastForm>
        </CardContent>
      </Card>
```

- [ ] **Step 6: Verify and commit**

```bash
npx vitest run tests/components
npm run typecheck
npm run lint
npm test
git add -A src/app tests/components
git commit -m "feat: product update template editor on /company"
```

The UI cannot be visually verified — the dev preview is behind an OAuth wall — so typecheck and lint are the gates here.

---

### Task 9: Grouping — resolver context, similarity merge, bounded candidates

**Files:**
- Modify: `src/lib/ai/resolve-atomic-updates.ts` (`ResolverEvent`, `buildResolverPrompt`)
- Modify: `src/lib/change-events/pipeline.ts` (the select)
- Modify: `src/lib/change-events/apply-resolution.ts` (`applyResolutionInTx`, `loadOpenAtomicUpdates`)
- Test: `tests/lib/ai/resolve-atomic-updates.test.ts`, `tests/lib/change-events/apply-resolution.test.ts`, `tests/lib/change-events/pipeline.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks. **This task is independent of Tasks 3–8 and may be done in parallel with them.**
- Produces: `RESOLVER_CONTEXT_CHARS`, `MAX_OPEN_CANDIDATES`, and an exported `titlesMatch(a: string, b: string): boolean`.

- [ ] **Step 1: Write the failing tests**

`tests/lib/change-events/apply-resolution.test.ts`:

```ts
import { titlesMatch } from "../../../src/lib/change-events/apply-resolution";

describe("titlesMatch", () => {
  it("matches identical titles", () => {
    expect(titlesMatch("Shared dashboards", "Shared dashboards")).toBe(true);
  });

  it("matches across case, punctuation and spacing", () => {
    expect(titlesMatch("Shared Dashboards!", "  shared   dashboards ")).toBe(true);
  });

  it("matches the near-miss that motivated this", () => {
    expect(titlesMatch("Shared dashboards", "Shared dashboard")).toBe(false);
  });

  it("matches a title differing only by a stray extra word", () => {
    expect(titlesMatch("New shared dashboards for teams", "Shared dashboards for teams")).toBe(true);
  });

  it("does NOT match two genuinely different changes", () => {
    expect(titlesMatch("Shared dashboards", "CSV export")).toBe(false);
    expect(titlesMatch("Faster search", "Faster export")).toBe(false);
  });
});
```

**Note on case 3:** "dashboards" and "dashboard" are different tokens, so token-set Jaccard scores 1/3 and does not merge. That is the honest outcome of the chosen algorithm — the spec's example is aspirational, and merging two genuinely different updates is worse than splitting one. Write the test to the behaviour, not the aspiration, and leave a comment saying so.

Add to `tests/lib/ai/resolve-atomic-updates.test.ts`, importing `RESOLVER_CONTEXT_CHARS` alongside `buildResolverPrompt`:

```ts
it("includes the PR description in the prompt, truncated", () => {
  const prompt = buildResolverPrompt(
    [{ id: "e1", type: "pull_request", title: "Add dashboards", summary: null, repoName: "acme/app", description: "x".repeat(RESOLVER_CONTEXT_CHARS + 50) }],
    []
  );
  expect(prompt).toContain("x".repeat(RESOLVER_CONTEXT_CHARS));
  expect(prompt).not.toContain("x".repeat(RESOLVER_CONTEXT_CHARS + 1));
});

it("omits the description block when there is none", () => {
  const prompt = buildResolverPrompt(
    [{ id: "e1", type: "commit", title: "Fix", summary: null, repoName: null, description: null }],
    []
  );
  expect(prompt).not.toContain("description:");
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run tests/lib/change-events/apply-resolution.test.ts tests/lib/ai/resolve-atomic-updates.test.ts`
Expected: FAIL — `titlesMatch` not exported; `description` not a known property.

- [ ] **Step 3: Add the resolver context**

In `resolve-atomic-updates.ts`:

```ts
/**
 * Chars of a PR/task description carried per event. At RESOLVER_BATCH_SIZE (25)
 * that is ~12.5k characters of added context, comfortably inside budget.
 *
 * Deliberately NOT the diff. Grouping needs to know what a change was FOR, which
 * the description carries; the diff is a more technical signal than this
 * decision needs and was rejected explicitly — see the spec's Non-goals.
 */
export const RESOLVER_CONTEXT_CHARS = 500;
```

`ResolverEvent` gains `description: string | null`; `buildResolverPrompt` emits `\n  description: ${description.slice(0, RESOLVER_CONTEXT_CHARS)}` when present.

In `pipeline.ts`, add `prDescription` and `taskDescription` to the select and map them: `description: r.prDescription ?? r.taskDescription ?? null`.

- [ ] **Step 4: Add the similarity merge**

In `apply-resolution.ts`:

```ts
/** Merge threshold for two same-batch `create` titles. */
const TITLE_SIMILARITY_THRESHOLD = 0.8;

function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
  );
}

/**
 * Whether two `create` actions in the SAME batch describe one change.
 *
 * `RESOLVER_SYSTEM` explicitly instructs the model to give co-describing events
 * the SAME title, so this is a tolerance band on an intended exact match, not
 * open-ended clustering — which is what makes widening the old exact-string
 * comparison safe. Merging two genuinely different updates is worse than
 * splitting one, so the threshold is deliberately strict, it applies only
 * within one batch's creates, and it never touches `assign`.
 */
export function titlesMatch(a: string, b: string): boolean {
  const left = titleTokens(a);
  const right = titleTokens(b);
  if (left.size === 0 || right.size === 0) return false;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  const union = left.size + right.size - shared;
  return shared / union >= TITLE_SIMILARITY_THRESHOLD;
}
```

Replace the `createdByTitle` map lookup with a scan over already-created titles using `titlesMatch`, keeping the first-create-wins behaviour.

- [ ] **Step 5: Bound the candidate set**

```ts
/**
 * Cap on the resolver's candidate set. Unbounded, the prompt grows with the
 * backlog and assign precision drops.
 *
 * A candidate excluded by the cap means a late commit creates a duplicate
 * instead of assigning — which is why the ordering is recency and why every
 * atomic update already linked to a content piece is included regardless. Those
 * are the in-flight-draft rows this query's missing `contentPieceId` filter
 * exists to serve; dropping one reintroduces exactly the duplicate that filter's
 * absence was written to prevent.
 */
export const MAX_OPEN_CANDIDATES = 100;
```

Implement as two queries unioned in code — all open rows with a non-null `contentPieceId`, plus the most recently updated open rows up to the cap — then de-duplicate by id. Two queries are clearer here than one with a window function, and this runs once per chunk.

Add to `tests/lib/change-events/apply-resolution.test.ts`:

```ts
it("caps the candidate set at MAX_OPEN_CANDIDATES", async () => {
  const tenant = await seedTenant("Candidate Cap Tenant");
  for (let i = 0; i < MAX_OPEN_CANDIDATES + 5; i++) {
    await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: `AU ${i}`, summary: "s" });
  }
  const open = await loadOpenAtomicUpdates(db, tenant.id);
  expect(open.length).toBe(MAX_OPEN_CANDIDATES);
});

it("includes a draft-linked update even when the cap would exclude it", async () => {
  const tenant = await seedTenant("Candidate Exemption Tenant");
  const [piece] = await db
    .insert(contentPieces)
    .values({ tenantId: tenant.id, title: "Draft", body: "b", status: "draft" })
    .returning();
  // Oldest by updatedAt, so recency ordering alone would drop it.
  const [linked] = await db
    .insert(atomicUpdates)
    .values({
      tenantId: tenant.id,
      title: "Linked to a draft",
      summary: "s",
      contentPieceId: piece.id,
      updatedAt: new Date("2020-01-01T00:00:00Z"),
    })
    .returning();
  for (let i = 0; i < MAX_OPEN_CANDIDATES + 5; i++) {
    await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: `AU ${i}`, summary: "s" });
  }

  const open = await loadOpenAtomicUpdates(db, tenant.id);
  expect(open.map((a) => a.id)).toContain(linked.id);
});
```

Both are database tests, so they belong to the node project and need `seedTenant` from `tests/helpers/fixtures.ts`.

- [ ] **Step 6: Run and commit**

```bash
npx vitest run tests/lib/change-events tests/lib/ai/resolve-atomic-updates.test.ts
npm test
npm run typecheck
git add -u
git commit -m "feat: richer resolver context, tolerant merge, bounded candidates"
```

---

### Task 10: Final verification

- [ ] **Step 1: Full gates**

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Compare the suite against the 304 files / 3765 tests baseline. Re-run any single failing file once — the suite is flaky against one shared Postgres — and confirm any genuine failure is in a file this plan touched.

- [ ] **Step 2: Walk the spec**

Re-read the spec's Testing section and confirm each bullet has a passing test. Anything missing is a gap to close now, not a follow-up.

- [ ] **Step 3: Confirm the null-template path is untouched**

The live path for every existing tenant is `productUpdateTemplate === null`. Confirm by test, not by reading: `composeReleasePrompt` with `template: null` renders today's prompt, and `buildReviewPrompt` with `template: null` emits no `<template>` block.

- [ ] **Step 4: Update the spec's status**

Change the spec header from `**Status:** approved, not implemented` to `**Status:** implemented`, then commit.

```bash
git add docs/superpowers
git commit -m "docs: mark the product update structure spec implemented"
```
