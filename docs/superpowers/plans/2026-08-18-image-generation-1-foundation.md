# Image Generation — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay every shared piece the image feature stands on — schema, storage, compression, the render call, the style compiler, the per-type policy, and the two settings cards — so Plans 2 (illustration agent), 3 (editor + library) and 4 (delivery) only wire.

> **UX naming rule (applies to every user-facing string in Plans 1–4):** the user-facing word is **"image"** — never "illustration", "render", or "graphic" in UI copy, labels, toasts, or banners. "Illustration" stays in code identifiers and comments; "render" in UI copy becomes "version" (a history entry) or "generate" (the act). Copy conventions to match (from the existing app): sentence case everywhere; success toasts short and past-tense with no period ("Personas saved"); error toasts "Couldn't X — try again"; pending buttons swap to a gerund + real `…` ("Saving…").

**Architecture:** Two new tables (`content_images`, `image_renders`) hold what an image *is* and every render it ever had; two jsonb columns on `company_profiles` hold the visual identity and the per-type policy. A `src/lib/images/*` module set (visual-identity, policy, prompt, compress, blob, store) plus `src/lib/ai/image-model.ts` + `src/lib/ai/images.ts` (`renderImage`) are the only code that touches the image model, sharp, or Vercel Blob. Settings UI follows the repo's each-card-owns-its-save convention with a colocated server action per card.

**Tech Stack:** Next.js 16.2.10 App Router, Drizzle ORM 0.45.2, Postgres, Vitest 4, `ai` 7.0.22 (`generateImage`), `@ai-sdk/openai` (new), `@vercel/blob` (new), `sharp` (new), zod 4.4.3.

**Spec:** docs/superpowers/specs/2026-08-18-image-generation-design.md — this plan covers §1 (engine and routing), §2 (visual brand guidelines incl. website bootstrap and alt policy constants), §3 (data model), §6 (per-type image settings), §7 (storage: Blob + compression), §9 (cost tracking). §4, §5, §5b, §8 are Plans 2–4.

## Global Constraints

- Run `npm install` in the worktree before anything (no node_modules).
- Tests: vitest; node project under tests/** (real Postgres via vitest.setup.ts, uses tests/helpers/fixtures.ts), jsdom project under tests/components/**. Run a single file with `npx vitest run tests/path/file.test.ts`. The suite is flaky when run whole — run the files you touched.
- Migrations: `npm run db:generate` after schema edits; commit the generated SQL in src/db/migrations. Then `npm run db:migrate && npm run db:migrate:test`. Never hand-write the SQL file. Next migration index is 0063 (last is `0062_next_dazzler.sql`).
- **Migration index allocation across the four plans.** Three of them add
  columns and drizzle-kit numbers by "highest existing + 1", so two plans
  generated from the same base both produce `0064_*` and their
  `meta/_journal.json` entries conflict at merge. The allocation is:
  **Plan 1 → `0063`, Plan 2 → `0064` (`content_images.anchor_heading`),
  Plan 3 → none, Plan 4 → `0065` (`delivery_attempts.metadata`)** — which is
  what you get if and only if each plan is merged before the next runs
  `db:generate`. If your generated file lands on a different index, the branch
  was cut from a stale base: rebase on the merged predecessor, delete the
  generated `.sql` + its `meta/*_snapshot.json` + its `_journal.json` entry,
  and re-run `npm run db:generate`. Never renumber a generated file by hand.
- Nothing in CI applies migrations to the test database. After every
  `npm run db:generate`, run `npm run db:migrate:test` or the next test run
  fails with a raw "column does not exist" in an unrelated file.
- Commit after every task; message style: lowercase imperative, `feat:`/`fix:`/`test:`/`docs:` prefix, no Co-Authored-By needed.
- Env: `process.env.X ?? default` at the call site; every new var gets a commented line in `.env.example`. New vars: `IMAGE_MODEL` (default `openai/gpt-image-2`), `OPENAI_API_KEY`, `BLOB_READ_WRITE_TOKEN`.
- Model default `IMAGE_MODEL_DEFAULT = "openai/gpt-image-2"`; `imageModelId` strips a leading `openai/`.
- Sizes: cover `1200x630`, body `1200x900`; `MAX_RENDER_HISTORY = 5`; palette 3–6 entries (ready when ≥ 3); `styleReferenceImages` 0–4; `customStyleDescriptors` ≤ 200 chars.
- **Covers are GENERATED wide, never cropped** (product owner, 2026-08-19). `renderImage` asks for `size: "1200x630"` *and* the matching `aspectRatio`, and — for covers only — measures what came back and retries once if it is off 1.91:1 by more than `ASPECT_TOLERANCE` (2%). Nothing anywhere crops or letterboxes: `compressPng` resizes by width alone, and a stubbornly square render is stored with its true `width`/`height`.
- **Every stored PNG is ≤ `MAX_IMAGE_BYTES` (1 MB)** — generated and uploaded alike (product owner, 2026-08-19). `compressPng` enforces it in a bounded loop and never changes the aspect ratio to get there. 1 MB clears Webflow's 4 MB rehost cap and LinkedIn's 5 MB upload cap with room to spare.
- Blob pathname `tenants/{tenantId}/content/{contentPieceId ?? "library"}/{role}-{slug}.png`, uploaded with `{ access: "public", addRandomSuffix: true, contentType: "image/png" }`. Brand assets (style reference images) live under `tenants/{tenantId}/brand/{slug}.png` and get no `content_images` row. Never overwrite a blob; never call `list()`.
- `recordLlmUsage` never throws. TS unions over free-text columns. jsonb columns typed with `$type<...>()`. Drizzle `db` from `@/db`; the `DbClient` type from `src/lib/publishing/destinations/types.ts` (line 11: `export type DbClient = NodePgDatabase<typeof schema>`).
- No test may reach OpenAI, Vercel Blob or Anthropic. `renderImage` takes an injected `generate`; blob and LLM tests use `vi.mock`.
- Server actions live in the colocated `actions.ts`, `"use server"`, exporting only async functions, `requireSession()` → tenant-scoped load → mutate → `revalidatePath`. Never import a runtime value from a server module into a `"use client"` file — `import type` only.
- The dashboard preview is behind an OAuth wall; UI wiring is verified by `npm run typecheck`, `npm run lint`, `npm run build`, plus the manual steps written into each UI task.
- **`@ai-sdk/openai` and `@vercel/blob` are NOT installed in the main checkout either**, so their call shapes below come from the AI SDK / Vercel docs (`openai.image("gpt-image-2")`, `put(pathname, body, opts)`, `del(pathnames)`). Task 1 verifies both exports exist right after install (`npx tsc --noEmit` on the two wrapper files) before anything else is written against them.

---

### Task 1: Dependencies and environment

**Files:**
- Modify: `package.json` (dependencies block, lines 16–43)
- Modify: `.env.example` (append after the `ANTHROPIC_API_KEY=` block, i.e. after line 65 `# IDEATION_MODEL=...`)

**Interfaces:**
- Produces: `@ai-sdk/openai`, `@vercel/blob`, `sharp` installed; three env vars documented. Every later task imports one of these.

- [ ] **Step 1: Install**

```bash
npm install @ai-sdk/openai @vercel/blob sharp
```

Confirm all three appear under `"dependencies"` in `package.json` and `package-lock.json` changed.

- [ ] **Step 2: Verify the two unverified exports exist**

```bash
node -e "const o=require('@ai-sdk/openai'); console.log(typeof o.openai.image, typeof o.createOpenAI)"
node -e "const b=require('@vercel/blob'); console.log(typeof b.put, typeof b.del)"
node -e "const s=require('sharp'); console.log(typeof s)"
```

Expected: `function function`, `function function`, `function`. If `openai.image` is not a function, run `node -e "console.log(Object.keys(require('@ai-sdk/openai').openai))"` and use the image-model factory it lists (`imageModel` is the ProviderV4 name) — Task 9 must then use that name instead of `.image`. Record which one worked in the Task 9 commit message.

- [ ] **Step 3: Document the env vars**

Append to `.env.example` directly after the `# IDEATION_MODEL=anthropic/claude-sonnet-4-5` line:

```
# Image generation. OpenAI, called DIRECTLY via @ai-sdk/openai (see
# src/lib/ai/image-model.ts) — the one documented exception to the
# Anthropic-only rule above, because Anthropic has no image model. Like
# ANTHROPIC_API_KEY, the SDK reads this implicitly, so grepping finds nothing.
OPENAI_API_KEY=
# Optional; default openai/gpt-image-2. A leading "openai/" is stripped.
# IMAGE_MODEL=openai/gpt-image-2

# Vercel Blob — where generated and uploaded images live. Read implicitly by
# @vercel/blob's put()/del(). Hobby limits (1 GB, 10 GB transfer/month) are the
# binding constraint, which is why every upload is compressed first and pruned
# renders delete their blobs (src/lib/images/compress.ts, store.ts).
BLOB_READ_WRITE_TOKEN=
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json .env.example
git commit -m "feat: add image generation dependencies and env"
```

---

### Task 2: Schema — visual identity, image policy, image tables, usage image count

**Files:**
- Modify: `src/db/schema.ts` — types near the top (after line 12 `ResolvedPersona`), `companyProfiles` (lines 234–267, add after `userPersonas` line 264), `llmUsage` (lines 712–726, add after `totalTokens` line 724), and two new tables appended after `channelVariants` (ends line 663)
- Create: `src/db/migrations/0063_*.sql` (generated)
- Test: `tests/db/content-images-schema.test.ts`

**Interfaces:**
- Produces (exact contract): `PaletteRole`, `ImageRule`, `VisualIdentity`, `BodyIllustrationSetting`, `ImagePolicy`, `ImageRole`, `ImageSourceKind`, `ImageStatus`, `contentImages`, `imageRenders`, `ContentImage`, `ImageRender`, `companyProfiles.visualIdentity`, `companyProfiles.imagePolicy`, `llmUsage.imageCount`.

- [ ] **Step 1: Write the failing test**

Create `tests/db/content-images-schema.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { companyProfiles, contentImages, contentPieces, imageRenders, llmUsage, tenants } from "../../src/db/schema";
import { seedTenant, dropTenant } from "../helpers/fixtures";

const TENANT = "Content Images Schema Test Tenant";

describe("content_images / image_renders schema", () => {
  afterEach(async () => {
    await dropTenant(TENANT);
  });

  it("stores an image with a piece, a render, and the current pointer", async () => {
    const tenant = await seedTenant(TENANT);
    const [piece] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, title: "T", body: "B", type: "blog_post" })
      .returning();
    const [image] = await db
      .insert(contentImages)
      .values({
        tenantId: tenant.id,
        contentPieceId: piece.id,
        role: "cover",
        concept: "a lighthouse",
        altText: "A lighthouse on a cliff",
        sourceKind: "generated",
        status: "pending",
      })
      .returning();
    expect(image.currentRenderId).toBeNull();

    const [render] = await db
      .insert(imageRenders)
      .values({
        imageId: image.id,
        prompt: "p",
        blobUrl: "https://blob.example/x.png",
        blobPathname: "tenants/t/content/p/cover-x.png",
        width: 1200,
        height: 630,
        bytes: 1000,
        model: "gpt-image-2",
      })
      .returning();
    const [updated] = await db
      .update(contentImages)
      .set({ currentRenderId: render.id, status: "ready" })
      .where(eq(contentImages.id, image.id))
      .returning();
    expect(updated.currentRenderId).toBe(render.id);
  });

  it("allows a library image with no piece", async () => {
    const tenant = await seedTenant(TENANT);
    const [image] = await db
      .insert(contentImages)
      .values({
        tenantId: tenant.id,
        contentPieceId: null,
        role: "library",
        concept: "c",
        altText: "a",
        sourceKind: "uploaded",
        status: "ready",
      })
      .returning();
    expect(image.contentPieceId).toBeNull();
  });

  it("refuses two covers on one piece but allows many body images", async () => {
    const tenant = await seedTenant(TENANT);
    const [piece] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, title: "T", body: "B", type: "blog_post" })
      .returning();
    const base = { tenantId: tenant.id, contentPieceId: piece.id, concept: "c", altText: "a", sourceKind: "generated", status: "pending" } as const;
    await db.insert(contentImages).values({ ...base, role: "cover" });
    await expect(db.insert(contentImages).values({ ...base, role: "cover" })).rejects.toThrow();
    await db.insert(contentImages).values({ ...base, role: "body" });
    await db.insert(contentImages).values({ ...base, role: "body" });
    const rows = await db.select().from(contentImages).where(eq(contentImages.contentPieceId, piece.id));
    expect(rows).toHaveLength(3);
  });

  it("cascades renders when the image is deleted, and images when the piece is deleted", async () => {
    const tenant = await seedTenant(TENANT);
    const [piece] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, title: "T", body: "B" })
      .returning();
    const [image] = await db
      .insert(contentImages)
      .values({ tenantId: tenant.id, contentPieceId: piece.id, role: "body", concept: "c", altText: "a", sourceKind: "generated", status: "pending" })
      .returning();
    await db.insert(imageRenders).values({ imageId: image.id, prompt: "p", blobUrl: "u", blobPathname: "p", width: 1, height: 1, bytes: 1, model: "m" });
    await db.delete(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(await db.select().from(contentImages).where(eq(contentImages.id, image.id))).toHaveLength(0);
    expect(await db.select().from(imageRenders).where(eq(imageRenders.imageId, image.id))).toHaveLength(0);
  });

  it("round-trips visual identity and image policy on the company profile", async () => {
    const tenant = await seedTenant(TENANT);
    const [profile] = await db.insert(companyProfiles).values({ tenantId: tenant.id }).returning();
    expect(profile.visualIdentity).toBeNull();
    expect(profile.imagePolicy).toBeNull();
    const [updated] = await db
      .update(companyProfiles)
      .set({
        visualIdentity: {
          palette: [{ hex: "#112233", role: "primary" }],
          stylePreset: "flat",
          moodWords: ["clean"],
          allowTextInImages: false,
          styleReferenceImages: [],
          customStyleDescriptors: "",
          imageGenerationRules: [{ kind: "dont", text: "no photorealism" }],
          backgroundTreatment: "solid",
          texture: "none",
          peopleStyle: "abstract_figures",
          pinStyleToCover: true,
        },
        imagePolicy: { blog_post: { cover: true, body: 2 } },
      })
      .where(eq(companyProfiles.id, profile.id))
      .returning();
    expect(updated.visualIdentity?.palette[0].hex).toBe("#112233");
    expect(updated.imagePolicy?.blog_post?.body).toBe(2);
  });

  it("stores an image count on llm_usage", async () => {
    const tenant = await seedTenant(TENANT);
    const [row] = await db
      .insert(llmUsage)
      .values({ tenantId: tenant.id, operation: "image_generation", model: "gpt-image-2", imageCount: 1 })
      .returning();
    expect(row.imageCount).toBe(1);
    expect(row.inputTokens).toBeNull();
    await db.delete(tenants).where(eq(tenants.id, tenant.id));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/db/content-images-schema.test.ts`
Expected: FAIL — `contentImages`/`imageRenders` are not exported from the schema; `visualIdentity` does not exist on the update type.

- [ ] **Step 3: Add the types**

In `src/db/schema.ts`, after line 12 (`export type ResolvedPersona = ...`), add:

```ts
// ---- Images (spec 2026-08-18-image-generation-design.md §2, §3, §6) ----
//
// The vocabulary lives in TypeScript; the columns below are free-form text and
// jsonb, matching the repo convention (see `llmUsage.operation`).

export type PaletteRole = "primary" | "secondary" | "accent" | "background" | "neutral";
export type ImageRule = { kind: "do" | "dont"; text: string };
export type VisualIdentity = {
  // 3–6 entries; roles let the compiled style block say "background in X,
  // accents in Y". `isVisualIdentityReady` gates generation on >= 3.
  palette: { hex: string; role: PaletteRole }[];
  stylePreset: "flat" | "geometric" | "line_art" | "isometric" | "gradient" | "duotone" | "hand_drawn";
  moodWords: string[];
  allowTextInImages: boolean;
  // Blob URLs, 0–4. Passed as reference images on every render.
  styleReferenceImages: string[];
  // <= 200 chars; "" when unset.
  customStyleDescriptors: string;
  // Appended verbatim to every prompt as "Always: …" / "Never: …".
  imageGenerationRules: ImageRule[];
  backgroundTreatment: "solid" | "subtle_pattern" | "scene";
  texture: "none" | "grain" | "paper" | "halftone";
  peopleStyle: "none" | "abstract_figures" | "diverse_characters";
  // Reuse a piece's cover as a style reference for its body images.
  pinStyleToCover: boolean;
};

// "auto" means "up to the default cap (3)"; a number is an explicit cap.
export type BodyIllustrationSetting = "off" | "auto" | 1 | 2 | 3;
// Partial: the column stays null (or sparse) until a tenant changes
// something; `resolveImagePolicy` fills the gaps from the TypeScript defaults.
export type ImagePolicy = Partial<
  Record<(typeof contentTypeEnum.enumValues)[number], { cover: boolean; body: BodyIllustrationSetting }>
>;

export type ImageRole = "cover" | "body" | "library";
export type ImageSourceKind = "generated" | "uploaded";
export type ImageStatus = "pending" | "ready" | "failed";
```

`contentTypeEnum` is declared at line 88, below this block — a `typeof` inside a type alias is fine with a later `const` declaration in the same module (types are hoisted for checking); if `tsc` complains about use-before-declaration, move the `ImagePolicy` alias to just below line 88 instead.

- [ ] **Step 4: Add the columns**

In `companyProfiles` (line 234), after `userPersonas` (line 264), add:

```ts
  // Visual brand guidelines feeding every image generation (image spec §2).
  // Null until the first save, like `guidelines`; while null, drafts get no
  // images and the draft page points at the setup card.
  visualIdentity: jsonb("visual_identity").$type<VisualIdentity>(),
  // Per-content-type cover/body-illustration policy (image spec §6). Null means
  // "the TypeScript defaults in src/lib/images/policy.ts".
  imagePolicy: jsonb("image_policy").$type<ImagePolicy>(),
```

In `llmUsage` (line 712), after `totalTokens` (line 724), add:

```ts
  // Image renders bill per image, not per token. Set on "image_generation"
  // rows; null on every text row, whose token columns stay populated instead.
  imageCount: integer("image_count"),
```

- [ ] **Step 5: Add the two tables**

After the `channelVariants` table (closes at line 663), add:

```ts
export const contentImages = pgTable(
  "content_images",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    // Null for standalone library images; set when the image belongs to a
    // piece. Cascade keeps piece deletion tidy; library images outlive pieces.
    contentPieceId: uuid("content_piece_id").references(() => contentPieces.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // ImageRole
    // What the image is for — survives regeneration, powers alt text and retry.
    concept: text("concept").notNull(),
    altText: text("alt_text").notNull(),
    sourceKind: text("source_kind").notNull(), // ImageSourceKind
    status: text("status").notNull(), // ImageStatus
    // Points at the image_renders row currently in use. Deliberately NO foreign
    // key: image_renders references content_images, and a constraint back the
    // other way would make the two tables circular for inserts and deletes.
    // src/lib/images/store.ts is the only writer and keeps it consistent.
    currentRenderId: uuid("current_render_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("content_images_tenant_created_idx").on(table.tenantId, table.createdAt),
    // One cover per piece. Partial because body images share the piece id, and
    // library images have no piece at all (NULLs are distinct in Postgres).
    uniqueIndex("content_images_cover_unique")
      .on(table.contentPieceId)
      .where(sql`${table.role} = 'cover'`),
  ]
);

export type ContentImage = typeof contentImages.$inferSelect;

export const imageRenders = pgTable(
  "image_renders",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    imageId: uuid("image_id")
      .notNull()
      .references(() => contentImages.id, { onDelete: "cascade" }),
    // The exact prompt sent to the model (style block + concept + any user
    // instruction). Full reproducibility per render; "edit prompt" reopens this.
    prompt: text("prompt").notNull(),
    blobUrl: text("blob_url").notNull(),
    // What @vercel/blob's del() takes.
    blobPathname: text("blob_pathname").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    bytes: integer("bytes").notNull(),
    model: text("model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("image_renders_image_created_idx").on(table.imageId, table.createdAt)]
);

export type ImageRender = typeof imageRenders.$inferSelect;
```

- [ ] **Step 6: Generate and apply the migration**

```bash
npm run db:generate
npm run db:migrate
npm run db:migrate:test
```

Confirm exactly one new file `src/db/migrations/0063_*.sql` and that it contains only: `CREATE TABLE "content_images"`, `CREATE TABLE "image_renders"`, three `ALTER TABLE ... ADD COLUMN` (`visual_identity`, `image_policy`, `image_count`), the FK constraints, and the three indexes (`content_images_tenant_created_idx`, `content_images_cover_unique` with `WHERE "content_images"."role" = 'cover'`, `image_renders_image_created_idx`). Anything else means schema drift — stop and report.

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run tests/db/content-images-schema.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts src/db/migrations tests/db/content-images-schema.test.ts
git commit -m "feat: content_images and image_renders tables, visual identity and image policy columns"
```

---

### Task 3: `recordLlmUsage` learns about images

**Files:**
- Modify: `src/lib/ai/llm-usage.ts` — `LlmOperation` union (lines 4–18), entry type + insert (lines 34–56)
- Test: `tests/lib/ai/llm-usage.test.ts` (exists — append)

**Interfaces:**
- Produces: `LlmOperation` gains `"illustration_plan" | "image_generation"`; entry gains optional `imageCount?: number` → `llm_usage.image_count`; the `database` parameter widens from `typeof defaultDb` to `DbClient`.

> **Why the `database` widening is mandatory, not conditional.** Today
> `recordLlmUsage(entry, database: typeof defaultDb = defaultDb)`
> (`src/lib/ai/llm-usage.ts:37`). `typeof defaultDb` is
> `NodePgDatabase<typeof schema> & { $client: NodePgClient }`; `DbClient`
> (`src/lib/publishing/destinations/types.ts:11`) is the same type **without**
> `$client`, so a `DbClient` is NOT assignable to it. Task 9's `renderImage`,
> Plan 2's `planIllustrations` and Plan 3's `suggestImageConcept` all forward a
> `DbClient`. Widen here, once, in this task — `db` is still assignable to the
> wider type, so no existing caller changes.

- [ ] **Step 1: Write the failing test**

Append inside the `describe("recordLlmUsage")` block in `tests/lib/ai/llm-usage.test.ts`:

```ts
  it("records an image count for image_generation rows and null tokens", async () => {
    const tenant = await seed();

    await recordLlmUsage({
      tenantId: tenant.id,
      operation: "image_generation",
      model: "gpt-image-2",
      imageCount: 1,
    });

    const [row] = await db.select().from(llmUsage).where(eq(llmUsage.tenantId, tenant.id));
    expect(row).toMatchObject({ operation: "image_generation", model: "gpt-image-2", imageCount: 1, inputTokens: null });
  });

  it("stores a null image count on text rows", async () => {
    const tenant = await seed();
    await recordLlmUsage({ tenantId: tenant.id, operation: "illustration_plan", model: "claude-sonnet-4-5", usage: { inputTokens: 5 } });
    const [row] = await db.select().from(llmUsage).where(eq(llmUsage.tenantId, tenant.id));
    expect(row.imageCount).toBeNull();
    expect(row.inputTokens).toBe(5);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/lib/ai/llm-usage.test.ts`
Expected: FAIL — type error on `operation: "image_generation"` / `imageCount` (vitest reports the TS error at runtime as an insert of an unknown property; either way the `imageCount` assertion fails with `null`).

- [ ] **Step 3: Implement**

In `src/lib/ai/llm-usage.ts`, add the import at the top:

```ts
import type { DbClient } from "@/lib/publishing/destinations/types";
```

Extend the union (after `"brief_proposal"` line 18):

```ts
  | "brief_proposal"
  // Image spec §9. `illustration_plan` is a normal token row (the text model
  // planning which images a draft needs); `image_generation` bills per image
  // and sets `imageCount` instead of the token columns.
  | "illustration_plan"
  | "image_generation";
```

Extend the entry type and the insert:

```ts
export async function recordLlmUsage(
  entry: {
    tenantId: string;
    operation: LlmOperation;
    model: string;
    usage?: TokenUsage;
    /** Number of images rendered by this call. Only image operations set it. */
    imageCount?: number;
  },
  // Widened from `typeof defaultDb`: image and illustration-plan callers hold a
  // `DbClient` (no `$client`), which is not assignable to `typeof defaultDb`.
  // `db` is assignable to `DbClient`, so every existing caller is unaffected.
  database: DbClient = defaultDb
): Promise<void> {
  try {
    await database.insert(llmUsage).values({
      tenantId: entry.tenantId,
      operation: entry.operation,
      model: entry.model,
      inputTokens: entry.usage?.inputTokens ?? null,
      outputTokens: entry.usage?.outputTokens ?? null,
      totalTokens: entry.usage?.totalTokens ?? null,
      imageCount: entry.imageCount ?? null,
    });
  } catch (error) {
    console.error(`Failed to record ${entry.operation} token usage:`, error);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/lib/ai/llm-usage.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean (the widened `database` parameter must not break any existing caller).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/llm-usage.ts tests/lib/ai/llm-usage.test.ts
git commit -m "feat: llm usage records image operations and image counts"
```

---

### Task 4: `visual-identity.ts` — defaults, style block compiler, readiness, validation

**Files:**
- Create: `src/lib/images/visual-identity.ts`
- Test: `tests/lib/images/visual-identity.test.ts`

**Interfaces:**
- Consumes: `VisualIdentity`, `PaletteRole`, `ImageRule` from `@/db/schema` (type-only — this module is imported by a `"use client"` editor).
- Produces:
  - `DEFAULT_VISUAL_IDENTITY: Omit<VisualIdentity, "palette">`
  - `compileStyleBlock(vi: VisualIdentity): string` — one deterministic paragraph
  - `isVisualIdentityReady(vi: VisualIdentity | null): boolean` — `palette.length >= 3`
  - `parseVisualIdentity(input: unknown): VisualIdentity | null` — zod-validated, normalised (hex lowercased, strings trimmed, empties dropped, caps enforced); `null` when invalid
  - `STYLE_PRESETS`, `BACKGROUND_TREATMENTS`, `TEXTURES`, `PEOPLE_STYLES`, `PALETTE_ROLES` — `readonly { value; label }[]` lists for the editor's selects
  - `MAX_PALETTE = 6`, `MAX_REFERENCE_IMAGES = 4`, `MAX_CUSTOM_DESCRIPTORS = 200`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/images/visual-identity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { VisualIdentity } from "../../../src/db/schema";
import {
  DEFAULT_VISUAL_IDENTITY,
  compileStyleBlock,
  isVisualIdentityReady,
  parseVisualIdentity,
} from "../../../src/lib/images/visual-identity";

const IDENTITY: VisualIdentity = {
  ...DEFAULT_VISUAL_IDENTITY,
  palette: [
    { hex: "#1a73e8", role: "primary" },
    { hex: "#fbbc04", role: "accent" },
    { hex: "#ffffff", role: "background" },
    { hex: "#5f6368", role: "neutral" },
  ],
  stylePreset: "geometric",
  moodWords: ["calm", "precise"],
  customStyleDescriptors: "rounded corners everywhere",
  imageGenerationRules: [
    { kind: "do", text: "include the blue orb" },
    { kind: "dont", text: "no photorealism" },
    { kind: "dont", text: "no hands" },
  ],
  backgroundTreatment: "subtle_pattern",
  texture: "grain",
  peopleStyle: "none",
};

describe("DEFAULT_VISUAL_IDENTITY", () => {
  it("matches the spec defaults", () => {
    expect(DEFAULT_VISUAL_IDENTITY.stylePreset).toBe("flat");
    expect(DEFAULT_VISUAL_IDENTITY.moodWords).toEqual(["clean", "modern"]);
    expect(DEFAULT_VISUAL_IDENTITY.allowTextInImages).toBe(false);
    expect(DEFAULT_VISUAL_IDENTITY.styleReferenceImages).toEqual([]);
    expect(DEFAULT_VISUAL_IDENTITY.customStyleDescriptors).toBe("");
    expect(DEFAULT_VISUAL_IDENTITY.imageGenerationRules).toEqual([
      { kind: "dont", text: "no photorealism" },
      { kind: "dont", text: "no stock-photo look" },
      { kind: "dont", text: "no 3D render" },
      { kind: "dont", text: "no clip-art" },
    ]);
    expect(DEFAULT_VISUAL_IDENTITY.backgroundTreatment).toBe("solid");
    expect(DEFAULT_VISUAL_IDENTITY.texture).toBe("none");
    expect(DEFAULT_VISUAL_IDENTITY.peopleStyle).toBe("abstract_figures");
    expect(DEFAULT_VISUAL_IDENTITY.pinStyleToCover).toBe(true);
  });
});

describe("compileStyleBlock", () => {
  it("is one paragraph containing preset words, palette with roles, mood, background, texture, people, descriptors and rules", () => {
    const block = compileStyleBlock(IDENTITY);
    expect(block).not.toContain("\n");
    expect(block).toContain("geometric");
    expect(block).toContain("#1a73e8 as the primary");
    expect(block).toContain("#ffffff as the background");
    expect(block).toContain("#fbbc04 as an accent");
    expect(block).toContain("#5f6368 as a neutral");
    expect(block).toContain("calm, precise");
    expect(block).toContain("subtle");
    expect(block).toContain("grain");
    expect(block).toContain("no people");
    expect(block).toContain("rounded corners everywhere");
    expect(block).toContain("Always: include the blue orb.");
    expect(block).toContain("Never: no photorealism; no hands.");
  });

  it("is deterministic and omits Always when there are no do rules", () => {
    const vi = { ...IDENTITY, imageGenerationRules: [{ kind: "dont" as const, text: "no clip-art" }] };
    expect(compileStyleBlock(vi)).toBe(compileStyleBlock(vi));
    expect(compileStyleBlock(vi)).not.toContain("Always:");
    expect(compileStyleBlock(vi)).toContain("Never: no clip-art.");
  });

  it("omits the descriptors clause when empty and the rules when there are none", () => {
    const vi = { ...IDENTITY, customStyleDescriptors: "", imageGenerationRules: [] };
    const block = compileStyleBlock(vi);
    expect(block).not.toContain("Always:");
    expect(block).not.toContain("Never:");
    expect(block).not.toContain("rounded corners");
  });

  it("omits the palette clause entirely for an empty palette, and stays one line", () => {
    // Generation is gated on `isVisualIdentityReady`, but the editor compiles a
    // preview from a half-filled card, so an empty palette must not emit
    // "Palette, used strictly: ." — an empty instruction the model may honour.
    const block = compileStyleBlock({ ...IDENTITY, palette: [] });
    expect(block).not.toContain("Palette");
    expect(block).not.toContain("\n");
    expect(block).toContain("Style:");
  });

  it("names all six colours, ordered by role, when the palette is full", () => {
    const full = {
      ...IDENTITY,
      palette: [
        { hex: "#111111", role: "neutral" as const },
        { hex: "#222222", role: "accent" as const },
        { hex: "#333333", role: "secondary" as const },
        { hex: "#444444", role: "primary" as const },
        { hex: "#555555", role: "background" as const },
        { hex: "#666666", role: "accent" as const },
      ],
    };
    const block = compileStyleBlock(full);
    for (const hex of ["#111111", "#222222", "#333333", "#444444", "#555555", "#666666"]) {
      expect(block).toContain(hex);
    }
    // ROLE_ORDER puts background first and neutral last.
    expect(block.indexOf("#555555")).toBeLessThan(block.indexOf("#444444"));
    expect(block.indexOf("#444444")).toBeLessThan(block.indexOf("#111111"));
  });

  it("stays one line even when a descriptor or a rule was typed with newlines", () => {
    // `customStyleDescriptors` is a <Textarea> and rule text is free input, so
    // both can carry newlines. The compiled block is embedded verbatim in the
    // stored render prompt; a multi-line style block is not what buildImagePrompt
    // documents it produces.
    const block = compileStyleBlock({
      ...IDENTITY,
      customStyleDescriptors: "rounded corners\neverywhere",
      imageGenerationRules: [{ kind: "dont", text: "no\nhands" }],
    });
    expect(block).not.toContain("\n");
  });

  it("lowercases hex in the compiled block regardless of how it was stored", () => {
    const block = compileStyleBlock({ ...IDENTITY, palette: [{ hex: "#1A73E8", role: "primary" }] });
    expect(block).toContain("#1a73e8");
    expect(block).not.toContain("#1A73E8");
  });
});

describe("isVisualIdentityReady", () => {
  it("needs three palette colors", () => {
    expect(isVisualIdentityReady(null)).toBe(false);
    expect(isVisualIdentityReady({ ...IDENTITY, palette: IDENTITY.palette.slice(0, 2) })).toBe(false);
    expect(isVisualIdentityReady({ ...IDENTITY, palette: IDENTITY.palette.slice(0, 3) })).toBe(true);
  });
});

describe("parseVisualIdentity", () => {
  it("accepts a full identity and normalises hex and whitespace", () => {
    const parsed = parseVisualIdentity({
      ...IDENTITY,
      palette: [{ hex: "#1A73E8 ", role: "primary" }],
      moodWords: [" Calm ", "", "precise"],
      customStyleDescriptors: "  rounded  ",
      imageGenerationRules: [{ kind: "do", text: "  keep it  " }, { kind: "dont", text: "" }],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.palette).toEqual([{ hex: "#1a73e8", role: "primary" }]);
    expect(parsed!.moodWords).toEqual(["Calm", "precise"]);
    expect(parsed!.customStyleDescriptors).toBe("rounded");
    expect(parsed!.imageGenerationRules).toEqual([{ kind: "do", text: "keep it" }]);
  });

  it("rejects bad hex, unknown presets, too many colors, over-long descriptors, non-URL references", () => {
    expect(parseVisualIdentity({ ...IDENTITY, palette: [{ hex: "blue", role: "primary" }] })).toBeNull();
    expect(parseVisualIdentity({ ...IDENTITY, stylePreset: "photoreal" })).toBeNull();
    expect(
      parseVisualIdentity({ ...IDENTITY, palette: Array.from({ length: 7 }, () => ({ hex: "#000000", role: "neutral" })) })
    ).toBeNull();
    expect(parseVisualIdentity({ ...IDENTITY, customStyleDescriptors: "x".repeat(201) })).toBeNull();
    expect(parseVisualIdentity({ ...IDENTITY, styleReferenceImages: ["not a url"] })).toBeNull();
    expect(parseVisualIdentity({ ...IDENTITY, styleReferenceImages: Array(5).fill("https://a.b/c.png") })).toBeNull();
    expect(parseVisualIdentity("nope")).toBeNull();
  });

  it("allows an empty palette (a draft the user is still building)", () => {
    expect(parseVisualIdentity({ ...IDENTITY, palette: [] })?.palette).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/lib/images/visual-identity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/images/visual-identity.ts`:

```ts
import { z } from "zod";
import type { ImageRule, PaletteRole, VisualIdentity } from "@/db/schema";

// Type-only import from the schema above: this module is imported by the
// "use client" Visual identity editor, so it must never pull drizzle in.

export const MAX_PALETTE = 6;
export const MIN_READY_PALETTE = 3;
export const MAX_REFERENCE_IMAGES = 4;
export const MAX_CUSTOM_DESCRIPTORS = 200;
export const MAX_MOOD_WORDS = 4;

export const STYLE_PRESETS = [
  { value: "flat", label: "Flat" },
  { value: "geometric", label: "Geometric" },
  { value: "line_art", label: "Line art" },
  { value: "isometric", label: "Isometric" },
  { value: "gradient", label: "Gradient" },
  { value: "duotone", label: "Duotone" },
  { value: "hand_drawn", label: "Hand-drawn" },
] as const satisfies readonly { value: VisualIdentity["stylePreset"]; label: string }[];

export const BACKGROUND_TREATMENTS = [
  { value: "solid", label: "Solid color" },
  { value: "subtle_pattern", label: "Subtle pattern" },
  { value: "scene", label: "Scene" },
] as const satisfies readonly { value: VisualIdentity["backgroundTreatment"]; label: string }[];

export const TEXTURES = [
  { value: "none", label: "None" },
  { value: "grain", label: "Grain" },
  { value: "paper", label: "Paper" },
  { value: "halftone", label: "Halftone" },
] as const satisfies readonly { value: VisualIdentity["texture"]; label: string }[];

export const PEOPLE_STYLES = [
  { value: "none", label: "No people" },
  { value: "abstract_figures", label: "Abstract figures" },
  { value: "diverse_characters", label: "Diverse characters" },
] as const satisfies readonly { value: VisualIdentity["peopleStyle"]; label: string }[];

export const PALETTE_ROLES = [
  { value: "primary", label: "Primary" },
  { value: "secondary", label: "Secondary" },
  { value: "accent", label: "Accent" },
  { value: "background", label: "Background" },
  { value: "neutral", label: "Neutral" },
] as const satisfies readonly { value: PaletteRole; label: string }[];

/** Spec §2 defaults. The palette has no default — it must be extracted or typed. */
export const DEFAULT_VISUAL_IDENTITY: Omit<VisualIdentity, "palette"> = {
  stylePreset: "flat",
  moodWords: ["clean", "modern"],
  allowTextInImages: false,
  styleReferenceImages: [],
  customStyleDescriptors: "",
  imageGenerationRules: [
    { kind: "dont", text: "no photorealism" },
    { kind: "dont", text: "no stock-photo look" },
    { kind: "dont", text: "no 3D render" },
    { kind: "dont", text: "no clip-art" },
  ],
  backgroundTreatment: "solid",
  texture: "none",
  peopleStyle: "abstract_figures",
  pinStyleToCover: true,
};

// The strongest lever in the prompt (spec §2 research ranking): a fixed
// descriptor phrase per preset keeps every render on tested vocabulary.
const PRESET_PHRASE: Record<VisualIdentity["stylePreset"], string> = {
  flat: "flat vector illustration with clean solid fills and simple shapes",
  geometric: "geometric illustration built from crisp shapes and clean angles",
  line_art: "minimal line-art illustration with consistent stroke weight and sparse fills",
  isometric: "isometric illustration with a consistent 30-degree projection and clean edges",
  gradient: "modern illustration with smooth, subtle gradients and soft shapes",
  duotone: "duotone illustration using two dominant tones with high contrast",
  hand_drawn: "hand-drawn illustration with organic, slightly imperfect lines",
};

const BACKGROUND_PHRASE: Record<VisualIdentity["backgroundTreatment"], string> = {
  solid: "a solid, uniform background",
  subtle_pattern: "a subtle, low-contrast patterned background",
  scene: "a simple environmental scene as the background",
};

const TEXTURE_PHRASE: Record<VisualIdentity["texture"], string> = {
  none: "no texture, perfectly clean fills",
  grain: "a light film-grain texture",
  paper: "a soft paper texture",
  halftone: "a halftone dot texture",
};

const PEOPLE_PHRASE: Record<VisualIdentity["peopleStyle"], string> = {
  none: "no people",
  abstract_figures: "people only as abstract, faceless figures",
  diverse_characters: "diverse stylised characters with simple features",
};

const ROLE_PHRASE: Record<PaletteRole, (hex: string) => string> = {
  primary: (hex) => `${hex} as the primary color`,
  secondary: (hex) => `${hex} as the secondary color`,
  accent: (hex) => `${hex} as an accent`,
  background: (hex) => `${hex} as the background`,
  neutral: (hex) => `${hex} as a neutral for outlines and shadows`,
};

const ROLE_ORDER: PaletteRole[] = ["background", "primary", "secondary", "accent", "neutral"];

/**
 * Turns the identity into ONE prompt paragraph. Generation code consumes only
 * this, so prompt assembly lives in exactly one place. Deterministic: same
 * input, same string — the render row stores the full prompt for
 * reproducibility, so nothing here may depend on time or randomness.
 */
export function compileStyleBlock(vi: VisualIdentity): string {
  const sentences: string[] = [];

  const descriptors = vi.customStyleDescriptors.trim();
  sentences.push(`Style: ${PRESET_PHRASE[vi.stylePreset]}${descriptors ? `; ${descriptors}` : ""}.`);

  if (vi.palette.length > 0) {
    const ordered = [...vi.palette].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
    sentences.push(
      `Palette, used strictly: ${ordered.map((p) => ROLE_PHRASE[p.role](p.hex.toLowerCase())).join(", ")}.`
    );
  }

  if (vi.moodWords.length > 0) sentences.push(`Mood: ${vi.moodWords.join(", ")}.`);
  sentences.push(`Background: ${BACKGROUND_PHRASE[vi.backgroundTreatment]}.`);
  sentences.push(`Texture: ${TEXTURE_PHRASE[vi.texture]}.`);
  sentences.push(`People: ${PEOPLE_PHRASE[vi.peopleStyle]}.`);

  const dos = vi.imageGenerationRules.filter((r) => r.kind === "do").map((r) => r.text.trim()).filter(Boolean);
  const donts = vi.imageGenerationRules.filter((r) => r.kind === "dont").map((r) => r.text.trim()).filter(Boolean);
  if (dos.length > 0) sentences.push(`Always: ${dos.join("; ")}.`);
  if (donts.length > 0) sentences.push(`Never: ${donts.join("; ")}.`);

  // ONE line, always: `customStyleDescriptors` comes from a <Textarea> and rule
  // text is free input, so either can carry newlines, and this block is
  // embedded verbatim in the prompt stored on every render row.
  return sentences.join(" ").replace(/\s+/g, " ").trim();
}

export function isVisualIdentityReady(vi: VisualIdentity | null): boolean {
  return vi !== null && vi.palette.length >= MIN_READY_PALETTE;
}

const HEX = /^#[0-9a-f]{6}$/;

const RuleSchema = z.object({
  kind: z.enum(["do", "dont"]),
  text: z.string().transform((s) => s.trim()),
});

const VisualIdentitySchema = z.object({
  palette: z
    .array(
      z.object({
        hex: z
          .string()
          .transform((s) => s.trim().toLowerCase())
          .refine((s) => HEX.test(s), "hex color like #1a73e8"),
        role: z.enum(["primary", "secondary", "accent", "background", "neutral"]),
      })
    )
    .max(MAX_PALETTE),
  stylePreset: z.enum(["flat", "geometric", "line_art", "isometric", "gradient", "duotone", "hand_drawn"]),
  moodWords: z
    .array(z.string())
    .transform((words) => words.map((w) => w.trim()).filter(Boolean).slice(0, MAX_MOOD_WORDS)),
  allowTextInImages: z.boolean(),
  styleReferenceImages: z.array(z.url()).max(MAX_REFERENCE_IMAGES),
  customStyleDescriptors: z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s.length <= MAX_CUSTOM_DESCRIPTORS, `at most ${MAX_CUSTOM_DESCRIPTORS} characters`),
  imageGenerationRules: z.array(RuleSchema).transform((rules) => rules.filter((r) => r.text.length > 0)),
  backgroundTreatment: z.enum(["solid", "subtle_pattern", "scene"]),
  texture: z.enum(["none", "grain", "paper", "halftone"]),
  peopleStyle: z.enum(["none", "abstract_figures", "diverse_characters"]),
  pinStyleToCover: z.boolean(),
});

/**
 * Validates client input for the save action. A Server Action argument is
 * client input, so this is the same posture as `sanitizePersonas`. Returns
 * null rather than throwing: the action reports "invalid" to the card.
 */
export function parseVisualIdentity(input: unknown): VisualIdentity | null {
  const result = VisualIdentitySchema.safeParse(input);
  if (!result.success) return null;
  // The transforms above already normalised; cast the rule kind back to the
  // schema's ImageRule shape (identical members).
  return result.data as VisualIdentity & { imageGenerationRules: ImageRule[] };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/lib/images/visual-identity.test.ts`
Expected: PASS. If `z.url()` is reported missing, the installed zod is not v4-classic at the root export — use `z.string().url()` instead and note it in the commit.

- [ ] **Step 5: Commit**

```bash
git add src/lib/images/visual-identity.ts tests/lib/images/visual-identity.test.ts
git commit -m "feat: visual identity defaults, style block compiler and validation"
```

---

### Task 5: `policy.ts` — per-type image policy

**Files:**
- Create: `src/lib/images/policy.ts`
- Test: `tests/lib/images/policy.test.ts`

**Interfaces:**
- Consumes: `ContentType` (type) from `@/lib/ai/compose-prompt` (line 6: `export type ContentType = (typeof contentTypeEnum.enumValues)[number]`) — `import type` only, so the client form can import this module.
- Produces: `DEFAULT_IMAGE_POLICY`, `resolveImagePolicy(policy, type): { cover: boolean; bodyCap: number }`, `parseImagePolicy(input: unknown): ImagePolicy | null`, `IMAGE_POLICY_ROWS: readonly { type: ContentType; label: string }[]`, `BODY_SETTING_OPTIONS`.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/images/policy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { contentTypeEnum } from "../../../src/db/schema";
import { DEFAULT_IMAGE_POLICY, resolveImagePolicy, parseImagePolicy } from "../../../src/lib/images/policy";

describe("DEFAULT_IMAGE_POLICY", () => {
  it("covers every content type in the enum — a new type must not fall through undefined", () => {
    // `resolveImagePolicy` does `policy?.[type] ?? DEFAULT_IMAGE_POLICY[type]`
    // and then reads `.body` off it. A ContentType missing from the defaults
    // throws at generation time, not here — so assert the table is total.
    for (const type of contentTypeEnum.enumValues) {
      expect(DEFAULT_IMAGE_POLICY[type]).toBeDefined();
      expect(resolveImagePolicy(null, type)).toEqual(
        expect.objectContaining({ cover: expect.any(Boolean), bodyCap: expect.any(Number) })
      );
      expect(resolveImagePolicy({}, type).bodyCap).toBeGreaterThanOrEqual(0);
    }
  });

  it("matches the spec table", () => {
    expect(DEFAULT_IMAGE_POLICY).toEqual({
      blog_post: { cover: true, body: "auto" },
      product_update: { cover: true, body: "off" },
      social_post: { cover: false, body: "off" },
    });
  });
});

describe("resolveImagePolicy", () => {
  it("falls back to defaults when the column is null or the type is missing", () => {
    expect(resolveImagePolicy(null, "blog_post")).toEqual({ cover: true, bodyCap: 3 });
    expect(resolveImagePolicy({}, "product_update")).toEqual({ cover: true, bodyCap: 0 });
    expect(resolveImagePolicy({ blog_post: { cover: false, body: 1 } }, "social_post")).toEqual({ cover: false, bodyCap: 0 });
  });

  it("maps auto to 3, off to 0 and a number to itself", () => {
    expect(resolveImagePolicy({ social_post: { cover: true, body: "auto" } }, "social_post")).toEqual({ cover: true, bodyCap: 3 });
    expect(resolveImagePolicy({ blog_post: { cover: false, body: "off" } }, "blog_post")).toEqual({ cover: false, bodyCap: 0 });
    expect(resolveImagePolicy({ blog_post: { cover: true, body: 2 } }, "blog_post")).toEqual({ cover: true, bodyCap: 2 });
  });
});

describe("parseImagePolicy", () => {
  it("accepts a valid partial policy", () => {
    expect(parseImagePolicy({ blog_post: { cover: true, body: 2 }, social_post: { cover: false, body: "off" } })).toEqual({
      blog_post: { cover: true, body: 2 },
      social_post: { cover: false, body: "off" },
    });
  });

  it("rejects unknown types, bad caps and non-objects", () => {
    expect(parseImagePolicy({ newsletter: { cover: true, body: "off" } })).toBeNull();
    expect(parseImagePolicy({ blog_post: { cover: true, body: 4 } })).toBeNull();
    expect(parseImagePolicy({ blog_post: { cover: "yes", body: "off" } })).toBeNull();
    expect(parseImagePolicy([])).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/lib/images/policy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/images/policy.ts`:

```ts
import { z } from "zod";
import type { BodyIllustrationSetting, ImagePolicy } from "@/db/schema";
import type { ContentType } from "@/lib/ai/compose-prompt";

// Type-only imports above: the /settings Content images form is a Client
// Component and imports the defaults and row list from here.

/** "auto" resolves to this many body illustrations at most (spec §4, §6). */
export const AUTO_BODY_CAP = 3;

/** Spec §6 table. The column stays null until a tenant changes something. */
export const DEFAULT_IMAGE_POLICY: Record<ContentType, { cover: boolean; body: BodyIllustrationSetting }> = {
  blog_post: { cover: true, body: "auto" },
  product_update: { cover: true, body: "off" },
  social_post: { cover: false, body: "off" },
};

/** Row order and labels for the settings card. */
export const IMAGE_POLICY_ROWS: readonly { type: ContentType; label: string }[] = [
  { type: "blog_post", label: "Blog post" },
  { type: "product_update", label: "Product update" },
  { type: "social_post", label: "Social post" },
];

export const BODY_SETTING_OPTIONS: readonly { value: BodyIllustrationSetting; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "auto", label: `Auto (up to ${AUTO_BODY_CAP})` },
  { value: 1, label: "Up to 1" },
  { value: 2, label: "Up to 2" },
  { value: 3, label: "Up to 3" },
];

/**
 * What generation and the editor actually consult: a boolean for the cover and
 * a numeric cap for body illustrations. `null`/missing falls back to the
 * TypeScript defaults, so a tenant who never touched the card gets the table.
 */
export function resolveImagePolicy(policy: ImagePolicy | null, type: ContentType): { cover: boolean; bodyCap: number } {
  const entry = policy?.[type] ?? DEFAULT_IMAGE_POLICY[type];
  const bodyCap = entry.body === "off" ? 0 : entry.body === "auto" ? AUTO_BODY_CAP : entry.body;
  return { cover: entry.cover, bodyCap };
}

const EntrySchema = z.object({
  cover: z.boolean(),
  body: z.union([z.literal("off"), z.literal("auto"), z.literal(1), z.literal(2), z.literal(3)]),
});

const ImagePolicySchema = z
  .object({
    blog_post: EntrySchema.optional(),
    product_update: EntrySchema.optional(),
    social_post: EntrySchema.optional(),
  })
  .strict();

/** Client input for the save action; null when invalid. */
export function parseImagePolicy(input: unknown): ImagePolicy | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const result = ImagePolicySchema.safeParse(input);
  return result.success ? result.data : null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/lib/images/policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/images/policy.ts tests/lib/images/policy.test.ts
git commit -m "feat: per-content-type image policy defaults and resolver"
```

---

### Task 6: `prompt.ts` — the fixed prompt template

**Files:**
- Create: `src/lib/images/prompt.ts`
- Test: `tests/lib/images/prompt.test.ts`

**Interfaces:**
- Produces: `buildImagePrompt(a: { styleBlock: string; concept: string; role: "cover" | "body"; allowText: boolean }): string`; also `IMAGE_SIZES = { cover: "1200x630", body: "1200x900" } as const`, `IMAGE_ASPECT_RATIOS` (the same two shapes in `{width}:{height}` form, for `generateImage`'s `aspectRatio`) and `NO_TEXT_CLAUSE`.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/images/prompt.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildImagePrompt, IMAGE_ASPECT_RATIOS, IMAGE_SIZES, NO_TEXT_CLAUSE } from "../../../src/lib/images/prompt";

describe("buildImagePrompt", () => {
  it("orders concept, style block, composition, aspect, then the no-text clause for a cover", () => {
    const prompt = buildImagePrompt({ styleBlock: "Style: flat.", concept: "a lighthouse guiding ships", role: "cover", allowText: false });
    const i = (s: string) => prompt.indexOf(s);
    expect(i("a lighthouse guiding ships")).toBe(0);
    expect(i("Style: flat.")).toBeGreaterThan(i("a lighthouse"));
    expect(i("Wide hero composition")).toBeGreaterThan(i("Style: flat."));
    expect(i("safe zone")).toBeGreaterThan(0);
    expect(i("1.91:1")).toBeGreaterThan(i("Wide hero"));
    expect(prompt.endsWith(NO_TEXT_CLAUSE)).toBe(true);
    expect(prompt).not.toContain("\n");
  });

  it("uses the single-concept composition and 4:3 aspect for a body image", () => {
    const prompt = buildImagePrompt({ styleBlock: "S.", concept: "c", role: "body", allowText: false });
    expect(prompt).toContain("Single-concept illustration");
    expect(prompt).toContain("4:3");
    expect(prompt).not.toContain("Wide hero");
  });

  it("drops the no-text clause when text is allowed", () => {
    const prompt = buildImagePrompt({ styleBlock: "S.", concept: "c", role: "body", allowText: true });
    expect(prompt).not.toContain(NO_TEXT_CLAUSE);
  });

  it("exposes the two render sizes", () => {
    expect(IMAGE_SIZES).toEqual({ cover: "1200x630", body: "1200x900" });
  });

  it("exposes an aspect ratio for every size, in generateImage's {w}:{h} form", () => {
    // Covers are generated wide, never cropped (product owner decision 1), so
    // the request states the shape twice: `size` for providers that take exact
    // pixels, `aspectRatio` for providers that take a ratio. The two must
    // agree, or a provider honouring the ratio would return a different shape
    // from one honouring the size.
    expect(IMAGE_ASPECT_RATIOS).toEqual({ "1200x630": "40:21", "1200x900": "4:3" });
    for (const [size, ratio] of Object.entries(IMAGE_ASPECT_RATIOS)) {
      const [sw, sh] = size.split("x").map(Number);
      const [rw, rh] = ratio.split(":").map(Number);
      expect(Math.abs(sw / sh - rw / rh)).toBeLessThan(0.001);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/lib/images/prompt.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/images/prompt.ts`:

```ts
/** One master per image (spec §7): the cover serves hero + og:image + LinkedIn. */
export const IMAGE_SIZES = { cover: "1200x630", body: "1200x900" } as const;
export type ImageSize = (typeof IMAGE_SIZES)[keyof typeof IMAGE_SIZES];

/**
 * The same two shapes as `IMAGE_SIZES`, in `generateImage`'s `{w}:{h}` form.
 * `renderImage` sends BOTH `size` and `aspectRatio` (spec §7, product owner
 * decision 1: covers are generated at 1200×630 natively and are never
 * cropped) — gpt-image-2 supports flexible sizes, and a provider that ignores
 * one of the two settings reports it in `result.warnings` rather than
 * throwing, so stating the shape twice costs nothing and buys the wide render
 * from providers that only understand ratios.
 */
export const IMAGE_ASPECT_RATIOS = {
  "1200x630": "40:21",
  "1200x900": "4:3",
} as const satisfies Record<ImageSize, `${number}:${number}`>;

export const NO_TEXT_CLAUSE = "No text, letters, words, logos or watermarks.";

const COMPOSITION = {
  // Platforms crop edges; keep the subject inside a center safe zone (spec §7).
  cover: "Wide hero composition, subject centered within a safe zone away from the edges, generous negative space.",
  body: "Single-concept illustration, one clear focal subject, uncluttered.",
} as const;

const ASPECT = {
  cover: "Aspect ratio 1.91:1 (1200x630).",
  body: "Aspect ratio 4:3 (1200x900).",
} as const;

/**
 * The fixed template every render uses (spec §4): concept metaphor → compiled
 * style block → composition → aspect → no-text clause. The result is what gets
 * stored on the render row, so it must be a plain single-line string.
 */
export function buildImagePrompt(a: {
  styleBlock: string;
  concept: string;
  role: "cover" | "body";
  allowText: boolean;
}): string {
  const parts = [a.concept.trim(), a.styleBlock.trim(), COMPOSITION[a.role], ASPECT[a.role]];
  if (!a.allowText) parts.push(NO_TEXT_CLAUSE);
  return parts
    .filter(Boolean)
    .join(" ")
    .replace(/\s*\n\s*/g, " ");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/lib/images/prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/images/prompt.ts tests/lib/images/prompt.test.ts
git commit -m "feat: image prompt template"
```

---

### Task 7: `compress.ts` — sharp compression pass

**Files:**
- Create: `src/lib/images/compress.ts`
- Test: `tests/lib/images/compress.test.ts`

**Interfaces:**
- Produces: `compressPng(input: Buffer, maxWidth: number): Promise<{ png: Buffer; width: number; height: number }>`; `MAX_IMAGE_BYTES = 1_000_000`; `MAX_DELIVERABLE_BYTES = 4 * 1024 * 1024`; `imageDimensions(input: Buffer): Promise<{ width: number; height: number }>`.

> **The two guarantees this function makes — both load-bearing downstream, read
> before implementing.** (Product owner decisions 1 and 2, 2026-08-19.)
>
> 1. **It NEVER changes the aspect ratio.** It resizes by width only, with
>    `withoutEnlargement: true`. No crop, no extend, no letterbox — anywhere in
>    this codebase. Covers come out of the model at 1200×630 because
>    `renderImage` asks for that size *and* that aspect ratio and re-asks once
>    if the answer is the wrong shape (Task 9); if a provider still returns a
>    square, it is stored square with its true `width`/`height` and Plan 4
>    publishes those true numbers. Cropping was rejected because it cuts detail
>    the concept put there on purpose.
> 2. **Every returned PNG is ≤ `MAX_IMAGE_BYTES` (1 MB), or it is the smallest
>    this function could make it.** The ceiling applies to *everything stored* —
>    model renders and user uploads alike — because that is the only way spec
>    §8's "4 MB — guaranteed by the compression pass" is actually guaranteed: an
>    upload of a 10 MB photograph (`uploadImageFile`, Plan 3) goes through this
>    same function. One ceiling, one code path, and both Webflow (4 MB) and
>    LinkedIn (5 MB) clear it with room to spare. The loop is bounded and never
>    throws — a slightly-over image beats a failed draft.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/images/compress.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import sharp from "sharp";
import { MAX_DELIVERABLE_BYTES, MAX_IMAGE_BYTES, compressPng, imageDimensions } from "../../../src/lib/images/compress";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

async function solidPng(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } } })
    .png()
    .toBuffer();
}

/** Deterministic pseudo-noise: the worst case for PNG, and what a photo upload looks like. */
async function noisyJpeg(width: number, height: number): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 2654435761) % 256;
  return sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

describe("compressPng", () => {
  it("resizes down to maxWidth keeping aspect and returns a PNG", async () => {
    const input = await solidPng(2400, 1260);
    const out = await compressPng(input, 1200);
    expect(out.width).toBe(1200);
    expect(out.height).toBe(630);
    expect(out.png.subarray(0, 4).equals(PNG_SIGNATURE)).toBe(true);
    const meta = await sharp(out.png).metadata();
    expect(meta.width).toBe(1200);
    expect(meta.format).toBe("png");
  });

  it("never enlarges a smaller image", async () => {
    const input = await solidPng(600, 300);
    const out = await compressPng(input, 1200);
    expect(out.width).toBe(600);
    expect(out.height).toBe(300);
  });

  it("does not grow a flat graphic", async () => {
    const input = await solidPng(1200, 630);
    const out = await compressPng(input, 1200);
    expect(out.png.byteLength).toBeLessThanOrEqual(input.byteLength);
  });

  it("keeps a realistic flat cover far under the 1 MB ceiling (and so under Webflow's 4 MB / LinkedIn's 5 MB)", async () => {
    // The cover master the agent produces: 1200 px wide, flat fills. This is
    // the claim spec §8 makes ("guaranteed by the compression pass"); pin it so
    // a future change to the sharp options can't quietly break Webflow
    // rehosting.
    const out = await compressPng(await solidPng(2400, 1260), 1200);
    expect(out.png.byteLength).toBeLessThan(MAX_IMAGE_BYTES);
    expect(MAX_IMAGE_BYTES).toBe(1_000_000);
    expect(MAX_DELIVERABLE_BYTES).toBe(4 * 1024 * 1024);
  });

  it("accepts a JPEG input and emits a PNG (the upload path, spec §5 uploads)", async () => {
    const out = await compressPng(await noisyJpeg(1600, 900), 1200);
    expect(out.png.subarray(0, 4).equals(PNG_SIGNATURE)).toBe(true);
    expect(out.width).toBeLessThanOrEqual(1200);
    expect(await sharp(out.png).metadata().then((m) => m.format)).toBe("png");
  });

  it("NEVER changes the aspect ratio — a square render stays square", async () => {
    // The no-crop guarantee (product owner decision 1). Providers sometimes
    // round a 1200x630 request to a square supported size; `renderImage` asks
    // again once (Task 9) and, if the answer is still square, we store it
    // square rather than cut pixels the concept asked for. Plan 4 publishes
    // exactly these numbers as coverImage.width/height.
    const out = await compressPng(await solidPng(1024, 1024), 1200);
    expect({ width: out.width, height: out.height }).toEqual({ width: 1024, height: 1024 });
  });

  it("brings a large noisy image under 1 MB with the aspect ratio intact", async () => {
    // A photograph upload — the worst case for PNG and the reason the ceiling
    // exists at all (a quantised 1200 px photo can otherwise exceed 4 MB and
    // Webflow 400s at publish with a message the user cannot act on).
    const input = await noisyJpeg(3000, 2000);
    const out = await compressPng(input, 1200);
    expect(out.png.byteLength).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    // 3:2 in, 3:2 out — the ceiling is met by width + palette, never by crop.
    expect(Math.abs(out.width / out.height - 3 / 2)).toBeLessThan(0.02);
    const meta = await sharp(out.png).metadata();
    expect({ width: meta.width, height: meta.height }).toEqual({ width: out.width, height: out.height });
  });

  it("leaves an already-small image essentially alone — no needless quality loss", async () => {
    // The common case must not pay for the ceiling: a 600x300 flat graphic is
    // already well under 1 MB, so the first encode returns and no step-down
    // loop runs.
    const input = await solidPng(600, 300);
    const out = await compressPng(input, 1200);
    expect({ width: out.width, height: out.height }).toEqual({ width: 600, height: 300 });
    expect(out.png.byteLength).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
  });

  it("returns the smallest result it achieved rather than throwing when the ceiling is unreachable", async () => {
    // Bounded attempts: if even the last width step is over the ceiling we
    // return that result and log — a slightly-over image beats a failed draft.
    // Forced by asking for a ceiling-busting width on noise: maxWidth is
    // honoured downward, so this exercises the same loop with a tiny budget.
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = await noisyJpeg(4000, 3000);
    const out = await compressPng(input, 4000);
    expect(Buffer.isBuffer(out.png)).toBe(true);
    expect(out.width).toBeGreaterThan(0);
    // Either it got under the ceiling, or it warned and returned its best.
    if (out.png.byteLength > MAX_IMAGE_BYTES) expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it("rejects bytes that are not an image, so an upload of a renamed file fails before Blob", async () => {
    // `uploadImageFile` (Plan 3) trusts the browser-supplied mime type; this
    // throw is what actually stops non-image bytes reaching Vercel Blob.
    await expect(compressPng(Buffer.from("not an image at all"), 1200)).rejects.toThrow();
  });
});

describe("imageDimensions", () => {
  it("reads the real pixel dimensions (what the cover aspect guard measures)", async () => {
    expect(await imageDimensions(await solidPng(1200, 630))).toEqual({ width: 1200, height: 630 });
  });

  it("throws on bytes sharp cannot parse — callers decide what that means", async () => {
    await expect(imageDimensions(Buffer.from("nope"))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/lib/images/compress.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/images/compress.ts`:

```ts
import sharp from "sharp";

/**
 * The hard ceiling on EVERY PNG we store — generated renders and user uploads
 * alike (product owner, 2026-08-19). One ceiling on one code path is the only
 * way spec §8's "guaranteed by the compression pass" is true of uploads too:
 * `uploadImageFile` (Plan 3) accepts 10 MB of JPEG and pushes it through this
 * same function.
 */
export const MAX_IMAGE_BYTES = 1_000_000;

/**
 * What the destinations themselves allow: Webflow rehosts at most 4 MB
 * (spec §8) and LinkedIn's Images API at most 5 MB. Kept exported as the
 * external contract this module's own, much lower ceiling satisfies — nothing
 * enforces it separately, because nothing needs to.
 */
export const MAX_DELIVERABLE_BYTES = 4 * 1024 * 1024;

/**
 * Palette sizes tried in order before touching the width. Fewer colours is a
 * free win on flat marketing graphics and barely visible on photographs at
 * this scale.
 */
const PALETTE_STEPS = [256, 128, 64] as const;
/** Last resort, applied only after the palette steps: shrink and re-encode. */
const WIDTH_STEP_FACTOR = 0.85;
const MAX_WIDTH_STEPS = 4;
const MIN_WIDTH = 400;

async function encode(input: Buffer, width: number, colors: number) {
  const { data, info } = await sharp(input)
    // Width only — `withoutEnlargement` keeps a small source small, and the
    // height follows the source ratio. This is the no-crop guarantee: nothing
    // in this file may ever pass `height`, `fit`, `extend` or `extract`.
    .resize({ width, withoutEnlargement: true })
    .png({ palette: true, colors, compressionLevel: 9, effort: 7 })
    .toBuffer({ resolveWithObject: true });
  return { png: data, width: info.width, height: info.height };
}

/**
 * The mandatory pass before every Blob `put()` (spec §7). Models emit multi-MB
 * PNGs; a resize to the target width plus a palette-quantized PNG turns the
 * Hobby plan's ~300 storable images into thousands. PNG, never WebP: LinkedIn's
 * image API rejects WebP and flat graphics quantize well.
 *
 * Two invariants (product owner decisions 1 and 2):
 * - **The aspect ratio is never changed.** No crop, no extend, ever.
 * - **The result is ≤ MAX_IMAGE_BYTES**, or the smallest of a bounded set of
 *   attempts. It never throws for being too big: a slightly-over image beats a
 *   failed draft, and the one caller that could produce one (a photograph
 *   upload) still lands far under Webflow's 4 MB.
 */
export async function compressPng(input: Buffer, maxWidth: number): Promise<{ png: Buffer; width: number; height: number }> {
  // Throws for bytes sharp cannot read — the guard that stops a renamed
  // non-image upload from reaching Blob.
  const meta = await sharp(input).metadata();
  let width = Math.min(maxWidth, meta.width ?? maxWidth);

  let best = await encode(input, width, PALETTE_STEPS[0]);
  if (best.png.byteLength <= MAX_IMAGE_BYTES) return best;

  for (const colors of PALETTE_STEPS.slice(1)) {
    const candidate = await encode(input, width, colors);
    if (candidate.png.byteLength < best.png.byteLength) best = candidate;
    if (best.png.byteLength <= MAX_IMAGE_BYTES) return best;
  }

  for (let step = 0; step < MAX_WIDTH_STEPS; step++) {
    const next = Math.max(MIN_WIDTH, Math.round(width * WIDTH_STEP_FACTOR));
    if (next === width) break;
    width = next;
    const candidate = await encode(input, width, PALETTE_STEPS[PALETTE_STEPS.length - 1]);
    if (candidate.png.byteLength < best.png.byteLength) best = candidate;
    if (best.png.byteLength <= MAX_IMAGE_BYTES) return best;
  }

  console.warn(
    `[images/compress] could not get below ${MAX_IMAGE_BYTES} bytes after ${PALETTE_STEPS.length + MAX_WIDTH_STEPS} attempts; storing ${best.png.byteLength} bytes at ${best.width}x${best.height}`
  );
  return best;
}

/**
 * The real pixel dimensions of some bytes. Used by `renderImage`'s cover
 * aspect guard (Task 9) — it lives here so `sharp` is imported in exactly one
 * module. Throws on unparseable bytes; the guard treats that as "cannot
 * measure" and stores as-is.
 */
export async function imageDimensions(input: Buffer): Promise<{ width: number; height: number }> {
  const meta = await sharp(input).metadata();
  if (!meta.width || !meta.height) throw new Error("Image has no readable dimensions");
  return { width: meta.width, height: meta.height };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/lib/images/compress.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/images/compress.ts tests/lib/images/compress.test.ts
git commit -m "feat: sharp compression pass with a 1 MB ceiling and no aspect change"
```

---

### Task 8: `blob.ts` — Vercel Blob wrappers

**Files:**
- Create: `src/lib/images/blob.ts`
- Test: `tests/lib/images/blob.test.ts`

**Interfaces:**
- Produces: `imagePathname({ tenantId, contentPieceId, role, slug })`, `brandAssetPathname({ tenantId, slug })`, `slugForImage(text): string`, `uploadPng(pathname, png): Promise<{ url; pathname }>`, `deleteBlobs(pathnames): Promise<void>`, `blobPathnameFromUrl(url): string`, and the upload validator shared with Plan 3: `UPLOAD_MAX_BYTES`, `UPLOAD_MIME_TYPES`, `validateUploadFile(file)`.
- The validator lives **here**, not in Plan 3's `actions-support.ts`, because Plan 1 Task 12 needs it first (style-reference upload) and two copies of "what may be uploaded" is exactly the kind of drift the QA review's defect 8 was about. Plan 3 Task 1 re-exports these three names so its own consumers' imports are unchanged.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/images/blob.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@vercel/blob", () => ({ put: vi.fn(), del: vi.fn() }));

import { put, del } from "@vercel/blob";
import {
  UPLOAD_MAX_BYTES,
  blobPathnameFromUrl,
  brandAssetPathname,
  deleteBlobs,
  imagePathname,
  slugForImage,
  uploadPng,
  validateUploadFile,
} from "../../../src/lib/images/blob";

beforeEach(() => {
  vi.mocked(put).mockReset();
  vi.mocked(del).mockReset();
  vi.restoreAllMocks();
});

describe("imagePathname", () => {
  it("nests under the tenant and piece", () => {
    expect(imagePathname({ tenantId: "t1", contentPieceId: "p1", role: "cover", slug: "lighthouse" })).toBe(
      "tenants/t1/content/p1/cover-lighthouse.png"
    );
  });
  it("uses 'library' when there is no piece", () => {
    expect(imagePathname({ tenantId: "t1", contentPieceId: null, role: "library", slug: "x" })).toBe(
      "tenants/t1/content/library/library-x.png"
    );
  });
});

describe("brandAssetPathname", () => {
  it("keeps brand inputs out of the content tree", () => {
    // Style reference images are brand INPUTS, not content output: they get no
    // content_images row and no piece, so they get their own prefix (product
    // owner decision 3).
    expect(brandAssetPathname({ tenantId: "t1", slug: "hero-illustration" })).toBe("tenants/t1/brand/hero-illustration.png");
  });

  it("stays inside the tenant prefix for a hostile file name", () => {
    const path = brandAssetPathname({ tenantId: "t1", slug: slugForImage("../../../etc/passwd") });
    expect(path.startsWith("tenants/t1/brand/")).toBe(true);
    expect(path).not.toContain("..");
  });
});

describe("validateUploadFile", () => {
  it("accepts png, jpeg and webp under the cap", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp"]) {
      expect(validateUploadFile({ type, size: 1024 })).toEqual({ ok: true });
    }
  });
  it("rejects other mime types with a readable error", () => {
    const result = validateUploadFile({ type: "image/gif", size: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/PNG, JPEG or WebP/);
  });
  it("rejects files over the 10 MB input cap", () => {
    const result = validateUploadFile({ type: "image/png", size: UPLOAD_MAX_BYTES + 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/10 MB/);
    expect(UPLOAD_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe("blobPathnameFromUrl", () => {
  it("recovers the pathname a blob URL was stored under", () => {
    expect(blobPathnameFromUrl("https://abc.public.blob.vercel-storage.com/tenants/t1/brand/a-b12ce.png")).toBe(
      "tenants/t1/brand/a-b12ce.png"
    );
  });
  it("passes a bare pathname through unchanged", () => {
    expect(blobPathnameFromUrl("tenants/t1/brand/a.png")).toBe("tenants/t1/brand/a.png");
  });
});

describe("slugForImage", () => {
  it("lowercases, hyphenates and clamps", () => {
    expect(slugForImage("A Lighthouse, Guiding Ships!")).toBe("a-lighthouse-guiding-ships");
    expect(slugForImage("   ")).toBe("image");
    expect(slugForImage("x".repeat(100))).toHaveLength(40);
  });

  it("cannot escape its directory: the slug is the ONLY caller-controlled part of a pathname", () => {
    // The concept, the piece title and an uploaded file's name all reach
    // `imagePathname` through this function. Slashes, dots and query characters
    // must not survive, or a crafted concept writes outside its tenant prefix.
    for (const hostile of ["../../etc/passwd", "..%2f..%2fsecret", "a/b/c", "x?y=z#frag", "\\windows\\system32"]) {
      const slug = slugForImage(hostile);
      expect(slug).toMatch(/^[a-z0-9-]+$/);
      expect(slug).not.toContain("..");
    }
  });

  it("keeps a hostile concept inside the tenant prefix once composed", () => {
    const path = imagePathname({ tenantId: "t1", contentPieceId: "p1", role: "body", slug: slugForImage("../../../x") });
    expect(path.startsWith("tenants/t1/content/p1/")).toBe(true);
    expect(path).not.toContain("..");
  });
});

describe("uploadPng", () => {
  it("puts a public, random-suffixed PNG and returns url + pathname", async () => {
    vi.mocked(put).mockResolvedValue({ url: "https://blob/x-abc.png", pathname: "tenants/t/x-abc.png" } as never);
    const png = Buffer.from("png");
    const result = await uploadPng("tenants/t/x.png", png);
    expect(put).toHaveBeenCalledWith("tenants/t/x.png", png, {
      access: "public",
      addRandomSuffix: true,
      contentType: "image/png",
    });
    expect(result).toEqual({ url: "https://blob/x-abc.png", pathname: "tenants/t/x-abc.png" });
  });
});

describe("deleteBlobs", () => {
  it("deletes in one call and is a no-op for an empty list", async () => {
    vi.mocked(del).mockResolvedValue(undefined as never);
    await deleteBlobs(["a.png", "b.png"]);
    expect(del).toHaveBeenCalledWith(["a.png", "b.png"]);
    await deleteBlobs([]);
    expect(del).toHaveBeenCalledTimes(1);
  });

  it("swallows and logs failures", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(del).mockRejectedValue(new Error("quota"));
    await expect(deleteBlobs(["a.png"])).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/lib/images/blob.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/images/blob.ts`:

```ts
import { put, del } from "@vercel/blob";
import type { ImageRole } from "@/db/schema";

const MAX_SLUG = 40;

/** A filesystem-safe slug for a pathname; never empty. */
export function slugForImage(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, "");
  return slug || "image";
}

/**
 * `tenants/{tenantId}/content/{contentPieceId ?? "library"}/{role}-{slug}.png`
 * (spec §7): tenant prefix for accounting; `put()` adds the random suffix that
 * makes it immutable and unguessable.
 */
export function imagePathname(a: { tenantId: string; contentPieceId: string | null; role: ImageRole; slug: string }): string {
  return `tenants/${a.tenantId}/content/${a.contentPieceId ?? "library"}/${a.role}-${a.slug}.png`;
}

/**
 * `tenants/{tenantId}/brand/{slug}.png` — style reference images and any other
 * brand INPUT. Deliberately outside the `content/` tree: these are not content
 * output, they have no `content_images` row and no piece, and putting them in
 * `content/library/` would make them show up as library images that cannot be
 * regenerated (product owner decision 3, 2026-08-19).
 */
export function brandAssetPathname(a: { tenantId: string; slug: string }): string {
  return `tenants/${a.tenantId}/brand/${a.slug}.png`;
}

/** What may be uploaded, in bytes and mime types. Shared with Plan 3's editor
 * uploads — one definition, re-exported there. The 10 MB is the INPUT cap; the
 * stored PNG is capped separately at `MAX_IMAGE_BYTES` by `compressPng`. */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const UPLOAD_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export function validateUploadFile(file: { type: string; size: number }): { ok: true } | { ok: false; error: string } {
  if (!(UPLOAD_MIME_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, error: "Only PNG, JPEG or WebP images can be uploaded." };
  }
  if (file.size > UPLOAD_MAX_BYTES) {
    return { ok: false, error: "Images must be 10 MB or smaller." };
  }
  return { ok: true };
}

/**
 * The pathname a stored blob URL corresponds to. `del()` accepts either, but
 * `deleteBlobs` takes pathnames, and the visual identity card stores reference
 * images as URLs only (no row carries their pathname), so removal needs this.
 */
export function blobPathnameFromUrl(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\/+/, "");
  } catch {
    return url;
  }
}

/**
 * Uploads one already-compressed PNG. Public — these are marketing images
 * that go public at publish anyway; the random suffix is the access control
 * for unpublished drafts. Never overwrites: regeneration writes a new blob.
 */
export async function uploadPng(pathname: string, png: Buffer): Promise<{ url: string; pathname: string }> {
  const blob = await put(pathname, png, { access: "public", addRandomSuffix: true, contentType: "image/png" });
  return { url: blob.url, pathname: blob.pathname };
}

/**
 * Deletes blobs by pathname. Swallows errors: deletion is cleanup after a
 * render was pruned or an image row removed, and the row change must not be
 * undone by a Blob hiccup. Never uses `list()` (an advanced op on Hobby).
 */
export async function deleteBlobs(pathnames: string[]): Promise<void> {
  if (pathnames.length === 0) return;
  try {
    await del(pathnames);
  } catch (error) {
    console.error("Failed to delete blobs:", pathnames, error);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/lib/images/blob.test.ts`
Expected: PASS. Then `npx tsc --noEmit` must be clean for this file — if `put`'s options type rejects `addRandomSuffix` or `del` rejects an array, adapt to the installed `@vercel/blob` typings and note it in the commit.

- [ ] **Step 5: Commit**

```bash
git add src/lib/images/blob.ts tests/lib/images/blob.test.ts
git commit -m "feat: vercel blob wrappers for image uploads"
```

---

### Task 9: `image-model.ts` + `images.ts` — the one render function

**Files:**
- Create: `src/lib/ai/image-model.ts`
- Create: `src/lib/ai/images.ts`
- Test: `tests/lib/ai/image-model.test.ts`, `tests/lib/ai/images.test.ts`

**Interfaces:**
- Consumes: `generateImage` from `ai` (7.0.22; `node_modules/ai/dist/index.d.ts` line 7063: `generateImage({ model, prompt, n, size, ... }): Promise<GenerateImageResult>`; prompt is `string | { images: DataContent[]; text?: string; mask? }` where `DataContent = string | Uint8Array | ArrayBuffer | Buffer`; result `images[0].uint8Array`, `usage: { inputTokens?, outputTokens?, totalTokens? }`). `recordLlmUsage` from Task 3.
- Produces: `IMAGE_MODEL_DEFAULT`, `imageModelId(spec)`, `resolveImageModel(spec)`, `RenderImageArgs` (with `enforceAspect?: boolean`), `RenderImageDeps = { generate?: typeof generateImage; fetchImpl?: typeof fetch }`, `ASPECT_TOLERANCE`, `renderImage(args, deps?): Promise<Buffer>`.

> **The cover aspect guard lives HERE, in the one render seam** (product owner
> decision 1, 2026-08-19) — not in `illustratePiece` and not in Plan 3's
> `renderAndStore`, because both of those render covers and a guard in two
> places drifts. Every call passes `size` **and** the matching
> `aspectRatio` from `IMAGE_ASPECT_RATIOS`; cover calls additionally pass
> `enforceAspect: true`, which makes `renderImage` measure the returned bytes
> and, if the shape is off by more than `ASPECT_TOLERANCE` (2%), warn and
> re-issue the request once with the size and aspect ratio restated. If the
> second answer is still the wrong shape it is returned **as-is** and stored
> with its true dimensions. **Nothing crops.** Two consequences to hold in your
> head: a guarded retry is a second billed image (it records its own
> `image_generation` usage row, which is correct — two images were generated),
> and Plan 2's silent per-render retry wraps this one, so a pathological cover
> can cost up to four renders. That is the accepted worst case for never
> shipping a cropped or mis-shaped cover.
- Note on references: `ai` accepts `http(s)` strings as `{ type: "url" }` files (`toImageModelV4File`, `node_modules/ai/dist/index.js` line 11725), but whether the OpenAI *edits* endpoint (multipart) accepts URL files is provider-dependent. `renderImage` therefore downloads string references to bytes itself before calling `generate`, so what reaches the provider is always bytes.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/ai/image-model.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { IMAGE_MODEL_DEFAULT, imageModelId, resolveImageModel } from "../../../src/lib/ai/image-model";

describe("imageModelId", () => {
  it("strips a leading openai/ prefix and leaves bare ids alone", () => {
    expect(imageModelId("openai/gpt-image-2")).toBe("gpt-image-2");
    expect(imageModelId("gpt-image-2")).toBe("gpt-image-2");
    expect(IMAGE_MODEL_DEFAULT).toBe("openai/gpt-image-2");
  });
});

describe("resolveImageModel", () => {
  it("returns an OpenAI image model with the bare id", () => {
    process.env.OPENAI_API_KEY ??= "test-key";
    const model = resolveImageModel("openai/gpt-image-2");
    expect(model.modelId).toBe("gpt-image-2");
    expect(model.provider).toContain("openai");
  });
});
```

Create `tests/lib/ai/images.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { db } from "../../../src/db";
import { llmUsage } from "../../../src/db/schema";
import { seedTenant, dropTenant } from "../../helpers/fixtures";
import { renderImage, type RenderImageDeps } from "../../../src/lib/ai/images";

process.env.OPENAI_API_KEY ??= "test-key";

const TENANT = "Render Image Test Tenant";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function fakeGenerate(bytes: Buffer = PNG) {
  const calls: unknown[] = [];
  const generate = vi.fn(async (opts: unknown) => {
    calls.push(opts);
    return { images: [{ uint8Array: new Uint8Array(bytes), base64: "", mediaType: "image/png" }], usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } };
  }) as unknown as NonNullable<RenderImageDeps["generate"]>;
  return { generate, calls: calls as { model: { modelId: string }; prompt: unknown; size?: string; aspectRatio?: string }[] };
}

/** A REAL png of the given shape — the aspect guard measures pixels with sharp. */
async function realPng(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } })
    .png()
    .toBuffer();
}

afterEach(async () => {
  await dropTenant(TENANT);
});

describe("renderImage", () => {
  it("sends a plain string prompt with the requested size and returns the PNG bytes", async () => {
    const tenant = await seedTenant(TENANT);
    const { generate, calls } = fakeGenerate();

    const png = await renderImage({ tenantId: tenant.id, prompt: "a lighthouse", size: "1200x630" }, { generate });

    expect(Buffer.isBuffer(png)).toBe(true);
    expect(png.equals(PNG)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toBe("a lighthouse");
    expect(calls[0].size).toBe("1200x630");
    // Covers are generated wide NATIVELY, never cropped later: the request
    // states the shape both ways so a provider honouring either one returns
    // 1.91:1 (product owner decision 1).
    expect(calls[0].aspectRatio).toBe("40:21");
    expect(calls[0].model.modelId).toBe("gpt-image-2");
  });

  it("passes reference images as {images, text}, downloading URL references to bytes", async () => {
    const tenant = await seedTenant(TENANT);
    const { generate, calls } = fakeGenerate();
    const refBytes = Buffer.from("ref-png");
    const fetchImpl = vi.fn(async () => new Response(refBytes)) as unknown as typeof fetch;

    await renderImage(
      { tenantId: tenant.id, prompt: "p", size: "1200x900", referenceImages: ["https://blob/ref.png", Buffer.from("local")] },
      { generate, fetchImpl }
    );

    expect(fetchImpl).toHaveBeenCalledWith("https://blob/ref.png");
    const prompt = calls[0].prompt as { images: Buffer[]; text: string };
    expect(prompt.text).toBe("p");
    expect(prompt.images).toHaveLength(2);
    expect(Buffer.from(prompt.images[0]).equals(refBytes)).toBe(true);
    expect(Buffer.from(prompt.images[1]).toString()).toBe("local");
  });

  it("edits: passes editOf as the single image and the prompt as the instruction", async () => {
    const tenant = await seedTenant(TENANT);
    const { generate, calls } = fakeGenerate();
    const original = Buffer.from("orig");

    await renderImage({ tenantId: tenant.id, prompt: "make the background darker", size: "1200x900", editOf: original }, { generate });

    const prompt = calls[0].prompt as { images: Buffer[]; text: string };
    expect(prompt.images).toHaveLength(1);
    expect(Buffer.from(prompt.images[0]).toString()).toBe("orig");
    expect(prompt.text).toBe("make the background darker");
  });

  it("records an image_generation usage row with imageCount 1", async () => {
    const tenant = await seedTenant(TENANT);
    const { generate } = fakeGenerate();

    await renderImage({ tenantId: tenant.id, prompt: "p", size: "1200x630" }, { generate });

    const [row] = await db.select().from(llmUsage).where(eq(llmUsage.tenantId, tenant.id));
    expect(row).toMatchObject({ operation: "image_generation", model: "gpt-image-2", imageCount: 1, inputTokens: 10, totalTokens: 30 });
  });

  it("accepts a cover that came back the right shape without a second call", async () => {
    const tenant = await seedTenant(TENANT);
    const { generate, calls } = fakeGenerate(await realPng(1200, 630));

    const png = await renderImage({ tenantId: tenant.id, prompt: "p", size: "1200x630", enforceAspect: true }, { generate });

    expect(calls).toHaveLength(1);
    expect((await sharp(png).metadata()).width).toBe(1200);
  });

  it("retries a cover ONCE when the provider returns a square, then stores the true dimensions — never a crop", async () => {
    const tenant = await seedTenant(TENANT);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const square = await realPng(1024, 1024);
    const { generate, calls } = fakeGenerate(square);

    const png = await renderImage({ tenantId: tenant.id, prompt: "p", size: "1200x630", enforceAspect: true }, { generate });

    // Exactly two attempts — one retry, not a loop — and the size/aspect ratio
    // are restated on the retry.
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ size: "1200x630", aspectRatio: "40:21" });
    // Still square, and returned untouched: no crop, no letterbox, no lie
    // about the dimensions. Plan 4 publishes 1024x1024 for this cover.
    const meta = await sharp(png).metadata();
    expect({ width: meta.width, height: meta.height }).toEqual({ width: 1024, height: 1024 });
    expect(consoleWarn).toHaveBeenCalled();
    // Two images were generated, so two usage rows: the retry is billed.
    expect(await db.select().from(llmUsage).where(eq(llmUsage.tenantId, tenant.id))).toHaveLength(2);
    consoleWarn.mockRestore();
  });

  it("does not guard a body render — only covers pass enforceAspect", async () => {
    const tenant = await seedTenant(TENANT);
    const { generate, calls } = fakeGenerate(await realPng(1024, 1024));

    await renderImage({ tenantId: tenant.id, prompt: "p", size: "1200x900" }, { generate });

    expect(calls).toHaveLength(1);
    expect(calls[0].aspectRatio).toBe("4:3");
  });

  it("stores unmeasurable bytes as-is rather than failing the render", async () => {
    // If sharp cannot read what came back, the guard has nothing to compare
    // and must not take the render down with it.
    const tenant = await seedTenant(TENANT);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { generate, calls } = fakeGenerate(PNG); // 7 bytes, not a real PNG

    const png = await renderImage({ tenantId: tenant.id, prompt: "p", size: "1200x630", enforceAspect: true }, { generate });

    expect(calls).toHaveLength(1);
    expect(png.equals(PNG)).toBe(true);
    consoleWarn.mockRestore();
  });

  it("propagates a model failure and records nothing", async () => {
    const tenant = await seedTenant(TENANT);
    const generate = vi.fn(async () => {
      throw new Error("model down");
    }) as unknown as NonNullable<RenderImageDeps["generate"]>;

    await expect(renderImage({ tenantId: tenant.id, prompt: "p", size: "1200x630" }, { generate })).rejects.toThrow("model down");
    expect(await db.select().from(llmUsage).where(eq(llmUsage.tenantId, tenant.id))).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/lib/ai/image-model.test.ts tests/lib/ai/images.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `image-model.ts`**

Create `src/lib/ai/image-model.ts`:

```ts
import { openai } from "@ai-sdk/openai";

export const IMAGE_MODEL_DEFAULT = "openai/gpt-image-2";

/** Strips a gateway-style "openai/" prefix: "openai/gpt-image-2" -> "gpt-image-2". */
export function imageModelId(spec: string): string {
  return spec.startsWith("openai/") ? spec.slice("openai/".length) : spec;
}

/**
 * Resolves the configured image model, calling OpenAI DIRECTLY via
 * @ai-sdk/openai (billed against OPENAI_API_KEY) — the same no-gateway stance
 * as src/lib/ai/model.ts, and the one documented exception to Anthropic-only
 * (Anthropic has no image model; image spec §1). Swapping models later is an
 * IMAGE_MODEL env change.
 */
export function resolveImageModel(spec: string) {
  return openai.image(imageModelId(spec));
}
```

If Task 1 Step 2 showed `openai.image` is not exported, use `openai.imageModel(imageModelId(spec))` and say so in the commit message.

- [ ] **Step 4: Implement `images.ts`**

Create `src/lib/ai/images.ts`:

```ts
import { generateImage } from "ai";
import type { DbClient } from "@/lib/publishing/destinations/types";
import { recordLlmUsage } from "@/lib/ai/llm-usage";
import { IMAGE_MODEL_DEFAULT, imageModelId, resolveImageModel } from "@/lib/ai/image-model";
import { imageDimensions } from "@/lib/images/compress";
import { IMAGE_ASPECT_RATIOS, type ImageSize } from "@/lib/images/prompt";

export type RenderImageArgs = {
  tenantId: string;
  /** The FULL prompt, style block already included (buildImagePrompt). */
  prompt: string;
  /** cover | body master sizes; sent as BOTH `size` and `aspectRatio`. */
  size: ImageSize;
  /** Style references — blob URLs or bytes. Passed via prompt {images, text}. */
  referenceImages?: (string | Buffer)[];
  /** When set: image+instruction edit; `prompt` is the instruction. */
  editOf?: string | Buffer;
  /**
   * Covers only. Measures what came back and re-asks once if the shape is off
   * by more than ASPECT_TOLERANCE. Never crops — see the block above.
   */
  enforceAspect?: boolean;
  database?: DbClient;
};

/** How far off 1.91:1 a cover may be before we ask again. 2% ≈ 1.87–1.94:1. */
export const ASPECT_TOLERANCE = 0.02;

/** Injectable for tests. `generate` is `ai`'s generateImage; `fetchImpl` downloads URL references. */
export type RenderImageDeps = {
  generate?: typeof generateImage;
  fetchImpl?: typeof fetch;
};

async function toBytes(ref: string | Buffer, fetchImpl: typeof fetch): Promise<Buffer> {
  if (Buffer.isBuffer(ref)) return ref;
  const res = await fetchImpl(ref);
  if (!res.ok) throw new Error(`Failed to fetch reference image (${res.status}): ${ref}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The shape `size` asks for, as a number. "1200x630" -> 1.904…  */
function targetAspect(size: ImageSize): number {
  const [width, height] = size.split("x").map(Number);
  return width / height;
}

/**
 * How far the bytes deviate from `wanted`, as a fraction. `null` means the
 * bytes could not be measured at all — the guard then stands down rather than
 * failing a render over a missing metadata read.
 */
async function aspectDeviation(png: Buffer, wanted: number): Promise<number | null> {
  try {
    const { width, height } = await imageDimensions(png);
    return Math.abs(width / height - wanted) / wanted;
  } catch (error) {
    console.warn("[ai/images] could not measure the rendered image; storing it as-is:", error);
    return null;
  }
}

/**
 * The single seam every render goes through (spec §1): prompt + references
 * in, raw PNG bytes out, one `image_generation` usage row per call. Callers
 * compress (`compressPng`) and upload (`uploadPng`) — this function knows
 * nothing about Blob or the database beyond accounting.
 *
 * References are downloaded to bytes here rather than passed as URLs so the
 * provider's edits endpoint (multipart) always receives file data regardless
 * of how it treats URL files.
 *
 * The request states the shape twice — `size` (exact pixels) and
 * `aspectRatio` — because gpt-image-2 supports flexible sizes and a provider
 * that honours only one of the two still returns the right shape. With
 * `enforceAspect` (covers), the answer is measured and re-asked for once if it
 * is off; a still-wrong second answer is returned as-is with its true
 * dimensions. NOTHING here or downstream crops (product owner, 2026-08-19).
 */
export async function renderImage(args: RenderImageArgs, deps: RenderImageDeps = {}): Promise<Buffer> {
  const generate = deps.generate ?? generateImage;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const spec = process.env.IMAGE_MODEL ?? IMAGE_MODEL_DEFAULT;
  const model = resolveImageModel(spec);

  let prompt: Parameters<typeof generateImage>[0]["prompt"];
  if (args.editOf !== undefined) {
    prompt = { images: [await toBytes(args.editOf, fetchImpl)], text: args.prompt };
  } else if (args.referenceImages && args.referenceImages.length > 0) {
    const images = await Promise.all(args.referenceImages.map((r) => toBytes(r, fetchImpl)));
    prompt = { images, text: args.prompt };
  } else {
    prompt = args.prompt;
  }

  /** One billed render: the model call plus its usage row. */
  const renderOnce = async (): Promise<Buffer> => {
    const result = await generate({
      model,
      prompt,
      size: args.size,
      aspectRatio: IMAGE_ASPECT_RATIOS[args.size],
      n: 1,
    });

    await recordLlmUsage(
      {
        tenantId: args.tenantId,
        operation: "image_generation",
        model: imageModelId(spec),
        usage: {
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
          totalTokens: result.usage?.totalTokens,
        },
        imageCount: 1,
      },
      args.database
    );

    return Buffer.from(result.images[0].uint8Array);
  };

  const first = await renderOnce();
  if (!args.enforceAspect) return first;

  const wanted = targetAspect(args.size);
  const deviation = await aspectDeviation(first, wanted);
  if (deviation === null || deviation <= ASPECT_TOLERANCE) return first;

  console.warn(
    `[ai/images] cover render came back off ${args.size} by ${(deviation * 100).toFixed(1)}%; asking once more with the size and aspect ratio restated`
  );
  const second = await renderOnce();
  const secondDeviation = await aspectDeviation(second, wanted);
  if (secondDeviation !== null && secondDeviation > ASPECT_TOLERANCE) {
    // Store the truth. Cropping to 1200x630 would cut detail the concept put
    // there on purpose, and lying about width/height would break every
    // downstream consumer (Plan 4 publishes these numbers verbatim).
    console.warn(
      `[ai/images] cover render is still off ${args.size} after one retry; storing it as-is with its true dimensions (no crop)`
    );
  }
  return second;
}
```

`recordLlmUsage`'s second parameter was widened to `DbClient` in Task 3, so passing `args.database` (possibly `undefined`) typechecks — the default `= defaultDb` covers the undefined case.

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run tests/lib/ai/image-model.test.ts tests/lib/ai/images.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

`generateImage` forwards both `size` and `aspectRatio` to the provider
(`node_modules/ai/dist/index.js:11583-11621`), and the SDK convention for a
setting a provider does not support is an entry in `result.warnings`, not a
throw. Confirm that at the first real render: if `@ai-sdk/openai` instead
*rejects* the pair, drop `aspectRatio` from the call (leaving `size`, which
gpt-image-2 honours) and say so in the commit message — the guard below still
does its job, it just has one fewer lever to pull.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ai/image-model.ts src/lib/ai/images.ts src/lib/ai/llm-usage.ts tests/lib/ai/image-model.test.ts tests/lib/ai/images.test.ts
git commit -m "feat: renderImage — the one seam to the image model"
```

---

### Task 10: `store.ts` — the image rows

**Files:**
- Create: `src/lib/images/store.ts`
- Test: `tests/lib/images/store.test.ts`

**Interfaces:**
- Consumes: `contentImages`, `imageRenders`, `contentPieces`, types from `@/db/schema`; `deleteBlobs` from Task 8; `DbClient`.
- Produces (contract; `database: DbClient = db` is the last *positional* param, an optional `deps` object follows only where blobs are deleted):
  - `MAX_RENDER_HISTORY = 5`
  - `createImage(a, database?)`, `addRender(a, database?, deps?)`, `setCurrentRender(imageId, renderId, database?)`, `markImageFailed(imageId, database?)`, `getImage(tenantId, imageId, database?)`, `getCoverImage(tenantId, contentPieceId, database?)`, `listImages(tenantId, filter?, database?)`, `listLibraryImages(tenantId, filter?, database?)`, `deleteImage(tenantId, imageId, database?, deps?)`, `findImageByRenderUrl(tenantId, url, database?)`
  - `StoreDeps = { deleteBlobs?: (pathnames: string[]) => Promise<void> }`, `ImageFilter`, `LIBRARY_HIDDEN_PIECE_STATUSES`
  - **`listImages` vs `listLibraryImages`** (product owner decision 4): same filters, same tenant scope, one extra predicate. `listImages` is the editor's view and keeps a draft's own images visible while it is being written. `listLibraryImages` is what `/images` and the "From library" picker call — it drops images whose piece is still `brief` or `draft`, so a library deletion can never touch an in-progress body. A dedicated function rather than a flag: the editor's listing must be impossible to filter by accident.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/images/store.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { contentImages, contentPieces, imageRenders } from "../../../src/db/schema";
import { seedTenant, dropTenant } from "../../helpers/fixtures";
import {
  MAX_RENDER_HISTORY,
  createImage,
  addRender,
  setCurrentRender,
  markImageFailed,
  getImage,
  getCoverImage,
  listImages,
  listLibraryImages,
  deleteImage,
  findImageByRenderUrl,
} from "../../../src/lib/images/store";

const TENANT = "Image Store Test Tenant";
const OTHER = "Image Store Other Tenant";

afterEach(async () => {
  await dropTenant(TENANT);
  await dropTenant(OTHER);
});

async function seedPiece(tenantId: string, title = "Piece") {
  const [piece] = await db.insert(contentPieces).values({ tenantId, title, body: "B", type: "blog_post" }).returning();
  return piece;
}

function renderArgs(imageId: string, n: number) {
  return { imageId, prompt: `p${n}`, blobUrl: `https://blob/r${n}.png`, blobPathname: `tenants/t/r${n}.png`, width: 1200, height: 630, bytes: 100, model: "gpt-image-2" };
}

describe("createImage / addRender / getImage", () => {
  it("creates a pending image, then a render makes it ready and current", async () => {
    const tenant = await seedTenant(TENANT);
    const piece = await seedPiece(tenant.id);
    const image = await createImage({ tenantId: tenant.id, contentPieceId: piece.id, role: "cover", concept: "c", altText: "a", sourceKind: "generated" });
    expect(image.status).toBe("pending");
    expect(image.currentRenderId).toBeNull();

    const render = await addRender(renderArgs(image.id, 1));
    const loaded = await getImage(tenant.id, image.id);
    expect(loaded?.status).toBe("ready");
    expect(loaded?.currentRenderId).toBe(render.id);
    expect(loaded?.current?.id).toBe(render.id);
    expect(loaded?.renders).toHaveLength(1);
  });

  it("refuses another tenant's image", async () => {
    const tenant = await seedTenant(TENANT);
    const other = await seedTenant(OTHER);
    const image = await createImage({ tenantId: tenant.id, contentPieceId: null, role: "library", concept: "c", altText: "a", sourceKind: "uploaded", status: "ready" });
    expect(await getImage(other.id, image.id)).toBeNull();
  });
});

describe("addRender pruning", () => {
  it("keeps only the newest MAX_RENDER_HISTORY renders and deletes pruned blobs", async () => {
    const tenant = await seedTenant(TENANT);
    const piece = await seedPiece(tenant.id);
    const image = await createImage({ tenantId: tenant.id, contentPieceId: piece.id, role: "body", concept: "c", altText: "a", sourceKind: "generated" });
    const deleteBlobs = vi.fn(async () => {});

    for (let n = 1; n <= MAX_RENDER_HISTORY + 2; n++) {
      await addRender(renderArgs(image.id, n), db, { deleteBlobs });
    }

    const loaded = await getImage(tenant.id, image.id);
    expect(loaded?.renders).toHaveLength(MAX_RENDER_HISTORY);
    expect(loaded?.renders.map((r) => r.prompt)).toEqual(["p7", "p6", "p5", "p4", "p3"]);
    expect(loaded?.current?.prompt).toBe("p7");
    const deleted = deleteBlobs.mock.calls.flatMap((c) => c[0] as string[]);
    expect(deleted.sort()).toEqual(["tenants/t/r1.png", "tenants/t/r2.png"]);
  });

  it("keeps exactly MAX_RENDER_HISTORY at the boundary and prunes nothing before it", async () => {
    const tenant = await seedTenant(TENANT);
    const image = await createImage({ tenantId: tenant.id, contentPieceId: null, role: "library", concept: "c", altText: "a", sourceKind: "generated" });
    const deleteBlobs = vi.fn(async () => {});

    for (let n = 1; n <= MAX_RENDER_HISTORY; n++) await addRender(renderArgs(image.id, n), db, { deleteBlobs });
    expect((await getImage(tenant.id, image.id))?.renders).toHaveLength(MAX_RENDER_HISTORY);
    expect(deleteBlobs).not.toHaveBeenCalled();

    // The 6th is the first that prunes, and it prunes exactly one.
    await addRender(renderArgs(image.id, MAX_RENDER_HISTORY + 1), db, { deleteBlobs });
    expect((await getImage(tenant.id, image.id))?.renders).toHaveLength(MAX_RENDER_HISTORY);
    expect(deleteBlobs).toHaveBeenCalledTimes(1);
    expect(deleteBlobs).toHaveBeenCalledWith(["tenants/t/r1.png"]);
  });

  it("never leaves currentRenderId dangling when the RESTORED render is the one pruned", async () => {
    // Restore the oldest version, then regenerate. The oldest is both "current"
    // and the prune candidate; addRender must repoint `current` at the new
    // render BEFORE pruning, or the image is left pointing at a deleted row.
    const tenant = await seedTenant(TENANT);
    const image = await createImage({ tenantId: tenant.id, contentPieceId: null, role: "library", concept: "c", altText: "a", sourceKind: "generated" });
    const deleteBlobs = vi.fn(async () => {});
    const first = await addRender(renderArgs(image.id, 1), db, { deleteBlobs });
    for (let n = 2; n <= MAX_RENDER_HISTORY; n++) await addRender(renderArgs(image.id, n), db, { deleteBlobs });
    await setCurrentRender(image.id, first.id);
    expect((await getImage(tenant.id, image.id))?.current?.id).toBe(first.id);

    const fresh = await addRender(renderArgs(image.id, MAX_RENDER_HISTORY + 1), db, { deleteBlobs });

    const loaded = await getImage(tenant.id, image.id);
    expect(loaded?.currentRenderId).toBe(fresh.id);
    expect(loaded?.current).not.toBeNull();
    expect(loaded?.renders.some((r) => r.id === first.id)).toBe(false);
    expect(deleteBlobs).toHaveBeenCalledWith(["tenants/t/r1.png"]);
  });

  it("skips pruning entirely for a published piece", async () => {
    const tenant = await seedTenant(TENANT);
    const piece = await seedPiece(tenant.id);
    await db.update(contentPieces).set({ publishedAt: new Date() }).where(eq(contentPieces.id, piece.id));
    const image = await createImage({ tenantId: tenant.id, contentPieceId: piece.id, role: "body", concept: "c", altText: "a", sourceKind: "generated" });
    const deleteBlobs = vi.fn(async () => {});

    for (let n = 1; n <= MAX_RENDER_HISTORY + 2; n++) {
      await addRender(renderArgs(image.id, n), db, { deleteBlobs });
    }

    const rows = await db.select().from(imageRenders).where(eq(imageRenders.imageId, image.id));
    expect(rows).toHaveLength(MAX_RENDER_HISTORY + 2);
    expect(deleteBlobs).not.toHaveBeenCalled();
  });
});

describe("setCurrentRender / markImageFailed", () => {
  it("restores an older render as current", async () => {
    const tenant = await seedTenant(TENANT);
    const image = await createImage({ tenantId: tenant.id, contentPieceId: null, role: "library", concept: "c", altText: "a", sourceKind: "generated" });
    const first = await addRender(renderArgs(image.id, 1));
    await addRender(renderArgs(image.id, 2));
    await setCurrentRender(image.id, first.id);
    expect((await getImage(tenant.id, image.id))?.current?.id).toBe(first.id);
  });

  it("marks failed", async () => {
    const tenant = await seedTenant(TENANT);
    const image = await createImage({ tenantId: tenant.id, contentPieceId: null, role: "library", concept: "c", altText: "a", sourceKind: "generated" });
    await markImageFailed(image.id);
    expect((await getImage(tenant.id, image.id))?.status).toBe("failed");
  });
});

describe("getCoverImage / listImages / findImageByRenderUrl", () => {
  it("finds the cover with its current render, and lists with filters and piece titles", async () => {
    const tenant = await seedTenant(TENANT);
    const piece = await seedPiece(tenant.id, "Launch post");
    const cover = await createImage({ tenantId: tenant.id, contentPieceId: piece.id, role: "cover", concept: "c", altText: "a", sourceKind: "generated" });
    const coverRender = await addRender(renderArgs(cover.id, 1));
    const body = await createImage({ tenantId: tenant.id, contentPieceId: piece.id, role: "body", concept: "b", altText: "a", sourceKind: "uploaded", status: "ready" });
    await createImage({ tenantId: tenant.id, contentPieceId: null, role: "library", concept: "l", altText: "a", sourceKind: "generated", status: "ready" });

    const found = await getCoverImage(tenant.id, piece.id);
    expect(found?.id).toBe(cover.id);
    expect(found?.current?.blobUrl).toBe("https://blob/r1.png");

    const all = await listImages(tenant.id);
    expect(all).toHaveLength(3);
    expect(all.find((i) => i.id === cover.id)?.pieceTitle).toBe("Launch post");
    expect(all.find((i) => i.id === cover.id)?.current?.id).toBe(coverRender.id);
    expect(all.find((i) => i.role === "library")?.pieceTitle).toBeNull();

    expect((await listImages(tenant.id, { contentPieceId: piece.id })).map((i) => i.id).sort()).toEqual([cover.id, body.id].sort());
    expect((await listImages(tenant.id, { role: "cover" })).map((i) => i.id)).toEqual([cover.id]);
    expect((await listImages(tenant.id, { sourceKind: "uploaded" })).map((i) => i.id)).toEqual([body.id]);

    const byUrl = await findImageByRenderUrl(tenant.id, "https://blob/r1.png");
    expect(byUrl?.image.id).toBe(cover.id);
    expect(byUrl?.render.id).toBe(coverRender.id);
    expect(await findImageByRenderUrl(tenant.id, "https://blob/nope.png")).toBeNull();
  });

  it("never resolves another tenant's render URL (the editor's src -> row lookup is the leak risk)", async () => {
    // `lookupImageBySrc` (Plan 3) passes an arbitrary client-supplied URL here.
    // Without the tenant predicate, pasting a competitor's blob URL into the
    // editor would return their prompt and full render history.
    const tenant = await seedTenant(TENANT);
    const other = await seedTenant(OTHER);
    const mine = await createImage({ tenantId: tenant.id, contentPieceId: null, role: "library", concept: "c", altText: "a", sourceKind: "generated" });
    await addRender(renderArgs(mine.id, 1));

    expect(await findImageByRenderUrl(other.id, "https://blob/r1.png")).toBeNull();
    expect((await findImageByRenderUrl(tenant.id, "https://blob/r1.png"))?.image.id).toBe(mine.id);
  });

  it("scopes getCoverImage and listImages to the tenant", async () => {
    const tenant = await seedTenant(TENANT);
    const other = await seedTenant(OTHER);
    const piece = await seedPiece(tenant.id);
    await createImage({ tenantId: tenant.id, contentPieceId: piece.id, role: "cover", concept: "c", altText: "a", sourceKind: "generated", status: "ready" });

    expect(await getCoverImage(other.id, piece.id)).toBeNull();
    expect(await listImages(other.id)).toHaveLength(0);
    expect(await listImages(other.id, { contentPieceId: piece.id })).toHaveLength(0);
  });
});

describe("listLibraryImages", () => {
  // Product owner decision 4 (2026-08-19): an image enters the library only
  // once its piece is past drafting. That is what makes deleting from the
  // library safe — it can never rewrite a body someone is still writing.
  async function seedImageOnPieceWithStatus(tenantId: string, status: (typeof STATUSES)[number]) {
    const [piece] = await db
      .insert(contentPieces)
      .values({ tenantId, title: `Piece ${status}`, body: "B", type: "blog_post", status })
      .returning();
    const image = await createImage({ tenantId, contentPieceId: piece.id, role: "body", concept: status, altText: "a", sourceKind: "generated" });
    await addRender({ ...renderArgs(image.id, 1), blobUrl: `https://blob/${status}.png`, blobPathname: `tenants/t/${status}.png` });
    return image;
  }

  const STATUSES = ["brief", "draft", "review", "scheduled", "published", "archived"] as const;

  it("excludes images of pieces still in brief or draft, and includes every later status", async () => {
    const tenant = await seedTenant(TENANT);
    const byStatus = new Map<string, string>();
    for (const status of STATUSES) {
      byStatus.set(status, (await seedImageOnPieceWithStatus(tenant.id, status)).id);
    }

    const concepts = (await listLibraryImages(tenant.id)).map((i) => i.concept).sort();
    expect(concepts).toEqual(["archived", "published", "review", "scheduled"]);

    // The editor's own listing is untouched — a draft's images stay reachable
    // where they are being written.
    expect(await listImages(tenant.id)).toHaveLength(STATUSES.length);
    expect(byStatus.size).toBe(STATUSES.length);
  });

  it("always includes a standalone library image, which has no piece to be in progress", async () => {
    const tenant = await seedTenant(TENANT);
    const standalone = await createImage({ tenantId: tenant.id, contentPieceId: null, role: "library", concept: "compass", altText: "a", sourceKind: "generated" });
    await addRender(renderArgs(standalone.id, 1));
    await seedImageOnPieceWithStatus(tenant.id, "draft");

    expect((await listLibraryImages(tenant.id)).map((i) => i.id)).toEqual([standalone.id]);
  });

  it("applies the same filters and tenant scope as listImages", async () => {
    const tenant = await seedTenant(TENANT);
    const other = await seedTenant(OTHER);
    const published = await seedImageOnPieceWithStatus(tenant.id, "published");

    expect((await listLibraryImages(tenant.id, { role: "body" })).map((i) => i.id)).toEqual([published.id]);
    expect(await listLibraryImages(tenant.id, { role: "cover" })).toHaveLength(0);
    expect(await listLibraryImages(other.id)).toHaveLength(0);
  });
});

describe("deleteImage", () => {
  it("deletes rows and blobs for an unpublished piece", async () => {
    const tenant = await seedTenant(TENANT);
    const piece = await seedPiece(tenant.id);
    const image = await createImage({ tenantId: tenant.id, contentPieceId: piece.id, role: "body", concept: "c", altText: "a", sourceKind: "generated" });
    await addRender(renderArgs(image.id, 1));
    await addRender(renderArgs(image.id, 2));
    const deleteBlobs = vi.fn(async () => {});

    expect(await deleteImage(tenant.id, image.id, db, { deleteBlobs })).toEqual({ ok: true });
    expect(await db.select().from(contentImages).where(eq(contentImages.id, image.id))).toHaveLength(0);
    expect(deleteBlobs).toHaveBeenCalledWith(["tenants/t/r1.png", "tenants/t/r2.png"]);
  });

  it("refuses when the piece is published, and reports not_found across tenants", async () => {
    const tenant = await seedTenant(TENANT);
    const other = await seedTenant(OTHER);
    const piece = await seedPiece(tenant.id);
    await db.update(contentPieces).set({ publishedAt: new Date() }).where(eq(contentPieces.id, piece.id));
    const image = await createImage({ tenantId: tenant.id, contentPieceId: piece.id, role: "cover", concept: "c", altText: "a", sourceKind: "generated" });
    const deleteBlobs = vi.fn(async () => {});

    expect(await deleteImage(tenant.id, image.id, db, { deleteBlobs })).toEqual({ ok: false, reason: "published" });
    expect(await deleteImage(other.id, image.id, db, { deleteBlobs })).toEqual({ ok: false, reason: "not_found" });
    expect(deleteBlobs).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/lib/images/store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/images/store.ts`:

```ts
import { and, asc, desc, eq, inArray, isNull, ne, notInArray, or, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
  contentImages,
  contentPieces,
  imageRenders,
  type ContentImage,
  type ImageRender,
  type ImageRole,
  type ImageSourceKind,
  type ImageStatus,
} from "@/db/schema";
import type { DbClient } from "@/lib/publishing/destinations/types";
import { deleteBlobs as defaultDeleteBlobs } from "@/lib/images/blob";

/** Renders kept per image (spec §3). Oldest are pruned, blobs deleted (spec §7). */
export const MAX_RENDER_HISTORY = 5;

export type StoreDeps = { deleteBlobs?: (pathnames: string[]) => Promise<void> };

export async function createImage(
  a: {
    tenantId: string;
    contentPieceId: string | null;
    role: ImageRole;
    concept: string;
    altText: string;
    sourceKind: ImageSourceKind;
    status?: ImageStatus;
  },
  database: DbClient = db
): Promise<ContentImage> {
  const [row] = await database
    .insert(contentImages)
    .values({
      tenantId: a.tenantId,
      contentPieceId: a.contentPieceId,
      role: a.role,
      concept: a.concept,
      altText: a.altText,
      sourceKind: a.sourceKind,
      status: a.status ?? "pending",
    })
    .returning();
  return row;
}

async function pieceIsPublished(contentPieceId: string | null, database: DbClient): Promise<boolean> {
  if (!contentPieceId) return false;
  const [piece] = await database
    .select({ publishedAt: contentPieces.publishedAt })
    .from(contentPieces)
    .where(eq(contentPieces.id, contentPieceId))
    .limit(1);
  return piece?.publishedAt != null;
}

/**
 * Records a render, makes it current, marks the image ready, and prunes
 * history beyond MAX_RENDER_HISTORY (oldest first), deleting the pruned blobs.
 * Pruning is skipped ENTIRELY when the image's piece has been published:
 * Webflow hotlinks body images (spec §8), so a blob a published page might
 * still point at is never deleted — rows are kept too, so history and blobs
 * stay in step.
 */
export async function addRender(
  a: {
    imageId: string;
    prompt: string;
    blobUrl: string;
    blobPathname: string;
    width: number;
    height: number;
    bytes: number;
    model: string;
  },
  database: DbClient = db,
  deps: StoreDeps = {}
): Promise<ImageRender> {
  const deleteBlobs = deps.deleteBlobs ?? defaultDeleteBlobs;

  const [render] = await database.insert(imageRenders).values(a).returning();
  const [image] = await database
    .update(contentImages)
    .set({ currentRenderId: render.id, status: "ready", updatedAt: new Date() })
    .where(eq(contentImages.id, a.imageId))
    .returning();

  if (await pieceIsPublished(image.contentPieceId, database)) return render;

  const history = await database
    .select({ id: imageRenders.id, blobPathname: imageRenders.blobPathname })
    .from(imageRenders)
    .where(and(eq(imageRenders.imageId, a.imageId), ne(imageRenders.id, render.id)))
    .orderBy(asc(imageRenders.createdAt), asc(imageRenders.id));
  // `history` excludes the render just added, so keep MAX - 1 of the rest.
  const excess = history.length - (MAX_RENDER_HISTORY - 1);
  if (excess > 0) {
    const pruned = history.slice(0, excess);
    await database.delete(imageRenders).where(
      inArray(
        imageRenders.id,
        pruned.map((r) => r.id)
      )
    );
    await deleteBlobs(pruned.map((r) => r.blobPathname));
  }
  return render;
}

export async function setCurrentRender(imageId: string, renderId: string, database: DbClient = db): Promise<void> {
  await database
    .update(contentImages)
    .set({ currentRenderId: renderId, status: "ready", updatedAt: new Date() })
    .where(eq(contentImages.id, imageId));
}

export async function markImageFailed(imageId: string, database: DbClient = db): Promise<void> {
  await database.update(contentImages).set({ status: "failed", updatedAt: new Date() }).where(eq(contentImages.id, imageId));
}

export async function getImage(
  tenantId: string,
  imageId: string,
  database: DbClient = db
): Promise<(ContentImage & { renders: ImageRender[]; current: ImageRender | null }) | null> {
  const [image] = await database
    .select()
    .from(contentImages)
    .where(and(eq(contentImages.tenantId, tenantId), eq(contentImages.id, imageId)))
    .limit(1);
  if (!image) return null;
  const renders = await database
    .select()
    .from(imageRenders)
    .where(eq(imageRenders.imageId, image.id))
    .orderBy(desc(imageRenders.createdAt), desc(imageRenders.id));
  const current = renders.find((r) => r.id === image.currentRenderId) ?? null;
  return { ...image, renders, current };
}

export async function getCoverImage(
  tenantId: string,
  contentPieceId: string,
  database: DbClient = db
): Promise<(ContentImage & { current: ImageRender | null }) | null> {
  const [row] = await database
    .select({ image: contentImages, current: imageRenders })
    .from(contentImages)
    .leftJoin(imageRenders, eq(imageRenders.id, contentImages.currentRenderId))
    .where(
      and(eq(contentImages.tenantId, tenantId), eq(contentImages.contentPieceId, contentPieceId), eq(contentImages.role, "cover"))
    )
    .limit(1);
  if (!row) return null;
  return { ...row.image, current: row.current };
}

export type ImageFilter = { contentPieceId?: string; role?: ImageRole; sourceKind?: ImageSourceKind };

async function selectImages(
  tenantId: string,
  filter: ImageFilter,
  database: DbClient,
  extra: (SQL | undefined)[] = []
): Promise<(ContentImage & { current: ImageRender | null; pieceTitle: string | null })[]> {
  const conditions: (SQL | undefined)[] = [eq(contentImages.tenantId, tenantId)];
  if (filter.contentPieceId) conditions.push(eq(contentImages.contentPieceId, filter.contentPieceId));
  if (filter.role) conditions.push(eq(contentImages.role, filter.role));
  if (filter.sourceKind) conditions.push(eq(contentImages.sourceKind, filter.sourceKind));
  conditions.push(...extra);

  const rows = await database
    .select({ image: contentImages, current: imageRenders, pieceTitle: contentPieces.title })
    .from(contentImages)
    .leftJoin(imageRenders, eq(imageRenders.id, contentImages.currentRenderId))
    .leftJoin(contentPieces, eq(contentPieces.id, contentImages.contentPieceId))
    .where(and(...conditions))
    .orderBy(desc(contentImages.createdAt), desc(contentImages.id));
  return rows.map((r) => ({ ...r.image, current: r.current, pieceTitle: r.pieceTitle ?? null }));
}

/**
 * Every image for the tenant. This is the EDITOR's view — a draft's own images
 * are visible while the draft is being written, which is the whole point of
 * the per-piece listing. The library uses `listLibraryImages` instead.
 */
export async function listImages(
  tenantId: string,
  filter: ImageFilter = {},
  database: DbClient = db
): Promise<(ContentImage & { current: ImageRender | null; pieceTitle: string | null })[]> {
  return selectImages(tenantId, filter, database);
}

/**
 * The piece statuses whose images are NOT in the library yet: a piece still
 * being briefed or drafted is in flight, and its images belong to the person
 * writing it (spec §5b, product owner decision 4, 2026-08-19). `contentPieces`
 * has exactly six statuses (`src/db/schema.ts:89-97`) — the other four
 * (review, scheduled, published, archived) are "completed" for this purpose.
 */
export const LIBRARY_HIDDEN_PIECE_STATUSES = ["brief", "draft"] as const;

/**
 * What the /images library and the "From library" picker list: standalone
 * `role: "library"` images (which have no piece and are always shown) plus the
 * images of pieces that are past drafting. Keeping in-flight drafts out is what
 * makes the library safe — deleting a library image can never mutate a body
 * someone is writing, so no library action ever has to stamp `bodyEditedAt`
 * and freeze that draft's regeneration.
 */
export async function listLibraryImages(
  tenantId: string,
  filter: ImageFilter = {},
  database: DbClient = db
): Promise<(ContentImage & { current: ImageRender | null; pieceTitle: string | null })[]> {
  return selectImages(tenantId, filter, database, [
    or(
      isNull(contentImages.contentPieceId),
      notInArray(contentPieces.status, [...LIBRARY_HIDDEN_PIECE_STATUSES])
    ),
  ]);
}

/**
 * Deletes an image, its renders (cascade) and their blobs. Refuses when the
 * piece is published — Webflow hotlinks these (spec §5b, §8) — so the library
 * can explain rather than fail silently.
 */
export async function deleteImage(
  tenantId: string,
  imageId: string,
  database: DbClient = db,
  deps: StoreDeps = {}
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "published" }> {
  const deleteBlobs = deps.deleteBlobs ?? defaultDeleteBlobs;
  const image = await getImage(tenantId, imageId, database);
  if (!image) return { ok: false, reason: "not_found" };
  if (await pieceIsPublished(image.contentPieceId, database)) return { ok: false, reason: "published" };

  await database.delete(contentImages).where(and(eq(contentImages.tenantId, tenantId), eq(contentImages.id, imageId)));
  // Oldest first, matching insertion order — cosmetic, but stable for logs.
  await deleteBlobs([...image.renders].reverse().map((r) => r.blobPathname));
  return { ok: true };
}

/** The editor maps an `<img src>` back to its row (spec §3: body images join by blob URL). */
export async function findImageByRenderUrl(
  tenantId: string,
  url: string,
  database: DbClient = db
): Promise<{ image: ContentImage; render: ImageRender } | null> {
  const [row] = await database
    .select({ image: contentImages, render: imageRenders })
    .from(imageRenders)
    .innerJoin(contentImages, eq(contentImages.id, imageRenders.imageId))
    .where(and(eq(contentImages.tenantId, tenantId), eq(imageRenders.blobUrl, url)))
    .limit(1);
  return row ?? null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/lib/images/store.test.ts`
Expected: PASS. If the pruning test's expected order `["p7","p6","p5","p4","p3"]` is flaky because two renders share a `created_at` microsecond, the `asc(id)`/`desc(id)` tiebreakers already make it deterministic per run but not by insertion order — in that case change the assertion to compare sorted prompt sets (`toEqual(expect.arrayContaining([...]))` with length 5) rather than loosening the code.

- [ ] **Step 5: Commit**

```bash
git add src/lib/images/store.ts tests/lib/images/store.test.ts
git commit -m "feat: content image store with render history and pruning"
```

---

### Task 10b: Shared image fixtures in `tests/helpers/fixtures.ts`

**Files:**
- Modify: `tests/helpers/fixtures.ts` (19 lines today: `seedTenant`, `dropTenant` only)
- Test: `tests/lib/images/fixtures-smoke.test.ts`

**Why:** Plans 2, 3 and 4 each hand-roll the same three seeds — a
`companyProfiles` row with a ready `visualIdentity`, a `contentPieces` row, and
a `content_images` + `image_renders` pair whose `currentRenderId` points at the
render. Six copies of the same eight-line insert is how a schema change breaks
five test files at once. Write them **once, here**; Plans 2–4 import them.

**Interfaces:**
- Produces (all take an explicit `tenantId` and return the inserted row):
  ```ts
  export const READY_VISUAL_IDENTITY: VisualIdentity;   // 3-colour palette, defaults otherwise
  export async function seedCompanyProfile(tenantId: string, overrides?: Partial<typeof companyProfiles.$inferInsert>);
  export async function seedVisualIdentity(tenantId: string, identity?: VisualIdentity | null);
  export async function seedContentPiece(tenantId: string, overrides?: Partial<typeof contentPieces.$inferInsert>);
  export async function seedContentImage(a: { tenantId: string; contentPieceId?: string | null; role?: ImageRole; withRender?: boolean; overrides?: Partial<typeof contentImages.$inferInsert>; renderOverrides?: Partial<typeof imageRenders.$inferInsert> }):
    Promise<{ image: ContentImage; render: ImageRender | null }>;
  ```
- Consumers: Plan 2 Tasks 4/7, Plan 3 Tasks 3/4/10, Plan 4 Tasks 2/7.

- [ ] **Step 1: Write the failing smoke test**

Create `tests/lib/images/fixtures-smoke.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { companyProfiles, contentImages } from "../../../src/db/schema";
import {
  READY_VISUAL_IDENTITY,
  dropTenant,
  seedContentImage,
  seedContentPiece,
  seedTenant,
  seedVisualIdentity,
} from "../../helpers/fixtures";
import { isVisualIdentityReady } from "../../../src/lib/images/visual-identity";

const TENANT = "Image Fixtures Smoke Test Tenant";

afterEach(async () => {
  await dropTenant(TENANT);
});

describe("image fixtures", () => {
  it("seeds a profile whose visual identity is ready", async () => {
    const tenant = await seedTenant(TENANT);
    await seedVisualIdentity(tenant.id);
    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(isVisualIdentityReady(profile.visualIdentity)).toBe(true);
    expect(READY_VISUAL_IDENTITY.palette.length).toBeGreaterThanOrEqual(3);
  });

  it("seeds a null visual identity on request, and is idempotent per tenant", async () => {
    const tenant = await seedTenant(TENANT);
    await seedVisualIdentity(tenant.id, null);
    await seedVisualIdentity(tenant.id, READY_VISUAL_IDENTITY);
    const rows = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].visualIdentity?.palette).toHaveLength(3);
  });

  it("seeds an image with a render wired as current, and without one", async () => {
    const tenant = await seedTenant(TENANT);
    const piece = await seedContentPiece(tenant.id, { type: "blog_post" });
    const ready = await seedContentImage({ tenantId: tenant.id, contentPieceId: piece.id, role: "cover" });
    expect(ready.render).not.toBeNull();
    const [row] = await db.select().from(contentImages).where(eq(contentImages.id, ready.image.id));
    expect(row.currentRenderId).toBe(ready.render!.id);
    expect(row.status).toBe("ready");

    const failed = await seedContentImage({
      tenantId: tenant.id,
      contentPieceId: piece.id,
      role: "body",
      withRender: false,
      overrides: { status: "failed" },
    });
    expect(failed.render).toBeNull();
    expect(failed.image.currentRenderId).toBeNull();
  });

  it("gives every render a distinct blob url so a body swap is observable", async () => {
    const tenant = await seedTenant(TENANT);
    const a = await seedContentImage({ tenantId: tenant.id, contentPieceId: null, role: "library" });
    const b = await seedContentImage({ tenantId: tenant.id, contentPieceId: null, role: "library" });
    expect(a.render!.blobUrl).not.toBe(b.render!.blobUrl);
    expect(a.render!.blobPathname).not.toBe(b.render!.blobPathname);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/lib/images/fixtures-smoke.test.ts`
Expected: FAIL — the new exports do not exist.

- [ ] **Step 3: Implement**

Append to `tests/helpers/fixtures.ts` (keep `seedTenant`/`dropTenant` exactly as they are):

```ts
import {
  companyProfiles,
  contentImages,
  contentPieces,
  imageRenders,
  type ContentImage,
  type ImageRender,
  type ImageRole,
  type VisualIdentity,
} from "../../src/db/schema";
import { DEFAULT_VISUAL_IDENTITY } from "../../src/lib/images/visual-identity";

/**
 * A visual identity that passes `isVisualIdentityReady` (>= 3 palette
 * colours). Every test that needs generation to be *allowed* uses this one, so
 * a change to the readiness rule breaks one constant, not twenty files.
 */
export const READY_VISUAL_IDENTITY: VisualIdentity = {
  ...DEFAULT_VISUAL_IDENTITY,
  palette: [
    { hex: "#112233", role: "primary" },
    { hex: "#445566", role: "secondary" },
    { hex: "#ffffff", role: "background" },
  ],
};

export async function seedCompanyProfile(
  tenantId: string,
  overrides: Partial<typeof companyProfiles.$inferInsert> = {}
) {
  const [profile] = await db
    .insert(companyProfiles)
    .values({ tenantId, topics: [], ...overrides })
    .returning();
  return profile;
}

/**
 * Upserts the tenant's profile with a visual identity. Pass `null` for the
 * "tenant has not set up visual identity yet" case — the row still exists, so
 * `getOrCreateCompanyProfile` does not create a second one.
 */
export async function seedVisualIdentity(tenantId: string, identity: VisualIdentity | null = READY_VISUAL_IDENTITY) {
  const existing = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenantId)).limit(1);
  if (existing.length > 0) {
    const [updated] = await db
      .update(companyProfiles)
      .set({ visualIdentity: identity })
      .where(eq(companyProfiles.tenantId, tenantId))
      .returning();
    return updated;
  }
  return seedCompanyProfile(tenantId, { visualIdentity: identity });
}

export async function seedContentPiece(
  tenantId: string,
  overrides: Partial<typeof contentPieces.$inferInsert> = {}
) {
  const [piece] = await db
    .insert(contentPieces)
    .values({ tenantId, type: "blog_post", title: "Test piece", body: "# Test piece\n\n## A\n\nText.", ...overrides })
    .returning();
  return piece;
}

// Unique per process so two images in one test never share a blob URL by
// accident — several assertions turn on "the body's URL changed".
let renderCounter = 0;

/**
 * Seeds a `content_images` row and (by default) one `image_renders` row wired
 * as its `currentRenderId` with `status: "ready"` — i.e. exactly the state
 * Plan 1's `addRender` leaves behind, without going near the model or Blob.
 */
export async function seedContentImage(a: {
  tenantId: string;
  contentPieceId?: string | null;
  role?: ImageRole;
  withRender?: boolean;
  overrides?: Partial<typeof contentImages.$inferInsert>;
  renderOverrides?: Partial<typeof imageRenders.$inferInsert>;
}): Promise<{ image: ContentImage; render: ImageRender | null }> {
  const role = a.role ?? "body";
  const [image] = await db
    .insert(contentImages)
    .values({
      tenantId: a.tenantId,
      contentPieceId: a.contentPieceId ?? null,
      role,
      concept: "a lighthouse beam over a data grid",
      altText: "Lighthouse beam over a grid of tiles",
      sourceKind: "generated",
      status: a.withRender === false ? "pending" : "ready",
      ...a.overrides,
    })
    .returning();

  if (a.withRender === false) return { image, render: null };

  const n = ++renderCounter;
  const [render] = await db
    .insert(imageRenders)
    .values({
      imageId: image.id,
      prompt: "FULL PROMPT",
      blobUrl: `https://blob.example/seed-${n}.png`,
      blobPathname: `tenants/seed/seed-${n}.png`,
      width: role === "cover" ? 1200 : 1200,
      height: role === "cover" ? 630 : 900,
      bytes: 1024,
      model: "gpt-image-2",
      ...a.renderOverrides,
    })
    .returning();

  const [wired] = await db
    .update(contentImages)
    .set({ currentRenderId: render.id })
    .where(eq(contentImages.id, image.id))
    .returning();
  return { image: wired, render };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/lib/images/fixtures-smoke.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add tests/helpers/fixtures.ts tests/lib/images/fixtures-smoke.test.ts
git commit -m "test: shared fixtures for visual identity, pieces and content images"
```

---

### Task 11: `derive-visual-identity.ts` — bootstrap from the website

**Files:**
- Create: `src/lib/workspace/derive-visual-identity.ts`
- Test: `tests/lib/workspace/derive-visual-identity.test.ts`

**Interfaces:**
- Consumes: `fetchPageText` (`src/lib/workspace/fetch-page.ts` line 200, returns `{ text, html, finalUrl, ... } | { error }`), `generateObject` from `ai`, `resolveModel`/`modelId` (`src/lib/ai/model.ts`), `recordLlmUsage` (operation `"brand_analysis"`), `DEFAULT_VISUAL_IDENTITY`.
- Produces:
  - `extractColorCandidates(html: string, max?: number): string[]` — pure; `#rrggbb` lowercase, by frequency desc, from `<style>` blocks, `style=""` attributes and `<meta name="theme-color">` (weighted), `#rgb` expanded, `rgb(r,g,b)` converted
  - `analyzeVisualIdentity(pageText, candidates, tenantId): Promise<DerivedVisualIdentity | null>` — LLM proposal `{ palette, stylePreset, moodWords }`
  - `deriveVisualIdentityFromPage(tenantId, url, deps?): Promise<{ ok: true; identity: VisualIdentity } | { ok: false; reason: string }>`
  - `DeriveVisualIdentityDeps = { scrape?; analyze? }`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/workspace/derive-visual-identity.test.ts`:

```ts
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));

import { generateObject } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { llmUsage } from "../../../src/db/schema";
import { seedTenant, dropTenant } from "../../helpers/fixtures";
import {
  extractColorCandidates,
  analyzeVisualIdentity,
  deriveVisualIdentityFromPage,
} from "../../../src/lib/workspace/derive-visual-identity";
import { DEFAULT_VISUAL_IDENTITY } from "../../../src/lib/images/visual-identity";

const TENANT = "Derive Visual Identity Test Tenant";
let tenantId: string;

const HTML = `
<html><head>
<meta name="theme-color" content="#1A73E8">
<style>
  body { background: #FFF; color: #202124; }
  .btn { background: #1a73e8; border-color: #1a73e8; }
  .accent { color: rgb(251, 188, 4); }
</style>
</head><body>
<div style="color:#202124;background:#fff">Hello</div>
<p style="border: 1px solid #202124">World</p>
</body></html>`;

describe("extractColorCandidates", () => {
  it("normalises hex and rgb(), weights theme-color, and orders by frequency", () => {
    const colors = extractColorCandidates(HTML);
    expect(colors[0]).toBe("#1a73e8"); // 2 in css + theme-color weight
    expect(colors).toContain("#ffffff");
    expect(colors).toContain("#202124");
    expect(colors).toContain("#fbbc04");
    expect(new Set(colors).size).toBe(colors.length);
    expect(colors.indexOf("#202124")).toBeLessThan(colors.indexOf("#fbbc04"));
  });

  it("caps the list and returns [] for colorless html", () => {
    expect(extractColorCandidates(HTML, 2)).toHaveLength(2);
    expect(extractColorCandidates("<p>no colors</p>")).toEqual([]);
  });
});

describe("analyzeVisualIdentity / deriveVisualIdentityFromPage", () => {
  beforeAll(async () => {
    tenantId = (await seedTenant(TENANT)).id;
  });
  afterAll(async () => {
    await dropTenant(TENANT);
  });
  beforeEach(() => {
    vi.mocked(generateObject).mockReset();
  });

  it("returns the model's proposal and records brand_analysis usage", async () => {
    const proposal = {
      palette: [{ hex: "#1a73e8", role: "primary" }, { hex: "#ffffff", role: "background" }, { hex: "#fbbc04", role: "accent" }],
      stylePreset: "flat",
      moodWords: ["bold", "friendly"],
    };
    vi.mocked(generateObject).mockResolvedValue({ object: proposal, usage: { inputTokens: 3 } } as never);
    expect(await analyzeVisualIdentity("page text", ["#1a73e8"], tenantId)).toEqual(proposal);
    const rows = await db.select().from(llmUsage).where(eq(llmUsage.tenantId, tenantId));
    expect(rows.at(-1)).toMatchObject({ operation: "brand_analysis", inputTokens: 3 });
  });

  it("returns null when the model throws", async () => {
    vi.mocked(generateObject).mockRejectedValue(new Error("down"));
    expect(await analyzeVisualIdentity("t", [], tenantId)).toBeNull();
  });

  it("derives a full identity: proposal merged over the defaults", async () => {
    const scrape = vi.fn(async () => ({ text: "We build calm tools", html: HTML, finalUrl: "https://x.y/", contentType: "text/html", truncated: false }));
    const analyze = vi.fn(async () => ({
      palette: [{ hex: "#1a73e8", role: "primary" as const }, { hex: "#ffffff", role: "background" as const }, { hex: "#fbbc04", role: "accent" as const }],
      stylePreset: "geometric" as const,
      moodWords: ["calm"],
    }));

    const result = await deriveVisualIdentityFromPage(tenantId, "https://x.y", { scrape, analyze });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.stylePreset).toBe("geometric");
    expect(result.identity.moodWords).toEqual(["calm"]);
    expect(result.identity.palette).toHaveLength(3);
    expect(result.identity.imageGenerationRules).toEqual(DEFAULT_VISUAL_IDENTITY.imageGenerationRules);
    expect(result.identity.pinStyleToCover).toBe(true);
    // The analyzer got the extracted candidates.
    expect(analyze.mock.calls[0][1]).toContain("#1a73e8");
  });

  it("falls back to a heuristic palette from the extracted colors when the model fails", async () => {
    const scrape = vi.fn(async () => ({ text: "t", html: HTML, finalUrl: "https://x.y/", contentType: "text/html", truncated: false }));
    const analyze = vi.fn(async () => null);
    const result = await deriveVisualIdentityFromPage(tenantId, "https://x.y", { scrape, analyze });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.stylePreset).toBe("flat");
    expect(result.identity.palette.map((p) => p.hex)).toEqual(extractColorCandidates(HTML, 4));
    expect(result.identity.palette.map((p) => p.role)).toEqual(["primary", "secondary", "accent", "neutral"]);
  });

  it("reports the scrape error", async () => {
    const scrape = vi.fn(async () => ({ error: "blocked" as const }));
    expect(await deriveVisualIdentityFromPage(tenantId, "http://10.0.0.1", { scrape })).toEqual({ ok: false, reason: "blocked" });
  });

  it("reports no-colors when the page yields nothing and the model fails", async () => {
    const scrape = vi.fn(async () => ({ text: "t", html: "<p>plain</p>", finalUrl: "https://x.y/", contentType: "text/html", truncated: false }));
    const analyze = vi.fn(async () => null);
    expect(await deriveVisualIdentityFromPage(tenantId, "https://x.y", { scrape, analyze })).toEqual({ ok: false, reason: "no-colors" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/lib/workspace/derive-visual-identity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/workspace/derive-visual-identity.ts`:

```ts
import { generateObject } from "ai";
import { z } from "zod";
import type { PaletteRole, VisualIdentity } from "@/db/schema";
import { resolveModel, modelId } from "@/lib/ai/model";
import { recordLlmUsage } from "@/lib/ai/llm-usage";
import { fetchPageText, type PageResult } from "@/lib/workspace/fetch-page";
import { DEFAULT_VISUAL_IDENTITY, MAX_PALETTE, MIN_READY_PALETTE } from "@/lib/images/visual-identity";

// Same MAX_SCAN_CHARS posture as fetch-page.ts: fetchPageText already clamps
// `html` to 200KB, but this is exported and a caller may pass raw HTML.
const MAX_SCAN_CHARS = 200_000;
const THEME_COLOR_WEIGHT = 5;
const DEFAULT_MAX_CANDIDATES = 8;

function normalizeHex(raw: string): string | null {
  const hex = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(hex)) return hex;
  if (/^#[0-9a-f]{3}$/.test(hex)) return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  return null;
}

function rgbToHex(r: number, g: number, b: number): string | null {
  if ([r, g, b].some((c) => !Number.isInteger(c) || c < 0 || c > 255)) return null;
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Candidate palette from a page's markup, most frequent first. Regex over
 * <style> blocks and inline style attributes plus the theme-color meta —
 * deliberately no linked-stylesheet fetches (a second request per sheet and a
 * new SSRF surface for a proposal the user confirms anyway; spec §2 names
 * Brandfetch as the fallback if this disappoints).
 */
export function extractColorCandidates(html: string, max = DEFAULT_MAX_CANDIDATES): string[] {
  const scanned = html.slice(0, MAX_SCAN_CHARS);
  const counts = new Map<string, number>();
  const bump = (hex: string | null, by = 1) => {
    if (hex) counts.set(hex, (counts.get(hex) ?? 0) + by);
  };

  const sources: string[] = [];
  for (const m of scanned.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) sources.push(m[1]);
  for (const m of scanned.matchAll(/\bstyle\s*=\s*["']([^"']*)["']/gi)) sources.push(m[1]);

  for (const css of sources) {
    for (const m of css.matchAll(/#[0-9a-f]{3}\b|#[0-9a-f]{6}\b/gi)) bump(normalizeHex(m[0]));
    for (const m of css.matchAll(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/gi)) {
      bump(rgbToHex(Number(m[1]), Number(m[2]), Number(m[3])));
    }
  }

  const theme = scanned.match(/<meta\b[^>]*\bname\s*=\s*["']theme-color["'][^>]*\bcontent\s*=\s*["']([^"']+)["']/i);
  if (theme) bump(normalizeHex(theme[1]), THEME_COLOR_WEIGHT);

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([hex]) => hex);
}

const PaletteRoleSchema = z.enum(["primary", "secondary", "accent", "background", "neutral"]);

export const DerivedVisualIdentitySchema = z.object({
  palette: z.array(z.object({ hex: z.string(), role: PaletteRoleSchema })),
  stylePreset: z.enum(["flat", "geometric", "line_art", "isometric", "gradient", "duotone", "hand_drawn"]),
  moodWords: z.array(z.string()),
});
export type DerivedVisualIdentity = z.infer<typeof DerivedVisualIdentitySchema>;

const ANALYSIS_SYSTEM = [
  "You look at the text of a company's website and the colors most used in its markup, and propose a visual",
  "identity for flat marketing illustrations that would sit naturally on that site.",
  `Pick ${MIN_READY_PALETTE}-${MAX_PALETTE} colors from the candidates (hex, lowercase, #rrggbb) and give each ONE role:`,
  "primary (the dominant brand color), secondary, accent (small highlights), background (the ground most images sit on),",
  "neutral (outlines/shadows). Prefer the candidates; only invent a color if the candidates lack a usable background or neutral.",
  "Choose the style preset that best matches the brand's register, and 2-4 short lowercase mood words.",
].join(" ");

export function buildVisualIdentityPrompt(pageText: string, candidates: string[]): string {
  return [
    `Most-used colors on the site, most frequent first: ${candidates.length > 0 ? candidates.join(", ") : "(none found)"}.`,
    "",
    "Website text:",
    pageText.slice(0, 6000),
  ].join("\n");
}

/** Null on any model failure — the caller falls back to a heuristic palette. */
export async function analyzeVisualIdentity(
  pageText: string,
  candidates: string[],
  tenantId: string
): Promise<DerivedVisualIdentity | null> {
  try {
    const spec = process.env.ONBOARDING_ANALYSIS_MODEL ?? "anthropic/claude-sonnet-4-5";
    const { object, usage } = await generateObject({
      model: resolveModel(spec),
      schema: DerivedVisualIdentitySchema,
      system: ANALYSIS_SYSTEM,
      prompt: buildVisualIdentityPrompt(pageText, candidates),
    });
    await recordLlmUsage({ tenantId, operation: "brand_analysis", model: modelId(spec), usage });
    return object;
  } catch {
    return null;
  }
}

export type DeriveVisualIdentityDeps = {
  scrape?: (url: string) => Promise<PageResult>;
  analyze?: (pageText: string, candidates: string[], tenantId: string) => Promise<DerivedVisualIdentity | null>;
};

const HEURISTIC_ROLES: PaletteRole[] = ["primary", "secondary", "accent", "neutral", "background", "secondary"];

/**
 * Website bootstrap (spec §2): scrape → extract colors → LLM proposal →
 * a full VisualIdentity draft merged over the defaults. Writes NOTHING: the
 * card prefills from this and the user confirms with Save, mirroring
 * `importBrandStyleForTenant`'s derive → prefill → confirm flow.
 */
export async function deriveVisualIdentityFromPage(
  tenantId: string,
  url: string,
  deps: DeriveVisualIdentityDeps = {}
): Promise<{ ok: true; identity: VisualIdentity } | { ok: false; reason: string }> {
  const scrape = deps.scrape ?? fetchPageText;
  const analyze = deps.analyze ?? analyzeVisualIdentity;

  const scraped = await scrape(url);
  if ("error" in scraped) return { ok: false, reason: scraped.error };

  const candidates = extractColorCandidates(scraped.html);
  const proposal = await analyze(scraped.text, candidates, tenantId);

  if (proposal) {
    const palette = proposal.palette
      .map((p) => ({ hex: normalizeHex(p.hex), role: p.role }))
      .filter((p): p is { hex: string; role: PaletteRole } => p.hex !== null)
      .slice(0, MAX_PALETTE);
    if (palette.length > 0) {
      return {
        ok: true,
        identity: {
          ...DEFAULT_VISUAL_IDENTITY,
          palette,
          stylePreset: proposal.stylePreset,
          moodWords: proposal.moodWords.map((w) => w.trim().toLowerCase()).filter(Boolean).slice(0, 4),
        },
      };
    }
  }

  if (candidates.length === 0) return { ok: false, reason: "no-colors" };
  const heuristic = candidates.slice(0, 4).map((hex, i) => ({ hex, role: HEURISTIC_ROLES[i] }));
  return { ok: true, identity: { ...DEFAULT_VISUAL_IDENTITY, palette: heuristic } };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/lib/workspace/derive-visual-identity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workspace/derive-visual-identity.ts tests/lib/workspace/derive-visual-identity.test.ts
git commit -m "feat: derive a visual identity draft from the company website"
```

---

### Task 12: Visual identity card on /company

**Files:**
- Modify: `src/app/(dashboard)/company/actions.ts` — imports (lines 1–14), append four actions after `setNewsWatching` (ends line 236)
- Create: `src/app/(dashboard)/company/visual-identity-editor.tsx`
- Modify: `src/app/(dashboard)/company/page.tsx` — imports (lines 7–19), insert a card between "Guidelines" (ends line 195) and "Change events" (starts line 202)
- Modify: `next.config.ts` — `images.remotePatterns` for the Blob host and a raised Server Action body limit (the reference thumbnails and the upload need both; Plan 3 Task 8 re-states the same file and is then a no-op for these two keys)
- Test: `tests/app/company-visual-identity-actions.test.ts`

**Interfaces:**
- Consumes: `parseVisualIdentity`, `DEFAULT_VISUAL_IDENTITY`, `MAX_REFERENCE_IMAGES`, the option lists (Task 4); `deriveVisualIdentityFromPage` (Task 11); `compressPng` (Task 7); `brandAssetPathname`, `blobPathnameFromUrl`, `deleteBlobs`, `slugForImage`, `uploadPng`, `validateUploadFile` (Task 8); `getOrCreateCompanyProfile`; `requireSession`; `useUnsavedChanges` from `src/app/(dashboard)/unsaved-changes.tsx` (`setSectionDirty(key, dirty)`); UI: `Button`, `Input`, `Label`, `Textarea`, `Switch` (`checked`/`onCheckedChange`, as `news-toggle.tsx` uses it), `Select`/`SelectTrigger`/`SelectValue`/`SelectContent`/`SelectItem` (as `settings/calendar-form.tsx` uses them), `Card*`, `next/image`.
- Produces: `saveVisualIdentity(input: unknown): Promise<{ ok: true } | { ok: false; reason: "invalid" }>`, `deriveVisualIdentityFromUrl(url: string): Promise<{ ok: true; identity: VisualIdentity } | { ok: false; reason: string }>`, `uploadStyleReference(formData: FormData): Promise<{ ok: true; styleReferenceImages: string[] } | { ok: false; error: string }>`, `removeStyleReference(url: string): Promise<{ ok: true; styleReferenceImages: string[] } | { ok: false; error: string }>`, `<VisualIdentityEditor initial={VisualIdentity | null} defaultWebsiteUrl={string} />`.

> **Style reference images are UPLOADED here, in this card** (product owner
> decision 3, 2026-08-19). Spec §2 calls them the strongest consistency
> mechanism and the user story is *"I upload two or three of our existing blog
> illustrations"* — a URL field does not serve someone with a file on their
> desktop, and no Plan 3 task ever comes back for this surface. Three
> consequences to hold:
> - They are brand **inputs**, not content: they go to
>   `tenants/{tenantId}/brand/{slug}.png` via `brandAssetPathname` and get
>   **no `content_images` row**, so they never appear in the /images library
>   and have no render history.
> - They still go through `compressPng` + `uploadPng` like every other stored
>   image, so the 1 MB ceiling (decision 2) covers them too.
> - Upload and remove write the profile **immediately** (they are not part of
>   the card's Save), so the client updates both its dirty-tracking baselines
>   from the returned list. Everything else on the card still saves on Save.

- [ ] **Step 1: Write the failing action test**

Create `tests/app/company-visual-identity-actions.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { companyProfiles, contentImages } from "../../src/db/schema";
import { seedTenant, dropTenant } from "../helpers/fixtures";
import { DEFAULT_VISUAL_IDENTITY } from "../../src/lib/images/visual-identity";

let currentTenantId = "";
vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: "user-1" } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const deriveMock = vi.fn(async (..._args: unknown[]) => ({ ok: false, reason: "blocked" }) as { ok: boolean; reason?: string });
vi.mock("../../src/lib/workspace/derive-visual-identity", () => ({
  deriveVisualIdentityFromPage: (...args: unknown[]) => deriveMock(...args),
}));

// No test may reach sharp's real work or Vercel Blob (Global Constraints).
vi.mock("../../src/lib/images/compress", () => ({
  compressPng: vi.fn(async (png: Buffer, maxWidth: number) => ({ png, width: maxWidth, height: 900 })),
}));
const deleteBlobs = vi.fn(async (_pathnames: string[]) => {});
vi.mock("../../src/lib/images/blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/images/blob")>();
  return {
    ...actual,
    uploadPng: vi.fn(async (pathname: string) => ({ url: `https://blob.example/${pathname}`, pathname })),
    deleteBlobs: (pathnames: string[]) => deleteBlobs(pathnames),
  };
});

import {
  saveVisualIdentity,
  deriveVisualIdentityFromUrl,
  uploadStyleReference,
  removeStyleReference,
} from "../../src/app/(dashboard)/company/actions";

const TENANT = "Visual Identity Actions Test Tenant";

afterEach(async () => {
  await dropTenant(TENANT);
  vi.clearAllMocks();
});

const IDENTITY = {
  ...DEFAULT_VISUAL_IDENTITY,
  palette: [
    { hex: "#1A73E8", role: "primary" },
    { hex: "#ffffff", role: "background" },
    { hex: "#fbbc04", role: "accent" },
  ],
};

describe("saveVisualIdentity", () => {
  it("validates, normalises and persists to the tenant's profile", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;

    expect(await saveVisualIdentity(IDENTITY)).toEqual({ ok: true });

    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile.visualIdentity?.palette[0]).toEqual({ hex: "#1a73e8", role: "primary" });
    expect(profile.visualIdentity?.stylePreset).toBe("flat");
  });

  it("rejects invalid input without writing", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;

    expect(await saveVisualIdentity({ ...IDENTITY, stylePreset: "photo" })).toEqual({ ok: false, reason: "invalid" });
    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile?.visualIdentity ?? null).toBeNull();
  });
});

describe("deriveVisualIdentityFromUrl", () => {
  it("passes the tenant and trimmed url through and never writes", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    deriveMock.mockResolvedValueOnce({ ok: true, identity: IDENTITY } as never);

    const result = await deriveVisualIdentityFromUrl("  https://example.com  ");
    expect(result.ok).toBe(true);
    expect(deriveMock).toHaveBeenCalledWith(tenant.id, "https://example.com");
    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile?.visualIdentity ?? null).toBeNull();
  });

  it("refuses an empty url", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    expect(await deriveVisualIdentityFromUrl("   ")).toEqual({ ok: false, reason: "empty" });
    expect(deriveMock).not.toHaveBeenCalled();
  });
});

describe("uploadStyleReference", () => {
  function form(file: File): FormData {
    const fd = new FormData();
    fd.set("file", file);
    return fd;
  }
  const png = (name = "illustration.png") => new File([Buffer.from("PNG")], name, { type: "image/png" });

  async function seedWithIdentity() {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    await saveVisualIdentity(IDENTITY);
    return tenant;
  }

  it("stores the file under the tenant's brand prefix and appends it to the identity", async () => {
    const tenant = await seedWithIdentity();

    const result = await uploadStyleReference(form(png("Our Hero Illustration.png")));

    expect(result).toEqual({
      ok: true,
      styleReferenceImages: [`https://blob.example/tenants/${tenant.id}/brand/our-hero-illustration.png`],
    });
    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile.visualIdentity?.styleReferenceImages).toEqual(result.ok ? result.styleReferenceImages : []);
    // Brand inputs are not content: no content_images row is written.
    expect(await db.select().from(contentImages).where(eq(contentImages.tenantId, tenant.id))).toHaveLength(0);
  });

  it("rejects a wrong mime type and an oversized file without storing anything", async () => {
    const tenant = await seedWithIdentity();

    const gif = await uploadStyleReference(form(new File([Buffer.from("GIF")], "a.gif", { type: "image/gif" })));
    expect(gif.ok).toBe(false);
    if (!gif.ok) expect(gif.error).toMatch(/PNG, JPEG or WebP/);

    const huge = new File([Buffer.from("PNG")], "big.png", { type: "image/png" });
    Object.defineProperty(huge, "size", { value: 11 * 1024 * 1024 });
    const tooBig = await uploadStyleReference(form(huge));
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.error).toMatch(/10 MB/);

    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile.visualIdentity?.styleReferenceImages).toEqual([]);
  });

  it("refuses the fifth reference with a message that says what to do", async () => {
    // The schema allows 1–4 (Task 4, MAX_REFERENCE_IMAGES); the cap is
    // enforced BEFORE the upload so a refused add never leaves a paid orphan.
    await seedWithIdentity();
    for (let i = 0; i < 4; i++) {
      expect((await uploadStyleReference(form(png(`ref-${i}.png`)))).ok).toBe(true);
    }

    const fifth = await uploadStyleReference(form(png("ref-5.png")));
    expect(fifth.ok).toBe(false);
    if (!fifth.ok) expect(fifth.error).toMatch(/up to 4 .*Remove one/i);
  });
});

describe("removeStyleReference", () => {
  it("drops the url from the identity and deletes its blob", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    await saveVisualIdentity(IDENTITY);
    const fd = new FormData();
    fd.set("file", new File([Buffer.from("PNG")], "a.png", { type: "image/png" }));
    const added = await uploadStyleReference(fd);
    const url = added.ok ? added.styleReferenceImages[0] : "";

    expect(await removeStyleReference(url)).toEqual({ ok: true, styleReferenceImages: [] });
    expect(deleteBlobs).toHaveBeenCalledWith([`tenants/${tenant.id}/brand/a.png`]);
    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile.visualIdentity?.styleReferenceImages).toEqual([]);
  });

  it("is a no-op for a url this tenant does not have", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    await saveVisualIdentity(IDENTITY);

    expect(await removeStyleReference("https://blob.example/somebody/else.png")).toEqual({ ok: true, styleReferenceImages: [] });
    expect(deleteBlobs).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/app/company-visual-identity-actions.test.ts`
Expected: FAIL — `saveVisualIdentity` is not exported.

- [ ] **Step 3: Add the actions**

In `src/app/(dashboard)/company/actions.ts`, add imports after line 14:

```ts
import { DEFAULT_VISUAL_IDENTITY, MAX_REFERENCE_IMAGES, parseVisualIdentity } from "@/lib/images/visual-identity";
import { deriveVisualIdentityFromPage } from "@/lib/workspace/derive-visual-identity";
import { compressPng } from "@/lib/images/compress";
import { blobPathnameFromUrl, brandAssetPathname, deleteBlobs, slugForImage, uploadPng, validateUploadFile } from "@/lib/images/blob";
import type { VisualIdentity } from "@/db/schema";
```

Append after `setNewsWatching`:

```ts
/**
 * Persists the Visual identity card. Takes `unknown`, like `savePersonas`: a
 * Server Action argument is client input, so it is validated with the same
 * schema regardless of what TypeScript would imply. Writes only its own
 * column — every card on this page saves itself.
 */
export async function saveVisualIdentity(input: unknown): Promise<{ ok: true } | { ok: false; reason: "invalid" }> {
  const session = await requireSession();
  const identity = parseVisualIdentity(input);
  if (!identity) return { ok: false, reason: "invalid" };

  const profile = await getOrCreateCompanyProfile(session.user.tenantId);
  await db
    .update(companyProfiles)
    .set({ visualIdentity: identity, updatedAt: new Date() })
    .where(eq(companyProfiles.id, profile.id));

  revalidatePath("/company");
  return { ok: true };
}

/**
 * Proposes a visual identity from the company's website. Unlike
 * `importBrandStyleFromUrl` this writes NOTHING: the card prefills from the
 * result and the user confirms with Save (image spec §2 — derive → prefill →
 * confirm → save), so nothing hand-tuned is overwritten by a guess.
 */
export async function deriveVisualIdentityFromUrl(
  url: string
): Promise<{ ok: true; identity: VisualIdentity } | { ok: false; reason: string }> {
  const session = await requireSession();
  const trimmed = url.trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  return deriveVisualIdentityFromPage(session.user.tenantId, trimmed);
}

const RENDER_MAX_WIDTH = 1200;

/**
 * Uploads one style reference image (spec §2's strongest consistency
 * mechanism; product owner decision 3). Unlike everything else on this card
 * it writes immediately rather than at Save — the blob exists the moment it is
 * uploaded, so leaving the array unsaved would strand a paid file. The client
 * takes the returned list as its new baseline.
 *
 * These are brand INPUTS: `tenants/{tenantId}/brand/…`, no `content_images`
 * row, no render history. They still go through `compressPng`, so the 1 MB
 * ceiling applies to them like everything else we store.
 */
export async function uploadStyleReference(
  formData: FormData
): Promise<{ ok: true; styleReferenceImages: string[] } | { ok: false; error: string }> {
  const session = await requireSession();
  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, error: "Choose an image file to upload." };
  const valid = validateUploadFile({ type: file.type, size: file.size });
  if (!valid.ok) return { ok: false, error: valid.error };

  const profile = await getOrCreateCompanyProfile(session.user.tenantId);
  const identity = profile.visualIdentity ?? DEFAULT_VISUAL_IDENTITY;
  // Checked BEFORE the upload: a refused add must not leave a paid orphan.
  if (identity.styleReferenceImages.length >= MAX_REFERENCE_IMAGES) {
    return {
      ok: false,
      error: `You can keep up to ${MAX_REFERENCE_IMAGES} style reference images. Remove one to add another.`,
    };
  }

  try {
    const { png } = await compressPng(Buffer.from(await file.arrayBuffer()), RENDER_MAX_WIDTH);
    const slug = slugForImage(file.name.replace(/\.[a-z0-9]+$/i, ""));
    const { url } = await uploadPng(brandAssetPathname({ tenantId: session.user.tenantId, slug }), png);
    const styleReferenceImages = [...identity.styleReferenceImages, url];

    await db
      .update(companyProfiles)
      .set({ visualIdentity: { ...identity, styleReferenceImages }, updatedAt: new Date() })
      .where(eq(companyProfiles.id, profile.id));

    revalidatePath("/company");
    return { ok: true, styleReferenceImages };
  } catch {
    // compressPng throws for bytes that are not an image, whatever the
    // browser claimed the mime type was.
    return { ok: false, error: "That file couldn't be read as an image — try a PNG, JPEG or WebP." };
  }
}

/** Removes one style reference: out of the array, and its blob deleted. */
export async function removeStyleReference(
  url: string
): Promise<{ ok: true; styleReferenceImages: string[] } | { ok: false; error: string }> {
  const session = await requireSession();
  const profile = await getOrCreateCompanyProfile(session.user.tenantId);
  const identity = profile.visualIdentity ?? DEFAULT_VISUAL_IDENTITY;
  const styleReferenceImages = identity.styleReferenceImages.filter((ref) => ref !== url);
  if (styleReferenceImages.length === identity.styleReferenceImages.length) {
    // Not ours — say nothing happened rather than deleting a blob by URL.
    return { ok: true, styleReferenceImages };
  }

  await db
    .update(companyProfiles)
    .set({ visualIdentity: { ...identity, styleReferenceImages }, updatedAt: new Date() })
    .where(eq(companyProfiles.id, profile.id));
  await deleteBlobs([blobPathnameFromUrl(url)]);

  revalidatePath("/company");
  return { ok: true, styleReferenceImages };
}
```

- [ ] **Step 4: Run the action test**

Run: `npx vitest run tests/app/company-visual-identity-actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the editor**

Create `src/app/(dashboard)/company/visual-identity-editor.tsx`:

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Loader2, Plus, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { saveVisualIdentity, deriveVisualIdentityFromUrl, removeStyleReference, uploadStyleReference } from "./actions";
import { useUnsavedChanges } from "../unsaved-changes";
import type { ImageRule, PaletteRole, VisualIdentity } from "@/db/schema";
import {
  BACKGROUND_TREATMENTS,
  DEFAULT_VISUAL_IDENTITY,
  MAX_CUSTOM_DESCRIPTORS,
  MAX_PALETTE,
  MAX_REFERENCE_IMAGES,
  MIN_READY_PALETTE,
  PALETTE_ROLES,
  PEOPLE_STYLES,
  STYLE_PRESETS,
  TEXTURES,
} from "@/lib/images/visual-identity";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const EMPTY: VisualIdentity = { ...DEFAULT_VISUAL_IDENTITY, palette: [] };

function labelOf<T extends string>(options: readonly { value: T; label: string }[], value: T): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

/**
 * The Visual identity card (image spec §2). Owns its own Save like every card
 * on /company. "Derive from website" only prefills — nothing is written until
 * Save — so the derive button needs no confirm dialog, unlike
 * BrandStyleImport, which overwrites on the server.
 *
 * The one exception to card-owns-its-save: style reference images upload and
 * delete immediately (a blob exists the moment it is uploaded), so those two
 * actions re-baseline the dirty tracking from the list they return.
 */
export function VisualIdentityEditor({
  initial,
  defaultWebsiteUrl,
}: {
  initial: VisualIdentity | null;
  defaultWebsiteUrl: string;
}) {
  const [identity, setIdentity] = useState<VisualIdentity>(initial ?? EMPTY);
  const [saved, setSaved] = useState<VisualIdentity>(initial ?? EMPTY);
  const [moodText, setMoodText] = useState((initial ?? EMPTY).moodWords.join(", "));
  const [saving, setSaving] = useState(false);
  const [deriving, setDeriving] = useState(false);
  // ok: true renders emerald (BrandStyleImport's success idiom); failures muted.
  const [derivedNote, setDerivedNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [url, setUrl] = useState(defaultWebsiteUrl);
  const [advanced, setAdvanced] = useState(false);
  const [uploadingReference, setUploadingReference] = useState(false);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const { setSectionDirty } = useUnsavedChanges();

  const dirty = JSON.stringify(identity) !== JSON.stringify(saved);
  useEffect(() => {
    setSectionDirty("visual-identity", dirty);
  }, [dirty, setSectionDirty]);
  useEffect(() => () => setSectionDirty("visual-identity", false), [setSectionDirty]);

  const update = (patch: Partial<VisualIdentity>) => setIdentity((v) => ({ ...v, ...patch }));

  // Mood words are one comma-separated field; parsed on every keystroke so
  // the saved list is always what the box shows.
  const setMood = (text: string) => {
    setMoodText(text);
    update({ moodWords: text.split(",").map((w) => w.trim()).filter(Boolean).slice(0, 4) });
  };

  const setPaletteEntry = (i: number, patch: Partial<{ hex: string; role: PaletteRole }>) =>
    update({ palette: identity.palette.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const addColor = () => {
    if (identity.palette.length >= MAX_PALETTE) return;
    const nextRole = PALETTE_ROLES[identity.palette.length % PALETTE_ROLES.length].value;
    update({ palette: [...identity.palette, { hex: "#000000", role: nextRole }] });
  };
  const removeColor = (i: number) => update({ palette: identity.palette.filter((_, j) => j !== i) });

  const setRule = (i: number, patch: Partial<ImageRule>) =>
    update({ imageGenerationRules: identity.imageGenerationRules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const addRule = (kind: ImageRule["kind"]) => update({ imageGenerationRules: [...identity.imageGenerationRules, { kind, text: "" }] });
  const removeRule = (i: number) => update({ imageGenerationRules: identity.imageGenerationRules.filter((_, j) => j !== i) });

  /**
   * Reference images are uploaded, not typed (product owner decision 3), and
   * both actions persist immediately — so the returned list becomes the new
   * baseline on BOTH `identity` and `saved`, or the card would either look
   * dirty for a change already stored, or overwrite the stored list on the
   * next Save.
   */
  const applyReferences = (styleReferenceImages: string[]) => {
    setIdentity((v) => ({ ...v, styleReferenceImages }));
    setSaved((v) => ({ ...v, styleReferenceImages }));
  };

  async function addReferenceFiles(files: File[]) {
    if (files.length === 0 || uploadingReference) return;
    setUploadingReference(true);
    try {
      // One at a time: the action enforces the cap of MAX_REFERENCE_IMAGES and
      // the message for the one that doesn't fit should name that, not fail
      // the whole drop.
      for (const file of files) {
        const fd = new FormData();
        fd.set("file", file);
        const res = await uploadStyleReference(fd);
        if (!res.ok) {
          toast.error(res.error);
          break;
        }
        applyReferences(res.styleReferenceImages);
      }
    } catch {
      toast.error("Couldn't upload that image — try again");
    } finally {
      setUploadingReference(false);
    }
  }

  async function removeReference(url: string) {
    try {
      const res = await removeStyleReference(url);
      if (res.ok) applyReferences(res.styleReferenceImages);
      else toast.error(res.error);
    } catch {
      toast.error("Couldn't remove that image — try again");
    }
  }

  async function derive() {
    const trimmed = url.trim();
    if (!trimmed || deriving) return;
    setDeriving(true);
    setDerivedNote(null);
    try {
      const res = await deriveVisualIdentityFromUrl(trimmed);
      if (res.ok) {
        // Keep the uploaded references: they are already stored (and paid for
        // on Blob), and a derived proposal has nothing to say about them.
        setIdentity({ ...res.identity, styleReferenceImages: identity.styleReferenceImages });
        setMoodText(res.identity.moodWords.join(", "));
        setDerivedNote({ ok: true, text: "Proposed from your site — review below and Save to keep it." });
      } else {
        setDerivedNote({ ok: false, text: "We couldn't derive an identity from that page — check the URL or fill in the palette by hand." });
      }
    } finally {
      setDeriving(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      // Drop blank rules before validating; a half-typed rule is not an
      // invalid identity. Reference images need no cleaning — they are blob
      // URLs written by their own actions, never typed.
      const clean: VisualIdentity = {
        ...identity,
        imageGenerationRules: identity.imageGenerationRules.filter((r) => r.text.trim()),
      };
      const res = await saveVisualIdentity(clean);
      if (res.ok) {
        setIdentity(clean);
        setSaved(clean);
        setDerivedNote(null);
        toast.success("Visual identity saved");
      } else {
        toast.error("Check the palette (hex like #1a73e8), then try again");
      }
    } catch {
      toast.error("Couldn't save visual identity — try again");
    } finally {
      setSaving(false);
    }
  }

  const ready = identity.palette.length >= MIN_READY_PALETTE;

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label>Derive from your website</Label>
        <div className="flex gap-2">
          <Input type="url" placeholder="https://yourcompany.com" value={url} onChange={(e) => setUrl(e.target.value)} className="flex-1" />
          <Button type="button" variant="outline" onClick={derive} disabled={deriving || !url.trim()}>
            {deriving ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            {deriving ? "Analyzing…" : "Derive"}
          </Button>
        </div>
        {derivedNote && (
          <p className={derivedNote.ok ? "text-xs text-emerald-600" : "text-xs text-muted-foreground"}>{derivedNote.text}</p>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Palette</Label>
          <span className="text-xs text-muted-foreground">
            {ready ? `${identity.palette.length} of ${MAX_PALETTE}` : `Add at least ${MIN_READY_PALETTE} colors to enable image generation`}
          </span>
        </div>
        {identity.palette.map((p, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              type="color"
              aria-label={`Color ${i + 1}`}
              value={/^#[0-9a-fA-F]{6}$/.test(p.hex) ? p.hex : "#000000"}
              onChange={(e) => setPaletteEntry(i, { hex: e.target.value })}
              className="size-9 cursor-pointer rounded border border-input bg-transparent p-0.5"
            />
            <Input value={p.hex} onChange={(e) => setPaletteEntry(i, { hex: e.target.value })} className="w-32 font-mono" placeholder="#1a73e8" />
            <Select value={p.role} onValueChange={(v) => setPaletteEntry(i, { role: v as PaletteRole })}>
              <SelectTrigger className="w-40">
                <SelectValue>{labelOf(PALETTE_ROLES, p.role)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {PALETTE_ROLES.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="button" variant="ghost" size="sm" aria-label="Remove color" onClick={() => removeColor(i)}>
              <X className="size-4" />
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={addColor} disabled={identity.palette.length >= MAX_PALETTE}>
          <Plus /> Add color
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>Style</Label>
          <Select value={identity.stylePreset} onValueChange={(v) => update({ stylePreset: v as VisualIdentity["stylePreset"] })}>
            <SelectTrigger>
              <SelectValue>{labelOf(STYLE_PRESETS, identity.stylePreset)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {STYLE_PRESETS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Mood words</Label>
          <Input value={moodText} onChange={(e) => setMood(e.target.value)} placeholder="clean, modern" />
          <p className="text-xs text-muted-foreground">Two to four, comma-separated.</p>
        </div>
      </div>

      <Label>
        <Switch checked={identity.allowTextInImages} onCheckedChange={(v) => update({ allowTextInImages: v })} />
        Allow text inside images
      </Label>

      <Button type="button" variant="ghost" size="sm" onClick={() => setAdvanced((a) => !a)}>
        {advanced ? "Hide advanced" : "Advanced…"}
      </Button>

      {advanced && (
        <div className="space-y-5 rounded-md border p-4">
          <div className="space-y-2">
            <Label>Style reference images</Label>
            <p className="text-xs text-muted-foreground">
              Up to {MAX_REFERENCE_IMAGES} images you already use; every generated image is steered toward them. PNG, JPEG or WebP,
              10 MB or smaller. These save as soon as they upload.
            </p>
            {identity.styleReferenceImages.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {identity.styleReferenceImages.map((ref) => (
                  <li key={ref} className="group relative">
                    <Image
                      src={ref}
                      alt=""
                      width={96}
                      height={72}
                      className="h-[72px] w-24 rounded border object-cover"
                      unoptimized
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label="Remove image"
                      className="absolute right-0 top-0 bg-background/80"
                      onClick={() => void removeReference(ref)}
                    >
                      <X className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {/* A hidden file input behind a Button: the app has no file-input
                primitive, and a bare <input type="file"> would be the only
                unstyled control on the page. */}
            <input
              ref={referenceInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              className="hidden"
              onChange={(e) => {
                // Copy out of the live FileList before clearing the input, so
                // picking the same file twice in a row still fires a change.
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                void addReferenceFiles(files);
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => referenceInputRef.current?.click()}
              disabled={uploadingReference || identity.styleReferenceImages.length >= MAX_REFERENCE_IMAGES}
            >
              {uploadingReference ? <Loader2 className="size-4 animate-spin" /> : <Plus />}
              {uploadingReference ? "Uploading…" : "Add image"}
            </Button>
          </div>

          <div className="space-y-2">
            <Label>Custom style descriptors</Label>
            <Textarea
              rows={2}
              maxLength={MAX_CUSTOM_DESCRIPTORS}
              value={identity.customStyleDescriptors}
              onChange={(e) => update({ customStyleDescriptors: e.target.value })}
              placeholder="e.g. rounded corners everywhere, thick outlines, isometric product shots"
            />
            <p className="text-xs text-muted-foreground">
              {identity.customStyleDescriptors.length}/{MAX_CUSTOM_DESCRIPTORS}
            </p>
          </div>

          <div className="space-y-2">
            <Label>Rules</Label>
            <p className="text-xs text-muted-foreground">Appended to every prompt as &ldquo;Always: …&rdquo; and &ldquo;Never: …&rdquo;.</p>
            {identity.imageGenerationRules.map((rule, i) => (
              <div key={i} className="flex gap-2">
                <Select value={rule.kind} onValueChange={(v) => setRule(i, { kind: v as ImageRule["kind"] })}>
                  <SelectTrigger className="w-28">
                    <SelectValue>{rule.kind === "do" ? "Always" : "Never"}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="do">Always</SelectItem>
                    <SelectItem value="dont">Never</SelectItem>
                  </SelectContent>
                </Select>
                <Input value={rule.text} onChange={(e) => setRule(i, { text: e.target.value })} className="flex-1" placeholder="no hands" />
                <Button type="button" variant="ghost" size="sm" aria-label="Remove rule" onClick={() => removeRule(i)}>
                  <X className="size-4" />
                </Button>
              </div>
            ))}
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => addRule("do")}>
                <Plus /> Always…
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => addRule("dont")}>
                <Plus /> Never…
              </Button>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label>Background</Label>
              <Select value={identity.backgroundTreatment} onValueChange={(v) => update({ backgroundTreatment: v as VisualIdentity["backgroundTreatment"] })}>
                <SelectTrigger>
                  <SelectValue>{labelOf(BACKGROUND_TREATMENTS, identity.backgroundTreatment)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {BACKGROUND_TREATMENTS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Texture</Label>
              <Select value={identity.texture} onValueChange={(v) => update({ texture: v as VisualIdentity["texture"] })}>
                <SelectTrigger>
                  <SelectValue>{labelOf(TEXTURES, identity.texture)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {TEXTURES.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>People</Label>
              <Select value={identity.peopleStyle} onValueChange={(v) => update({ peopleStyle: v as VisualIdentity["peopleStyle"] })}>
                <SelectTrigger>
                  <SelectValue>{labelOf(PEOPLE_STYLES, identity.peopleStyle)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {PEOPLE_STYLES.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <Label>
            <Switch checked={identity.pinStyleToCover} onCheckedChange={(v) => update({ pinStyleToCover: v })} />
            Use each post&apos;s cover as a style reference for its body images
          </Label>
        </div>
      )}

      <div className="flex justify-end">
        <Button type="button" variant="outline" disabled={!dirty || saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Mount the card**

In `src/app/(dashboard)/company/page.tsx`, add the import after line 14 (`GuidelinesEditor`):

```ts
import { VisualIdentityEditor } from "./visual-identity-editor";
```

Insert between the Guidelines card (closes `</Card>` at line 195) and the Change events comment (line 197):

```tsx
      <Card>
        <CardHeader>
          <CardTitle>Visual identity</CardTitle>
          <CardDescription>
            Palette, style and rules every generated image follows. Drafts get images only once at least three
            colors are saved here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* Keyed on the server value for the same reason as GuidelinesEditor
              above: the editor seeds its state once from `initial`. */}
          <VisualIdentityEditor
            key={JSON.stringify(brandProfile.visualIdentity)}
            initial={brandProfile.visualIdentity}
            defaultWebsiteUrl={brandProfile.websiteUrl ?? ""}
          />
        </CardContent>
      </Card>
```

- [ ] **Step 7: Blob host for `next/image`, and room for a 10 MB upload**

The reference thumbnails render from the Blob host through `next/image`, and
`uploadStyleReference` posts a file through a Server Action whose body limit
defaults to 1 MB — both need `next.config.ts`. Add these two keys, keeping
everything already in the file:

```ts
  // Reference thumbnails, covers and library images render through next/image
  // from Vercel Blob. Store hosts are `<store-id>.public.blob.vercel-storage.com`.
  images: {
    remotePatterns: [{ protocol: "https", hostname: "*.public.blob.vercel-storage.com", search: "" }],
  },
```

and inside the existing `experimental.serverActions` object:

```ts
      // Image uploads accept files up to 10 MB (UPLOAD_MAX_BYTES); the default
      // 1 MB action body would reject them. Headroom for multipart framing.
      bodySizeLimit: "11mb",
```

Plan 3 Task 8 Step 3 states the same two keys — once this lands, that step is
a no-op for them and must not duplicate them.

- [ ] **Step 8: Verify**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all clean. If `Switch`'s `onCheckedChange` callback is typed with a second `event` argument, `(v) => update({...})` still typechecks (extra params are ignored); if `SelectValue` complains about children, mirror `calendar-form.tsx` line 50 exactly. `next build` validates the config keys, so a typo in Step 7 surfaces here.

Manual verification (dev server, signed in, `BLOB_READ_WRITE_TOKEN` set): open /company; the Visual identity card appears after Guidelines; add three colors, pick a style, Save → toast "Visual identity saved" and the values survive a reload; Derive with the company URL fills the palette/style/mood and shows the "Proposed from your site" note without saving; navigating away with unsaved edits prompts (unsaved-changes guard); Advanced toggles the disclosure; an invalid hex shows the error toast on Save.

Style reference images (Advanced):
- [ ] Add image → pick a PNG → a thumbnail appears and **survives a reload without pressing Save** (it is stored on upload).
- [ ] Adding it does not make the card dirty — navigating away straight after an upload does not prompt.
- [ ] The X on a thumbnail removes it, and it is gone after a reload (its blob is deleted too).
- [ ] With four thumbnails present, "Add image" is disabled; forcing a fifth through (select five files at once) shows "You can keep up to 4 style reference images. Remove one to add another."
- [ ] A GIF shows "Only PNG, JPEG or WebP…"; a 12 MB PNG shows the 10 MB message; neither leaves a thumbnail.
- [ ] With references saved, a later draft's images visibly follow them (checked again in Plan 2's manual pass).

- [ ] **Step 9: Commit**

```bash
git add "src/app/(dashboard)/company/actions.ts" "src/app/(dashboard)/company/visual-identity-editor.tsx" "src/app/(dashboard)/company/page.tsx" next.config.ts tests/app/company-visual-identity-actions.test.ts
git commit -m "feat: visual identity card on /company with style reference uploads"
```

---

### Task 13: Content images card on /settings

**Files:**
- Modify: `src/app/(dashboard)/settings/actions.ts` — imports (lines 1–15), append `saveImagePolicy` after `removeMember` (ends line 150)
- Create: `src/app/(dashboard)/settings/image-policy-form.tsx`
- Modify: `src/app/(dashboard)/settings/page.tsx` — imports (lines 1–16), profile load, new card after "Calendar" (closes line 75)
- Test: `tests/app/settings-image-policy-actions.test.ts`

**Interfaces:**
- Consumes: `parseImagePolicy`, `resolveImagePolicy`, `IMAGE_POLICY_ROWS`, `BODY_SETTING_OPTIONS`, `DEFAULT_IMAGE_POLICY` (Task 5); `getOrCreateCompanyProfile`; `companyProfiles`.
- Produces: `saveImagePolicy(input: unknown): Promise<{ ok: true } | { ok: false; reason: "invalid" }>`, `<ImagePolicyForm initial={ImagePolicy | null} />`.

- [ ] **Step 1: Write the failing action test**

Create `tests/app/settings-image-policy-actions.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { companyProfiles } from "../../src/db/schema";
import { seedTenant, dropTenant } from "../helpers/fixtures";

let currentTenantId = "";
vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: "user-1", role: "owner" } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { saveImagePolicy } from "../../src/app/(dashboard)/settings/actions";

const TENANT = "Image Policy Actions Test Tenant";

afterEach(async () => {
  await dropTenant(TENANT);
});

describe("saveImagePolicy", () => {
  it("persists a valid policy on the tenant's profile", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;

    expect(
      await saveImagePolicy({ blog_post: { cover: true, body: 2 }, product_update: { cover: false, body: "off" }, social_post: { cover: false, body: "off" } })
    ).toEqual({ ok: true });

    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile.imagePolicy).toEqual({
      blog_post: { cover: true, body: 2 },
      product_update: { cover: false, body: "off" },
      social_post: { cover: false, body: "off" },
    });
  });

  it("rejects an invalid policy without writing", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    expect(await saveImagePolicy({ blog_post: { cover: true, body: 9 } })).toEqual({ ok: false, reason: "invalid" });
    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile?.imagePolicy ?? null).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/app/settings-image-policy-actions.test.ts`
Expected: FAIL — `saveImagePolicy` is not exported.

- [ ] **Step 3: Add the action**

In `src/app/(dashboard)/settings/actions.ts`, add imports after line 15:

```ts
import { companyProfiles } from "@/db/schema";
import { getOrCreateCompanyProfile } from "@/lib/workspace/company-profile";
import { parseImagePolicy } from "@/lib/images/policy";
```

(`repos, scheduleConfigs, tenants` are already imported from `@/db/schema` on line 7 — merge `companyProfiles` into that import instead of a second line.)

Append after `removeMember`:

```ts
/**
 * Persists the Content images card (image spec §6): per content type, whether
 * a cover is generated and how many body illustrations at most. Takes
 * `unknown` — a Server Action argument is client input — and validates
 * against the allow-list in src/lib/images/policy.ts. Turning a type off
 * never deletes existing images.
 */
export async function saveImagePolicy(input: unknown): Promise<{ ok: true } | { ok: false; reason: "invalid" }> {
  const session = await requireSession();
  const policy = parseImagePolicy(input);
  if (!policy) return { ok: false, reason: "invalid" };

  const profile = await getOrCreateCompanyProfile(session.user.tenantId);
  await db
    .update(companyProfiles)
    .set({ imagePolicy: policy, updatedAt: new Date() })
    .where(eq(companyProfiles.id, profile.id));

  revalidatePath("/settings");
  return { ok: true };
}
```

- [ ] **Step 4: Run the action test**

Run: `npx vitest run tests/app/settings-image-policy-actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the form**

Create `src/app/(dashboard)/settings/image-policy-form.tsx`:

```tsx
"use client";

import { useState } from "react";
import { toast } from "sonner";
import { saveImagePolicy } from "./actions";
import type { BodyIllustrationSetting, ImagePolicy } from "@/db/schema";
import type { ContentType } from "@/lib/ai/compose-prompt";
import { BODY_SETTING_OPTIONS, DEFAULT_IMAGE_POLICY, IMAGE_POLICY_ROWS } from "@/lib/images/policy";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Entry = { cover: boolean; body: BodyIllustrationSetting };
type Matrix = Record<ContentType, Entry>;

// The Select works in strings; the setting is "off" | "auto" | 1 | 2 | 3.
const toValue = (b: BodyIllustrationSetting) => String(b);
const fromValue = (v: string): BodyIllustrationSetting => (v === "off" || v === "auto" ? v : (Number(v) as 1 | 2 | 3));

function fill(initial: ImagePolicy | null): Matrix {
  const out = { ...DEFAULT_IMAGE_POLICY } as Matrix;
  for (const row of IMAGE_POLICY_ROWS) {
    const entry = initial?.[row.type];
    if (entry) out[row.type] = entry;
  }
  return out;
}

/**
 * The Content images card (image spec §6): one row per content type, a cover
 * switch and a body-illustration cap. Saves the full matrix — the column is
 * one jsonb, and a row that matches the default is stored too, so a future
 * default change never silently flips a tenant's choice.
 */
export function ImagePolicyForm({ initial }: { initial: ImagePolicy | null }) {
  const [matrix, setMatrix] = useState<Matrix>(() => fill(initial));
  const [saving, setSaving] = useState(false);

  const set = (type: ContentType, patch: Partial<Entry>) => setMatrix((m) => ({ ...m, [type]: { ...m[type], ...patch } }));

  async function save() {
    setSaving(true);
    try {
      const res = await saveImagePolicy(matrix);
      if (res.ok) toast.success("Content image settings saved");
      else toast.error("Couldn't save content image settings");
    } catch {
      toast.error("Couldn't save content image settings — try again");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-2 pr-4 font-medium">Type</th>
              <th className="py-2 pr-4 font-medium">Cover image</th>
              <th className="py-2 font-medium">Body images</th>
            </tr>
          </thead>
          <tbody>
            {IMAGE_POLICY_ROWS.map((row) => {
              const entry = matrix[row.type];
              const bodyLabel = BODY_SETTING_OPTIONS.find((o) => o.value === entry.body)?.label ?? String(entry.body);
              return (
                <tr key={row.type} className="border-t">
                  <td className="py-2 pr-4">{row.label}</td>
                  <td className="py-2 pr-4">
                    <Switch aria-label={`${row.label} cover image`} checked={entry.cover} onCheckedChange={(v) => set(row.type, { cover: v })} />
                  </td>
                  <td className="py-2">
                    <Select value={toValue(entry.body)} onValueChange={(v) => set(row.type, { body: fromValue(v as string) })}>
                      <SelectTrigger className="w-40" aria-label={`${row.label} body images`}>
                        <SelectValue>{bodyLabel}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {BODY_SETTING_OPTIONS.map((o) => (
                          <SelectItem key={String(o.value)} value={toValue(o.value)}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Turning a type off stops new images from being generated for it; existing images stay.
      </p>
      <Button type="button" variant="outline" disabled={saving} onClick={save}>
        {saving ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}
```

- [ ] **Step 6: Mount the card**

In `src/app/(dashboard)/settings/page.tsx`, add imports after line 12 (`normalizeWeekStart`):

```ts
import { getOrCreateCompanyProfile } from "@/lib/workspace/company-profile";
import { ImagePolicyForm } from "./image-policy-form";
```

After the `workspaceSchedule` query (line 25), add:

```ts
  const profile = await getOrCreateCompanyProfile(session.user.tenantId);
```

After the Calendar card (closes `</Card>` at line 75), add:

```tsx
      <Card>
        <CardHeader>
          <CardTitle>Content images</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Keyed on the server value like the other cards: the form seeds
              its matrix once from `initial`. */}
          <ImagePolicyForm key={JSON.stringify(profile.imagePolicy)} initial={profile.imagePolicy} />
        </CardContent>
      </Card>
```

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all clean.

Manual verification (dev server, signed in): open /settings; the Content images card shows three rows with defaults Blog post (cover on, Auto), Product update (cover on, Off), Social post (off, Off); flip Product update's body to "Up to 2", Save → toast, reload shows "Up to 2".

- [ ] **Step 8: Commit**

```bash
git add "src/app/(dashboard)/settings/actions.ts" "src/app/(dashboard)/settings/image-policy-form.tsx" "src/app/(dashboard)/settings/page.tsx" tests/app/settings-image-policy-actions.test.ts
git commit -m "feat: content images policy card on /settings"
```

---

### Task 14: Final verification

- [ ] **Step 1: Run every file this plan touched**

```bash
npx vitest run \
  tests/db/content-images-schema.test.ts \
  tests/lib/ai/llm-usage.test.ts \
  tests/lib/images/visual-identity.test.ts \
  tests/lib/images/policy.test.ts \
  tests/lib/images/prompt.test.ts \
  tests/lib/images/compress.test.ts \
  tests/lib/images/blob.test.ts \
  tests/lib/ai/image-model.test.ts \
  tests/lib/ai/images.test.ts \
  tests/lib/images/store.test.ts \
  tests/lib/images/fixtures-smoke.test.ts \
  tests/lib/workspace/derive-visual-identity.test.ts \
  tests/app/company-visual-identity-actions.test.ts \
  tests/app/settings-image-policy-actions.test.ts
```

Expected: PASS. **Run this line twice** — the suite shares one Postgres and has
no per-test truncation (`vitest.setup.ts` only points `DATABASE_URL` at the
`_test` database; isolation is per-file tenant naming via
`tests/helpers/fixtures.ts`). A failure that does not repeat is not yours; a
failure that repeats is.

- [ ] **Step 2: Regression check on the files this plan changed the contract of**

`recordLlmUsage`'s `database` parameter widened (Task 3) and
`tests/helpers/fixtures.ts` gained exports (Task 10b) — both are imported
across the suite, so run every file that touches them:

```bash
npx vitest run tests/lib/ai tests/lib/workspace tests/lib/briefs
```

Expected: PASS (twice, per above).

- [ ] **Step 3: Gates**

```bash
npx tsc --noEmit && npm run lint && npm run build
```

Expected: clean. `npm run typecheck` also type-checks `tests/**`
(`tsconfig.json` includes them), so a broken test type fails here too.

> **Not a gate: `npm test`.** The whole suite against one shared Postgres is
> documented as flaky (`docs/superpowers/plans/2026-08-13-shared-fixtures-and-selection-hook.md:29`),
> so a red whole-suite run proves nothing and a green one proves little. Run it
> if you like for information, but do not treat it as pass/fail for this plan —
> Steps 1–3 are the gate.

- [ ] **Step 4: Report**

Report which of `openai.image` / `openai.imageModel` exists (Task 1 Step 2), and whether `@vercel/blob`'s typings needed any adaptation in Task 8.

---

## Self-review

**Spec coverage owned by this plan**

- §1 Engine and routing — `image-model.ts` (Task 9) mirrors `model.ts`, `IMAGE_MODEL` env + default, direct `@ai-sdk/openai`; `renderImage` in `images.ts` is the single call surface using `generateImage` for both generation and image+instruction edits, and records usage. Deviation from §1's wording "compressed PNG out": per the shared contract, `renderImage` returns the model's raw PNG and callers run `compressPng` before `uploadPng` — kept so the compression pass sits next to the upload it protects.
- §2 Visual brand guidelines — schema type + `visual_identity` column (Task 2); defaults, `compileStyleBlock`, readiness and validation (Task 4); the card with palette/preset/mood/allowText/advanced fields (Task 12); website bootstrap via `fetchPageText`'s `html` + LLM (Task 11) with the derive → prefill → confirm → save flow. Alt-text *policy* (≤125 chars, from concept) is prompt guidance for Plan 2's planner; nothing here to build.
  **Style reference images are uploaded in this plan** (product owner decision 3,
  resolving QA review defect 12): `uploadStyleReference` /
  `removeStyleReference` in Task 12, storing under `tenants/{tenantId}/brand/`
  with no `content_images` row, capped at `MAX_REFERENCE_IMAGES`. The §2 user
  story *"I upload two or three of our existing blog illustrations as
  references"* is therefore complete here and nothing about it is deferred to
  Plan 3. The upload validator (`validateUploadFile`, `UPLOAD_MAX_BYTES`,
  `UPLOAD_MIME_TYPES`) lives in `blob.ts` and Plan 3 re-exports it.
- §3 Data model — both tables, partial unique cover index, `currentRenderId` without FK, `llm_usage.image_count` (Task 2); render history cap 5, prune-with-blob-delete unless published (Task 10, `addRender`); "body images join by blob URL" is `findImageByRenderUrl`.
- §6 Per-type settings — `policy.ts` defaults/resolver/parser (Task 5), `image_policy` column (Task 2), Content images card + `saveImagePolicy` (Task 13). Deviation: the spec names `src/lib/content/image-policy.ts`; the shared contract fixes `src/lib/images/policy.ts`, which is what every plan imports.
- §7 Storage — `blob.ts` pathname/put/del wrappers + the brand-asset prefix and upload validator (Task 8), `compress.ts` sharp pass with the 1 MB ceiling (Task 7), sizes and aspect ratios in `prompt.ts` (Task 6), env var (Task 1). No `list()` anywhere. **Product owner decisions 1 and 2 (2026-08-19) land here:** covers are generated at 1200×630 natively (`size` + `aspectRatio`, one measured retry in `renderImage`, Task 9) and nothing crops; every stored PNG is ≤ 1 MB, uploads included.
- §5b Image library — `listLibraryImages` (Task 10) is the library's reader: standalone library images plus images of pieces past `brief`/`draft` (product owner decision 4). `listImages` stays the editor's unfiltered view.
- §9 Cost tracking — `LlmOperation` additions and `imageCount` (Task 3), recorded by `renderImage` (Task 9). Structural caps live in Plan 2 (≤1 cover + bodyCap) and Task 10 (≤5 renders).

**Contract additions beyond the brief** (harmless, all exported): `parseVisualIdentity`, option lists and `MAX_*` constants in `visual-identity.ts`; `parseImagePolicy`, `IMAGE_POLICY_ROWS`, `BODY_SETTING_OPTIONS`, `AUTO_BODY_CAP` in `policy.ts`; `slugForImage`, `brandAssetPathname`, `blobPathnameFromUrl`, `UPLOAD_MAX_BYTES`/`UPLOAD_MIME_TYPES`/`validateUploadFile` in `blob.ts`; `MAX_IMAGE_BYTES` and `imageDimensions` in `compress.ts`; `IMAGE_SIZES`/`ImageSize`/`IMAGE_ASPECT_RATIOS`/`NO_TEXT_CLAUSE` in `prompt.ts`; `ASPECT_TOLERANCE` and `RenderImageArgs.enforceAspect` in `images.ts`; `listLibraryImages`/`ImageFilter`/`LIBRARY_HIDDEN_PIECE_STATUSES` in `store.ts`; `uploadStyleReference`/`removeStyleReference` on /company; `RenderImageDeps.fetchImpl`; `StoreDeps` as a trailing `deps` param on `addRender`/`deleteImage` (the `database` param stays in the contract's position, so `addRender(a)` and `addRender(a, db)` both work).

**Handed to other plans**

- Plan 2: `illustration_plan` usage recording call site, `DRAFT_STEPS` `"illustrating"` step, planner + splice + `illustratePiece`, `isVisualIdentityReady` gate and `resolveImagePolicy` consumption in `generateDraftForPiece`.
- Plan 3: `uploadImageFile`, editor insert/edit/cover, `/images` library (reading `listLibraryImages`, and re-exporting this plan's upload validator), `.mdx-content img` CSS. `next.config.ts`'s `images.remotePatterns` and `serverActions.bodySizeLimit` are added **here** (Task 12 Step 7) because the reference thumbnails and uploads need them first.
- Plan 4: `getCoverImage` in Webflow/LinkedIn/webhook dispatch.

**Unverified until install:** exact export names/typings of `@ai-sdk/openai` (`openai.image` vs `openai.imageModel`) and `@vercel/blob` (`put` options, `del` accepting an array) — Task 1 Step 2 checks both before any code depends on them, and Tasks 8/9 say what to change if they differ.
