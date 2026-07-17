# Review Remediation Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn D's single inline critique-and-rewrite into an iterative feedback-remediation loop: a critique-only reviewer, a separate reviser that consumes the issues as explicit feedback, and iteration up to a configurable cap before holding the draft.

**Architecture:** A single-module change to `src/lib/review-draft.ts` (and its test). `reviewDraft` becomes critique-only; a new `reviseDraft` remediates from explicit issues; `reviewAndReconcile` loops review→revise→review up to `REVIEW_MAX_ROUNDS` (default 2). The public `reviewAndReconcile` signature and `ReviewOutcome`/`ReviewStatus` are unchanged, so all downstream code is untouched.

**Tech Stack:** TypeScript, `ai` v7 (`generateObject`), Zod, Vitest.

## Global Constraints

- **This is NOT stock Next.js** — per `AGENTS.md`; this plan touches no framework APIs.
- **Model:** `process.env.REVIEW_MODEL ?? "anthropic/claude-sonnet-4-5"` for both review and revise calls.
- **Rounds:** `REVIEW_MAX_ROUNDS` — default **2** when the env var is unset; a non-positive or invalid value clamps to **0** (pure gate: review once, fail if non-compliant, no revision).
- **Retry:** every review/revise call retries once on error; if any call still throws, `reviewAndReconcile` returns `status: "error"` holding the most recent draft (fail-safe).
- **`failed` holds the last (best) revision** and the last review's issues; `error` holds the most recent successfully-produced draft.
- **External contract unchanged:** `reviewAndReconcile(draft, brandProfile): Promise<{ finalDraft: UpdateDraft; status: ReviewStatus; issues: string[] }>`; `ReviewStatus = "passed" | "revised" | "failed" | "error"`. Do not change these — Task 5 of D and `claimBatchAndCreateUpdate` depend on them.
- **Vitest hooks must be block-bodied** (`() => { ... }`), never an expression arrow returning a value (Vitest treats a hook's return as a teardown callback and re-invokes it).
- Test command: `npm test` / `npm test -- review-draft`. Type-check: `npx tsc --noEmit`.

---

### Task 1: Critique/revise split + remediation loop in `review-draft.ts`

**Files:**
- Modify: `src/lib/review-draft.ts` (rewrite the schemas, prompts, calls, and `reviewAndReconcile`)
- Modify: `tests/lib/review-draft.test.ts` (rewrite for the loop)

**Interfaces:**
- Consumes: `UpdateDraft` from `./generation`; `brandProfiles` type.
- Produces (unchanged names where they already exist): `ReviewStatus`, `ReviewOutcome`, `reviewAndReconcile`, `buildReviewPrompt`, `reviewDraft`. New: `ReviewCritiqueSchema`/`ReviewCritique`, `RevisionSchema`/`Revision`, `buildRevisionPrompt`, `reviseDraft`. Removed: `ReviewResultSchema`/`ReviewResult` (folded into `ReviewCritique`).

- [ ] **Step 1: Confirm no external importer of the removed symbols**

Run: `grep -rn "ReviewResult\b\|ReviewResultSchema" src/ tests/`
Expected: matches ONLY in `src/lib/review-draft.ts` and `tests/lib/review-draft.test.ts` (both rewritten here). If any other file imports them, STOP — the plan assumed they were internal.

- [ ] **Step 2: Rewrite the test file (failing against the current module)**

Replace the entire contents of `tests/lib/review-draft.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));

import { generateObject } from "ai";
import { buildReviewPrompt, buildRevisionPrompt, reviewAndReconcile } from "../../src/lib/review-draft";

const draft = { title: "Big news!!!", body: "Buy now.", category: "new" as const };
const brand = { tone: "calm", readingLevel: "simple", doList: ["be factual"], dontList: ["hype"], examplePhrases: ["ship"], industry: null, userPersonas: [] };

function ok(object: unknown) { return { object } as never; }
const critique = (compliant: boolean, issues: string[] = []) => ok({ compliant, issues });
const revision = (title: string, body: string) => ok({ title, body });

describe("buildReviewPrompt", () => {
  it("includes the brand rules and the draft", () => {
    const prompt = buildReviewPrompt(draft, brand as never);
    expect(prompt).toContain("Tone: calm.");
    expect(prompt).toContain("Reading level: simple.");
    expect(prompt).toContain("Do: be factual.");
    expect(prompt).toContain("Avoid: hype.");
    expect(prompt).toContain("Preferred phrasing: ship.");
    expect(prompt).toContain("Big news!!!");
    expect(prompt).toContain("Buy now.");
  });
});

describe("buildRevisionPrompt", () => {
  it("includes the brand rules, the draft, and the specific issues to fix", () => {
    const prompt = buildRevisionPrompt(draft, ["too hypey", "no exclamation marks"], brand as never);
    expect(prompt).toContain("Tone: calm.");
    expect(prompt).toContain("Big news!!!");
    expect(prompt).toContain("- too hypey");
    expect(prompt).toContain("- no exclamation marks");
  });
});

describe("reviewAndReconcile", () => {
  beforeEach(() => {
    vi.mocked(generateObject).mockReset();
  });
  afterEach(() => {
    delete process.env.REVIEW_MAX_ROUNDS;
  });

  it("returns passed on a compliant first review, without revising", async () => {
    vi.mocked(generateObject).mockResolvedValue(critique(true));
    const out = await reviewAndReconcile(draft, brand as never);
    expect(out).toEqual({ finalDraft: draft, status: "passed", issues: [] });
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it("revises once and returns 'revised' when the fix becomes compliant", async () => {
    vi.mocked(generateObject)
      .mockResolvedValueOnce(critique(false, ["too hypey"]))    // review 1
      .mockResolvedValueOnce(revision("News", "We shipped X.")) // revise 1
      .mockResolvedValueOnce(critique(true));                   // review 2
    const out = await reviewAndReconcile(draft, brand as never);
    expect(out.status).toBe("revised");
    expect(out.finalDraft).toEqual({ title: "News", body: "We shipped X.", category: "new" });
    expect(out.issues).toEqual([]);
    expect(generateObject).toHaveBeenCalledTimes(3);
  });

  it("loops for a second round when the first fix is still non-compliant", async () => {
    vi.mocked(generateObject)
      .mockResolvedValueOnce(critique(false, ["hype"]))        // review 1
      .mockResolvedValueOnce(revision("R1", "b1"))             // revise 1
      .mockResolvedValueOnce(critique(false, ["still hype"]))  // review 2
      .mockResolvedValueOnce(revision("R2", "b2"))             // revise 2
      .mockResolvedValueOnce(critique(true));                  // review 3
    const out = await reviewAndReconcile(draft, brand as never);
    expect(out.status).toBe("revised");
    expect(out.finalDraft).toEqual({ title: "R2", body: "b2", category: "new" });
    expect(generateObject).toHaveBeenCalledTimes(5);
  });

  it("returns 'failed' with the last revision and last issues after exhausting maxRounds (default 2)", async () => {
    vi.mocked(generateObject)
      .mockResolvedValueOnce(critique(false, ["hype"]))   // review 1
      .mockResolvedValueOnce(revision("R1", "b1"))        // revise 1
      .mockResolvedValueOnce(critique(false, ["still"]))  // review 2
      .mockResolvedValueOnce(revision("R2", "b2"))        // revise 2
      .mockResolvedValueOnce(critique(false, ["nope"]));  // review 3
    const out = await reviewAndReconcile(draft, brand as never);
    expect(out.status).toBe("failed");
    expect(out.issues).toEqual(["nope"]);
    expect(out.finalDraft).toEqual({ title: "R2", body: "b2", category: "new" });
    expect(generateObject).toHaveBeenCalledTimes(5);
  });

  it("treats REVIEW_MAX_ROUNDS=0 as a pure gate: fails a non-compliant draft without revising", async () => {
    process.env.REVIEW_MAX_ROUNDS = "0";
    vi.mocked(generateObject).mockResolvedValue(critique(false, ["bad"]));
    const out = await reviewAndReconcile(draft, brand as never);
    expect(out).toEqual({ finalDraft: draft, status: "failed", issues: ["bad"] });
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it("respects REVIEW_MAX_ROUNDS=1: stops after one revision round", async () => {
    process.env.REVIEW_MAX_ROUNDS = "1";
    vi.mocked(generateObject)
      .mockResolvedValueOnce(critique(false, ["hype"]))   // review 1
      .mockResolvedValueOnce(revision("R1", "b1"))        // revise 1
      .mockResolvedValueOnce(critique(false, ["still"])); // review 2
    const out = await reviewAndReconcile(draft, brand as never);
    expect(out.status).toBe("failed");
    expect(out.finalDraft).toEqual({ title: "R1", body: "b1", category: "new" });
    expect(generateObject).toHaveBeenCalledTimes(3);
  });

  it("retries a failing review once, then holds the draft as 'error'", async () => {
    vi.mocked(generateObject).mockRejectedValue(new Error("review down"));
    const out = await reviewAndReconcile(draft, brand as never);
    expect(out).toEqual({ finalDraft: draft, status: "error", issues: [] });
    expect(generateObject).toHaveBeenCalledTimes(2);
  });

  it("holds as 'error' when a revision call keeps failing after its retry", async () => {
    vi.mocked(generateObject)
      .mockResolvedValueOnce(critique(false, ["hype"]))  // review 1
      .mockRejectedValueOnce(new Error("revise down"))   // revise attempt 1
      .mockRejectedValueOnce(new Error("revise down"));  // revise retry
    const out = await reviewAndReconcile(draft, brand as never);
    expect(out.status).toBe("error");
    expect(out.finalDraft).toEqual(draft);
    expect(generateObject).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- review-draft`
Expected: FAIL — `buildRevisionPrompt` is not exported yet, and the loop tests (2-round, MAX_ROUNDS overrides, revise-error) don't match the current single-rewrite implementation.

- [ ] **Step 4: Rewrite `review-draft.ts`**

Replace the entire contents of `src/lib/review-draft.ts` with:

```ts
import { generateObject } from "ai";
import { z } from "zod";
import type { brandProfiles } from "../db/schema";
import type { UpdateDraft } from "./generation";

type BrandProfileRow = typeof brandProfiles.$inferSelect;

export const ReviewCritiqueSchema = z.object({
  compliant: z.boolean(),
  issues: z.array(z.string()),
});
export type ReviewCritique = z.infer<typeof ReviewCritiqueSchema>;

export const RevisionSchema = z.object({
  title: z.string(),
  body: z.string(),
});
export type Revision = z.infer<typeof RevisionSchema>;

export type ReviewStatus = "passed" | "revised" | "failed" | "error";
export type ReviewOutcome = { finalDraft: UpdateDraft; status: ReviewStatus; issues: string[] };

const DEFAULT_MAX_ROUNDS = 2;

function reviewModel(): string {
  return process.env.REVIEW_MODEL ?? "anthropic/claude-sonnet-4-5";
}

// Default when unset; any non-positive/invalid value clamps to 0 (pure gate).
function reviewMaxRounds(): number {
  const raw = process.env.REVIEW_MAX_ROUNDS;
  if (raw === undefined) return DEFAULT_MAX_ROUNDS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// One retry on error; a second failure propagates to the caller.
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return await fn();
  }
}

const REVIEW_SYSTEM = [
  "You are a brand-compliance reviewer for product update announcements.",
  "Check the draft against the brand requirements.",
  "If it fully complies, set compliant true and issues [].",
  "If it violates any requirement, set compliant false and list the specific issues to fix.",
  "Do not rewrite the draft — only critique it.",
].join(" ");

const REVISION_SYSTEM = [
  "You are a product-update editor.",
  "Rewrite the draft to fix the listed brand-compliance issues while keeping the same facts.",
  "Return only the revised title and body.",
].join(" ");

function brandRubric(brandProfile: BrandProfileRow): string {
  const rules = [
    brandProfile.tone ? `Tone: ${brandProfile.tone}.` : null,
    brandProfile.readingLevel ? `Reading level: ${brandProfile.readingLevel}.` : null,
    brandProfile.doList.length > 0 ? `Do: ${brandProfile.doList.join("; ")}.` : null,
    brandProfile.dontList.length > 0 ? `Avoid: ${brandProfile.dontList.join("; ")}.` : null,
    brandProfile.examplePhrases.length > 0 ? `Preferred phrasing: ${brandProfile.examplePhrases.join("; ")}.` : null,
  ].filter((line): line is string => Boolean(line));

  return rules.length > 0 ? rules.join(" ") : "No specific brand requirements are configured.";
}

export function buildReviewPrompt(draft: UpdateDraft, brandProfile: BrandProfileRow): string {
  return `Brand requirements:\n${brandRubric(brandProfile)}\n\nDraft to review:\nTitle: ${draft.title}\nBody:\n${draft.body}`;
}

export function buildRevisionPrompt(draft: UpdateDraft, issues: string[], brandProfile: BrandProfileRow): string {
  const list = issues.map((issue) => `- ${issue}`).join("\n");
  return `Brand requirements:\n${brandRubric(brandProfile)}\n\nDraft to revise:\nTitle: ${draft.title}\nBody:\n${draft.body}\n\nFix these issues:\n${list}`;
}

export async function reviewDraft(draft: UpdateDraft, brandProfile: BrandProfileRow): Promise<ReviewCritique> {
  const result = await generateObject({
    model: reviewModel(),
    schema: ReviewCritiqueSchema,
    system: REVIEW_SYSTEM,
    prompt: buildReviewPrompt(draft, brandProfile),
  });
  return result.object;
}

export async function reviseDraft(
  draft: UpdateDraft,
  issues: string[],
  brandProfile: BrandProfileRow
): Promise<UpdateDraft> {
  const result = await generateObject({
    model: reviewModel(),
    schema: RevisionSchema,
    system: REVISION_SYSTEM,
    prompt: buildRevisionPrompt(draft, issues, brandProfile),
  });
  return { title: result.object.title, body: result.object.body, category: draft.category };
}

/**
 * Feedback-remediation loop. Critiques the draft; if non-compliant, revises it
 * from the specific issues and re-reviews, iterating up to REVIEW_MAX_ROUNDS
 * (default 2). Outcomes: passed (compliant first review), revised (compliant
 * after ≥1 round), failed (still non-compliant at the cap — holds the last
 * revision + last issues), error (a review/revise call failed after its retry —
 * holds the most recent draft, fail-safe). Every call is retried once on error.
 */
export async function reviewAndReconcile(draft: UpdateDraft, brandProfile: BrandProfileRow): Promise<ReviewOutcome> {
  const rounds = reviewMaxRounds();
  let current = draft;

  try {
    let critique = await withRetry(() => reviewDraft(current, brandProfile));
    if (critique.compliant) return { finalDraft: current, status: "passed", issues: [] };

    for (let round = 0; round < rounds; round++) {
      current = await withRetry(() => reviseDraft(current, critique.issues, brandProfile));
      critique = await withRetry(() => reviewDraft(current, brandProfile));
      if (critique.compliant) return { finalDraft: current, status: "revised", issues: [] };
    }

    return { finalDraft: current, status: "failed", issues: critique.issues };
  } catch {
    // A review/revise call failed after its retry — hold the most recent draft.
    return { finalDraft: current, status: "error", issues: [] };
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- review-draft`
Expected: PASS (all 10 tests — two prompt tests + eight `reviewAndReconcile` cases).

- [ ] **Step 6: Confirm downstream is untouched — full suite + type-check**

Run: `npm test`
Expected: all PASS. The D auto-publish/run-schedule tests stub `reviewAndReconcile` entirely (they don't exercise the internals), and no other file imported the removed `ReviewResult`.

Run: `npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/review-draft.ts tests/lib/review-draft.test.ts
git commit -m "feat: run a feedback-remediation loop in the review pass"
```

---

## Self-Review

**Spec coverage:**
- §1 split reviewer/reviser (`ReviewCritiqueSchema`, `RevisionSchema`, critique-only `reviewDraft`, `buildRevisionPrompt`, `reviseDraft` preserving category) → Task 1 Step 4. ✓
- §2 loop (`reviewAndReconcile` iterating review→revise→review up to `REVIEW_MAX_ROUNDS`, default 2, clamp-to-0, retry-each-call, fail-safe error holding most recent draft, `failed` holds last revision) → Task 1 Step 4. ✓
- §3 statuses unchanged (`passed`/`revised`/`failed`/`error`) → type kept verbatim. ✓
- §4 testing (both prompt builders; passed; 1-round revised; 2-round revised; failed-at-cap with last revision+issues; MAX_ROUNDS=0 pure gate; MAX_ROUNDS=1; review-error; revise-error) → Task 1 Step 2. ✓
- Scope boundaries: signature/`ReviewOutcome` unchanged (Step 1 verifies no external importer of removed symbols; Step 6 runs the full suite + tsc to prove downstream is intact); no new columns/UI; generation untouched. ✓

**Placeholder scan:** No TBD/TODO/"handle appropriately". The module and test are complete literal replacements. ✓

**Type consistency:** `reviewDraft` now returns `ReviewCritique` (was `ReviewResult`); its only caller is `reviewAndReconcile` in the same file. `reviseDraft` returns `UpdateDraft` (category preserved), consumed as `current` in the loop. `ReviewStatus`/`ReviewOutcome` are byte-identical to the pre-D.1 definitions, so `claimBatchAndCreateUpdate`'s `review?: { status: ReviewStatus; issues }` param and the run-schedule wiring still type-check. Vitest hooks are block-bodied. ✓

**Single-task justification:** The critique/revise split and the loop are one indivisible change — the old `reviewAndReconcile` references `ReviewResult.revised`, which ceases to exist, so there is no working intermediate state to split across two tasks.
