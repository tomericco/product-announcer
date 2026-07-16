# Prompt Composition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compose the generation prompt from all available context — lead each change with A's enriched `impactSummary` (no diffs), fold in `examplePhrases` and fuller persona identity, make example selection category-aware — and extract prompt assembly into a dedicated, testable module.

**Architecture:** A new `compose-prompt.ts` owns `serializeBatch`, the system-prompt builder, and `composePrompt`; `generation.ts` slims to `composePrompt` + `generateObject`. `resolvePersonaRefs` carries the persona `description`; `selectExamples` gains an optional `categories` tiebreak; `runBatchForWorkspace` derives the batch's categories via a new `batchCategories` helper.

**Tech Stack:** Next.js (App Router), Drizzle ORM + Postgres, `ai` v7 (`generateObject`), Zod, Vitest.

## Global Constraints

- **This is NOT stock Next.js** — per `AGENTS.md`; this plan touches no new Next.js APIs.
- **No new columns or migrations** — C is pure prompt/selection logic over existing data.
- **Serialization uses `impactSummary` + title/message, never the diff.** PR detail = `impactSummary ?? prDescription ?? ""`; commit detail = `impactSummary ?? ""`. Un-enriched items fall back to title/message only.
- **Safety cap:** `serializeBatch(items, reposById, maxChars = 24000)` renders all items; if over `maxChars`, keep leading items that fit and append `…and <N> more changes not shown.` (whole-item drop).
- **Example selection stays strict** (industry OR persona must match; category alone never qualifies). Category is a **tiebreak after** the industry+persona score and **before** `sort_order`. **Equal weights** — persona is NOT weighted above industry.
- **`ResolvedPersona.description` is optional**; system personas populate it, custom personas leave it unset. Prompt renders `name (description): brief` when present, else `name: brief`.
- **`ExampleCriteria.categories` is optional** (`categories?: string[]`) so B's existing callers/tests keep working; absent/empty reproduces B's ordering exactly.
- Test command: `npm test` (`vitest run`); `npm test -- <name>` filters. Type-check: `npx tsc --noEmit`.

---

### Task 1: `resolvePersonaRefs` carries persona `description`

**Files:**
- Modify: `src/db/schema.ts:11` (`ResolvedPersona` type)
- Modify: `src/lib/personas.ts` (`CatalogEntry` type + `resolvePersonaRefs`)
- Test: `tests/lib/personas.test.ts` (add cases)

**Interfaces:**
- Produces: `ResolvedPersona = { name: string; brief: string; description?: string }`. `resolvePersonaRefs` sets `description` from the system persona's `description` for system refs; custom refs leave it unset. Consumed by Task 3's system-prompt builder.

- [ ] **Step 1: Write the failing test**

Add to `tests/lib/personas.test.ts` inside the existing `describe("resolvePersonaRefs", ...)` block (the file already imports `resolvePersonaRefs`):

```ts
  it("carries the system persona description for system refs and leaves it unset for custom refs", () => {
    const catalogWithDesc = [
      { key: "developer", name: "Developer", brief: "cares about APIs", description: "Engineers who integrate" },
    ];
    expect(resolvePersonaRefs([{ type: "system", key: "developer" }], catalogWithDesc)).toEqual([
      { name: "Developer", brief: "cares about APIs", description: "Engineers who integrate" },
    ]);

    const [custom] = resolvePersonaRefs([{ type: "custom", name: "Ops", brief: "runs infra" }], catalogWithDesc);
    expect(custom).toEqual({ name: "Ops", brief: "runs infra" });
    expect(custom.description).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- personas`
Expected: FAIL — resolved system ref lacks `description`, so `toEqual` with the `description` field fails.

- [ ] **Step 3: Widen the types and populate `description`**

In `src/db/schema.ts`, change the `ResolvedPersona` type (line 11):

```ts
export type ResolvedPersona = { name: string; brief: string; description?: string };
```

In `src/lib/personas.ts`, widen `CatalogEntry` and populate `description` for system refs. Change the `CatalogEntry` type:

```ts
type CatalogEntry = { key: string; name: string; brief: string; description?: string };
```

And in `resolvePersonaRefs`, change the system-ref branch to carry `description`:

```ts
    } else {
      const sys = byKey.get(ref.key);
      if (sys) resolved.push({ name: sys.name, brief: sys.brief, description: sys.description });
    }
```

(The custom-ref branch stays `resolved.push({ name: ref.name, brief: ref.brief })` — no description.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- personas`
Expected: PASS. The pre-existing `resolvePersonaRefs` tests still pass because their catalog fixtures have no `description`, so `sys.description` is `undefined` and Vitest's `toEqual` treats `{ ..., description: undefined }` as equal to `{ ... }`.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/lib/personas.ts tests/lib/personas.test.ts
git commit -m "feat: carry persona description through resolvePersonaRefs"
```

---

### Task 2: Category-aware `selectExamples`

**Files:**
- Modify: `src/lib/select-examples.ts`
- Test: `tests/lib/select-examples.test.ts` (add cases)

**Interfaces:**
- Produces: `ExampleCriteria = { industry: string | null; personaKeys: string[]; categories?: string[] }`. `selectExamples` ranks by industry+persona score desc, then category-match desc, then `sort_order` asc. Consumed by Task 4's wiring.

- [ ] **Step 1: Write the failing test**

Add to `tests/lib/select-examples.test.ts` inside the existing `describe("selectExamples", ...)` block (reuse the existing `ex` factory):

```ts
  it("ranks a category-matching example above an equal-score example that does not match category", () => {
    const matchesCat = ex({ key: "catmatch", industry: "SaaS", category: "new", sortOrder: 20 });
    const noCat = ex({ key: "nocat", industry: "SaaS", category: "improved", sortOrder: 10 });
    const result = selectExamples([noCat, matchesCat], { industry: "SaaS", personaKeys: [], categories: ["new"] });
    // Both score 1 (industry). Category match beats the lower sort_order.
    expect(result.map((r) => r.key)).toEqual(["catmatch", "nocat"]);
  });

  it("reproduces sort_order ordering when categories is omitted", () => {
    const a = ex({ key: "a", industry: "SaaS", sortOrder: 10, category: "new" });
    const b = ex({ key: "b", industry: "SaaS", sortOrder: 20, category: "improved" });
    const result = selectExamples([b, a], { industry: "SaaS", personaKeys: [] });
    expect(result.map((r) => r.key)).toEqual(["a", "b"]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- select-examples`
Expected: FAIL — the first new test: without a category tiebreak, `nocat` (sort_order 10) outranks `catmatch` (sort_order 20), so the order is `["nocat", "catmatch"]`, not the expected `["catmatch", "nocat"]`.

- [ ] **Step 3: Add the category tiebreak**

Replace the contents of `src/lib/select-examples.ts` with:

```ts
import type { systemUpdateExamples } from "../db/schema";

export type ExampleRow = typeof systemUpdateExamples.$inferSelect;

export type ExampleCriteria = {
  industry: string | null;
  personaKeys: string[];
  categories?: string[];
};

function score(example: ExampleRow, criteria: ExampleCriteria): number {
  const industryMatch =
    example.industry !== null &&
    criteria.industry !== null &&
    example.industry.toLowerCase() === criteria.industry.toLowerCase();
  const personaMatch = example.personaKey !== null && criteria.personaKeys.includes(example.personaKey);
  return (industryMatch ? 1 : 0) + (personaMatch ? 1 : 0);
}

function categoryMatch(example: ExampleRow, criteria: ExampleCriteria): boolean {
  return (criteria.categories ?? []).includes(example.category);
}

/**
 * Strict, capped few-shot selection. An example is a candidate only if it matches
 * the tenant's industry OR one of their system persona keys. Candidates are ranked
 * by match strength (both tags > one tag), then by whether the example's category is
 * one the batch is about, then by sort_order ascending. Top `limit` returned; no
 * candidates → empty array.
 */
export function selectExamples(
  examples: ExampleRow[],
  criteria: ExampleCriteria,
  limit = 3
): ExampleRow[] {
  return examples
    .map((example) => ({ example, s: score(example, criteria), c: categoryMatch(example, criteria) }))
    .filter((candidate) => candidate.s > 0)
    .sort(
      (a, b) =>
        b.s - a.s ||
        Number(b.c) - Number(a.c) ||
        a.example.sortOrder - b.example.sortOrder
    )
    .slice(0, limit)
    .map((candidate) => candidate.example);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- select-examples`
Expected: PASS — the two new tests plus all six pre-existing tests (they pass criteria without `categories`, so `categoryMatch` is always false and their orderings are unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/lib/select-examples.ts tests/lib/select-examples.test.ts
git commit -m "feat: make selectExamples category-aware"
```

---

### Task 3: Extract `compose-prompt` module and slim `generation.ts`

**Files:**
- Create: `src/lib/compose-prompt.ts`
- Create: `tests/lib/compose-prompt.test.ts`
- Modify: `src/lib/generation.ts` (remove moved functions; call `composePrompt`)
- Modify: `tests/lib/generation.test.ts` (remove the `serializeBatchForPrompt` tests; keep `generateUpdateDraft` tests)

**Interfaces:**
- Consumes: `ResolvedPersona.description` (Task 1).
- Produces (from `compose-prompt.ts`):
  - `serializeBatch(items: ChangeItemRow[], reposById: Map<string,string>, maxChars?: number): string`
  - `buildSystemPrompt(brandProfile, personas: ResolvedPersona[], examples: ExampleRow[]): string`
  - `composePrompt(args: { items, brandProfile, reposById, personas, examples }): { system: string; prompt: string }`
- `generation.ts` keeps exporting `UpdateDraftSchema`, `UpdateDraft`, and `generateUpdateDraft` (unchanged signature). It no longer exports `serializeBatchForPrompt`.

- [ ] **Step 1: Write the failing test for the new module**

Create `tests/lib/compose-prompt.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { serializeBatch, buildSystemPrompt } from "../../src/lib/compose-prompt";

type FakeChangeItem = {
  id: string; repoId: string; sourceType: "pr" | "commit";
  prNumber: number | null; prTitle: string | null; prDescription: string | null;
  commitSha: string | null; commitMessage: string | null; diff: string | null;
  impactSummary: string | null;
};

function prItem(o: Partial<FakeChangeItem> = {}): FakeChangeItem {
  return { id: "ci_1", repoId: "repo_web", sourceType: "pr", prNumber: 1, prTitle: "Add dark mode",
    prDescription: "Adds a toggle.", commitSha: null, commitMessage: null, diff: "diff --git a/x b/x\n+dark",
    impactSummary: null, ...o };
}
function commitItem(o: Partial<FakeChangeItem> = {}): FakeChangeItem {
  return { id: "ci_2", repoId: "repo_api", sourceType: "commit", prNumber: null, prTitle: null,
    prDescription: null, commitSha: "abcdef1234567", commitMessage: "fix export timeout",
    diff: "diff --git a/y b/y\n+fix", impactSummary: null, ...o };
}

const REPOS = new Map([["repo_web", "acme/web"], ["repo_api", "acme/api"]]);

describe("serializeBatch", () => {
  it("leads with impactSummary when present and never emits the diff", () => {
    const result = serializeBatch([commitItem({ impactSummary: "Exports finish faster" })] as never, REPOS);
    expect(result).toContain('1. [acme/api · commit abcdef1] "fix export timeout" — Exports finish faster');
    expect(result).not.toContain("diff --git");
  });

  it("falls back to prDescription for a PR with no impactSummary", () => {
    const result = serializeBatch([prItem()] as never, REPOS);
    expect(result).toContain('1. [acme/web · PR #1] "Add dark mode" — Adds a toggle.');
    expect(result).not.toContain("diff --git");
  });

  it("shows only the title for a commit with no impactSummary (no trailing separator)", () => {
    const result = serializeBatch([commitItem()] as never, REPOS);
    expect(result).toBe('1. [acme/api · commit abcdef1] "fix export timeout"');
  });

  it("caps oversized batches by dropping trailing whole items with a note", () => {
    const items = [
      commitItem({ id: "a", commitSha: "aaaaaaa0000", impactSummary: "A".repeat(60) }),
      commitItem({ id: "b", commitSha: "bbbbbbb0000", impactSummary: "B".repeat(60) }),
      commitItem({ id: "c", commitSha: "ccccccc0000", impactSummary: "C".repeat(60) }),
    ];
    const result = serializeBatch(items as never, REPOS, 90);
    expect(result).toContain("A".repeat(60));
    expect(result).not.toContain("C".repeat(60));
    expect(result).toMatch(/more changes not shown\./);
  });
});

describe("buildSystemPrompt", () => {
  const baseBrand = { tone: null, readingLevel: null, doList: [], dontList: [], examplePhrases: [], industry: null, userPersonas: [] };

  it("includes an examplePhrases line when present and omits it when empty", () => {
    const withPhrases = buildSystemPrompt({ ...baseBrand, examplePhrases: ["ship it", "delightful"] } as never, [], []);
    expect(withPhrases).toContain("Prefer this vocabulary and phrasing where natural: ship it; delightful.");
    const without = buildSystemPrompt(baseBrand as never, [], []);
    expect(without).not.toContain("Prefer this vocabulary");
  });

  it("renders persona identity in parentheses when a description is present", () => {
    const withDesc = buildSystemPrompt(baseBrand as never, [{ name: "Developer", brief: "cares about APIs", description: "Engineers who integrate" }], []);
    expect(withDesc).toContain("Developer (Engineers who integrate): cares about APIs");
    const withoutDesc = buildSystemPrompt(baseBrand as never, [{ name: "Ops", brief: "runs infra" }], []);
    expect(withoutDesc).toContain("Ops: runs infra");
    expect(withoutDesc).not.toContain("Ops (");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- compose-prompt`
Expected: FAIL — `Cannot find module '../../src/lib/compose-prompt'`.

- [ ] **Step 3: Create `compose-prompt.ts`**

Create `src/lib/compose-prompt.ts`:

```ts
import type { changeItems, brandProfiles, ResolvedPersona, systemUpdateExamples } from "../db/schema";

type ChangeItemRow = typeof changeItems.$inferSelect;
type BrandProfileRow = typeof brandProfiles.$inferSelect;
type ExampleRow = typeof systemUpdateExamples.$inferSelect;

const DEFAULT_MAX_PROMPT_CHARS = 24000;

function formatChangeItem(item: ChangeItemRow, index: number, reposById: Map<string, string>): string {
  const repo = reposById.get(item.repoId) ?? "unknown";
  const n = index + 1;
  if (item.sourceType === "pr") {
    const detail = item.impactSummary ?? item.prDescription ?? "";
    return `${n}. [${repo} · PR #${item.prNumber}] "${item.prTitle}"${detail ? ` — ${detail}` : ""}`;
  }
  const sha = item.commitSha?.slice(0, 7) ?? "unknown";
  const detail = item.impactSummary ?? "";
  return `${n}. [${repo} · commit ${sha}] "${item.commitMessage}"${detail ? ` — ${detail}` : ""}`;
}

/**
 * Renders the batch as numbered, repo-tagged lines using each item's enriched
 * impactSummary (falling back to title/message). Diffs are never included — A's
 * enricher already distilled them into impactSummary. If the rendered batch exceeds
 * `maxChars`, trailing whole items are dropped and a summary note is appended.
 */
export function serializeBatch(
  items: ChangeItemRow[],
  reposById: Map<string, string>,
  maxChars = DEFAULT_MAX_PROMPT_CHARS
): string {
  const lines = items.map((item, i) => formatChangeItem(item, i, reposById));
  const full = lines.join("\n");
  if (full.length <= maxChars) return full;

  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const droppedIfStopHere = lines.length - (i + 1);
    const note = droppedIfStopHere > 0 ? `\n…and ${droppedIfStopHere} more changes not shown.` : "";
    const candidate = [...kept, lines[i]].join("\n") + note;
    if (candidate.length > maxChars) break;
    kept.push(lines[i]);
  }

  const dropped = lines.length - kept.length;
  return dropped > 0 ? `${kept.join("\n")}\n…and ${dropped} more changes not shown.` : kept.join("\n");
}

function renderExample(example: ExampleRow): string {
  return `Example (${example.category}):\nTitle: ${example.title}\nBody:\n${example.body}`;
}

function renderPersona(persona: ResolvedPersona): string {
  return persona.description ? `${persona.name} (${persona.description}): ${persona.brief}` : `${persona.name}: ${persona.brief}`;
}

export function buildSystemPrompt(
  brandProfile: BrandProfileRow,
  personas: ResolvedPersona[],
  examples: ExampleRow[]
): string {
  const lines = [
    "You write concise, user-facing product update announcements.",
    brandProfile.industry ? `Industry: ${brandProfile.industry}.` : null,
    personas.length > 0
      ? `Audience personas — tailor the update to appeal to each: ${personas.map(renderPersona).join(" ")}`
      : null,
    brandProfile.tone ? `Tone: ${brandProfile.tone}.` : null,
    brandProfile.readingLevel ? `Reading level: ${brandProfile.readingLevel}.` : null,
    brandProfile.doList.length > 0 ? `Do: ${brandProfile.doList.join("; ")}.` : null,
    brandProfile.dontList.length > 0 ? `Avoid: ${brandProfile.dontList.join("; ")}.` : null,
    brandProfile.examplePhrases.length > 0
      ? `Prefer this vocabulary and phrasing where natural: ${brandProfile.examplePhrases.join("; ")}.`
      : null,
  ].filter((line): line is string => Boolean(line));

  const base = lines.join(" ");
  if (examples.length === 0) return base;

  const block = [
    "Here are example updates for a similar audience — mirror their structure, depth, and voice; do not reuse their wording or specifics:",
    ...examples.map(renderExample),
  ].join("\n\n");

  return `${base}\n\n${block}`;
}

export function composePrompt(args: {
  items: ChangeItemRow[];
  brandProfile: BrandProfileRow;
  reposById: Map<string, string>;
  personas: ResolvedPersona[];
  examples: ExampleRow[];
}): { system: string; prompt: string } {
  const batchText = serializeBatch(args.items, args.reposById);
  return {
    system: buildSystemPrompt(args.brandProfile, args.personas, args.examples),
    prompt: `Here are the changes to summarize into one product update. Format the body as Markdown (short paragraphs, and bullet lists where helpful):\n\n${batchText}`,
  };
}
```

- [ ] **Step 4: Run the new module test to verify it passes**

Run: `npm test -- compose-prompt`
Expected: PASS (all serializeBatch and buildSystemPrompt tests).

- [ ] **Step 5: Slim `generation.ts` to use `composePrompt`**

Replace the entire contents of `src/lib/generation.ts` with:

```ts
import { generateObject } from "ai";
import { z } from "zod";
import type { changeItems, brandProfiles, ResolvedPersona, systemUpdateExamples } from "../db/schema";
import { composePrompt } from "./compose-prompt";

type ChangeItemRow = typeof changeItems.$inferSelect;
type BrandProfileRow = typeof brandProfiles.$inferSelect;
type ExampleRow = typeof systemUpdateExamples.$inferSelect;

export const UpdateDraftSchema = z.object({
  title: z.string(),
  body: z.string(),
  category: z.enum(["new", "improved", "fixed"]),
});

export type UpdateDraft = z.infer<typeof UpdateDraftSchema>;

export async function generateUpdateDraft(
  items: ChangeItemRow[],
  brandProfile: BrandProfileRow,
  reposById: Map<string, string>,
  personas: ResolvedPersona[] = [],
  examples: ExampleRow[] = []
): Promise<UpdateDraft> {
  const { system, prompt } = composePrompt({ items, brandProfile, reposById, personas, examples });

  const result = await generateObject({
    model: process.env.GENERATION_MODEL ?? "anthropic/claude-sonnet-4-5",
    schema: UpdateDraftSchema,
    system,
    prompt,
  });

  return result.object;
}
```

- [ ] **Step 6: Update `generation.test.ts` — drop the moved serialization tests**

In `tests/lib/generation.test.ts`:
- Change the top import (line 2) from `import { serializeBatchForPrompt } from "../../src/lib/generation";` to remove it — delete that import line entirely.
- Delete the entire `describe("serializeBatchForPrompt", ...)` block (the block spanning the two `serializeBatchForPrompt` tests). The `FakeChangeItem`/`prItem`/`commitItem` helpers and the `REPOS` map are still used by the `generateUpdateDraft` tests below, so keep them.
- Leave the `vi.mock("ai", ...)`, the `generateObject`/`generateUpdateDraft` imports, and the entire `describe("generateUpdateDraft", ...)` block unchanged. (These still pass: `generateUpdateDraft` now routes through `composePrompt`, but a persona `{ name, brief }` with no description still renders `name: brief`, and a `prItem` with no `impactSummary` still serializes its `prDescription`, so the existing assertions on `system`/`prompt` hold.)

- [ ] **Step 7: Run the full suite and type-check**

Run: `npm test`
Expected: all PASS — `compose-prompt.test.ts` (new), `generation.test.ts` (`generateUpdateDraft` block only), and every other suite.

Run: `npx tsc --noEmit`
Expected: no type errors. (Only `generation.test.ts` imported `serializeBatchForPrompt`; that import is now removed. `run-schedule.ts` imports `generateUpdateDraft`, which is unchanged.)

- [ ] **Step 8: Commit**

```bash
git add src/lib/compose-prompt.ts tests/lib/compose-prompt.test.ts src/lib/generation.ts tests/lib/generation.test.ts
git commit -m "refactor: extract compose-prompt module, drop diffs from the prompt"
```

---

### Task 4: `batchCategories` helper + wire into `runBatchForWorkspace`

**Files:**
- Modify: `src/lib/change-item-batch.ts` (add `batchCategories`)
- Modify: `src/lib/run-schedule.ts` (pass `categories` into `selectExamples`)
- Test: `tests/lib/change-item-batch.test.ts` (add `batchCategories` cases)

**Interfaces:**
- Consumes: `selectExamples`'s `categories` criteria (Task 2).
- Produces: `batchCategories(items: { suggestedCategory: string | null }[]): string[]` — the distinct non-null `suggestedCategory` values, in first-seen order.

- [ ] **Step 1: Write the failing test**

In `tests/lib/change-item-batch.test.ts`, add `batchCategories` to the existing import from `../../src/lib/change-item-batch`, then add this `describe` block (it is a pure test — no DB):

```ts
describe("batchCategories", () => {
  it("returns the distinct non-null suggested categories in first-seen order", () => {
    const items = [
      { suggestedCategory: "new" },
      { suggestedCategory: null },
      { suggestedCategory: "improved" },
      { suggestedCategory: "new" },
    ];
    expect(batchCategories(items)).toEqual(["new", "improved"]);
  });

  it("returns an empty array when there are no categories", () => {
    expect(batchCategories([])).toEqual([]);
    expect(batchCategories([{ suggestedCategory: null }])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- change-item-batch`
Expected: FAIL — `batchCategories is not a function`.

- [ ] **Step 3: Add the helper**

In `src/lib/change-item-batch.ts`, add (below the existing exports):

```ts
/**
 * The distinct, non-null `suggestedCategory` values across a batch of change items,
 * in first-seen order. Feeds category-aware example selection.
 */
export function batchCategories(items: { suggestedCategory: string | null }[]): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    if (item.suggestedCategory !== null) seen.add(item.suggestedCategory);
  }
  return [...seen];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- change-item-batch`
Expected: PASS (the two new tests plus all existing change-item-batch tests).

- [ ] **Step 5: Wire `categories` into `runBatchForWorkspace`**

In `src/lib/run-schedule.ts`:

Update the `change-item-batch` import (line 4) to include `batchCategories`:

```ts
import { getPendingChangeItems, getBatchableChangeItems, claimBatchAndCreateUpdate, batchCategories } from "./change-item-batch";
```

In `runBatchForWorkspace`, add `categories` to the `selectExamples` criteria (the existing call currently passes only `industry` and `personaKeys`):

```ts
  const examples = selectExamples(allExamples, {
    industry: brandProfile.industry,
    personaKeys: systemPersonaKeys(brandProfile.userPersonas),
    categories: batchCategories(pending),
  });
```

- [ ] **Step 6: Run the full suite and type-check**

Run: `npm test`
Expected: all PASS. The existing run-schedule example-injection test still passes — passing `categories` does not change which examples match for its single-example scenario.

Run: `npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/change-item-batch.ts src/lib/run-schedule.ts tests/lib/change-item-batch.test.ts
git commit -m "feat: derive batch categories and feed category-aware selection"
```

---

## Self-Review

**Spec coverage:**
- §1 enrichment-driven serialization (impactSummary + title/message, no diff, whole-item safety cap) → Task 3 (`serializeBatch`). ✓
- §2 examplePhrases line + fuller persona `description` → Task 1 (`resolvePersonaRefs` carries description) + Task 3 (`buildSystemPrompt` renders both). ✓
- §3 category-aware selection (categories tiebreak, strict candidacy, equal weights) → Task 2. ✓
- §4 `compose-prompt` module + slimmed `generation.ts` → Task 3. ✓
- §5 wiring (derive batch categories, pass to selection) → Task 4. ✓
- §6 testing (serializeBatch fallbacks + no-diff + cap; examplePhrases/description; category tiebreak; resolvePersonaRefs description; batchCategories) → Tasks 1–4. ✓
- Scope boundaries: no review pass; no migrations; diffs still stored/feed enricher; equal weights kept. ✓

**Placeholder scan:** No TBD/TODO/"handle appropriately"/"similar to Task N". Every code step shows complete code; the `generation.ts` and `select-examples.ts` full-file replacements are literal. ✓

**Type consistency:** `ResolvedPersona` gains optional `description` in schema.ts (Task 1) and is rendered by `renderPersona` in compose-prompt.ts (Task 3) using the same field. `ExampleCriteria.categories?` (Task 2) is the field Task 4 populates via `batchCategories`. `ExampleRow`/`ChangeItemRow`/`BrandProfileRow` aliases are derived identically (`typeof X.$inferSelect`) in compose-prompt.ts and generation.ts. `serializeBatch`/`buildSystemPrompt`/`composePrompt` signatures declared in Task 3 match their test usage and generation.ts's call. ✓

**Ordering:** Task 1 and Task 2 are independent. Task 3 depends on Task 1 (persona `description`). Task 4 depends on Task 2 (`categories` criteria). Safe sequence: 1 → 2 → 3 → 4.

**Note on removed export:** `serializeBatchForPrompt` (old, diff-based) is deleted from `generation.ts`; its only importer was `tests/lib/generation.test.ts`, updated in Task 3. Its replacement `serializeBatch` lives in `compose-prompt.ts`.
