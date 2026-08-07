# Drafting From a Brief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the accept-time scaffold with a real AI-written draft, shaped by the brief's content type, without ever letting a generation failure cost the human their decision.

**Architecture:** Accepting a brief leaves the content piece at status `"brief"` (approved, not yet drafted). Next.js `after()` runs generation past the response and moves it to `"draft"`. A failure leaves it at `"brief"` with a recorded reason and a Generate button, so retry and deferred generation are the same code path. The system prompt gains a content-type parameter; its grounding and company-naming rules stay universal, and a post-generation scan against the `competitors` table warns if a name leaks through.

**Tech Stack:** Next.js 16 App Router (`after` from `next/server`), AI SDK v7 + `@ai-sdk/anthropic`, Drizzle ORM 0.45.2, Postgres, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-06-brief-drafting-design.md`

## Global Constraints

- **This is NOT the Next.js you know.** Read the relevant guide in `node_modules/next/dist/docs/` before writing App Router code. `after` is documented at `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md`.
- **`npm run build` is a mandatory gate, ahead of the test suite.** It previously caught a `"use server"` export-rule break that 1216 passing tests, a clean `tsc` and a clean eslint all missed. Whole classes of defect are invisible to every other gate.
- **The tests are the contract. If prose and a code sample in this plan disagree, STOP and report it.** Four implementers on the previous plan did exactly this and were right every time — the plan was wrong, not them.
- **A comment that promises behaviour the code does not implement is a bug.**
- **Never hardcode a value a constant already expresses.** Derive test fixtures from exported constants.
- **When you add a test to guard a behaviour, delete the guard and confirm the test fails.**
- **After any schema change run BOTH `npm run db:migrate:test` and `npm run db:migrate`.**
- **Never call the real Anthropic API from a test.** Every generation test injects a fake. A test that reaches the network is a defect regardless of whether it passes.
- `briefs` has TWO NOT NULL timestamp columns with no default — `lastEvidenceAt` and `expiresAt`. Set both in any fixture or you get an opaque `23502`.
- Tests run against a database whose name ends in `_test`; `npm run test` enforces this.
- The suite is FLAKY (~160 files, one shared Postgres). If a file you did not touch fails, do NOT conclude "pre-existing" from a stash test alone — stashing clears only YOUR changes, not an earlier commit on this branch.
- Commit after each task. Do NOT push. Do NOT merge.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/db/schema.ts` | `generationError`, `generatedAt` on `contentPieces` | 1 |
| `src/app/(dashboard)/briefs/actions.ts` | accept sets `"brief"`; later, the `after()` call | 1, 5 |
| `src/lib/ai/compose-prompt.ts` | `contentType` param, `composeBriefPrompt`, `serializeBriefEvidence` | 2 |
| `src/lib/ai/generation.ts` | `generateBriefDraft` | 3 |
| `src/lib/ai/generation-context.ts` | parameterised content type | 3 |
| `src/lib/ai/llm-usage.ts` | `"brief_draft"` | 3 |
| `src/lib/briefs/draft.ts` | generation orchestration + the naming check | 4 |
| `src/app/(dashboard)/briefs/actions.ts` + `drafts` UI | `after()`, Generate action, rendering | 5, 6 |

---

### Task 1: Generation state, and the status 5b got wrong

**Files:**
- Modify: `src/db/schema.ts` (the `contentPieces` table)
- Create: `src/db/migrations/<generated>.sql`
- Modify: `src/app/(dashboard)/briefs/actions.ts`
- Modify: `tests/app/briefs-actions.test.ts`

**Interfaces:**
- Produces: `contentPieces.generationError: text | null`, `contentPieces.generatedAt: timestamptz | null`; `acceptBrief` now creates the piece at status `"brief"`.

**Why the status changes:** `contentPieceStatusEnum` already contains `"brief"`, and `schema.ts:571` defines it as *approved-but-not-yet-drafted, so a lead can approve several briefs at once and generate drafts across the week*. 5b set `"draft"`, which contradicts that. Generation (Task 4) moves `brief → draft`.

- [ ] **Step 1: Write the failing tests**

In `tests/app/briefs-actions.test.ts`, the existing test "creates one content piece and links it both ways" asserts `pieces[0].status` — update that assertion to `"brief"` rather than adding a second test. Then add:

```typescript
  it("leaves generation state empty on a freshly accepted brief", async () => {
    const tenant = await seedTenant();
    const brief = await seedBrief(tenant.id);

    const result = await acceptBrief(brief.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [piece] = await db
      .select()
      .from(contentPieces)
      .where(eq(contentPieces.id, result.contentPieceId));
    // "brief" means approved, not yet drafted. A null generatedAt is what
    // distinguishes the scaffold from a model-written body.
    expect(piece.status).toBe("brief");
    expect(piece.generatedAt).toBeNull();
    expect(piece.generationError).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run tests/app/briefs-actions.test.ts
```

Expected: FAIL — `generationError` is not a column, and status is `"draft"`.

- [ ] **Step 3: Add the columns**

In `src/db/schema.ts`, inside the `contentPieces` table beside `reviewStatus`:

```typescript
  // Why the last generation attempt did not produce a usable draft. Carries two
  // distinct meanings, and the status disambiguates them:
  //   status "brief" + set  -> generation failed; the scaffold body is intact
  //                            and the Generate button offers a retry.
  //   status "draft" + set  -> the draft is real, but the post-generation name
  //                            scan matched something the copy should not name.
  // Null on a clean generated draft. A third meaning would need its own column
  // rather than a third overload of this one.
  generationError: text("generation_error"),
  // When a model last wrote this body. Null means the body is still the
  // deterministic scaffold written at accept time. Distinct from
  // `bodyEditedAt`, which records a HUMAN edit and freezes regeneration.
  generatedAt: timestamp("generated_at", { withTimezone: true }),
```

- [ ] **Step 4: Change the status in `acceptBrief`**

In `src/app/(dashboard)/briefs/actions.ts`, in the `contentPieces` insert, replace `status: "draft"` with:

```typescript
          // "brief" = approved, draft not yet generated (schema.ts's own
          // definition). Generation moves it to "draft"; until then the body is
          // the scaffold. Do NOT set "draft" here — that would present an
          // ungenerated scaffold as a finished draft.
          status: "brief",
```

- [ ] **Step 5: Generate and apply the migration**

```bash
npm run db:generate
npm run db:migrate:test && npm run db:migrate
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run tests/app/briefs-actions.test.ts
npm run typecheck
npm run build
```

Expected: PASS; typecheck and build clean.

- [ ] **Step 7: Prove the status guard bites**

Change `status: "brief"` back to `"draft"`. The new test must FAIL on the status assertion. Restore and re-run.

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts src/db/migrations "src/app/(dashboard)/briefs/actions.ts" tests/app/briefs-actions.test.ts
git commit -m "feat: accept leaves a piece at status brief, with generation state"
```

---

### Task 2: A content-type-aware system prompt, and a brief prompt

**Files:**
- Modify: `src/lib/ai/compose-prompt.ts`
- Test: `tests/lib/ai/compose-prompt.test.ts` (existing file — add to it; if it does not exist, create it)

**Interfaces:**
- Produces:
```typescript
export function buildSystemPrompt(
  brandProfile: BrandProfileRow,
  personas: ResolvedPersona[],
  examples: ExampleRow[],
  contentType?: "product_update" | "blog_post" | "social_post"   // default "product_update"
): string

export type BriefForPrompt = {
  title: string; angle: string; whyNow: string; keyPoints: string[];
  contentType: "product_update" | "blog_post" | "social_post";
  targetLength: number | null;
};
export type BriefEvidenceForPrompt = { title: string; kind: string; excerpt: string | null };
export function serializeBriefEvidence(items: BriefEvidenceForPrompt[], maxChars?: number): string
export function composeBriefPrompt(args: {
  brief: BriefForPrompt;
  evidence: BriefEvidenceForPrompt[];
  brandProfile: BrandProfileRow;
  personas: ResolvedPersona[];
  examples: ExampleRow[];
}): { system: string; prompt: string }
```

**Critical:** `buildSystemPrompt` has FIVE existing callers in this file (lines 127, 147, 182, 207, 233), all passing three positional arguments. The new parameter is optional and defaults to `"product_update"` so every one of them is unaffected — and Step 1 proves it.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from "vitest";
import {
  buildSystemPrompt,
  composeBriefPrompt,
  serializeBriefEvidence,
} from "../../../src/lib/ai/compose-prompt";

const PROFILE = {
  tenantId: "t1",
  industry: "Design tooling",
  guidelines: null,
  userPersonas: [],
} as unknown as Parameters<typeof buildSystemPrompt>[0];

describe("buildSystemPrompt content types", () => {
  it("is byte-identical to the three-argument form when the type is omitted", () => {
    // The three existing product-update paths (release, merge, edit, extract)
    // call this with three arguments. If this ever differs, those prompts
    // changed silently and their output changed with them.
    expect(buildSystemPrompt(PROFILE, [], [])).toBe(buildSystemPrompt(PROFILE, [], [], "product_update"));
  });

  it("gives each content type its own role line", () => {
    const update = buildSystemPrompt(PROFILE, [], [], "product_update");
    const blog = buildSystemPrompt(PROFILE, [], [], "blog_post");
    const social = buildSystemPrompt(PROFILE, [], [], "social_post");

    expect(update).toContain("product update announcements");
    expect(blog).not.toContain("product update announcements");
    expect(social).not.toContain("product update announcements");
    expect(blog).not.toBe(social);
  });

  it("keeps the grounding, link and naming rules on EVERY content type", () => {
    for (const type of ["product_update", "blog_post", "social_post"] as const) {
      const system = buildSystemPrompt(PROFILE, [], [], type);
      // These three are universal by decision. The naming rule in particular was
      // chosen deliberately over relaxing it for non-product types.
      expect(system).toContain("never invent");
      expect(system).toContain("[add link]");
      expect(system).toMatch(/never name, compare to, or reference/i);
    }
  });
});

describe("composeBriefPrompt", () => {
  const BRIEF = {
    title: "Why localization breaks design systems",
    angle: "Teams discover it too late",
    whyNow: "Two vendors shipped multilingual tooling this month",
    keyPoints: ["Point one", "Point two"],
    contentType: "blog_post" as const,
    targetLength: 800,
  };

  it("separates the commission from the evidence", () => {
    const { prompt } = composeBriefPrompt({
      brief: BRIEF,
      evidence: [{ title: "Phrase ships X", kind: "market_news", excerpt: "Body text." }],
      brandProfile: PROFILE,
      personas: [],
      examples: [],
    });

    // The angle and key points are INSTRUCTIONS to follow; the signals are
    // source material to ground against. Merging them makes the model treat the
    // commission as just more evidence.
    expect(prompt).toContain("Teams discover it too late");
    expect(prompt).toContain("Point one");
    expect(prompt).toContain("Phrase ships X");
    expect(prompt.indexOf("Teams discover it too late")).toBeLessThan(prompt.indexOf("Phrase ships X"));
  });

  it("tells the model that names in the evidence must not be reproduced", () => {
    const { prompt, system } = composeBriefPrompt({
      brief: BRIEF,
      evidence: [{ title: "Phrase ships X", kind: "market_news", excerpt: null }],
      brandProfile: PROFILE,
      personas: [],
      examples: [],
    });
    // The evidence necessarily contains company names. Without this the naming
    // rule reads as contradicted by the material it is given.
    expect(`${system}\n${prompt}`).toMatch(/do not (repeat|reproduce|name)/i);
  });

  it("uses the brief's own content type for the system prompt", () => {
    const { system } = composeBriefPrompt({
      brief: { ...BRIEF, contentType: "social_post" },
      evidence: [],
      brandProfile: PROFILE,
      personas: [],
      examples: [],
    });
    expect(system).toBe(buildSystemPrompt(PROFILE, [], [], "social_post"));
  });
});

describe("serializeBriefEvidence", () => {
  it("drops trailing items past the cap with a note rather than truncating mid-item", () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      title: `Signal ${i}`,
      kind: "market_news",
      excerpt: "x".repeat(200),
    }));
    const out = serializeBriefEvidence(items, 1_000);
    expect(out.length).toBeLessThan(1_500);
    expect(out).toMatch(/more signals not shown/);
    expect(out).toContain("Signal 0");
  });

  it("handles an item with no excerpt", () => {
    expect(() => serializeBriefEvidence([{ title: "T", kind: "shipped_work", excerpt: null }])).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run tests/lib/ai/compose-prompt.test.ts
```

Expected: FAIL — `composeBriefPrompt` is not exported.

- [ ] **Step 3: Add the content-type parameter**

In `buildSystemPrompt`, replace the hardcoded first line with a per-type role line, leaving every other line exactly as it is:

```typescript
const ROLE_LINES: Record<ContentType, string> = {
  product_update: "You write concise, user-facing product update announcements.",
  blog_post: "You write industry blog posts for this company's audience — substantive, specific, and useful to a practitioner.",
  social_post: "You write a single short social post: one idea, no headings, no preamble.",
};

const FORMAT_GUIDANCE: Record<ContentType, string> = {
  product_update: SIZE_GUIDANCE,
  blog_post: "Format the body as Markdown with section headings. Aim for the target length if one is given.",
  social_post: "Plain text, no Markdown headings, no bullet lists. A few sentences at most.",
};
```

`buildSystemPrompt` takes `contentType: ContentType = "product_update"` as its fourth parameter and uses `ROLE_LINES[contentType]` in place of the literal first line. **Nothing else in the function changes** — the grounding rule, the link rule, the naming rule, industry, personas, guidelines and examples all stay exactly where they are and unconditional.

- [ ] **Step 4: Add the brief serializer and composer**

```typescript
export type BriefEvidenceForPrompt = { title: string; kind: string; excerpt: string | null };

/**
 * Renders the signals a brief cited. The analogue of `serializeAtomicUpdates`,
 * which serializes atomic updates and is the wrong shape for this input.
 * Trailing items past `maxChars` are dropped whole with a note, never cut
 * mid-item.
 */
export function serializeBriefEvidence(
  items: BriefEvidenceForPrompt[],
  maxChars = DEFAULT_MAX_PROMPT_CHARS
): string {
  const lines = items.map(
    (item, i) => `${i + 1}. [${item.kind}] "${item.title}"${item.excerpt ? ` — ${item.excerpt}` : ""}`
  );
  const full = lines.join("\n");
  if (full.length <= maxChars) return full;

  const kept: string[] = [];
  for (const line of lines) {
    if ([...kept, line].join("\n").length > maxChars && kept.length > 0) break;
    kept.push(line);
    if (kept.join("\n").length > maxChars) break;
  }
  const dropped = lines.length - kept.length;
  return dropped > 0 ? `${kept.join("\n")}\n…and ${dropped} more signals not shown.` : kept.join("\n");
}

export function composeBriefPrompt(args: {
  brief: BriefForPrompt;
  evidence: BriefEvidenceForPrompt[];
  brandProfile: BrandProfileRow;
  personas: ResolvedPersona[];
  examples: ExampleRow[];
}): { system: string; prompt: string } {
  const { brief } = args;
  const commission = [
    `Write this piece. Title: "${brief.title}".`,
    `Angle: ${brief.angle}`,
    `Why now: ${brief.whyNow}`,
    brief.keyPoints.length > 0
      ? `Cover these points, in order:\n${brief.keyPoints.map((p, i) => `${i + 1}. ${p}`).join("\n")}`
      : null,
    brief.targetLength ? `Target length: about ${brief.targetLength} words.` : null,
    FORMAT_GUIDANCE[brief.contentType],
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");

  // The evidence is source material, NOT part of the commission — the two are
  // fenced apart because the model otherwise treats the angle as one more
  // signal. The naming reminder sits here rather than only in the system
  // prompt because this is where the company names actually appear.
  const evidence =
    args.evidence.length > 0
      ? `\n\nSource material — ground every factual claim in it. It names companies and publications: use what they describe, but do not repeat any company name in your copy.\n<sources>\n${serializeBriefEvidence(args.evidence)}\n</sources>`
      : "\n\nNo source material was attached. Write only what the commission above supports.";

  return {
    system: buildSystemPrompt(args.brandProfile, args.personas, args.examples, brief.contentType),
    prompt: `${commission}${evidence}`,
  };
}
```

`ContentType` and `BriefForPrompt` must be declared in this file; derive `ContentType` from the schema enum's members rather than retyping the three strings.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run tests/lib/ai/compose-prompt.test.ts
npm run typecheck
```

- [ ] **Step 6: Prove two guards bite**

1. Make the naming rule conditional on `contentType === "product_update"`. The "keeps the grounding, link and naming rules on EVERY content type" test must FAIL.
2. Change the default of the fourth parameter to `"blog_post"`. The byte-identical test must FAIL.

Restore both and re-run.

- [ ] **Step 7: Commit**

```bash
git add src/lib/ai/compose-prompt.ts tests/lib/ai/compose-prompt.test.ts
git commit -m "feat: content-type-aware system prompt and a brief prompt composer"
```

---

### Task 3: The model call

**Files:**
- Modify: `src/lib/ai/generation.ts`, `src/lib/ai/generation-context.ts`, `src/lib/ai/llm-usage.ts`
- Test: `tests/lib/ai/generation-brief.test.ts`

**Interfaces:**
- Consumes: `composeBriefPrompt`, `BriefForPrompt`, `BriefEvidenceForPrompt` (Task 2).
- Produces:
```typescript
export async function generateBriefDraft(args: {
  brief: BriefForPrompt;
  evidence: BriefEvidenceForPrompt[];
  brandProfile: BrandProfileRow;
  personas?: ResolvedPersona[];
  examples?: ExampleRow[];
}): Promise<UpdateDraft>                      // UpdateDraft = { title: string; body: string }

// generation-context.ts
export async function prepareGenerationContext(
  tenantId: string,
  database?: Database,
  categories?: string[],
  contentType?: "product_update" | "blog_post" | "social_post"   // default "product_update"
): Promise<{ brandProfile; personas; examples }>
```

- [ ] **Step 1: Add the operation to the closed union**

`src/lib/ai/llm-usage.ts` exports `LlmOperation` as a **closed** string-literal union of 12 members while the database column is free text — so an omission fails at `tsc`, never at runtime. Add `| "brief_draft"` to it.

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/lib/ai/llm-usage", () => ({ recordLlmUsage: vi.fn(async () => {}) }));

const generateObject = vi.fn(async () => ({
  object: { title: "Written title", body: "Written body." },
  usage: { inputTokens: 10, outputTokens: 20 },
}));
vi.mock("ai", () => ({ generateObject: (...a: unknown[]) => generateObject(...a) }));

import { generateBriefDraft } from "../../../src/lib/ai/generation";
import { recordLlmUsage } from "../../../src/lib/ai/llm-usage";

const PROFILE = { tenantId: "t1", industry: null, guidelines: null, userPersonas: [] } as never;
const BRIEF = {
  title: "T", angle: "A", whyNow: "W", keyPoints: ["One"],
  contentType: "blog_post" as const, targetLength: null,
};

describe("generateBriefDraft", () => {
  it("returns the model's title and body", async () => {
    const draft = await generateBriefDraft({ brief: BRIEF, evidence: [], brandProfile: PROFILE });
    expect(draft).toEqual({ title: "Written title", body: "Written body." });
  });

  it("records usage under the brief_draft operation", async () => {
    await generateBriefDraft({ brief: BRIEF, evidence: [], brandProfile: PROFILE });
    // The DB column is free text, so a wrong value here is invisible at runtime
    // and only ever shows up as mis-attributed cost.
    expect(vi.mocked(recordLlmUsage).mock.calls.at(-1)?.[0]).toMatchObject({
      tenantId: "t1",
      operation: "brief_draft",
    });
  });

  it("sends the brief's content type through to the system prompt", async () => {
    await generateBriefDraft({
      brief: { ...BRIEF, contentType: "social_post" },
      evidence: [],
      brandProfile: PROFILE,
    });
    const call = generateObject.mock.calls.at(-1)?.[0] as { system: string };
    expect(call.system).toContain("short social post");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx vitest run tests/lib/ai/generation-brief.test.ts
```

Expected: FAIL — `generateBriefDraft` is not exported.

- [ ] **Step 4: Implement**

In `src/lib/ai/generation.ts`, mirroring `generateReleaseDraft` exactly — same model resolution, same schema, same usage recording, only the composer differs:

```typescript
export async function generateBriefDraft(args: {
  brief: BriefForPrompt;
  evidence: BriefEvidenceForPrompt[];
  brandProfile: BrandProfileRow;
  personas?: ResolvedPersona[];
  examples?: ExampleRow[];
}): Promise<UpdateDraft> {
  const { system, prompt } = composeBriefPrompt({
    brief: args.brief,
    evidence: args.evidence,
    brandProfile: args.brandProfile,
    personas: args.personas ?? [],
    examples: args.examples ?? [],
  });

  const spec = process.env.GENERATION_MODEL ?? "anthropic/claude-sonnet-4-5";
  const result = await generateObject({ model: resolveModel(spec), schema: UpdateDraftSchema, system, prompt });

  await recordLlmUsage({
    tenantId: args.brandProfile.tenantId,
    operation: "brief_draft",
    model: modelId(spec),
    usage: result.usage,
  });

  return result.object;
}
```

In `src/lib/ai/generation-context.ts`, add a fourth parameter and use it where `"product_update"` is currently hardcoded (line 35):

```typescript
  contentType: ContentType = "product_update"
```
```typescript
    contentType,
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run tests/lib/ai/generation-brief.test.ts
npm run typecheck
```

- [ ] **Step 6: Prove the operation guard bites**

Change `operation: "brief_draft"` to `"generation"`. The usage test must FAIL. Restore.

- [ ] **Step 7: Commit**

```bash
git add src/lib/ai tests/lib/ai/generation-brief.test.ts
git commit -m "feat: generateBriefDraft, and a content type on the generation context"
```

---

### Task 4: Generation orchestration and the naming check

**Files:**
- Create: `src/lib/briefs/draft.ts`
- Test: `tests/lib/briefs/draft.test.ts`

**Interfaces:**
- Consumes: `generateBriefDraft` (Task 3); `contentPieces.generationError` / `generatedAt` (Task 1).
- Produces:
```typescript
export type DraftGenerator = (args: {
  brief: BriefForPrompt; evidence: BriefEvidenceForPrompt[]; brandProfile: BrandProfileRow;
  personas?: ResolvedPersona[]; examples?: ExampleRow[];
}) => Promise<{ title: string; body: string }>;

export const MIN_COMPETITOR_NAME_LENGTH = 3;
export function findNamedCompanies(text: string, names: string[]): string[];
export async function generateDraftForPiece(
  contentPieceId: string,
  tenantId: string,
  deps?: { database?: typeof defaultDb; generate?: DraftGenerator }
): Promise<{ ok: true } | { ok: false; error: string }>;
```

**This is a plain module, not a server action** — `after()` and the Generate button both call it, and it must be testable without mocking Next internals.

**Verified for you:** `competitors` requires only `tenantId` and `name` (both NOT NULL, no default); `companyProfiles` requires only `tenantId`; `contentPieces` requires `tenantId`, `title` and `body`. `bodyEditedAt` is `schema.ts:590`, nullable. The fixtures below set exactly what is required.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, contentPieces, competitors, companyProfiles } from "../../../src/db/schema";
import { generateDraftForPiece, findNamedCompanies, MIN_COMPETITOR_NAME_LENGTH } from "../../../src/lib/briefs/draft";

const TENANT = "Brief Draft Test Tenant";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
  vi.restoreAllMocks();
});

async function seedTenant() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  await db.insert(companyProfiles).values({ tenantId: tenant.id, topics: [] });
  return tenant;
}

async function seedPiece(tenantId: string, overrides: Partial<typeof contentPieces.$inferInsert> = {}) {
  const [piece] = await db
    .insert(contentPieces)
    .values({
      tenantId,
      type: "blog_post",
      title: "Scaffold title",
      body: "SCAFFOLD BODY",
      status: "brief",
      ...overrides,
    })
    .returning();
  return piece;
}

describe("findNamedCompanies", () => {
  it("matches case-insensitively on a word boundary", () => {
    expect(findNamedCompanies("We admire Phrase a lot.", ["phrase"])).toEqual(["phrase"]);
    expect(findNamedCompanies("A PHRASE-based tool.", ["Phrase"])).toHaveLength(1);
  });

  it("does not match a name inside another word", () => {
    // The reason this function exists rather than a bare `includes`.
    expect(findNamedCompanies("A quilted jacket.", ["Lilt"])).toEqual([]);
    expect(findNamedCompanies("Deposit the cheque.", ["Posit"])).toEqual([]);
  });

  it("skips names too short to match safely", () => {
    const short = "a".repeat(MIN_COMPETITOR_NAME_LENGTH - 1);
    expect(findNamedCompanies(`${short} word here`, [short])).toEqual([]);
  });
});

describe("generateDraftForPiece", () => {
  it("writes the generated draft and promotes the piece to draft", async () => {
    const tenant = await seedTenant();
    const piece = await seedPiece(tenant.id);
    const generate = vi.fn(async () => ({ title: "Real title", body: "Real body." }));

    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(true);

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("draft");
    expect(after.body).toBe("Real body.");
    expect(after.generatedAt).toBeInstanceOf(Date);
    expect(after.generationError).toBeNull();
  });

  it("keeps the scaffold and records the reason when generation throws", async () => {
    const tenant = await seedTenant();
    const piece = await seedPiece(tenant.id);
    const generate = vi.fn(async () => {
      throw new Error("model timeout");
    });

    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(false);

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    // The human's decision must survive. Status stays "brief" so the Generate
    // button offers a retry, and the scaffold is still there to read.
    expect(after.status).toBe("brief");
    expect(after.body).toBe("SCAFFOLD BODY");
    expect(after.generationError).toContain("model timeout");
    expect(after.generatedAt).toBeNull();
  });

  it("warns but keeps the draft when a competitor name survives into the copy", async () => {
    const tenant = await seedTenant();
    await db.insert(competitors).values({ tenantId: tenant.id, name: "Phrase" });
    const piece = await seedPiece(tenant.id);
    const generate = vi.fn(async () => ({ title: "T", body: "As Phrase showed last week…" }));

    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(true);

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    // Detection, not blocking. Discarding a good draft on a false positive
    // would be worse than the leak it guards against.
    expect(after.status).toBe("draft");
    expect(after.body).toContain("Phrase");
    expect(after.generationError).toContain("Phrase");
  });

  it("refuses to overwrite a body a human has edited", async () => {
    const tenant = await seedTenant();
    const piece = await seedPiece(tenant.id, { bodyEditedAt: new Date(), body: "HUMAN WORDS" });
    const generate = vi.fn(async () => ({ title: "T", body: "Machine words." }));

    const result = await generateDraftForPiece(piece.id, tenant.id, { database: db, generate });
    expect(result.ok).toBe(false);
    expect(generate).not.toHaveBeenCalled();

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.body).toBe("HUMAN WORDS");
  });

  it("refuses a piece belonging to another tenant", async () => {
    const mine = await seedTenant();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const theirs = await seedPiece(other.id);
    const generate = vi.fn(async () => ({ title: "T", body: "B" }));

    const result = await generateDraftForPiece(theirs.id, mine.id, { database: db, generate });
    expect(result.ok).toBe(false);
    expect(generate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run tests/lib/briefs/draft.test.ts
```

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

`src/lib/briefs/draft.ts` must:

1. Load the piece scoped to `tenantId`; return `{ ok: false }` if absent.
2. Return `{ ok: false, error: "This draft has been edited by hand." }` if `bodyEditedAt` is set, **without calling the generator**.
3. Load the brief linked to this piece (`briefs.contentPieceId = piece.id`, tenant-scoped) and its cited signals via `brief_signals` for the evidence.
4. Build the generation context with the piece's own `type`.
5. Call the generator inside `try`/`catch`. On a throw: set `generationError` to the message, leave `status`, `body` and `generatedAt` untouched, return `{ ok: false }`.
6. On success: write `title`, `body`, `status: "draft"`, `generatedAt: new Date()`.
7. Then run the naming check over `title + body` against `listCompetitors(tenantId)` names, and set `generationError` to a warning naming what matched, or null if nothing did.

`findNamedCompanies` escapes each name for regex use and matches with `\b` boundaries, case-insensitively, skipping names shorter than `MIN_COMPETITOR_NAME_LENGTH` (3).

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run tests/lib/briefs/draft.test.ts
npm run typecheck
```

- [ ] **Step 5: Prove three guards bite**

1. Remove the `bodyEditedAt` check — "refuses to overwrite a body a human has edited" must FAIL.
2. Remove the tenant predicate — "refuses a piece belonging to another tenant" must FAIL.
3. Replace the `\b` regex with `text.toLowerCase().includes(name.toLowerCase())` — "does not match a name inside another word" must FAIL.

Restore each and re-run.

- [ ] **Step 6: Commit**

```bash
git add src/lib/briefs/draft.ts tests/lib/briefs/draft.test.ts
git commit -m "feat: generate a draft for an accepted brief, and check for named companies"
```

---

### Task 5: Trigger generation

**Files:**
- Modify: `src/app/(dashboard)/briefs/actions.ts`
- Test: `tests/app/briefs-actions.test.ts`

**Interfaces:**
- Consumes: `generateDraftForPiece` (Task 4).
- Produces: `export async function generateDraft(contentPieceId: string): Promise<{ ok: true } | { ok: false; error: string }>` — the Generate button's action.

- [ ] **Step 1: Wire `after()` into `acceptBrief`**

Import `after` from `next/server`. After the accept transaction succeeds and before returning, schedule generation:

```typescript
  // Runs once the response is finished, so accept stays instant and a
  // generation failure can never cost the human their decision.
  //
  // Request APIs (cookies, headers) are NOT available inside `after` — see
  // node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md.
  // tenantId and contentPieceId are read above and closed over deliberately.
  after(async () => {
    await generateDraftForPiece(contentPieceId, tenantId);
  });
```

`generateDraftForPiece` never throws — it returns a result — so nothing here needs a catch. Verify that claim against Task 4's implementation before relying on it; if it can throw, wrap it and say so in your report.

- [ ] **Step 2: Add the Generate action**

```typescript
export async function generateDraft(contentPieceId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireSession();
  const result = await generateDraftForPiece(contentPieceId, session.user.tenantId);
  revalidatePath("/drafts");
  revalidatePath(`/drafts/${contentPieceId}`);
  return result;
}
```

Tenant scoping lives inside `generateDraftForPiece`, which re-reads the piece — the id here is user-supplied.

- [ ] **Step 3: Write the test**

`after` must be mocked, or the callback never runs under Vitest. Add to the existing `vi.mock` block set in `tests/app/briefs-actions.test.ts`:

```typescript
// Runs the callback immediately so the test can observe its effect. The real
// `after` defers until the response is finished, which never happens here.
vi.mock("next/server", () => ({ after: (fn: () => unknown) => fn() }));
```

```typescript
  it("schedules generation without letting it block or fail the accept", async () => {
    const tenant = await seedTenant();
    const brief = await seedBrief(tenant.id);

    const result = await acceptBrief(brief.id);

    // Accept succeeds regardless of what generation does — that is the whole
    // point of deferring it.
    expect(result.ok).toBe(true);
    const [after] = await db.select().from(briefs).where(eq(briefs.id, brief.id));
    expect(after.status).toBe("accepted");
  });
```

- [ ] **Step 4: Verify**

```bash
npx vitest run tests/app/briefs-actions.test.ts
npm run typecheck
npm run build
```

The build is the gate that matters here: `actions.ts` is `"use server"` and **may only export async functions**. `generateDraft` is async; do not add any synchronous export to this file.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/briefs/actions.ts" tests/app/briefs-actions.test.ts
git commit -m "feat: generate a draft after accept, and on demand"
```

---

### Task 6: Surface the brief state

**Files:**
- Modify: `src/app/(dashboard)/drafts/page.tsx`, `src/app/(dashboard)/drafts/[releaseId]/page.tsx`
- Create: a small client component for the Generate button

**The bug this fixes:** `drafts/page.tsx:25` filters `eq(contentPieces.status, "draft")`. With Task 1 in place, an accepted brief lands at status `"brief"` and **disappears from the drafts list entirely** — accept redirects the user to a piece they can never find again.

- [ ] **Step 1: Include brief-status pieces in the list, distinctly**

Change the filter to `inArray(contentPieces.status, ["brief", "draft"])`. Render a `"brief"` row with a badge marking it as awaiting generation, so it is visible but never reads as a finished draft.

- [ ] **Step 2: Render the two generation states on the detail page**

- status `"brief"`: say the draft has not been generated yet; if `generationError` is set, show it as a failure; offer **Generate draft**, which calls `generateDraft(pieceId)`.
- status `"draft"` with `generationError` set: show it as a **warning** above the editor — the draft is real, but the name scan matched something. Do not imply the draft is broken.

- [ ] **Step 3: Verify**

```bash
npm run build
npm run typecheck
npx eslint "src/app/(dashboard)/drafts"
npm run test
npm run test
```

**Browser verification is NOT possible** — the dev preview is behind an OAuth wall. Do not attempt it and do not report visual confirmation you did not obtain. State plainly in your report that the UI was not visually verified.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(dashboard)/drafts"
git commit -m "feat: show ungenerated briefs and generation warnings in drafts"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| accept sets `"brief"`, not `"draft"` | 1 |
| `generationError`, `generatedAt` columns | 1 |
| `contentType` param, five callers unaffected | 2 |
| Grounding, link, naming rules universal | 2 |
| Prompt tells the model not to reproduce names from evidence | 2 |
| `composeBriefPrompt` separates commission from evidence | 2 |
| `generateBriefDraft`, `"brief_draft"` operation | 3 |
| `prepareGenerationContext` parameterised | 3 |
| Failure keeps scaffold + status `brief` + reason | 4 |
| `bodyEditedAt` refusal | 4 |
| Name scan warns, never discards; word-boundary; short-name skip | 4 |
| `after()` trigger, request APIs read before the callback | 5 |
| Generate button path identical to `after()` path | 5 |
| Brief state and warning rendered | 6 |

**Type consistency:** `BriefForPrompt` / `BriefEvidenceForPrompt` are defined in Task 2 and consumed under those names in Tasks 3 and 4. `generateDraftForPiece(contentPieceId, tenantId, deps)` is defined in Task 4 and called with that signature in Task 5. `UpdateDraft` is the pre-existing `{ title, body }`.

**Known gaps carried forward:**

- `generationError` carries two meanings, disambiguated by status. A third would need its own column.
- Regeneration after a human edit is refused outright, with no override.
- The naming rule will visibly constrain drafts about industry developments. Read the first real drafts for whether they read as evasive; relaxing it for non-product types is a one-line change to `buildSystemPrompt`.
