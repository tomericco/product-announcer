# Image Generation — Illustration Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `generateDraftForPiece` plan, render, and splice on-brand illustrations into a draft under a new "Creating images" loader step, and give the draft page a Retry for any illustration that failed to render.

> **UX naming rule (applies to every user-facing string in this plan):** the user-facing word is **"image"** — never "illustration", "render", or "graphic" in UI copy, toasts, or banners. "Illustration" stays in code identifiers (`illustratePiece`, `illustration_plan`) and internal comments only. "Render" in UI copy becomes "version" (a row in the history strip) or "generate" (the act).

**Architecture:** Two-stage agent inside the existing drafting pipeline: `planIllustrations` (one `generateObject` call to the text model → concepts + anchor headings + alt text; the final image prompts are built in code by Plan 1's `buildImagePrompt`), then `illustratePiece` (rows first, cover render, body renders in parallel with the cover as a style reference, compress → Blob → `addRender`, `spliceImageAfterHeading` into the body). It sits between review and save in `src/lib/briefs/draft.ts` behind a `deps.illustrate` seam; failures degrade to a `generationError` warning, never a failed draft. A retry server action re-renders a failed row from its stored concept and splices it at its stored anchor heading — a nullable `anchor_heading` column added to `content_images` here, on top of Plan 1's schema.

**Tech Stack:** Next.js 16 App Router (server actions), Drizzle ORM 0.45 + Postgres, `ai` v7 `generateObject` + `@ai-sdk/anthropic` (plan), Plan 1's `renderImage` (`@ai-sdk/openai` gpt-image-2), `sharp`, `@vercel/blob`, zod v4, vitest.

**Spec:** docs/superpowers/specs/2026-08-18-image-generation-design.md — this plan covers **§4 (the illustration agent, pipeline placement and the loader, failure handling)** plus the §3 note that body images join the markdown by blob URL and the §2 alt-text policy as enforced at plan time. It **depends on Plan 1 (foundation) being merged**: schema (`contentImages`, `imageRenders`, `companyProfiles.visualIdentity` / `imagePolicy`, `llmUsage.imageCount`), `src/lib/images/{visual-identity,policy,compress,blob,prompt,store}.ts`, `src/lib/ai/{image-model,images}.ts`, and the widened `LlmOperation`. Everything below consumes those under the exact names in the shared contract and redefines none of them.

**Background (not instructions):** `2026-08-18-image-generation-ux-review.md` and `2026-08-18-image-generation-qa-review.md` record *why* the constraints below exist. Their findings are already folded into these tasks — this plan is the single source of truth for execution. Read the reviews only to understand a rationale, never to take an instruction from them; where they disagree with a task here, the task wins.


## Global Constraints

- Run `npm install` in the worktree before anything (no node_modules).
- Tests: vitest; node project under tests/** (real Postgres via vitest.setup.ts, uses tests/helpers/fixtures.ts), jsdom project under tests/components/**. Run a single file with `npx vitest run tests/path/file.test.ts`. The suite is flaky when run whole — run the files you touched.
- Migrations: `npm run db:generate` after schema edits; commit the generated SQL in src/db/migrations. Then `npm run db:migrate` and `npm run db:migrate:test`. Never hand-write the SQL. **This plan's migration must land at index `0064`** (Plan 1 took `0063`; Plan 4 takes `0065`). A different index means the branch was cut before Plan 1 merged — rebase, delete the generated `.sql` + its `meta/*_snapshot.json` + its `_journal.json` entry, and re-generate. Never renumber by hand.
- Test fixtures: use `seedTenant`, `dropTenant`, `seedVisualIdentity`, `READY_VISUAL_IDENTITY`, `seedContentPiece` and `seedContentImage` from `tests/helpers/fixtures.ts` (added by Plan 1 Task 10b). Do not re-create profile/piece/image seeds inline — six copies of the same insert is how one schema change breaks five test files.
- Commit after every task; message style: lowercase imperative, `feat:`/`fix:`/`test:`/`docs:` prefix, no Co-Authored-By needed.
- No test may reach a real model, Blob, or OpenAI. Every network seam is injected: `deps.generate` in `planIllustrations`, `deps.{planIllustrations,renderImage,uploadPng,compressPng,deleteBlobs}` in `illustratePiece`, `deps.illustrate` in `generateDraftForPiece`, and the retry action's `vi.mock` of `@/lib/ai/images` / `@/lib/images/blob`.
  **`deleteBlobs` is the easy one to miss**: `illustratePiece` calls
  `deleteImage` for leftover rows, and `deleteImage`'s default deps reach
  `@vercel/blob`'s `del()`. It is a silent no-op only while the leftover row has
  no renders; a leftover row *with* a render (the realistic regenerate case)
  fires a real network call from the test process. Hence the explicit dep below.
- Exact values from the spec: cover size `1200x630` **generated natively, never cropped** — cover renders pass `enforceAspect: true` to `renderImage`, which restates the size + aspect ratio and re-asks once if the answer is off by more than 2% (product owner decision 1, 2026-08-19); body size `1200x900`, compressed to 1200 px wide; `compressPng` also holds every stored PNG to `MAX_IMAGE_BYTES` (1 MB) without ever changing the aspect ratio (decision 2); body cap default 3 (`resolveImagePolicy`: `"auto"` → 3, `"off"` → 0); one silent retry per render; plan model = `GENERATION_MODEL` (default `anthropic/claude-sonnet-4-5`, `resolveModel`/`modelId` from `src/lib/ai/model.ts`); usage rows: `illustration_plan` (token usage) — `image_generation` rows are written by Plan 1's `renderImage`, not here; alt text ≤125 chars, never starts with "image of"; new step `{ key: "illustrating", label: "Creating images", slow: true }` between `"reviewing"` and `"saving"`; the illustration agent runs **only** inside `generateDraftForPiece` (never on agent edits, extract, catch-up).
- `"use server"` files may export ONLY async functions. Never import a runtime value from a server module into a `"use client"` file — `import type` only.
- Tenant scoping in the WHERE clause is the security boundary; every lib function takes `tenantId` and an injectable `database` defaulting to `db` from `@/db`.
- `npm run typecheck && npm run lint` are gates on every task; `npm run build` on the task that touches page/route files (Task 7).
- The dev preview is behind an OAuth wall (see memory) — UI verification is typecheck + lint + build + the manual step written in Task 7.

## Reading list before Task 1

`src/lib/briefs/draft.ts` (all 624 lines — you will edit lines 286–296, 437–508), `src/lib/drafting/draft-progress.ts`, `tests/lib/briefs/draft.test.ts` (seed helpers, lines 48–179), Plan 1's `src/lib/images/store.ts` / `prompt.ts` / `visual-identity.ts` / `policy.ts` and `src/lib/ai/images.ts` as merged, `src/lib/briefs/propose.ts` lines 50–61 and 108–130 (the injected-`generate` + `recordLlmUsage` shape this plan copies), `src/app/(dashboard)/drafts/[releaseId]/actions.ts` lines 15–22 and 103–122 (`loadOwnedDraft`, `saveDraftBody`).

- **User-facing naming (enforced across all four plans).** Every string a user reads must use these words. Code identifiers (`illustratePiece`, `illustration_plan`, `imageRenders`, step key `illustrating`) deliberately keep their internal names — this table governs UI copy only.

  | Term | Use it for | Never say |
  |---|---|---|
  | **image** | any picture: nav "Images", "Generate image", "Image added", "N images failed to generate", loader "Creating images", settings "Body images" | illustration, graphic, asset, render (as a noun) |
  | **cover** | the `role:"cover"` image: "Add cover", "Remove this cover?", "Cover alt text", Webflow "Cover image" | hero, featured image, thumbnail |
  | **body image** | an image placed in the body | body illustration, inline image |
  | **version** | one entry in an image's history strip: "History", "Restore this version", "Current version" | render, revision |
  | **generate / regenerate** | the act: "Generating image…", "Generation failed" | compose, render, create (except the loader's "Creating images") |
  | **prompt** | the user-editable description of *what* the image shows: "Suggest prompt", "Edit prompt", "Write a prompt" | description, instruction (reserved for "Describe a change") |
  | **library** | the /images page and reuse source: "Images" (nav), "From library" | gallery, media, assets |

  Missing-identity error, verbatim on every surface: "Set up your visual identity in Company settings before generating images."

---

### Task 1: `spliceImageAfterHeading` and `listH2Headings` (pure)

**Files:**
- Create: `src/lib/images/splice.ts`
- Test: `tests/lib/images/splice.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function listH2Headings(markdown: string): string[];             // trimmed heading texts, in order, code fences ignored
  export function spliceImageAfterHeading(markdown: string, heading: string, imageMarkdown: string): string; // pure; no-op if not found
  ```
- Consumers: Task 3 (`planIllustrations` post-validation uses `listH2Headings`), Task 4 (`illustratePiece`), Task 7 (retry action).

- [ ] **Step 1: Write the failing test**

Create `tests/lib/images/splice.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { listH2Headings, spliceImageAfterHeading } from "../../../src/lib/images/splice";

const BODY = [
  "# Title",
  "",
  "Intro paragraph.",
  "",
  "## First Section",
  "",
  "First paragraph.",
  "",
  "```md",
  "## Not A Heading",
  "```",
  "",
  "##   Second section  ",
  "Second paragraph.",
  "",
  "### Deeper heading",
  "",
  "## Closing",
  "",
  "Bye.",
].join("\n");

describe("listH2Headings", () => {
  it("returns trimmed H2 texts in order and ignores fenced code and other levels", () => {
    expect(listH2Headings(BODY)).toEqual(["First Section", "Second section", "Closing"]);
  });

  it("returns [] for a body with no H2", () => {
    expect(listH2Headings("# Only a title\n\nText.")).toEqual([]);
  });
});

describe("spliceImageAfterHeading", () => {
  const IMG = "![Gears turning](https://blob.example/gears.png)";

  it("inserts the image on its own paragraph directly after the matched heading line", () => {
    const out = spliceImageAfterHeading(BODY, "First Section", IMG);
    expect(out).toContain(`## First Section\n\n${IMG}\n\nFirst paragraph.`);
    // Nothing else moved.
    expect(out.replace(`\n\n${IMG}\n`, "")).toBe(BODY);
  });

  it("matches case-insensitively and trims both sides", () => {
    const out = spliceImageAfterHeading(BODY, "  second SECTION ", IMG);
    expect(out).toContain(`##   Second section  \n\n${IMG}\n\nSecond paragraph.`);
  });

  it("does not match a heading inside a code fence", () => {
    expect(spliceImageAfterHeading(BODY, "Not A Heading", IMG)).toBe(BODY);
  });

  it("is a no-op when the heading is not found", () => {
    expect(spliceImageAfterHeading(BODY, "Missing", IMG)).toBe(BODY);
  });

  it("uses only the first match when a heading text repeats", () => {
    const dup = "## Same\n\nA.\n\n## Same\n\nB.";
    const out = spliceImageAfterHeading(dup, "Same", IMG);
    expect(out).toBe(`## Same\n\n${IMG}\n\nA.\n\n## Same\n\nB.`);
  });

  it("splices two images after two headings without disturbing each other", () => {
    const one = spliceImageAfterHeading(BODY, "First Section", IMG);
    const two = spliceImageAfterHeading(one, "Closing", "![Wave](https://blob.example/wave.png)");
    expect(two).toContain(`## First Section\n\n${IMG}\n\nFirst paragraph.`);
    expect(two).toContain("## Closing\n\n![Wave](https://blob.example/wave.png)\n\nBye.");
    // Both headings still listed once each.
    expect(listH2Headings(two)).toEqual(["First Section", "Second section", "Closing"]);
  });

  it("does not match a heading that is only a prefix of another", () => {
    expect(spliceImageAfterHeading(BODY, "First", IMG)).toBe(BODY);
  });
});
```

- [ ] **Step 2: Run it, expect failure**

`npx vitest run tests/lib/images/splice.test.ts` — fails: `Cannot find module '../../../src/lib/images/splice'`.

- [ ] **Step 3: Implement**

Create `src/lib/images/splice.ts`:

```ts
/**
 * Body images join the markdown as plain `![alt](url)` lines (spec §3), so
 * placing one is a text operation on the stored body. Both functions treat
 * ATX H2 lines (`## text`) as anchors and skip anything inside a fenced code
 * block — a "## " inside a code sample is not a section.
 *
 * Matching is by heading TEXT: trimmed, case-insensitive, whole-text (not a
 * prefix). Headings are the one thing the plan step and the retry action can
 * both name later — a line offset would rot the moment a human edits above it.
 */

const H2 = /^##(?!#)\s*(.*?)\s*$/;
const FENCE = /^\s*(```|~~~)/;

function normalize(heading: string): string {
  return heading.trim().toLowerCase();
}

/** Line index of the first H2 whose text matches `heading`, or -1. */
function findHeadingLine(lines: string[], heading: string): number {
  const wanted = normalize(heading);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = H2.exec(lines[i]);
    if (match && normalize(match[1]) === wanted) return i;
  }
  return -1;
}

export function listH2Headings(markdown: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = H2.exec(line);
    if (match) out.push(match[1].trim());
  }
  return out;
}

/**
 * Inserts `imageMarkdown` as its own paragraph directly after the FIRST H2
 * whose text matches `heading`. Returns the input unchanged when no heading
 * matches — the caller decides whether that is a failure (the retry action
 * reports it; the agent simply loses that image and keeps the draft).
 */
export function spliceImageAfterHeading(markdown: string, heading: string, imageMarkdown: string): string {
  const lines = markdown.split("\n");
  const at = findHeadingLine(lines, heading);
  if (at === -1) return markdown;
  // `\n\n![alt](url)\n` after the heading line: a blank line closes the
  // heading, the image is its own block, and the trailing newline plus the
  // body's own blank line keeps the following paragraph separate.
  lines.splice(at + 1, 0, "", imageMarkdown);
  return lines.join("\n");
}
```

Note on the splice shape: after `## H` the body normally has a blank line then the paragraph. Inserting `["", img]` after the heading gives `## H\n\n![..](..)\n\nParagraph` — exactly the contract's `\n\n![alt](url)\n` followed by the existing blank line.

- [ ] **Step 4: Run, expect pass**

`npx vitest run tests/lib/images/splice.test.ts` — all 9 pass.

- [ ] **Step 5: Commit**

```
git add src/lib/images/splice.ts tests/lib/images/splice.test.ts
git commit -m "feat: splice image markdown after an H2 heading, ignoring code fences"
```

---

### Task 2: `content_images.anchor_heading` (additive migration on top of Plan 1)

**Files:**
- Modify: `src/db/schema.ts` — Plan 1's `contentImages` table definition (search for `export const contentImages = pgTable("content_images"`); add one column after `altText`.
- Create: `src/db/migrations/<next>_*.sql` (generated).
- Test: `tests/db/content-images-anchor.test.ts`

**Interfaces:**
- Produces: `contentImages.anchorHeading: text("anchor_heading")` — nullable. Written by `illustratePiece` (Task 4) for body images; read by the retry action (Task 7). Null for covers, uploads, library images, and editor-inserted images (Plan 3 never sets it).

Why here and not Plan 1: the contract omitted where a failed body image should be re-placed. Retry "splices it at its stored anchor" (spec §4) needs the anchor stored. This is a nullable column with no default — purely additive; Plan 1's tests and store functions are unaffected (`createImage`'s insert omits it, so it reads null).

- [ ] **Step 1: Write the failing test**

Create `tests/db/content-images-anchor.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, contentPieces, contentImages } from "../../src/db/schema";

const TENANT = "Content Images Anchor Test Tenant";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
});

describe("contentImages.anchorHeading", () => {
  it("is null by default and round-trips a heading text", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [piece] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, title: "T", body: "B", type: "blog_post" })
      .returning();
    const [image] = await db
      .insert(contentImages)
      .values({
        tenantId: tenant.id,
        contentPieceId: piece.id,
        role: "body",
        concept: "gears",
        altText: "Gears turning",
        sourceKind: "generated",
        status: "pending",
      })
      .returning();
    expect(image.anchorHeading).toBeNull();

    const [updated] = await db
      .update(contentImages)
      .set({ anchorHeading: "First Section" })
      .where(eq(contentImages.id, image.id))
      .returning();
    expect(updated.anchorHeading).toBe("First Section");
  });
});
```

- [ ] **Step 2: Run it, expect failure**

`npx vitest run tests/db/content-images-anchor.test.ts` — fails to typecheck/run: `anchorHeading` does not exist on the insert/select type (or Postgres: column "anchor_heading" does not exist).

- [ ] **Step 3: Add the column**

In `src/db/schema.ts`, inside Plan 1's `contentImages` table, directly after the `altText: text("alt_text").notNull(),` line, add:

```ts
  // The H2 heading text a BODY illustration was planned under (spec §4). Set
  // by the illustration agent, read by the draft page's Retry so a failed
  // render can be re-placed where the plan wanted it. Null for covers,
  // uploads, library images and editor-inserted images — for those, the
  // markdown position is the only position. Text, not an offset: humans edit
  // above and below; the heading text survives that, a line number does not.
  anchorHeading: text("anchor_heading"),
```

Then:

```
npm run db:generate
npm run db:migrate
npm run db:migrate:test
```

Confirm the generated SQL is exactly one statement: `ALTER TABLE "content_images" ADD COLUMN "anchor_heading" text;`.

- [ ] **Step 4: Run, expect pass**

`npx vitest run tests/db/content-images-anchor.test.ts` — passes. Also run Plan 1's store tests to prove nothing regressed: `npx vitest run tests/lib/images/store.test.ts` (path as Plan 1 created it).

- [ ] **Step 5: Commit**

```
git add src/db/schema.ts src/db/migrations tests/db/content-images-anchor.test.ts
git commit -m "feat: content_images.anchor_heading for re-placing a retried body illustration"
```

---

### Task 3: `planIllustrations` — the plan call

**Files:**
- Create: `src/lib/images/plan.ts`
- Test: `tests/lib/images/plan.test.ts`

**Interfaces:**
- Consumes: `resolveModel`, `modelId` (`src/lib/ai/model.ts`); `recordLlmUsage` (`src/lib/ai/llm-usage.ts`, `LlmOperation` already includes `"illustration_plan"` from Plan 1); `buildImagePrompt` (`src/lib/images/prompt.ts`, Plan 1: `({ styleBlock, concept, role: "cover" | "body", allowText }) => string`); `listH2Headings` (Task 1); `generateObject` from `ai`.
- Produces (exact contract shape):
  ```ts
  export type IllustrationPlan = {
    cover: { concept: string; prompt: string; altText: string } | null;
    body: { anchorHeading: string; concept: string; prompt: string; altText: string }[];
  };
  export type PlanGenerate = (args: { model; schema; system: string; prompt: string; maxOutputTokens: number }) =>
    Promise<{ object: z.infer<typeof PlanSchema>; usage?: TokenUsage }>;
  export type PlanDeps = { generate?: PlanGenerate };
  export async function planIllustrations(
    a: { tenantId: string; title: string; body: string; wantCover: boolean; bodyCap: number; styleBlock: string; allowText?: boolean; database?: DbClient },
    deps?: PlanDeps
  ): Promise<IllustrationPlan>;
  export const MAX_ALT_TEXT_LENGTH = 125;
  export const MAX_PLAN_OUTPUT_TOKENS = 1_500;
  ```
  `allowText` is an addition to the contract's argument list (defaults `false`); `illustratePiece` passes `vi.allowTextInImages` so the built prompt honours the brand setting. Plan 3/4 never call this function.

The LLM returns concepts + anchor headings + alt text. **It never writes the image prompt** — that is `buildImagePrompt(styleBlock, concept, role, allowText)` in code, so the style block lives in exactly one place (spec §2).

- [ ] **Step 1: Write the failing test**

Create `tests/lib/images/plan.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../../src/lib/ai/llm-usage", () => ({ recordLlmUsage: vi.fn(async () => {}) }));

import { planIllustrations, MAX_ALT_TEXT_LENGTH } from "../../../src/lib/images/plan";
import { buildImagePrompt } from "../../../src/lib/images/prompt";
import { recordLlmUsage } from "../../../src/lib/ai/llm-usage";

const STYLE = "Flat vector illustration, palette: primary #112233, accents #445566.";
const BODY = [
  "Intro paragraph.",
  "",
  "## Why It Matters",
  "",
  "Para.",
  "",
  "## How It Works",
  "",
  "Para.",
  "",
  "## What Changes For You",
  "",
  "Para.",
  "",
  "## Next Steps",
  "",
  "CTA.",
].join("\n");

const PLAN = {
  cover: { concept: "a lighthouse beam sweeping over stacked documents", altText: "A lighthouse beam sweeping over a stack of documents" },
  body: [
    { anchorHeading: "How It Works", concept: "three gears meshing", altText: "Three gears meshing together" },
    { anchorHeading: "what changes for you", concept: "a door opening onto a path", altText: "A door opening onto a bright path" },
  ],
};

function fakeGenerate(object: unknown) {
  return vi.fn(async (_call: { system: string; prompt: string }) => ({ object, usage: { inputTokens: 10, outputTokens: 5 } }));
}

afterEach(() => vi.mocked(recordLlmUsage).mockClear());

describe("planIllustrations", () => {
  it("builds each prompt in code from the concept and the style block; the model never writes it", async () => {
    const generate = fakeGenerate(PLAN);
    const plan = await planIllustrations(
      { tenantId: "t1", title: "T", body: BODY, wantCover: true, bodyCap: 3, styleBlock: STYLE },
      { generate: generate as never }
    );
    expect(plan.cover?.prompt).toBe(
      buildImagePrompt({ styleBlock: STYLE, concept: PLAN.cover.concept, role: "cover", allowText: false })
    );
    expect(plan.body[0].prompt).toBe(
      buildImagePrompt({ styleBlock: STYLE, concept: "three gears meshing", role: "body", allowText: false })
    );
    // The model's schema has no prompt field to fill in.
    const call = generate.mock.calls[0][0] as { system: string; prompt: string };
    expect(call.system).not.toMatch(/write (the|an) image prompt/i);
  });

  it("passes the title, the H2 list and the body to the model, with the rules in the system prompt", async () => {
    const generate = fakeGenerate(PLAN);
    await planIllustrations(
      { tenantId: "t1", title: "The Title", body: BODY, wantCover: true, bodyCap: 3, styleBlock: STYLE },
      { generate: generate as never }
    );
    const call = generate.mock.calls[0][0] as { system: string; prompt: string; maxOutputTokens: number };
    expect(call.prompt).toContain("The Title");
    expect(call.prompt).toContain("- Why It Matters");
    expect(call.prompt).toContain("- Next Steps");
    expect(call.prompt).toContain("Intro paragraph.");
    expect(call.system).toContain("at most 3");
    expect(call.system).toMatch(/never pad/i);
    expect(call.system).toMatch(/125 characters/);
    expect(call.system).toMatch(/"image of"/);
    expect(call.system).toMatch(/double hero|no second hero/i);
    expect(call.maxOutputTokens).toBeGreaterThan(0);
  });

  it("keeps the anchor heading's canonical text and drops entries not anchored to a real H2", async () => {
    const generate = fakeGenerate({
      cover: null,
      body: [
        ...PLAN.body,
        { anchorHeading: "A Heading That Does Not Exist", concept: "x", altText: "x" },
      ],
    });
    const plan = await planIllustrations(
      { tenantId: "t1", title: "T", body: BODY, wantCover: false, bodyCap: 3, styleBlock: STYLE },
      { generate: generate as never }
    );
    expect(plan.body.map((b) => b.anchorHeading)).toEqual(["How It Works", "What Changes For You"]);
  });

  it("truncates to bodyCap and drops the cover when the type has none", async () => {
    const generate = fakeGenerate(PLAN);
    const plan = await planIllustrations(
      { tenantId: "t1", title: "T", body: BODY, wantCover: false, bodyCap: 1, styleBlock: STYLE },
      { generate: generate as never }
    );
    expect(plan.cover).toBeNull();
    expect(plan.body).toHaveLength(1);
    expect(plan.body[0].anchorHeading).toBe("How It Works");
  });

  it("drops a second entry anchored to the same heading", async () => {
    const generate = fakeGenerate({
      cover: null,
      body: [PLAN.body[0], { ...PLAN.body[0], concept: "different" }],
    });
    const plan = await planIllustrations(
      { tenantId: "t1", title: "T", body: BODY, wantCover: false, bodyCap: 3, styleBlock: STYLE },
      { generate: generate as never }
    );
    expect(plan.body).toHaveLength(1);
  });

  it("enforces the alt-text policy on whatever the model returned", async () => {
    const generate = fakeGenerate({
      cover: { concept: "c", altText: "Image of " + "x".repeat(200) },
      body: [{ anchorHeading: "How It Works", concept: "g", altText: "An illustration of gears" }],
    });
    const plan = await planIllustrations(
      { tenantId: "t1", title: "T", body: BODY, wantCover: true, bodyCap: 3, styleBlock: STYLE },
      { generate: generate as never }
    );
    expect(plan.cover?.altText.length).toBeLessThanOrEqual(MAX_ALT_TEXT_LENGTH);
    expect(plan.cover?.altText.toLowerCase().startsWith("image of")).toBe(false);
    expect(plan.body[0].altText).toBe("Gears");
  });

  it("returns an empty plan without calling the model when nothing is wanted", async () => {
    const generate = fakeGenerate(PLAN);
    const plan = await planIllustrations(
      { tenantId: "t1", title: "T", body: BODY, wantCover: false, bodyCap: 0, styleBlock: STYLE },
      { generate: generate as never }
    );
    expect(plan).toEqual({ cover: null, body: [] });
    expect(generate).not.toHaveBeenCalled();
  });

  it("records illustration_plan usage for the tenant", async () => {
    await planIllustrations(
      { tenantId: "t-usage", title: "T", body: BODY, wantCover: true, bodyCap: 3, styleBlock: STYLE },
      { generate: fakeGenerate(PLAN) as never }
    );
    expect(recordLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "t-usage", operation: "illustration_plan", usage: { inputTokens: 10, outputTokens: 5 } }),
      expect.anything()
    );
  });
});
```

- [ ] **Step 2: Run it, expect failure**

`npx vitest run tests/lib/images/plan.test.ts` — fails: cannot find module `src/lib/images/plan`.

- [ ] **Step 3: Implement**

Create `src/lib/images/plan.ts`:

```ts
import { generateObject } from "ai";
import { z } from "zod";
import { db as defaultDb } from "@/db";
import { resolveModel, modelId } from "@/lib/ai/model";
import { recordLlmUsage, type TokenUsage } from "@/lib/ai/llm-usage";
import { buildImagePrompt } from "@/lib/images/prompt";
import { listH2Headings } from "@/lib/images/splice";
import type { DbClient } from "@/lib/publishing/destinations/types";

/**
 * Stage 1 of the illustration agent (spec §4): the TEXT model reads the
 * finished draft and decides what to illustrate and where. It returns
 * concepts, anchor headings and alt text only. The image prompt for each
 * entry is assembled here in code by `buildImagePrompt` from the concept and
 * the compiled style block — the model never sees or writes the style block,
 * so prompt assembly stays in one place (spec §2).
 */

export type IllustrationPlan = {
  cover: { concept: string; prompt: string; altText: string } | null;
  body: { anchorHeading: string; concept: string; prompt: string; altText: string }[];
};

/** Alt text policy (spec §2): one sentence, ≤125 chars, meaning not style. */
export const MAX_ALT_TEXT_LENGTH = 125;

/** A cover plus at most three body entries is a few hundred tokens; 1,500 bounds a runaway. */
export const MAX_PLAN_OUTPUT_TOKENS = 1_500;

// No `prompt` field: the model has nothing to fill in there even if it tried.
export const PlanSchema = z.object({
  cover: z.object({ concept: z.string(), altText: z.string() }).nullable(),
  body: z.array(z.object({ anchorHeading: z.string(), concept: z.string(), altText: z.string() })),
});

export type PlanGenerate = (args: {
  model: ReturnType<typeof resolveModel>;
  schema: typeof PlanSchema;
  system: string;
  prompt: string;
  maxOutputTokens: number;
}) => Promise<{ object: z.infer<typeof PlanSchema>; usage?: TokenUsage }>;

export type PlanDeps = { generate?: PlanGenerate };

function buildSystem(args: { wantCover: boolean; bodyCap: number }): string {
  return [
    "You plan the illustrations for a piece of marketing content that has already been written.",
    "You do NOT write image prompts and you do NOT describe visual style. Another step renders",
    "each concept in the company's fixed brand style, so never mention colours, palette, medium,",
    "lighting, composition, or artistic style. Describe only WHAT the image depicts: a concrete",
    "visual metaphor for the idea in that section.",
    "",
    "RULES.",
    `1. BODY IMAGES: at most ${args.bodyCap}. Aim for roughly one image per two H2 sections, and go`,
    "   UNDER that whenever a section has nothing worth visualising. NEVER PAD to the limit — an",
    "   image that merely decorates is worse than no image. Return an empty body list when nothing",
    "   earns one.",
    "2. ANCHORS: every body image names one H2 heading from the list given, copied verbatim. The",
    "   image is placed directly after that heading, before the section's first paragraph.",
    "3. PLACEMENT:",
    args.wantCover
      ? "   - The piece opens with a cover image above the title. Never anchor a body image to the first H2 when the text before it is a short intro — that is a double hero. No second hero."
      : "   - There is no cover image on this piece.",
    "   - Never anchor two images to neighbouring short sections; keep roughly 150 words of text",
    "     between images.",
    "   - Never anchor an image to a closing, summary, conclusion, next-steps or call-to-action section.",
    "4. CONCEPT FIRST: each concept is one or two sentences naming a concrete subject and what it is",
    '   doing — for example "three interlocking gears, one glowing, lifting a stack of documents".',
    "   No text, labels, numbers, logos or brand marks in the depiction.",
    "5. ALT TEXT: one sentence, at most 125 characters, saying what the image MEANS for a reader who",
    '   cannot see it. Never start with "image of" or "illustration of". Derived from the concept,',
    "   never from style.",
    args.wantCover
      ? "6. COVER: exactly one concept for a wide hero image that captures the piece as a whole — its thesis, not any one section. Keep the subject centred; the edges may be cropped."
      : "6. COVER: this piece has no cover. Return null for cover.",
  ].join("\n");
}

function buildPrompt(args: { title: string; body: string; headings: string[] }): string {
  return [
    `## Title`,
    args.title,
    "",
    "## H2 headings you may anchor to (copy verbatim)",
    args.headings.length > 0 ? args.headings.map((h) => `- ${h}`).join("\n") : "(none — return an empty body list)",
    "",
    "## Body (markdown)",
    args.body,
  ].join("\n");
}

/**
 * Enforces the alt policy on whatever came back: strips a leading
 * "image of"/"illustration of"/"picture of", capitalises, and truncates.
 * An instruction is not an enforcement (see `proposeBriefFromSignals`'s
 * score clamp for the precedent).
 */
export function normalizeAltText(raw: string): string {
  let text = raw.trim().replace(/^(an?\s+)?(image|illustration|picture|graphic|drawing)\s+of\s+/i, "");
  if (text.length > 0) text = text[0].toUpperCase() + text.slice(1);
  if (text.length > MAX_ALT_TEXT_LENGTH) text = text.slice(0, MAX_ALT_TEXT_LENGTH).replace(/\s+\S*$/, "").trimEnd();
  return text;
}

export async function planIllustrations(
  args: {
    tenantId: string;
    title: string;
    body: string;
    wantCover: boolean;
    bodyCap: number;
    styleBlock: string;
    allowText?: boolean;
    database?: DbClient;
  },
  deps: PlanDeps = {}
): Promise<IllustrationPlan> {
  const bodyCap = Math.max(0, Math.floor(args.bodyCap));
  if (!args.wantCover && bodyCap === 0) return { cover: null, body: [] };

  const generate = deps.generate ?? (generateObject as unknown as PlanGenerate);
  const headings = listH2Headings(args.body);
  const allowText = args.allowText ?? false;

  const spec = process.env.GENERATION_MODEL ?? "anthropic/claude-sonnet-4-5";
  const { object, usage } = await generate({
    model: resolveModel(spec),
    schema: PlanSchema,
    system: buildSystem({ wantCover: args.wantCover, bodyCap }),
    prompt: buildPrompt({ title: args.title, body: args.body, headings }),
    maxOutputTokens: MAX_PLAN_OUTPUT_TOKENS,
  });

  await recordLlmUsage(
    { tenantId: args.tenantId, operation: "illustration_plan", model: modelId(spec), usage },
    args.database ?? defaultDb
  );

  // Post-validation. `generate` is caller-injected and the model is a model:
  // an anchor that is not an H2 in the body cannot be placed, a repeat anchor
  // would stack two images under one heading, and the cap is the cap. The
  // canonical heading text (as written in the body) is stored, not the model's
  // spelling of it, so the splice and the retry match exactly.
  const byNormalized = new Map(headings.map((h) => [h.trim().toLowerCase(), h] as const));
  const seen = new Set<string>();
  const body: IllustrationPlan["body"] = [];
  for (const entry of object.body) {
    const key = entry.anchorHeading.trim().toLowerCase();
    const canonical = byNormalized.get(key);
    if (canonical === undefined || seen.has(key)) continue;
    seen.add(key);
    body.push({
      anchorHeading: canonical,
      concept: entry.concept.trim(),
      altText: normalizeAltText(entry.altText),
      prompt: buildImagePrompt({ styleBlock: args.styleBlock, concept: entry.concept.trim(), role: "body", allowText }),
    });
    if (body.length >= bodyCap) break;
  }

  const cover =
    args.wantCover && object.cover
      ? {
          concept: object.cover.concept.trim(),
          altText: normalizeAltText(object.cover.altText),
          prompt: buildImagePrompt({ styleBlock: args.styleBlock, concept: object.cover.concept.trim(), role: "cover", allowText }),
        }
      : null;

  return { cover, body };
}
```

- [ ] **Step 4: Run, expect pass**

`npx vitest run tests/lib/images/plan.test.ts` — 8 pass. `npm run typecheck`.

- [ ] **Step 5: Commit**

```
git add src/lib/images/plan.ts tests/lib/images/plan.test.ts
git commit -m "feat: plan illustrations — text model picks concepts and anchors, code builds prompts"
```

---

### Task 4: `illustratePiece` — the orchestrator

**Files:**
- Create: `src/lib/images/illustrate.ts`
- Test: `tests/lib/images/illustrate.test.ts`

**Interfaces:**
- Consumes (Plan 1, exact names): `getOrCreateCompanyProfile` (`src/lib/workspace/company-profile.ts`, `(tenantId, database?)`), `isVisualIdentityReady`, `compileStyleBlock` (`src/lib/images/visual-identity.ts`), `resolveImagePolicy` (`src/lib/images/policy.ts`), `renderImage` (`src/lib/ai/images.ts`), `imageModelId`, `IMAGE_MODEL_DEFAULT` (`src/lib/ai/image-model.ts`), `compressPng` (`src/lib/images/compress.ts`), `imagePathname`, `slugForImage`, `uploadPng` (`src/lib/images/blob.ts`), `createImage`, `addRender`, `markImageFailed`, `listImages`, `deleteImage` (`src/lib/images/store.ts`), `planIllustrations` (Task 3), `spliceImageAfterHeading` (Task 1), `contentImages` (schema, for the `anchorHeading` write).
- Produces:
  ```ts
  export type IllustrateSkipReason = "no_visual_identity" | "policy_off";
  export type IllustrateResult = { body: string; failures: number; skipped?: IllustrateSkipReason };
  export type IllustrateDeps = {
    planIllustrations?: typeof planIllustrations;
    renderImage?: typeof renderImage;
    uploadPng?: typeof uploadPng;
    compressPng?: typeof compressPng;
    // Forwarded to `deleteImage`'s StoreDeps when clearing leftovers. Without
    // it a test with a leftover row that HAS a render calls @vercel/blob's
    // del() for real.
    deleteBlobs?: (pathnames: string[]) => Promise<void>;
  };
  export async function illustratePiece(
    a: { tenantId: string; contentPieceId: string; title: string; body: string; contentType: ContentType; database?: DbClient },
    deps?: IllustrateDeps
  ): Promise<IllustrateResult>;
  ```
  The contract's `{ body; failures }` return is extended with the optional `skipped` (the caller shows nothing for a skip; a test asserts the reason).

Design points to carry into the code comments:
- **Cover first, then body in parallel** (`Promise.all`), each body render getting `[...styleReferenceImages, coverPng?]` as references when `pinStyleToCover` and the cover rendered. Wall clock ≈ two render round trips.
- **One silent retry** per render (`renderImage` → on throw, call again once). Second failure → `markImageFailed`, row kept with its concept + anchor, counted in `failures`; body image omitted from the markdown.
- **Cover unique index**: `content_images_cover_unique (content_piece_id) where role='cover'`. `illustratePiece` runs only on a `"brief"` piece being generated, so any existing `cover`/`body` rows on the piece are leftovers of an earlier aborted or failed run (the release branch's zero-link throw rolls the body back but not the image rows written before it). They are removed via `deleteImage` at the start (blobs included) so a regeneration cannot trip the unique index or leave orphaned blobs. `sourceKind: "uploaded"` rows are left alone — no path exists to upload to a "brief" piece today, but the guard costs nothing.
- Rows are written with `status: "pending"` before rendering (the row exists while the render is in flight, exactly like the interrupted-generation marker in draft.ts), flipped to `"ready"` by `addRender` or `"failed"` by `markImageFailed`.
- `anchorHeading` written on the body row right after `createImage` — a direct `update(contentImages)` rather than a change to Plan 1's `createImage` signature, so this plan does not touch store.ts.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/images/illustrate.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, contentPieces, companyProfiles, contentImages, imageRenders, type VisualIdentity } from "../../../src/db/schema";
import { DEFAULT_VISUAL_IDENTITY } from "../../../src/lib/images/visual-identity";
import { illustratePiece, type IllustrateDeps } from "../../../src/lib/images/illustrate";
import type { IllustrationPlan } from "../../../src/lib/images/plan";

const TENANT = "Illustrate Piece Test Tenant";

const VI: VisualIdentity = {
  ...DEFAULT_VISUAL_IDENTITY,
  palette: [
    { hex: "#112233", role: "primary" },
    { hex: "#445566", role: "secondary" },
    { hex: "#ffffff", role: "background" },
  ],
  styleReferenceImages: ["https://blob.example/ref-1.png"],
  pinStyleToCover: true,
};

const BODY = "Intro.\n\n## Alpha\n\nA para.\n\n## Beta\n\nB para.\n\n## Wrap Up\n\nBye.";

const PLAN: IllustrationPlan = {
  cover: { concept: "lighthouse", prompt: "PROMPT cover", altText: "A lighthouse beam" },
  body: [
    { anchorHeading: "Alpha", concept: "gears", prompt: "PROMPT alpha", altText: "Gears turning" },
    { anchorHeading: "Beta", concept: "door", prompt: "PROMPT beta", altText: "A door opening" },
  ],
};

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
});

async function seed(opts: { visualIdentity?: VisualIdentity | null; imagePolicy?: Record<string, unknown> | null } = {}) {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  await db.insert(companyProfiles).values({
    tenantId: tenant.id,
    topics: [],
    visualIdentity: opts.visualIdentity === undefined ? VI : opts.visualIdentity,
    imagePolicy: (opts.imagePolicy ?? null) as never,
  });
  const [piece] = await db
    .insert(contentPieces)
    .values({ tenantId: tenant.id, type: "blog_post", title: "T", body: BODY, status: "brief" })
    .returning();
  return { tenant, piece };
}

/** Fakes for every network seam. `renderImage` records what it was asked for. */
function fakes(overrides: Partial<IllustrateDeps> & { failPrompts?: string[] } = {}) {
  const renderCalls: { prompt: string; size: string; referenceImages: (string | Buffer)[]; enforceAspect?: boolean }[] = [];
  const uploadCalls: string[] = [];
  const failing = new Set(overrides.failPrompts ?? []);
  // Every pathname is distinct: two body images rendered in parallel would
  // otherwise share a blob URL and the splice assertions could not tell them
  // apart. Real `uploadPng` gets uniqueness from `addRandomSuffix`.
  let uploadCounter = 0;
  const deleteBlobs = vi.fn(async (_pathnames: string[]) => {});
  const deps: Required<IllustrateDeps> = {
    planIllustrations: vi.fn(async () => PLAN),
    renderImage: vi.fn(async (args: { prompt: string; size: string; referenceImages?: (string | Buffer)[]; enforceAspect?: boolean }) => {
      renderCalls.push({
        prompt: args.prompt,
        size: args.size,
        referenceImages: args.referenceImages ?? [],
        enforceAspect: args.enforceAspect,
      });
      if (failing.has(args.prompt)) throw new Error(`render failed: ${args.prompt}`);
      return Buffer.from(`PNG:${args.prompt}`);
    }) as never,
    compressPng: vi.fn(async (input: Buffer, maxWidth: number) => ({ png: input, width: maxWidth, height: 630 })),
    uploadPng: vi.fn(async (pathname: string) => {
      uploadCalls.push(pathname);
      const unique = `${pathname}-${++uploadCounter}`;
      return { url: `https://blob.example/${unique}`, pathname: unique };
    }),
    deleteBlobs,
    ...overrides,
  };
  return { deps, renderCalls, uploadCalls, deleteBlobs };
}

async function imagesFor(pieceId: string) {
  return db.select().from(contentImages).where(eq(contentImages.contentPieceId, pieceId)).orderBy(contentImages.createdAt);
}

describe("illustratePiece", () => {
  it("skips with a reason when the tenant has no ready visual identity", async () => {
    const { tenant, piece } = await seed({ visualIdentity: null });
    const { deps } = fakes();
    const result = await illustratePiece(
      { tenantId: tenant.id, contentPieceId: piece.id, title: "T", body: BODY, contentType: "blog_post", database: db },
      deps
    );
    expect(result).toEqual({ body: BODY, failures: 0, skipped: "no_visual_identity" });
    expect(deps.planIllustrations).not.toHaveBeenCalled();
    expect(await imagesFor(piece.id)).toHaveLength(0);
  });

  it("returns the body untouched when the type's policy has no cover and body off", async () => {
    // social_post: DEFAULT_IMAGE_POLICY {cover:false, body:"off"}.
    const { tenant, piece } = await seed();
    const { deps } = fakes();
    const result = await illustratePiece(
      { tenantId: tenant.id, contentPieceId: piece.id, title: "T", body: BODY, contentType: "social_post", database: db },
      deps
    );
    expect(result).toEqual({ body: BODY, failures: 0, skipped: "policy_off" });
    expect(deps.planIllustrations).not.toHaveBeenCalled();
  });

  it("creates cover + body rows, renders cover first, body with the cover as a reference, and splices", async () => {
    const { tenant, piece } = await seed();
    const { deps, renderCalls } = fakes();

    const result = await illustratePiece(
      { tenantId: tenant.id, contentPieceId: piece.id, title: "T", body: BODY, contentType: "blog_post", database: db },
      deps
    );

    expect(result.failures).toBe(0);
    expect(result.skipped).toBeUndefined();

    // Cover first, at 1200x630, with only the brand references — and asking
    // renderImage to hold it to that shape (product owner decision 1: the
    // cover is GENERATED wide, never cropped afterwards).
    expect(renderCalls[0]).toMatchObject({ prompt: "PROMPT cover", size: "1200x630", enforceAspect: true });
    expect(renderCalls[0].referenceImages).toEqual(["https://blob.example/ref-1.png"]);
    // Body renders after, at 1200x900, brand refs + the fresh cover bytes (pinStyleToCover).
    const bodyCalls = renderCalls.slice(1);
    expect(bodyCalls.map((c) => c.prompt).sort()).toEqual(["PROMPT alpha", "PROMPT beta"]);
    for (const call of bodyCalls) {
      expect(call.size).toBe("1200x900");
      // Body images have no fixed shape to hold; only covers are guarded.
      expect(call.enforceAspect).toBeFalsy();
      expect(call.referenceImages[0]).toBe("https://blob.example/ref-1.png");
      expect(Buffer.isBuffer(call.referenceImages[1])).toBe(true);
    }

    // Rows: one cover, two body, all ready with a current render and the anchor stored.
    const rows = await imagesFor(piece.id);
    expect(rows.map((r) => r.role).sort()).toEqual(["body", "body", "cover"]);
    expect(rows.every((r) => r.status === "ready" && r.currentRenderId !== null)).toBe(true);
    const alpha = rows.find((r) => r.concept === "gears")!;
    expect(alpha.anchorHeading).toBe("Alpha");
    expect(alpha.altText).toBe("Gears turning");
    expect(rows.find((r) => r.role === "cover")!.anchorHeading).toBeNull();

    // Renders carry the exact prompt and the blob URL.
    const [alphaRender] = await db.select().from(imageRenders).where(eq(imageRenders.imageId, alpha.id));
    expect(alphaRender.prompt).toBe("PROMPT alpha");
    expect(alphaRender.blobUrl).toMatch(/^https:\/\/blob\.example\/tenants\//);

    // Spliced after the anchors, cover NOT in the body.
    expect(result.body).toContain(`## Alpha\n\n![Gears turning](${alphaRender.blobUrl})\n\nA para.`);
    expect(result.body).toMatch(/## Beta\n\n!\[A door opening\]\(https:\/\/blob\.example\/[^)]+\)\n\nB para\./);
    expect(result.body).not.toContain("lighthouse");
    expect(result.body).toContain("## Wrap Up\n\nBye.");
  });

  it("retries a failed render once, silently", async () => {
    const { tenant, piece } = await seed();
    let alphaAttempts = 0;
    const { deps } = fakes();
    (deps.renderImage as ReturnType<typeof vi.fn>).mockImplementation(async (args: { prompt: string }) => {
      if (args.prompt === "PROMPT alpha" && alphaAttempts++ === 0) throw new Error("transient");
      return Buffer.from("PNG");
    });
    const result = await illustratePiece(
      { tenantId: tenant.id, contentPieceId: piece.id, title: "T", body: BODY, contentType: "blog_post", database: db },
      deps
    );
    expect(result.failures).toBe(0);
    expect(alphaAttempts).toBe(2);
    expect(result.body).toMatch(/## Alpha\n\n!\[Gears turning\]/);
  });

  it("marks a twice-failed body image failed, keeps its row and anchor, omits it from the body, counts it", async () => {
    const { tenant, piece } = await seed();
    const { deps } = fakes({ failPrompts: ["PROMPT beta"] });
    const result = await illustratePiece(
      { tenantId: tenant.id, contentPieceId: piece.id, title: "T", body: BODY, contentType: "blog_post", database: db },
      deps
    );
    expect(result.failures).toBe(1);
    expect(result.body).toMatch(/## Alpha\n\n!\[Gears turning\]/);
    expect(result.body).toContain("## Beta\n\nB para.");
    const beta = (await imagesFor(piece.id)).find((r) => r.concept === "door")!;
    expect(beta.status).toBe("failed");
    expect(beta.anchorHeading).toBe("Beta");
    expect(beta.currentRenderId).toBeNull();
  });

  it("saves the draft coverless when the cover fails, and still renders body images without it as a reference", async () => {
    const { tenant, piece } = await seed();
    const { deps, renderCalls } = fakes({ failPrompts: ["PROMPT cover"] });
    const result = await illustratePiece(
      { tenantId: tenant.id, contentPieceId: piece.id, title: "T", body: BODY, contentType: "blog_post", database: db },
      deps
    );
    expect(result.failures).toBe(1);
    const cover = (await imagesFor(piece.id)).find((r) => r.role === "cover")!;
    // The row persists with its concept — Plan 3's Add-cover menu pre-fills from it.
    expect(cover.status).toBe("failed");
    expect(cover.concept).toBe("lighthouse");
    const bodyCalls = renderCalls.filter((c) => c.size === "1200x900");
    expect(bodyCalls).toHaveLength(2);
    for (const call of bodyCalls) expect(call.referenceImages).toEqual(["https://blob.example/ref-1.png"]);
  });

  it("does not pass the cover as a reference when pinStyleToCover is off", async () => {
    const { tenant, piece } = await seed({ visualIdentity: { ...VI, pinStyleToCover: false } });
    const { deps, renderCalls } = fakes();
    await illustratePiece(
      { tenantId: tenant.id, contentPieceId: piece.id, title: "T", body: BODY, contentType: "blog_post", database: db },
      deps
    );
    for (const call of renderCalls.filter((c) => c.size === "1200x900")) {
      expect(call.referenceImages).toEqual(["https://blob.example/ref-1.png"]);
    }
  });

  it("plans no cover for a type whose policy has cover off, and honours the body cap", async () => {
    const { tenant, piece } = await seed({ imagePolicy: { blog_post: { cover: false, body: 1 } } });
    const { deps } = fakes();
    await illustratePiece(
      { tenantId: tenant.id, contentPieceId: piece.id, title: "T", body: BODY, contentType: "blog_post", database: db },
      deps
    );
    expect(deps.planIllustrations).toHaveBeenCalledWith(
      expect.objectContaining({ wantCover: false, bodyCap: 1, tenantId: tenant.id }),
      expect.anything()
    );
  });

  it("removes leftover generated rows from an earlier run before creating new ones", async () => {
    const { tenant, piece } = await seed();
    // A cover row from an aborted earlier generation. Without cleanup the
    // partial unique index on (content_piece_id) where role='cover' would
    // reject the new cover.
    await db.insert(contentImages).values({
      tenantId: tenant.id,
      contentPieceId: piece.id,
      role: "cover",
      concept: "stale",
      altText: "stale",
      sourceKind: "generated",
      status: "failed",
    });
    const { deps } = fakes();
    const result = await illustratePiece(
      { tenantId: tenant.id, contentPieceId: piece.id, title: "T", body: BODY, contentType: "blog_post", database: db },
      deps
    );
    expect(result.failures).toBe(0);
    const covers = (await imagesFor(piece.id)).filter((r) => r.role === "cover");
    expect(covers).toHaveLength(1);
    expect(covers[0].concept).toBe("lighthouse");
  });

  it("deletes a leftover row's BLOBS too, through the injected seam — never the real del()", async () => {
    // The realistic regenerate case: an earlier run succeeded, its rows and
    // blobs exist, and this run must not orphan them. Without an injected
    // deleteBlobs this test would call @vercel/blob for real.
    const { tenant, piece } = await seed();
    const [stale] = await db
      .insert(contentImages)
      .values({
        tenantId: tenant.id,
        contentPieceId: piece.id,
        role: "body",
        concept: "stale gears",
        altText: "Stale",
        sourceKind: "generated",
        status: "ready",
      })
      .returning();
    const [staleRender] = await db
      .insert(imageRenders)
      .values({
        imageId: stale.id,
        prompt: "old",
        blobUrl: "https://blob.example/old.png",
        blobPathname: "tenants/x/old.png",
        width: 1200,
        height: 900,
        bytes: 10,
        model: "m",
      })
      .returning();
    await db.update(contentImages).set({ currentRenderId: staleRender.id }).where(eq(contentImages.id, stale.id));

    const { deps, deleteBlobs } = fakes();
    await illustratePiece(
      { tenantId: tenant.id, contentPieceId: piece.id, title: "T", body: BODY, contentType: "blog_post", database: db },
      deps
    );

    expect(deleteBlobs).toHaveBeenCalledWith(["tenants/x/old.png"]);
    expect(await db.select().from(contentImages).where(eq(contentImages.id, stale.id))).toHaveLength(0);
    expect((await imagesFor(piece.id)).map((r) => r.concept).sort()).toEqual(["door", "gears", "lighthouse"]);
  });

  it("leaves an UPLOADED leftover row and its blob alone", async () => {
    const { tenant, piece } = await seed();
    const [uploaded] = await db
      .insert(contentImages)
      .values({
        tenantId: tenant.id,
        contentPieceId: piece.id,
        role: "body",
        concept: "screenshot.png",
        altText: "",
        sourceKind: "uploaded",
        status: "ready",
      })
      .returning();

    const { deps, deleteBlobs } = fakes();
    await illustratePiece(
      { tenantId: tenant.id, contentPieceId: piece.id, title: "T", body: BODY, contentType: "blog_post", database: db },
      deps
    );

    expect(await db.select().from(contentImages).where(eq(contentImages.id, uploaded.id))).toHaveLength(1);
    expect(deleteBlobs).not.toHaveBeenCalled();
  });

  it("keeps blob pathnames short — the slug is clamped, not the raw title", async () => {
    // `slugify` (publishing/slug.ts) allows 200 chars; `slugForImage`
    // (images/blob.ts) clamps to 40. Pathnames are stored on every render row
    // and shown in the Blob UI, so the image slug is the right one here.
    const { tenant, piece } = await seed();
    const longTitle = "The Very Long Title That Keeps Going ".repeat(6);
    const { deps, uploadCalls } = fakes();
    await illustratePiece(
      { tenantId: tenant.id, contentPieceId: piece.id, title: longTitle, body: BODY, contentType: "blog_post", database: db },
      deps
    );
    const coverPath = uploadCalls.find((p) => p.includes("/cover-"))!;
    expect(coverPath.split("/").pop()!.length).toBeLessThanOrEqual(50); // "cover-" + <=40 + ".png"
  });

  it("scopes to the tenant: image rows carry the tenant id", async () => {
    const { tenant, piece } = await seed();
    const { deps } = fakes();
    await illustratePiece(
      { tenantId: tenant.id, contentPieceId: piece.id, title: "T", body: BODY, contentType: "blog_post", database: db },
      deps
    );
    const rows = await db
      .select()
      .from(contentImages)
      .where(and(eq(contentImages.contentPieceId, piece.id), eq(contentImages.tenantId, tenant.id)));
    expect(rows).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run it, expect failure**

`npx vitest run tests/lib/images/illustrate.test.ts` — fails: cannot find module `src/lib/images/illustrate`.

- [ ] **Step 3: Implement**

Create `src/lib/images/illustrate.ts`:

```ts
import { eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { contentImages } from "@/db/schema";
import type { ContentType } from "@/lib/ai/compose-prompt";
import type { DbClient } from "@/lib/publishing/destinations/types";
import { getOrCreateCompanyProfile } from "@/lib/workspace/company-profile";
import { compileStyleBlock, isVisualIdentityReady } from "@/lib/images/visual-identity";
import { resolveImagePolicy } from "@/lib/images/policy";
import { renderImage as defaultRenderImage } from "@/lib/ai/images";
import { imageModelId, IMAGE_MODEL_DEFAULT } from "@/lib/ai/image-model";
import { compressPng as defaultCompressPng } from "@/lib/images/compress";
// `slugForImage`, NOT `slugify`: publishing/slug.ts allows 200 characters (it
// builds public CMS slugs), while a Blob pathname wants the 40-char image slug
// every other image caller uses. Sharing one slug function across the image
// feature is what keeps pathnames consistent and readable.
import { imagePathname, slugForImage, uploadPng as defaultUploadPng } from "@/lib/images/blob";
import { createImage, addRender, markImageFailed, listImages, deleteImage } from "@/lib/images/store";
import { planIllustrations as defaultPlanIllustrations, type IllustrationPlan } from "@/lib/images/plan";
import { spliceImageAfterHeading } from "@/lib/images/splice";

/**
 * Stage 2 of the illustration agent (spec §4): given a finished draft, plan
 * the images, create their rows, render the cover first, then every body
 * image in parallel (each with the fresh cover as a style reference when
 * `pinStyleToCover` is on), compress → Blob → `addRender`, and splice each
 * body image's `![alt](url)` directly after its anchor H2.
 *
 * Runs ONLY from `generateDraftForPiece`. Never on agent edits, extract or
 * catch-up. The caller owns the body write; this returns the spliced body.
 *
 * Failure semantics (spec §4):
 *   - each render is retried once, silently;
 *   - a still-failed body image is omitted from the markdown but its row stays
 *     with `status: "failed"` + concept + anchor, so the draft page can offer
 *     Retry (Task 7) and nothing is silently lost;
 *   - a failed cover leaves the draft coverless; the row stays for Plan 3's
 *     Add-cover menu to pre-fill from;
 *   - anything thrown out of the plan call propagates — `generateDraftForPiece`
 *     turns it into a `generationError` warning, never a failed draft.
 */

export type IllustrateSkipReason = "no_visual_identity" | "policy_off";

export type IllustrateResult = { body: string; failures: number; skipped?: IllustrateSkipReason };

export type IllustrateDeps = {
  planIllustrations?: typeof defaultPlanIllustrations;
  renderImage?: typeof defaultRenderImage;
  uploadPng?: typeof defaultUploadPng;
  compressPng?: typeof defaultCompressPng;
  /**
   * Forwarded to `deleteImage` when clearing leftovers from an aborted run.
   * Present so a test never reaches @vercel/blob's `del()` — `deleteImage`'s
   * own default does, and a leftover row with a render would fire it.
   */
  deleteBlobs?: (pathnames: string[]) => Promise<void>;
};

export const COVER_SIZE = "1200x630" as const;
export const BODY_SIZE = "1200x900" as const;
export const COVER_MAX_WIDTH = 1200;
export const BODY_MAX_WIDTH = 1200;

async function renderWithOneRetry(
  render: typeof defaultRenderImage,
  args: Parameters<typeof defaultRenderImage>[0]
): Promise<Buffer> {
  try {
    return await render(args);
  } catch {
    return await render(args);
  }
}

export async function illustratePiece(
  args: {
    tenantId: string;
    contentPieceId: string;
    title: string;
    body: string;
    contentType: ContentType;
    database?: DbClient;
  },
  deps: IllustrateDeps = {}
): Promise<IllustrateResult> {
  const database = args.database ?? defaultDb;
  const plan = deps.planIllustrations ?? defaultPlanIllustrations;
  const render = deps.renderImage ?? defaultRenderImage;
  const upload = deps.uploadPng ?? defaultUploadPng;
  const compress = deps.compressPng ?? defaultCompressPng;

  // One fetch for both brand inputs (spec §6: policy is read with the rest of
  // the profile). No confirmed visual identity → no images: the draft page
  // nudges toward setup instead of generating something off-brand.
  const profile = await getOrCreateCompanyProfile(args.tenantId, database);
  const vi = profile.visualIdentity;
  if (!isVisualIdentityReady(vi) || vi === null) {
    return { body: args.body, failures: 0, skipped: "no_visual_identity" };
  }

  const policy = resolveImagePolicy(profile.imagePolicy, args.contentType);
  if (!policy.cover && policy.bodyCap === 0) {
    return { body: args.body, failures: 0, skipped: "policy_off" };
  }

  const styleBlock = compileStyleBlock(vi);
  const model = imageModelId(process.env.IMAGE_MODEL ?? IMAGE_MODEL_DEFAULT);

  const illustrationPlan: IllustrationPlan = await plan(
    {
      tenantId: args.tenantId,
      title: args.title,
      body: args.body,
      wantCover: policy.cover,
      bodyCap: policy.bodyCap,
      styleBlock,
      allowText: vi.allowTextInImages,
      database,
    },
    {}
  );
  if (illustrationPlan.cover === null && illustrationPlan.body.length === 0) {
    return { body: args.body, failures: 0 };
  }

  // Leftovers from an earlier aborted/failed run of THIS generation (the piece
  // is still "brief", so no human has placed images yet). The cover's partial
  // unique index would otherwise reject the new cover row, and their blobs
  // would be orphaned. `deleteImage` also removes the blobs. Uploads are left
  // alone on principle.
  const existing = await listImages(args.tenantId, { contentPieceId: args.contentPieceId }, database);
  for (const image of existing) {
    if (image.sourceKind !== "generated") continue;
    if (image.role !== "cover" && image.role !== "body") continue;
    // The deps object is forwarded so tests never reach @vercel/blob. Passing
    // `{}` when no dep is injected keeps `deleteImage`'s own default.
    await deleteImage(args.tenantId, image.id, database, deps.deleteBlobs ? { deleteBlobs: deps.deleteBlobs } : {});
  }

  const brandReferences: (string | Buffer)[] = vi.styleReferenceImages;
  let failures = 0;

  // ---- Cover: first, alone. Its bytes feed the body renders below. ----
  let coverPng: Buffer | null = null;
  if (illustrationPlan.cover) {
    const cover = illustrationPlan.cover;
    const row = await createImage(
      {
        tenantId: args.tenantId,
        contentPieceId: args.contentPieceId,
        role: "cover",
        concept: cover.concept,
        altText: cover.altText,
        sourceKind: "generated",
        status: "pending",
      },
      database
    );
    try {
      const raw = await renderWithOneRetry(render, {
        tenantId: args.tenantId,
        prompt: cover.prompt,
        size: COVER_SIZE,
        referenceImages: brandReferences,
        // Covers are generated wide, never cropped (product owner decision 1,
        // 2026-08-19). `renderImage` sends the size AND the aspect ratio, and
        // re-asks once if what comes back is off 1.91:1 by more than 2%. The
        // guard lives there, in the one render seam, so this call site and
        // Plan 3's `renderAndStore` cannot drift. `compressPng` below still
        // only resizes by width — nothing anywhere crops.
        enforceAspect: true,
        database,
      });
      const { png, width, height } = await compress(raw, COVER_MAX_WIDTH);
      const { url, pathname } = await upload(
        imagePathname({ tenantId: args.tenantId, contentPieceId: args.contentPieceId, role: "cover", slug: slugForImage(args.title) }),
        png
      );
      await addRender(
        { imageId: row.id, prompt: cover.prompt, blobUrl: url, blobPathname: pathname, width, height, bytes: png.byteLength, model },
        database
      );
      coverPng = png;
    } catch (e) {
      console.error(`[images/illustrate] cover render failed for piece ${args.contentPieceId}:`, e);
      await markImageFailed(row.id, database);
      failures += 1;
    }
  }

  // ---- Body: rows first (so the anchor is stored even if the render fails), then all renders in parallel. ----
  const bodyReferences: (string | Buffer)[] =
    vi.pinStyleToCover && coverPng ? [...brandReferences, coverPng] : brandReferences;

  const bodyRows = [];
  for (const entry of illustrationPlan.body) {
    const row = await createImage(
      {
        tenantId: args.tenantId,
        contentPieceId: args.contentPieceId,
        role: "body",
        concept: entry.concept,
        altText: entry.altText,
        sourceKind: "generated",
        status: "pending",
      },
      database
    );
    await database.update(contentImages).set({ anchorHeading: entry.anchorHeading }).where(eq(contentImages.id, row.id));
    bodyRows.push({ row, entry });
  }

  const placed = await Promise.all(
    bodyRows.map(async ({ row, entry }) => {
      try {
        const raw = await renderWithOneRetry(render, {
          tenantId: args.tenantId,
          prompt: entry.prompt,
          size: BODY_SIZE,
          referenceImages: bodyReferences,
          database,
        });
        const { png, width, height } = await compress(raw, BODY_MAX_WIDTH);
        const { url, pathname } = await upload(
          imagePathname({ tenantId: args.tenantId, contentPieceId: args.contentPieceId, role: "body", slug: slugForImage(entry.anchorHeading) }),
          png
        );
        await addRender(
          { imageId: row.id, prompt: entry.prompt, blobUrl: url, blobPathname: pathname, width, height, bytes: png.byteLength, model },
          database
        );
        return { anchorHeading: entry.anchorHeading, markdown: `![${entry.altText}](${url})` };
      } catch (e) {
        console.error(`[images/illustrate] body render failed for piece ${args.contentPieceId} (${entry.anchorHeading}):`, e);
        await markImageFailed(row.id, database);
        return null;
      }
    })
  );

  // Splice sequentially, in plan order, on the caller's body. Each splice
  // touches only its own heading, so order does not change the result.
  let body = args.body;
  for (const item of placed) {
    if (item === null) {
      failures += 1;
      continue;
    }
    body = spliceImageAfterHeading(body, item.anchorHeading, item.markdown);
  }

  return { body, failures };
}
```

If Plan 1's `isVisualIdentityReady` is typed as a type guard (`vi is VisualIdentity`), drop the `|| vi === null` — keep whichever compiles. If `deleteImage` in Plan 1 returns `{ ok: false, reason: "published" }` for a "brief" piece it never will; ignore the return value.

- [ ] **Step 4: Run, expect pass**

`npx vitest run tests/lib/images/illustrate.test.ts` — 10 pass. `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```
git add src/lib/images/illustrate.ts tests/lib/images/illustrate.test.ts
git commit -m "feat: illustratePiece — rows, cover-first render, parallel body renders, splice"
```

---

### Task 5: The `"illustrating"` step

**Files:**
- Modify: `src/lib/drafting/draft-progress.ts` lines 1 and 38–50.
- Modify: `tests/components/paced-steps.test.tsx` lines 254–257.
- No change: `src/components/generation-checklist.tsx` and `src/components/draft-progress-checklist.tsx` (see below), `src/lib/content/generation-progress.ts` (asserts the raw column to `DraftStepKey`, line 47), `EDIT_STEPS` (lines 56–61 — the whole-update agent edit never illustrates; spec §4).

**Interfaces:**
- Produces: `DraftStepKey` gains `"illustrating"`; `DRAFT_STEPS` gains `{ key: "illustrating", label: "Creating images", slow: true }` between `reviewing` and `saving`. (The key stays `illustrating` — internal; the label follows the UX naming rule: "image", not "illustration".)

Why no component change (verified by reading): `generation-checklist.tsx` derives everything from `DRAFT_STEPS` — `statusesForStep` (lines 106–119) walks `DRAFT_STEPS.entries()`, `stepsToAnnounce` (lines 153–162) slices `DRAFT_STEPS`, the checklist renders `steps={DRAFT_STEPS}` (line 476) through `usePacedStatuses<DraftStepKey>(DRAFT_STEPS)` (line 298). `draft-progress-checklist.tsx`'s `usePacedStatuses` (lines 104–160) reads `slow` off the outgoing step definition (line 151), so `slow: true` exempts the ~30–60 s illustrating wait from the 800 ms floor and lets a fast failure out of it advance immediately. `generationStep` is free text (schema.ts lines 621–633) — no migration.

- [ ] **Step 1: Update the failing test first**

In `tests/components/paced-steps.test.tsx` lines 254–257, change the expected slow list:

```ts
    expect(DRAFT_STEPS.filter((step) => step.slow).map((step) => step.key)).toEqual([
      "generating",
      "reviewing",
      "illustrating",
    ]);
```

and extend the comment above it (lines 245–253) with one line: `// "illustrating" is the image plan + renders (src/lib/images/illustrate.ts) — two model round trips, the longest wait in the list.`

Run `npx vitest run tests/components/paced-steps.test.tsx` — the slow-steps test fails (`["generating","reviewing"]` ≠ expected).

- [ ] **Step 2: Add the step**

`src/lib/drafting/draft-progress.ts` line 1:

```ts
export type DraftStepKey = "collecting" | "preparing" | "generating" | "reviewing" | "illustrating" | "saving";
```

Lines 38–50, insert after the `reviewing` entry (line 48) and before `saving`:

```ts
  // The illustration agent (spec 2026-08-18 §4): one text-model plan call,
  // then a cover render and the body renders in parallel — two image
  // round trips, ~30-60 s. Blocks draft readiness by design (the body is one
  // text column with hand-edit-freeze semantics; splicing images in after
  // save would race the human's first edit). `slow` for the same reason as
  // the two above: nothing here is bookkeeping.
  { key: "illustrating", label: "Creating images", slow: true },
```

- [ ] **Step 3: Run**

`npx vitest run tests/components/paced-steps.test.tsx tests/components/generation-checklist.test.tsx` — all pass. `npm run typecheck`.

- [ ] **Step 4: Commit**

```
git add src/lib/drafting/draft-progress.ts tests/components/paced-steps.test.tsx
git commit -m "feat: illustrating step between reviewing and saving in the draft loader"
```

---

### Task 6: Wire `illustratePiece` into `generateDraftForPiece`

**Files:**
- Modify: `src/lib/briefs/draft.ts` — imports (lines 18–25), the docstring's exit list (lines 250–259, unchanged count: illustrate never adds an exit), `deps` type (lines 289–295), dep defaults (lines 297–300), the stretch between the inner `try`/`catch` end (line 486) and `setStep(database, contentPieceId, "saving")` (line 508).
- Modify: `src/db/schema.ts` `generationError` comment (lines 608–616) — the "status draft + set" meaning widens to "post-generation warning" (competitor scan OR illustration failure).
- Modify: `src/app/(dashboard)/drafts/[releaseId]/page.tsx` line 285: banner heading `Possible competitor mention` → `Generation notes` (the same banner now carries illustration warnings; the body text still spells out which).
- Test: `tests/lib/briefs/draft.test.ts` — append a `describe("generateDraftForPiece — illustrations")` block.

**Interfaces:**
- Consumes: `illustratePiece`, `IllustrateResult` (Task 4).
- Produces: `generateDraftForPiece(contentPieceId, tenantId, deps)` gains `deps.illustrate?: Illustrator` where
  ```ts
  export type Illustrator = (args: {
    tenantId: string; contentPieceId: string; title: string; body: string; contentType: ContentType; database?: Database;
  }) => Promise<IllustrateResult>;
  ```

**Where exactly.** After the inner `try { … } catch (e) { … return { ok: false } }` closes at line 486, `result` is set on both branches (release: line 468; generic: line 470) — that is where the two branches converge. The competitor scan (lines 496–506) computes `generationError`. Illustration goes **between the scan and `setStep("saving")` (line 508)**, outside the inner try so an illustrate throw is a warning, not a failed draft; the outer catch (line 597) still covers a DB failure inside it — acceptable, that is a real failure. Placing it after the scan means the scan sees the pre-image body (image markdown contains no company names; either order is equivalent — this order keeps `generationError` composition in one place).

**Existing tests are unaffected without stubbing** (verified): `seedTenant()` in `tests/lib/briefs/draft.test.ts` line 58 inserts a `companyProfiles` row with no `visualIdentity`, so the real `illustratePiece` returns `skipped: "no_visual_identity"` before touching any network module — the default dep is safe in every existing test. The new tests inject `illustrate` explicitly.

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/briefs/draft.test.ts` (after the release-fork `describe`, before EOF). Add to the imports at the top:

```ts
import { illustratePiece, type IllustrateResult } from "../../../src/lib/images/illustrate";
import { contentImages } from "../../../src/db/schema";           // if not already imported
import { seedVisualIdentity } from "../../helpers/fixtures";      // Plan 1 Task 10b
```

and add `type Illustrator,` to the existing `from "../../../src/lib/briefs/draft"` import (lines 35–41). Note this file's local `seedTenant()` takes no argument (it wraps the shared helper with a file-local tenant name) — `seedVisualIdentity(tenant.id)` composes with it.

```ts
/**
 * The illustration agent runs between review and save (spec 2026-08-18 §4),
 * behind `deps.illustrate`. Images block draft readiness on purpose; a failed
 * illustration pass never fails the draft.
 */
describe("generateDraftForPiece — illustrations", () => {
  const WITH_IMAGES = "# T\n\n## A\n\n![Gears](https://blob.example/g.png)\n\nBody.";

  it("writes the illustrating step, hands the reviewed body to the illustrator, and saves the spliced body", async () => {
    const tenant = await seedTenant();
    const { piece } = await seedPieceWithBrief(tenant.id);
    let stepDuring: string | null | undefined;
    let received: { title: string; body: string; contentType: string; contentPieceId: string; tenantId: string } | undefined;

    const illustrate = vi.fn(async (args: Parameters<Illustrator>[0]): Promise<IllustrateResult> => {
      received = args;
      const [current] = await db.select({ step: contentPieces.generationStep }).from(contentPieces).where(eq(contentPieces.id, piece.id));
      stepDuring = current.step;
      return { body: WITH_IMAGES, failures: 0 };
    });

    const result = await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate: vi.fn(async () => ({ title: "Real title", body: "# T\n\n## A\n\nBody." })),
      illustrate,
    });
    expect(result.ok).toBe(true);
    expect(stepDuring).toBe("illustrating");
    expect(received).toMatchObject({
      tenantId: tenant.id,
      contentPieceId: piece.id,
      title: "Real title",
      body: "# T\n\n## A\n\nBody.",
      contentType: "blog_post",
    });

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("draft");
    expect(after.body).toBe(WITH_IMAGES);
    expect(after.generationError).toBeNull();
    expect(after.generationStep).toBeNull();
  });

  it("runs the illustrator on the RELEASE branch too, on the reviewed body", async () => {
    const tenant = await seedTenant();
    const { piece, brief } = await seedPieceWithBrief(tenant.id, { type: "product_update" }, { contentType: "product_update" });
    await seedShippedWork({ tenantId: tenant.id, briefId: brief.id });

    const illustrate = vi.fn(async (): Promise<IllustrateResult> => ({ body: WITH_IMAGES, failures: 0 }));
    const result = await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate: vi.fn(async () => ({ title: "Brief title", body: "Brief body." })),
      generateRelease: vi.fn(async () => ({ title: "Release title", body: "Release body." })),
      review: async (draft) => ({ finalDraft: { title: draft.title, body: "REVIEWED body." }, status: "passed", issues: [] }),
      illustrate,
    });
    expect(result.ok).toBe(true);
    expect(illustrate.mock.calls[0][0]).toMatchObject({ body: "REVIEWED body.", contentType: "product_update" });

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.body).toBe(WITH_IMAGES);
  });

  it("saves the draft with a warning, not a failure, when the illustrator throws", async () => {
    const tenant = await seedTenant();
    const { piece } = await seedPieceWithBrief(tenant.id);
    const illustrate = vi.fn(async (): Promise<IllustrateResult> => {
      throw new Error("plan call exploded");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate: vi.fn(async () => ({ title: "T", body: "Plain body." })),
      illustrate,
    });
    expect(result.ok).toBe(true);

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("draft");
    expect(after.body).toBe("Plain body.");
    expect(after.generationError).toContain("Images could not be generated");
    expect(after.generationStep).toBeNull();
    expect(errors.mock.calls.map((c) => String(c[0])).join("\n")).toContain(piece.id);
  });

  it("does NOT warn in generationError when some renders failed — the failed-images notice owns that state", async () => {
    // A banner copy of the count would go stale the moment a Retry succeeds
    // (generationError only clears on the next body-changing save) and would
    // flag the board card as "Flagged copy" for a non-copy problem. The
    // failed rows themselves drive the live notice (Task 7).
    const tenant = await seedTenant();
    const { piece } = await seedPieceWithBrief(tenant.id);
    const illustrate = vi.fn(async (): Promise<IllustrateResult> => ({ body: WITH_IMAGES, failures: 2 }));

    const result = await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate: vi.fn(async () => ({ title: "T", body: "B" })),
      illustrate,
    });
    expect(result.ok).toBe(true);
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.body).toBe(WITH_IMAGES);
    expect(after.generationError).toBeNull();
  });

  it("keeps the competitor warning AND adds the images warning when the illustrator throws", async () => {
    const tenant = await seedTenant();
    await db.insert(competitors).values({ tenantId: tenant.id, name: "Phrase" });
    const { piece } = await seedPieceWithBrief(tenant.id, { type: "product_update" });
    const illustrate = vi.fn(async (): Promise<IllustrateResult> => {
      throw new Error("plan call exploded");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate: vi.fn(async () => ({ title: "T", body: "As Phrase showed…" })),
      illustrate,
    });
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.generationError).toContain("Phrase");
    expect(after.generationError).toContain("Images could not be generated");
    expect(errors).toHaveBeenCalled();
  });

  it("does not run the illustrator when generation itself failed", async () => {
    const tenant = await seedTenant();
    const { piece } = await seedPieceWithBrief(tenant.id);
    const illustrate = vi.fn(async (): Promise<IllustrateResult> => ({ body: "x", failures: 0 }));
    await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate: vi.fn(async () => {
        throw new Error("model timeout");
      }),
      illustrate,
    });
    expect(illustrate).not.toHaveBeenCalled();
  });

  /**
   * The one end-to-end-ish test in this plan: the REAL `illustratePiece` and
   * the REAL `planIllustrations` post-validation and splice, with only the
   * three network seams faked. Every other test in this block stubs
   * `illustrate` wholesale, so nothing else would catch a wiring break between
   * generateDraftForPiece → illustratePiece → planIllustrations →
   * spliceImageAfterHeading → the body write. Uses the shared fixtures
   * (tests/helpers/fixtures.ts) so the "identity is ready" state is defined in
   * one place.
   */
  it("end to end: a ready tenant gets a cover row and image markdown in the SAVED body", async () => {
    const tenant = await seedTenant();
    await seedVisualIdentity(tenant.id);
    const { piece } = await seedPieceWithBrief(tenant.id);

    const rendered = "# T\n\nIntro.\n\n## Alpha\n\nA para.\n\n## Beta\n\nB para.";
    let uploads = 0;

    const result = await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate: vi.fn(async () => ({ title: "Real title", body: rendered })),
      // The real illustratePiece, with only the network seams faked.
      illustrate: (args) =>
        illustratePiece(args, {
          planIllustrations: async () => ({
            cover: { concept: "lighthouse", prompt: "P cover", altText: "A lighthouse beam" },
            body: [{ anchorHeading: "Alpha", concept: "gears", prompt: "P alpha", altText: "Gears turning" }],
          }),
          renderImage: (async () => Buffer.from("PNG")) as never,
          compressPng: async (png: Buffer, maxWidth: number) => ({ png, width: maxWidth, height: 900 }),
          uploadPng: async (pathname: string) => ({
            url: `https://blob.example/${pathname}-${++uploads}`,
            pathname: `${pathname}-${uploads}`,
          }),
          deleteBlobs: async () => {},
        }),
    });

    expect(result.ok).toBe(true);

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("draft");
    expect(after.generationError).toBeNull();
    expect(after.generationStep).toBeNull();
    // The body image landed under its anchor, by blob URL (spec §3).
    expect(after.body).toMatch(/## Alpha\n\n!\[Gears turning\]\(https:\/\/blob\.example\/tenants\/[^)]+\)\n\nA para\./);
    // The cover is NOT in the body (spec §3) — it is a row.
    expect(after.body).not.toContain("lighthouse");
    expect(after.body).toContain("## Beta\n\nB para.");

    const rows = await db.select().from(contentImages).where(eq(contentImages.contentPieceId, piece.id));
    expect(rows.map((r) => r.role).sort()).toEqual(["body", "cover"]);
    expect(rows.every((r) => r.status === "ready" && r.currentRenderId !== null)).toBe(true);
    expect(rows.find((r) => r.role === "body")!.anchorHeading).toBe("Alpha");
  });

  it("uses the real illustrator by default, which skips cleanly when the tenant has no visual identity", async () => {
    // seedTenant() writes a companyProfiles row with visualIdentity null —
    // the real `illustratePiece` returns before touching any network module.
    // This is what keeps every OTHER test in this file honest without a stub.
    const tenant = await seedTenant();
    const { piece } = await seedPieceWithBrief(tenant.id);
    const result = await generateDraftForPiece(piece.id, tenant.id, {
      database: db,
      generate: vi.fn(async () => ({ title: "T", body: "## A\n\nBody." })),
    });
    expect(result.ok).toBe(true);
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.body).toBe("## A\n\nBody.");
    expect(after.generationError).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect failure**

`npx vitest run tests/lib/briefs/draft.test.ts` — the new block fails: `illustrate` is not a known dep (never called; step never written; TS error on the unknown property).

- [ ] **Step 3: Implement in `src/lib/briefs/draft.ts`**

(a) Imports — after line 25 (`import type { DraftStepKey } …`) add:

```ts
import { illustratePiece, type IllustrateResult } from "@/lib/images/illustrate";
import type { ContentType } from "@/lib/ai/compose-prompt";
```

(b) After the `DraftReviewer` type (line 52) add:

```ts
/** `illustratePiece`'s shape, as a seam. */
export type Illustrator = (args: {
  tenantId: string;
  contentPieceId: string;
  title: string;
  body: string;
  contentType: ContentType;
  database?: Database;
}) => Promise<IllustrateResult>;
```

(c) In the `generateDraftForPiece` signature (lines 289–295) add `illustrate?: Illustrator;` after `checkLink?: LinkCheck;`. After line 300 (`const review = …`) add:

```ts
  const illustrate = deps.illustrate ?? illustratePiece;
```

(d) Replace lines 503–508 (`const generationError = …` through `await setStep(database, contentPieceId, "saving");`) with:

```ts
    const warnings: string[] = [];
    if (matches.length > 0) {
      warnings.push(
        `This product update may name a company from your competitors list: ${matches.join(", ")}. This only checks names on that list, not every company — review before publishing.`
      );
    }

    // The illustration agent (spec 2026-08-18 §4). Runs on BOTH branches, on
    // the final reviewed body, and blocks draft readiness on purpose: the body
    // is one text column with hand-edit-freeze semantics, so splicing images
    // in after the save would race the human's first edit.
    //
    // Outside the inner try above, deliberately: a thrown plan call or a DB
    // hiccup inside the agent is a WARNING on a real draft, never a failed
    // generation — the words are done and the human should get them.
    //
    // Failed renders are deliberately NOT added to generationError: their rows
    // stay `failed` and the draft page's failed-images notice (Task 7) shows a
    // live count with Retry. A banner copy of the count would go stale the
    // moment a Retry succeeds (generationError only clears on the next
    // body-changing save) and would mark the board card "Flagged copy" for a
    // problem that has nothing to do with the copy.
    // Everything after `result` was set — including the writes below — is
    // still covered by the outer catch for genuine failures.
    await setStep(database, contentPieceId, "illustrating");
    try {
      const illustrated = await illustrate({
        tenantId,
        contentPieceId,
        title: result.title,
        body: result.body,
        contentType: piece.type,
        database,
      });
      result = { title: result.title, body: illustrated.body };
    } catch (e) {
      console.error(`[briefs/draft] illustration failed for piece ${contentPieceId}:`, e);
      warnings.push("Images could not be generated. The draft is complete without them.");
    }

    const generationError = warnings.length > 0 ? warnings.join(" ") : null;

    await setStep(database, contentPieceId, "saving");
```

Note `result` is `let` (line 437) so reassigning is fine. `piece.type` is the piece's `ContentType` (schema.ts line 592) — the illustration policy is per PIECE type, matching what the settings card configures.

(e) Update the `generateDraftForPiece` docstring's step narrative (lines 250–259 list exits — unchanged) by adding one sentence after "The interrupted-generation marker is not an exit: it SETS "generating".":

```
 * "illustrating" is written after review on both branches and is not an
 * exit either: the illustration pass can only warn (see the block above
 * `setStep("saving")`), never fail the draft.
```

(f) `src/db/schema.ts` lines 612–613, change the second meaning:

```ts
  //   status "draft" + set  -> the draft is real, but generation left a
  //                            warning: the post-generation name scan matched
  //                            something, and/or the whole illustration pass
  //                            threw (src/lib/briefs/draft.ts joins them into
  //                            one text). Individual failed renders are NOT
  //                            here — their `failed` content_images rows drive
  //                            the draft page's live notice instead.
```

(g) `src/app/(dashboard)/drafts/[releaseId]/page.tsx` line 285: `<p className="font-medium">Possible competitor mention</p>` → `<p className="font-medium">Generation notes</p>`, and update the comment above it (lines 271–282) so its first sentence reads: "…in every one of those cases it means generation finished with a warning — the competitor-name scan matched something, and/or images could not be generated at all (see draft.ts) — not a failure."

- [ ] **Step 4: Run**

`npx vitest run tests/lib/briefs/draft.test.ts` (twice — the file is big and the DB is shared) — all pass, including every pre-existing test. `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```
git add src/lib/briefs/draft.ts src/db/schema.ts "src/app/(dashboard)/drafts/[releaseId]/page.tsx" tests/lib/briefs/draft.test.ts
git commit -m "feat: illustrate the draft between review and save; failures warn, never fail"
```

---

### Task 7: Failed-illustration notice + Retry on the draft page

**Files:**
- Create: `src/app/(dashboard)/drafts/[releaseId]/illustration-actions.ts` (`"use server"`)
- Create: `src/app/(dashboard)/drafts/[releaseId]/failed-illustrations-notice.tsx` (async Server Component)
- Create: `src/app/(dashboard)/drafts/[releaseId]/retry-illustration-button.tsx` (`"use client"`)
- Modify: `src/app/(dashboard)/drafts/[releaseId]/page.tsx` — import block (after line 32) and the editor branch after line 288 (the `generationError` banner) / before line 290 (`showCodeWarning`).
- Test: `tests/app/drafts/illustration-actions.test.ts`

**Interfaces:**
- Consumes: `requireSession` (`src/lib/workspace/session.ts`), `getImage`, `addRender`, `listImages` (Plan 1 store), `buildImagePrompt`, `compileStyleBlock`, `isVisualIdentityReady`, `renderImage`, `compressPng`, `uploadPng`, `imagePathname`, `imageModelId`, `IMAGE_MODEL_DEFAULT`, `getOrCreateCompanyProfile`, `assertDraftEditable` (`src/lib/draft-editable.ts`), `spliceImageAfterHeading` (Task 1), `slugForImage`.
- Produces:
  ```ts
  // illustration-actions.ts
  export async function retryFailedIllustration(input: { contentPieceId: string; imageId: string }):
    Promise<{ ok: true; placed: boolean; url: string } | { ok: false; error: string }>;
  // Dismiss (spec §4 calls the notice "dismissible"): deletes the piece's
  // failed generated rows, so the notice disappears for good and the library
  // never shows dead "failed" cards. An explicit dismissal is not a *silent*
  // loss of the concept.
  export async function dismissFailedIllustrations(input: { contentPieceId: string }):
    Promise<{ ok: true } | { ok: false; error: string }>;
  ```
  `placed: false` means the render succeeded (row is now `ready`, blob uploaded) but the stored anchor heading no longer exists in the body — the body was left untouched and the toast tells the user to place it from the library (Plan 3 §5b) rather than dumping it at the end of the piece.

Body write semantics (read `drafts/[releaseId]/actions.ts` lines 103–122): `saveDraftBody` stamps `bodyEditedAt` on change, which freezes regeneration (`generateDraftForPiece` lines 337–340) — an agent placing its own image is not a hand edit, so this action writes `body` directly with the same tenant guard as `loadOwnedDraft` (lines 15–22) and does **not** stamp `bodyEditedAt` or `editedBy`. Same discipline as `linkedin-actions.ts` line 46–48 ("Generation path: never marks the write as a hand-edit").

Known limitation, stated in the notice copy: the retry writes the stored body server-side; unsaved edits sitting in the editor would, on the next Save, overwrite the body without the new image line (the row stays `ready`; the image is recoverable from the library). The notice says "Save your changes first, then retry."

- [ ] **Step 1: Write the failing test**

Create `tests/app/drafts/illustration-actions.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, contentPieces, companyProfiles, contentImages, imageRenders, users, type VisualIdentity } from "../../../src/db/schema";
import { DEFAULT_VISUAL_IDENTITY } from "../../../src/lib/images/visual-identity";

const TENANT_NAME = "Illustration Actions Test Tenant";
const OTHER_NAME = "Illustration Actions Other Tenant";
const USER_EMAIL = "illustration-actions-test@example.com";
let currentTenantId = "";
let currentUserId: string | null = null;

vi.mock("../../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: currentUserId } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

type RenderArgs = { prompt: string; size: string; referenceImages?: (string | Buffer)[]; enforceAspect?: boolean };
const renderImage = vi.fn(async (_args: RenderArgs) => Buffer.from("PNG"));
vi.mock("../../../src/lib/ai/images", () => ({ renderImage: (a: RenderArgs) => renderImage(a) }));
vi.mock("../../../src/lib/images/compress", () => ({
  compressPng: vi.fn(async (png: Buffer, maxWidth: number) => ({ png, width: maxWidth, height: 900 })),
}));
vi.mock("../../../src/lib/images/blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/images/blob")>();
  return {
    ...actual,
    uploadPng: vi.fn(async (pathname: string) => ({ url: `https://blob.example/${pathname}`, pathname })),
    deleteBlobs: vi.fn(async () => {}),
  };
});

import { retryFailedIllustration, dismissFailedIllustrations } from "../../../src/app/(dashboard)/drafts/[releaseId]/illustration-actions";

const VI: VisualIdentity = {
  ...DEFAULT_VISUAL_IDENTITY,
  palette: [
    { hex: "#112233", role: "primary" },
    { hex: "#445566", role: "secondary" },
    { hex: "#ffffff", role: "background" },
  ],
};

const BODY = "Intro.\n\n## Alpha\n\nA para.\n\n## Beta\n\nB para.";

async function seed(opts: { anchor?: string | null; status?: "draft" | "published"; role?: "body" | "cover" } = {}) {
  const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
  const [user] = await db.insert(users).values({ email: USER_EMAIL }).returning();
  currentTenantId = tenant.id;
  currentUserId = user.id;
  await db.insert(companyProfiles).values({ tenantId: tenant.id, topics: [], visualIdentity: VI });
  const [piece] = await db
    .insert(contentPieces)
    .values({ tenantId: tenant.id, type: "blog_post", title: "T", body: BODY, status: opts.status ?? "draft" })
    .returning();
  const [image] = await db
    .insert(contentImages)
    .values({
      tenantId: tenant.id,
      contentPieceId: piece.id,
      role: opts.role ?? "body",
      concept: "gears meshing",
      altText: "Gears meshing",
      sourceKind: "generated",
      status: "failed",
      anchorHeading: opts.anchor === undefined ? "Beta" : opts.anchor,
    })
    .returning();
  return { tenant, piece, image };
}

afterEach(async () => {
  renderImage.mockClear();
  await db.delete(tenants).where(eq(tenants.name, TENANT_NAME));
  await db.delete(tenants).where(eq(tenants.name, OTHER_NAME));
  await db.delete(users).where(eq(users.email, USER_EMAIL));
});

describe("retryFailedIllustration", () => {
  it("re-renders from the stored concept, adds a render, and splices at the stored anchor without stamping bodyEditedAt", async () => {
    const { piece, image } = await seed();
    const result = await retryFailedIllustration({ contentPieceId: piece.id, imageId: image.id });
    expect(result).toMatchObject({ ok: true, placed: true });

    // The prompt is rebuilt from the concept + the CURRENT style block, in code.
    expect(renderImage).toHaveBeenCalledTimes(1);
    expect(renderImage.mock.calls[0][0].prompt).toContain("gears meshing");
    expect(renderImage.mock.calls[0][0].prompt).toContain("#112233");

    const [row] = await db.select().from(contentImages).where(eq(contentImages.id, image.id));
    expect(row.status).toBe("ready");
    expect(row.currentRenderId).not.toBeNull();
    const [render] = await db.select().from(imageRenders).where(eq(imageRenders.imageId, image.id));
    expect(render.prompt).toBe(renderImage.mock.calls[0][0].prompt);

    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.body).toBe(`Intro.\n\n## Alpha\n\nA para.\n\n## Beta\n\n![Gears meshing](${render.blobUrl})\n\nB para.`);
    expect(after.bodyEditedAt).toBeNull();
    expect(after.editedBy).toBeNull();
  });

  it("re-renders a failed cover without touching the body", async () => {
    const { piece, image } = await seed({ role: "cover", anchor: null });
    const result = await retryFailedIllustration({ contentPieceId: piece.id, imageId: image.id });
    expect(result).toMatchObject({ ok: true, placed: true });
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.body).toBe(BODY);
    const [row] = await db.select().from(contentImages).where(eq(contentImages.id, image.id));
    expect(row.status).toBe("ready");
  });

  it("renders but reports placed:false when the anchor heading no longer exists", async () => {
    const { piece, image } = await seed({ anchor: "Gone" });
    const result = await retryFailedIllustration({ contentPieceId: piece.id, imageId: image.id });
    expect(result).toMatchObject({ ok: true, placed: false });
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.body).toBe(BODY);
    const [row] = await db.select().from(contentImages).where(eq(contentImages.id, image.id));
    expect(row.status).toBe("ready");
  });

  it("refuses an image that is not failed", async () => {
    const { piece, image } = await seed();
    await db.update(contentImages).set({ status: "ready" }).where(eq(contentImages.id, image.id));
    const result = await retryFailedIllustration({ contentPieceId: piece.id, imageId: image.id });
    expect(result.ok).toBe(false);
    expect(renderImage).not.toHaveBeenCalled();
  });

  it("refuses another tenant's image and never renders", async () => {
    await seed();
    const [other] = await db.insert(tenants).values({ name: OTHER_NAME }).returning();
    const [foreignPiece] = await db.insert(contentPieces).values({ tenantId: other.id, title: "X", body: "b" }).returning();
    const [foreign] = await db
      .insert(contentImages)
      .values({ tenantId: other.id, contentPieceId: foreignPiece.id, role: "body", concept: "c", altText: "a", sourceKind: "generated", status: "failed" })
      .returning();
    const result = await retryFailedIllustration({ contentPieceId: foreignPiece.id, imageId: foreign.id });
    expect(result.ok).toBe(false);
    expect(renderImage).not.toHaveBeenCalled();
  });

  it("refuses an image that belongs to a different piece than the one named", async () => {
    const { tenant, image } = await seed();
    const [otherPiece] = await db.insert(contentPieces).values({ tenantId: tenant.id, title: "Y", body: "b" }).returning();
    const result = await retryFailedIllustration({ contentPieceId: otherPiece.id, imageId: image.id });
    expect(result.ok).toBe(false);
    expect(renderImage).not.toHaveBeenCalled();
  });

  it("refuses when the piece is no longer editable", async () => {
    const { piece, image } = await seed({ status: "published" });
    const result = await retryFailedIllustration({ contentPieceId: piece.id, imageId: image.id });
    expect(result.ok).toBe(false);
    expect(renderImage).not.toHaveBeenCalled();
  });

  it("passes the piece's ready cover as a style reference for a BODY retry when pinStyleToCover is on", async () => {
    // The whole-post consistency the agent buys with pinStyleToCover must
    // survive a retry, or the retried image is the one that looks wrong.
    const { tenant, piece, image } = await seed();
    const [cover] = await db
      .insert(contentImages)
      .values({ tenantId: tenant.id, contentPieceId: piece.id, role: "cover", concept: "c", altText: "a", sourceKind: "generated", status: "ready" })
      .returning();
    const [coverRender] = await db
      .insert(imageRenders)
      .values({ imageId: cover.id, prompt: "p", blobUrl: "https://blob.example/cover.png", blobPathname: "p/cover.png", width: 1200, height: 630, bytes: 10, model: "m" })
      .returning();
    await db.update(contentImages).set({ currentRenderId: coverRender.id }).where(eq(contentImages.id, cover.id));

    await retryFailedIllustration({ contentPieceId: piece.id, imageId: image.id });

    expect(renderImage.mock.calls[0][0].referenceImages).toContain("https://blob.example/cover.png");
  });

  it("holds a retried COVER to 1200x630", async () => {
    // Product owner decision 1: covers are generated wide, never cropped —
    // and a retry is a generation like any other, so it asks for the shape
    // the same way (renderImage restates size + aspect ratio and re-asks once).
    const { piece, image } = await seed({ role: "cover", anchor: null });
    await retryFailedIllustration({ contentPieceId: piece.id, imageId: image.id });
    expect(renderImage.mock.calls[0][0]).toMatchObject({ size: "1200x630", enforceAspect: true });
  });

  it("does not guard the shape of a retried body image", async () => {
    const { piece, image } = await seed();
    await retryFailedIllustration({ contentPieceId: piece.id, imageId: image.id });
    expect(renderImage.mock.calls[0][0]).toMatchObject({ size: "1200x900" });
    expect(renderImage.mock.calls[0][0].enforceAspect).toBeFalsy();
  });

  it("does NOT pass the cover as a reference when retrying the cover itself", async () => {
    const { piece, image } = await seed({ role: "cover", anchor: null });
    await retryFailedIllustration({ contentPieceId: piece.id, imageId: image.id });
    expect(renderImage.mock.calls[0][0].referenceImages).toEqual([]);
  });

  it("marks the row failed again and reports the error when the render fails twice", async () => {
    const { piece, image } = await seed();
    renderImage.mockImplementation(async () => {
      throw new Error("model down");
    });
    const result = await retryFailedIllustration({ contentPieceId: piece.id, imageId: image.id });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("model down") });
    expect(renderImage).toHaveBeenCalledTimes(2);
    const [row] = await db.select().from(contentImages).where(eq(contentImages.id, image.id));
    expect(row.status).toBe("failed");
  });
});

describe("dismissFailedIllustrations", () => {
  it("deletes the piece's failed generated rows so the notice disappears", async () => {
    const { piece, image } = await seed();
    expect(await dismissFailedIllustrations({ contentPieceId: piece.id })).toEqual({ ok: true });
    expect(await db.select().from(contentImages).where(eq(contentImages.id, image.id))).toHaveLength(0);
  });

  it("leaves ready and uploaded images alone", async () => {
    const { tenant, piece } = await seed();
    const [ready] = await db
      .insert(contentImages)
      .values({ tenantId: tenant.id, contentPieceId: piece.id, role: "body", concept: "keep", altText: "Keep", sourceKind: "uploaded", status: "ready" })
      .returning();
    await dismissFailedIllustrations({ contentPieceId: piece.id });
    expect(await db.select().from(contentImages).where(eq(contentImages.id, ready.id))).toHaveLength(1);
  });

  it("refuses another tenant's piece", async () => {
    const { image } = await seed();
    const [other] = await db.insert(tenants).values({ name: OTHER_NAME }).returning();
    const [foreignPiece] = await db.insert(contentPieces).values({ tenantId: other.id, title: "X", body: "b" }).returning();
    currentTenantId = other.id;
    // The other tenant can dismiss only its own pieces; ours is untouched.
    expect((await dismissFailedIllustrations({ contentPieceId: foreignPiece.id })).ok).toBe(true);
    expect(await db.select().from(contentImages).where(eq(contentImages.id, image.id))).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run, expect failure**

`npx vitest run tests/app/drafts/illustration-actions.test.ts` — cannot find module `illustration-actions`.

- [ ] **Step 3: Implement the action**

Create `src/app/(dashboard)/drafts/[releaseId]/illustration-actions.ts`:

```ts
"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { contentPieces } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { assertDraftEditable } from "@/lib/draft-editable";
import { getOrCreateCompanyProfile } from "@/lib/workspace/company-profile";
import { compileStyleBlock, isVisualIdentityReady } from "@/lib/images/visual-identity";
import { buildImagePrompt } from "@/lib/images/prompt";
import { getImage, getCoverImage, addRender, markImageFailed, listImages, deleteImage } from "@/lib/images/store";
import { renderImage } from "@/lib/ai/images";
import { imageModelId, IMAGE_MODEL_DEFAULT } from "@/lib/ai/image-model";
import { compressPng } from "@/lib/images/compress";
import { imagePathname, slugForImage, uploadPng } from "@/lib/images/blob";
import { spliceImageAfterHeading } from "@/lib/images/splice";

/**
 * Retry for an illustration the agent could not render (spec §4 failure
 * handling). Re-renders from the row's stored CONCEPT with the CURRENT style
 * block — the concept is what survived, the prompt is rebuilt the same way the
 * agent built it — uploads, records the render, and for a body image splices
 * `![alt](url)` after the row's stored anchor heading.
 *
 * Writes the body directly, with the same tenant guard as `loadOwnedDraft`,
 * and does NOT stamp `bodyEditedAt`/`editedBy`: an agent placing its own image
 * is not a hand edit, and stamping it would freeze regeneration
 * (`generateDraftForPiece` refuses a hand-edited body). Same rule
 * `linkedin-actions.ts` follows for generated copy.
 *
 * Returns a result object rather than throwing, like Plan 3's image actions:
 * the button toasts the message.
 */
export async function retryFailedIllustration(input: {
  contentPieceId: string;
  imageId: string;
}): Promise<{ ok: true; placed: boolean; url: string } | { ok: false; error: string }> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;

  const [piece] = await db
    .select()
    .from(contentPieces)
    .where(and(eq(contentPieces.id, input.contentPieceId), eq(contentPieces.tenantId, tenantId)));
  if (!piece) return { ok: false, error: "Draft not found." };
  try {
    assertDraftEditable(piece);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  // Tenant-scoped by `getImage`; the piece check closes the "my image, but
  // named against a different piece id" hole.
  const image = await getImage(tenantId, input.imageId);
  if (!image || image.contentPieceId !== piece.id) return { ok: false, error: "Image not found." };
  if (image.status !== "failed") return { ok: false, error: "This image doesn't need a retry." };
  if (image.role !== "body" && image.role !== "cover") return { ok: false, error: "Only generated cover and body images can be retried here." };

  const profile = await getOrCreateCompanyProfile(tenantId);
  const vi = profile.visualIdentity;
  if (!isVisualIdentityReady(vi) || vi === null) {
    return { ok: false, error: "Set up your visual identity in Company settings before generating images." };
  }

  const prompt = buildImagePrompt({
    styleBlock: compileStyleBlock(vi),
    concept: image.concept,
    role: image.role,
    allowText: vi.allowTextInImages,
  });
  const size = image.role === "cover" ? "1200x630" : "1200x900";
  const model = imageModelId(process.env.IMAGE_MODEL ?? IMAGE_MODEL_DEFAULT);

  // Same reference set the agent used (`illustratePiece`): brand references,
  // plus the piece's ready cover for a BODY image when `pinStyleToCover` is on.
  // Without this a retried body image is styled off the brand references alone
  // and visibly differs from its siblings — the exact whole-post consistency
  // the setting exists to buy.
  const referenceImages: (string | Buffer)[] = [...vi.styleReferenceImages];
  if (image.role === "body" && vi.pinStyleToCover) {
    const cover = await getCoverImage(tenantId, piece.id);
    if (cover?.current) referenceImages.push(cover.current.blobUrl);
  }

  // A retried COVER goes through the same aspect guard as a generated one
  // (product owner decision 1): size + aspect ratio stated, one measured
  // re-ask, never a crop.
  const enforceAspect = image.role === "cover";

  let url: string;
  try {
    let raw: Buffer;
    try {
      raw = await renderImage({ tenantId, prompt, size, referenceImages, enforceAspect });
    } catch {
      raw = await renderImage({ tenantId, prompt, size, referenceImages, enforceAspect });
    }
    const { png, width, height } = await compressPng(raw, 1200);
    const uploaded = await uploadPng(
      imagePathname({
        tenantId,
        contentPieceId: piece.id,
        role: image.role,
        slug: slugForImage(image.role === "cover" ? piece.title : (image.anchorHeading ?? image.concept)),
      }),
      png
    );
    await addRender({
      imageId: image.id,
      prompt,
      blobUrl: uploaded.url,
      blobPathname: uploaded.pathname,
      width,
      height,
      bytes: png.byteLength,
      model,
    });
    url = uploaded.url;
  } catch (e) {
    await markImageFailed(image.id);
    return { ok: false, error: `The image could not be generated: ${e instanceof Error ? e.message : String(e)}` };
  }

  let placed = true;
  if (image.role === "body") {
    const markdown = `![${image.altText}](${url})`;
    const anchor = image.anchorHeading ?? "";
    const next = anchor ? spliceImageAfterHeading(piece.body, anchor, markdown) : piece.body;
    placed = next !== piece.body;
    if (placed) {
      await db
        .update(contentPieces)
        .set({ body: next })
        .where(and(eq(contentPieces.id, piece.id), eq(contentPieces.tenantId, tenantId)));
    }
  }

  revalidatePath(`/drafts/${piece.id}`);
  return { ok: true, placed, url };
}

/**
 * Dismisses the failed-images notice (spec §4 calls it dismissible): deletes
 * the piece's still-failed GENERATED rows. Explicit dismissal is not a silent
 * loss of the concept — the user chose to drop them — and deleting the rows
 * keeps the library free of dead "failed" cards. Uploads and ready images are
 * untouched.
 */
export async function dismissFailedIllustrations(input: {
  contentPieceId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const [piece] = await db
    .select()
    .from(contentPieces)
    .where(and(eq(contentPieces.id, input.contentPieceId), eq(contentPieces.tenantId, tenantId)));
  if (!piece) return { ok: false, error: "Draft not found." };

  const images = await listImages(tenantId, { contentPieceId: piece.id });
  for (const image of images) {
    if (image.status !== "failed" || image.sourceKind !== "generated") continue;
    await deleteImage(tenantId, image.id);
  }
  revalidatePath(`/drafts/${piece.id}`);
  return { ok: true };
}
```

Two type notes: `getImage`'s return includes the `anchorHeading` column automatically once Task 2 lands (it selects the row). If Plan 1's `isVisualIdentityReady` is a type guard, drop `|| vi === null`.

- [ ] **Step 4: Run the action test**

`npx vitest run tests/app/drafts/illustration-actions.test.ts` — 13 pass. Watch for the `next/cache` mock and the `@/lib/images/blob` partial mock: `imagePathname` must stay real (the assertion on the blob URL prefix depends on it), and `deleteBlobs` must stay mocked (`dismissFailedIllustrations` → `deleteImage` → `del()`).

- [ ] **Step 5: The client Retry button**

Create `src/app/(dashboard)/drafts/[releaseId]/retry-illustration-button.tsx`:

```tsx
"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { dismissFailedIllustrations, retryFailedIllustration } from "./illustration-actions";

/**
 * One failed image's Retry. Server-side render + splice (~10-30 s), so
 * a pending state on the button rather than an optimistic update — same
 * shape as `CatchUpBanner`. `router.refresh()` re-runs the page's Server
 * Component so the notice drops the row and the editor's `defaultValue`
 * carries the spliced body on the next mount.
 */
export function RetryIllustrationButton({ contentPieceId, imageId }: { contentPieceId: string; imageId: string }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={isPending}
      onClick={() =>
        startTransition(async () => {
          const result = await retryFailedIllustration({ contentPieceId, imageId });
          if (!result.ok) {
            toast.error(result.error);
            return;
          }
          toast.success(
            result.placed
              ? "Image added to the draft"
              : "Image generated, but its section heading is gone — insert it from the image library"
          );
          router.refresh();
        })
      }
    >
      {isPending ? "Generating…" : "Retry"}
    </Button>
  );
}

/**
 * The notice's dismiss X — same affordance as WebflowCodeWarning's dismiss
 * (ghost, icon-xs, aria-label). Discards the failed rows for good; no confirm,
 * because nothing the user made is lost (only concepts the agent failed to
 * draw, recoverable by generating fresh from the editor).
 */
export function DismissIllustrationsButton({ contentPieceId }: { contentPieceId: string }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      aria-label="Dismiss"
      disabled={isPending}
      onClick={() =>
        startTransition(async () => {
          const result = await dismissFailedIllustrations({ contentPieceId });
          if (!result.ok) {
            toast.error(result.error);
            return;
          }
          router.refresh();
        })
      }
    >
      <X className="size-3.5" />
    </Button>
  );
}
```

- [ ] **Step 6: The notice (Server Component)**

Create `src/app/(dashboard)/drafts/[releaseId]/failed-illustrations-notice.tsx`:

```tsx
import { listImages } from "@/lib/images/store";
import { DismissIllustrationsButton, RetryIllustrationButton } from "./retry-illustration-button";

/**
 * "1 image failed to generate — Retry" (spec §4). Lists the piece's generated
 * cover/body rows still at `status: "failed"`; each row's concept is what the
 * agent meant to draw, so the human knows what they are retrying. Renders
 * nothing when there is nothing to retry — the row disappears from this list
 * the moment `addRender` flips it to `ready`, and the X discards the failed
 * rows for anyone who is happy with the draft as it is.
 *
 * `listImages` has no status filter in the store contract, so the filter is
 * here. It is one tenant-scoped query per page load; the page already runs
 * several.
 */
export async function FailedIllustrationsNotice({ tenantId, contentPieceId }: { tenantId: string; contentPieceId: string }) {
  const images = await listImages(tenantId, { contentPieceId });
  const failed = images.filter(
    (image) => image.status === "failed" && image.sourceKind === "generated" && (image.role === "cover" || image.role === "body")
  );
  if (failed.length === 0) return null;

  return (
    <div className="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium">
          {failed.length === 1 ? "1 image failed to generate" : `${failed.length} images failed to generate`}
        </p>
        <DismissIllustrationsButton contentPieceId={contentPieceId} />
      </div>
      <p className="text-muted-foreground">
        The draft is complete without them. Save any edits first, then retry — a retried image is placed under
        the section it was planned for.
      </p>
      <ul className="space-y-1.5">
        {failed.map((image) => (
          <li key={image.id} className="flex items-center justify-between gap-3">
            <span>
              <span className="text-muted-foreground">{image.role === "cover" ? "Cover: " : `Under "${image.anchorHeading ?? "?"}": `}</span>
              {image.concept}
            </span>
            <RetryIllustrationButton contentPieceId={contentPieceId} imageId={image.id} />
          </li>
        ))}
      </ul>
    </div>
  );
}
```

`listImages`'s row type includes `anchorHeading` after Task 2 (it returns `ContentImage & {…}`); if Plan 1's `listImages` selects explicit columns rather than the whole row, add `anchorHeading: contentImages.anchorHeading` to that select — a one-line, additive touch to store.ts, and say so in the commit.

- [ ] **Step 7: Mount it on the draft page**

`src/app/(dashboard)/drafts/[releaseId]/page.tsx`: after line 32 add

```ts
import { FailedIllustrationsNotice } from "./failed-illustrations-notice";
```

and in the editor branch, directly after the `generationError` banner closes (line 288, `)}`), before `{showCodeWarning && …}` (line 290), add:

```tsx
          {/* Illustrations the agent could not render (spec 2026-08-18 §4).
              Server-rendered from `content_images`; a Retry re-renders from the
              stored concept and splices at the stored anchor. Only ever shows
              on a real draft — the "brief" branch returned above. */}
          <FailedIllustrationsNotice tenantId={session.user.tenantId} contentPieceId={update.id} />
```

- [ ] **Step 8: Gates**

`npm run typecheck && npm run lint && npm run build`. Then re-run `npx vitest run tests/app/drafts/illustration-actions.test.ts tests/lib/briefs/draft.test.ts`.

Manual verification (behind OAuth — do what you can): with `IMAGE_MODEL`/`OPENAI_API_KEY`/`BLOB_READ_WRITE_TOKEN` set and a tenant whose visual identity is ready, accept a blog_post brief; the generation modal should show "Creating images" after "Reviewing…", and the draft should open with `![…](https://….public.blob.vercel-storage.com/tenants/…)` lines under two-ish H2s and a `content_images` cover row. Force a failure (unset `OPENAI_API_KEY`, generate) → draft lands with the failed-images notice (and no amber "Generation notes" banner — that only appears when the whole pass throws); restore the key, click Retry → the image appears under its heading after refresh; the notice's X dismisses it for good and the failed rows disappear from the Images library.

- [ ] **Step 9: Commit**

```
git add "src/app/(dashboard)/drafts/[releaseId]/illustration-actions.ts" "src/app/(dashboard)/drafts/[releaseId]/failed-illustrations-notice.tsx" "src/app/(dashboard)/drafts/[releaseId]/retry-illustration-button.tsx" "src/app/(dashboard)/drafts/[releaseId]/page.tsx" tests/app/drafts/illustration-actions.test.ts
git commit -m "feat: failed-illustration notice with retry from the stored concept and anchor"
```

---

### Task 8: Final verification

**Files:** none new.

- [ ] **Step 1: Every file this plan touched, twice**

```bash
npx vitest run \
  tests/lib/images/splice.test.ts \
  tests/db/content-images-anchor.test.ts \
  tests/lib/images/plan.test.ts \
  tests/lib/images/illustrate.test.ts \
  tests/components/paced-steps.test.tsx \
  tests/components/generation-checklist.test.tsx \
  tests/lib/briefs/draft.test.ts \
  tests/app/drafts/illustration-actions.test.ts
```

Expected: PASS. **Run it twice** — one shared Postgres, no per-test truncation.
A failure that repeats is real; one that does not is the known flakiness. Note
`tests/lib/briefs/draft.test.ts` is the big one and the one this plan changes
behaviourally — read its failures rather than re-running past them.

- [ ] **Step 2: Regression check on everything that reaches `generateDraftForPiece`**

This plan adds a default dependency (`illustratePiece`) to a function several
server-action tests drain through `after()`. Those tests must still not touch
the network — the real `illustratePiece` returns `skipped: "no_visual_identity"`
before importing anything network-shaped, because their tenants have no
`visualIdentity`. Prove it:

```bash
npx vitest run tests/app/briefs-actions.test.ts tests/app/board-actions.test.ts tests/lib/content
```

Expected: PASS, and no test takes materially longer than before (a jump of tens
of seconds means something is calling a real model).

- [ ] **Step 3: Gates**

```bash
npm run typecheck && npm run lint && npm run build
```

Expected: clean. Do **not** use `npm test` (whole suite) as a gate — it is
documented as flaky against the shared Postgres, so neither result is evidence.

- [ ] **Step 4: Confirm the migration index**

`ls src/db/migrations | tail -3` must show this plan's file at `0064_*.sql` with
Plan 1's `0063_*.sql` immediately before it, and `meta/_journal.json`'s last
entry must be `idx: 64`. Anything else means a stale base — see Global
Constraints.

---

## Self-review

**Spec coverage owned by this plan**

| Spec item | Where |
|---|---|
| §4 runs only inside `generateDraftForPiece`; skipped when type off or no visual identity | Task 4 (`skipped` reasons), Task 6 (single call site; `EDIT_STEPS` untouched, catch-up/extract/edit never import it) |
| §4 Stage 1 plan: `generateObject`, `{cover, body[]}` shape, cap, ~1 per 2 H2, never pad, placement rules, prompt template concept → style → composition → aspect, concept as alt source | Task 3 (system prompt text; prompts built by `buildImagePrompt`; post-validation) |
| §4 Stage 2: cover first, body in parallel, cover as reference when `pinStyleToCover`, plus `styleReferenceImages` | Task 4 |
| §4 loader: `DraftStepKey`/`DRAFT_STEPS` `illustrating` between reviewing and saving, `slow: true`, no migration, poller unchanged | Task 5 (with line refs into generation-checklist.tsx / draft-progress-checklist.tsx) |
| §4 pipeline: `setStep("illustrating")` after review, splice into `result.body`, rows written, then existing `setStep("saving")`/`draftWrite` | Task 6 |
| §4 images block draft readiness | Task 6 (illustrate runs before the body write; piece stays `brief` + generating) |
| §4 failure: one silent retry; failed body image omitted but row persists `failed`; notice + Retry splices at stored anchor; failed cover → coverless draft, row kept for Add-cover pre-fill; failed plan → `generationError` warning, never a failed draft | Task 4 (retry, `markImageFailed`), Task 6 (warning), Task 7 (notice + retry action), Task 2 (anchor column) |
| §3 body images join markdown by blob URL; cover not in body | Task 1 + Task 4 |
| §2 alt policy ≤125, no "image of" | Task 3 (`normalizeAltText`) |
| §9 `illustration_plan` usage row | Task 3 |

**Deviations / judgement calls to flag**

1. `content_images.anchor_heading` is a new nullable column not in the shared contract (Task 2) — additive on top of Plan 1; Plans 3/4 need not read it.
2. `planIllustrations` takes an extra optional `allowText` (default false) so the built prompt honours `allowTextInImages`; `illustratePiece`'s return gains optional `skipped`. Both additive.
3. Render-failure counts are deliberately NOT appended to `generationError` (UX review): the failed rows drive the live failed-images notice, which shows an accurate count, offers Retry, and disappears the moment a retry succeeds or the user dismisses it. A `generationError` copy of the count would go stale after a successful Retry (it only clears on the next body-changing save) and would flag the board card "Flagged copy" for a non-copy problem. `generationError` carries only the competitor scan and the whole-pass-threw warning; the banner heading was still renamed to "Generation notes" since it can now carry both of those.
4. `illustratePiece` deletes leftover generated cover/body rows for the piece before creating new ones (Task 4) — needed because of the cover partial-unique index on regeneration after an aborted run. Uploaded rows are left alone.
5. Retry when the anchor heading no longer exists renders (and bills) but does not place; the toast points to the library (Plan 3). Alternative would be appending at the end of the body, rejected because that lands the image in a CTA section.
6. The spec's "rows are written in the same transaction as the body on the release branch" is not literally honoured: rows are written by `illustratePiece` before the release transaction. Consequence on a rolled-back release save: image rows exist for a `brief` piece. Item 4's cleanup runs at the very top of `illustratePiece`, before the visual-identity/policy checks and before the plan call (final-review fix), so it now catches this on the next run even when that next run's plan legitimately comes back empty or the tenant's policy/visual identity changed in between — not only on a normal next run with a non-empty plan. Wrapping the renders inside the tx would hold a Postgres transaction open across two image round trips — deliberately avoided.
7. Existing `draft.test.ts` tests are not individually stubbed for `illustrate` — the real default skips before any network module because the test tenant has no visual identity; a new test pins that.

**Handed to other plans**

- Cover display on the draft page, Add-cover menu pre-filled from a failed cover row's concept, editor insert/edit, "From library" placement of a rendered-but-unplaced retry: Plan 3.
- `getCoverImage` consumers (Webflow field, LinkedIn media, webhook `coverImage`): Plan 4.
- `illustratePiece` assumes Plan 1's `renderImage` records the `image_generation` usage row and `addRender` prunes history — not re-tested here.
