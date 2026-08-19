# Image Generation — Editor Tools, Cover, and Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a content lead insert, edit, restore, upload and reuse brand-styled images from the draft editor, set a cover on the draft page, and manage every image from a new Images library.

**Architecture:** Thin server actions (`drafts/[releaseId]/image-actions.ts`, `images/actions.ts`) call a shared `src/lib/images/generate.ts` (render → compress → upload → store rows) on top of Plan 1's foundation modules. The editor reuses the two seams Ask AI already uses — the floating insert surface in the shared `MdxEditor` and the `EditorOps` bridge in `AgentEditBridge` — extended with three ops (`captureInsertPoint`, `insertAtCursor`, `replaceImageSrc`), and MDXEditor's `imagePlugin({ imageUploadHandler, EditImageToolbar })` seams for uploads and per-image edit affordances. The cover is a `role: "cover"` row shown by a `CoverPanel` above the title; the library is a read view over the same rows.

**Tech Stack:** Next.js 16.2.10 App Router (server actions, `next/image`), `@mdxeditor/editor` 4.1.0 (+ its `lexical` 0.48 / `@lexical/react` deps), Drizzle, `ai` v7 `generateObject`, Vercel Blob (via Plan 1), sharp (via Plan 1), Vitest.

**Spec:** docs/superpowers/specs/2026-08-18-image-generation-design.md — this plan covers §5 (Editor: insert, edit, cover), §5b (Image library), the §3 "body images join the markdown by blob URL" contract, and the §5 plumbing notes (`images.remotePatterns`, `.mdx-content img`).

## Global Constraints

- Run `npm install` in the worktree before anything (no node_modules).
- Plans 1 and 2 are merged: `src/lib/images/{visual-identity,policy,compress,blob,prompt,store}.ts`, `src/lib/ai/{image-model,images}.ts`, the `content_images` / `image_renders` tables (with Plan 2's nullable `anchorHeading` on `content_images`) all exist with the signatures in the shared contract. Consume them; never redefine. **Before Task 3 and Task 4, open `src/lib/images/store.ts` and confirm the exported names and the `database: DbClient = db` last-arg convention** — this plan cites the contract, not line numbers, for that file.
- Body images: `1200x900` renders, `compressPng(raw, 1200)`. Cover: `1200x630`, `compressPng(raw, 1200)`. Library images render at the body size. Uploads: `image/png`, `image/jpeg`, `image/webp`, ≤ 10 MB, converted to PNG via `compressPng`.
- The user-facing "prompt" in insert / cover / library **is a concept-level description**; the server wraps it with `buildImagePrompt({ styleBlock, concept, role, allowText })`. `regenerateImage` mode `"prompt"` is the exception: it takes the **stored full prompt** (spec §5 "Edit prompt opens the current render's stored prompt") and sends it verbatim. Mode `"edit"` stores `${previous}\n\nEdit: ${instruction}`.
- Generation requires `isVisualIdentityReady(profile.visualIdentity)`; otherwise actions return `{ ok: false, error: "Set up your visual identity in Company settings before generating images." }` and the UI shows that sentence.
- Every write to a piece's body or cover goes through `requireSession()` → tenant-scoped load → `assertDraftEditable(piece)` (exactly as `requestAgentEdit` does, `src/app/(dashboard)/drafts/[releaseId]/actions.ts:65-96`). Library images (`contentPieceId === null`) skip `assertDraftEditable`.
- `"use server"` files export ONLY async functions — pure helpers live in `src/lib/images/actions-support.ts`.
- Never import a runtime value from a server module into a `"use client"` file — `import type` only; Server Function references (from `"use server"` files) are fine.
- Tests: vitest; node project under tests/** (real Postgres via vitest.setup.ts, uses tests/helpers/fixtures.ts), jsdom project under tests/components/**. Run a single file with `npx vitest run tests/path/file.test.ts`. The suite is flaky when run whole — run the files you touched.
- Migrations: `npm run db:generate` after schema edits; commit the generated SQL in src/db/migrations. (This plan adds no schema.)
- `npm run typecheck && npm run lint && npm run build` are the gates for every task touching a route or component. The dev preview sits behind an OAuth wall — the manual checklist (Task 11) is run by the user.
- Commit after every task; message style: lowercase imperative, `feat:`/`fix:`/`test:`/`docs:` prefix, no Co-Authored-By needed.

---

### Task 1: Pure helpers — `src/lib/images/actions-support.ts`

**Files:**
- Create: `src/lib/images/actions-support.ts`
- Test: `tests/lib/images/actions-support.test.ts`

**Interfaces:**
- Consumes: `slugify` from `src/lib/publishing/slug.ts:3` (`slugify(title: string): string`).
- Produces:
  ```ts
  export function editPromptHistory(previous: string, instruction: string): string;
  export const UPLOAD_MAX_BYTES: number;                       // 10 * 1024 * 1024
  export const UPLOAD_MIME_TYPES: readonly ["image/png", "image/jpeg", "image/webp"];
  export function validateUploadFile(file: { type: string; size: number }): { ok: true } | { ok: false; error: string };
  export function altFromConcept(concept: string): string;     // ≤125 chars, one sentence, no "image of"
  export function sliceAroundHeading(markdown: string, heading: string | null, maxChars?: number): string;
  export function stripImageFromMarkdown(markdown: string, urls: string[]): string;
  export function imageSlug(text: string): string;             // ≤40 chars, "image" fallback
  export function sizeForRole(role: "cover" | "body" | "library"): "1200x630" | "1200x900";
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/lib/images/actions-support.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  editPromptHistory,
  validateUploadFile,
  altFromConcept,
  sliceAroundHeading,
  stripImageFromMarkdown,
  imageSlug,
  sizeForRole,
  UPLOAD_MAX_BYTES,
} from "../../../src/lib/images/actions-support";

describe("editPromptHistory", () => {
  it("appends the instruction as an Edit line after a blank line", () => {
    expect(editPromptHistory("A blue orb.\n", "  make it darker ")).toBe("A blue orb.\n\nEdit: make it darker");
  });
  it("chains a second edit after the first", () => {
    const once = editPromptHistory("A blue orb.", "darker");
    expect(editPromptHistory(once, "no people")).toBe("A blue orb.\n\nEdit: darker\n\nEdit: no people");
  });
});

describe("validateUploadFile", () => {
  it("accepts png, jpeg and webp under the cap", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp"]) {
      expect(validateUploadFile({ type, size: 1024 })).toEqual({ ok: true });
    }
  });
  it("rejects other mime types with a readable error", () => {
    const r = validateUploadFile({ type: "image/gif", size: 10 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/PNG, JPEG or WebP/);
  });
  it("rejects files over 10 MB", () => {
    const r = validateUploadFile({ type: "image/png", size: UPLOAD_MAX_BYTES + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/10 MB/);
  });
});

describe("altFromConcept", () => {
  it("takes the first sentence, drops a leading 'image of', and caps at 125 chars", () => {
    expect(altFromConcept("Image of a rocket launching from a laptop. Second sentence.")).toBe(
      "A rocket launching from a laptop"
    );
    const long = "x".repeat(200);
    expect(altFromConcept(long).length).toBeLessThanOrEqual(125);
  });
  it("returns an empty string for an empty concept", () => {
    expect(altFromConcept("   ")).toBe("");
  });
});

describe("sliceAroundHeading", () => {
  const md = [
    "# Title",
    "",
    "Intro paragraph.",
    "",
    "## Search",
    "",
    "Search is faster now.",
    "",
    "### Details",
    "",
    "Indexing changed.",
    "",
    "## Billing",
    "",
    "Billing moved.",
  ].join("\n");

  it("returns the section under the named heading up to the next heading of the same or higher level", () => {
    const out = sliceAroundHeading(md, "Search");
    expect(out.startsWith("## Search")).toBe(true);
    expect(out).toContain("### Details");
    expect(out).toContain("Indexing changed.");
    expect(out).not.toContain("## Billing");
  });
  it("matches the heading case-insensitively and trims", () => {
    expect(sliceAroundHeading(md, "  billing ")).toContain("Billing moved.");
  });
  it("falls back to the head of the document when the heading is null or not found", () => {
    expect(sliceAroundHeading(md, null).startsWith("# Title")).toBe(true);
    expect(sliceAroundHeading(md, "Nope").startsWith("# Title")).toBe(true);
  });
  it("caps the slice at maxChars", () => {
    expect(sliceAroundHeading(md, "Search", 12).length).toBeLessThanOrEqual(12);
  });
});

describe("stripImageFromMarkdown", () => {
  it("removes image lines whose URL is in the list and collapses the blank line they leave", () => {
    const md = "## A\n\n![alt](https://x/a.png)\n\nText.\n\n![keep](https://x/b.png)\n";
    expect(stripImageFromMarkdown(md, ["https://x/a.png"])).toBe("## A\n\nText.\n\n![keep](https://x/b.png)\n");
  });
  it("removes an inline image reference inside a paragraph without touching the rest", () => {
    const md = "See ![alt](https://x/a.png) here.";
    expect(stripImageFromMarkdown(md, ["https://x/a.png"])).toBe("See  here.");
  });
  it("is a no-op when nothing matches", () => {
    const md = "![alt](https://x/a.png)";
    expect(stripImageFromMarkdown(md, ["https://x/zzz.png"])).toBe(md);
  });
});

describe("imageSlug and sizeForRole", () => {
  it("slugifies to at most 40 chars with a fallback", () => {
    expect(imageSlug("A Rocket Launching From A Laptop, At Dawn, With Confetti")).toBe(
      "a-rocket-launching-from-a-laptop-at-dawn"
    );
    expect(imageSlug("!!!")).toBe("image");
  });
  it("maps roles to render sizes", () => {
    expect(sizeForRole("cover")).toBe("1200x630");
    expect(sizeForRole("body")).toBe("1200x900");
    expect(sizeForRole("library")).toBe("1200x900");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/lib/images/actions-support.test.ts`
Expected: FAIL — cannot resolve `../../../src/lib/images/actions-support`.

- [ ] **Step 3: Implement**

Create `src/lib/images/actions-support.ts`:

```ts
import { slugify } from "@/lib/publishing/slug";

/**
 * Pure helpers behind the image server actions. They live here rather than
 * in the `"use server"` files because those may export only async functions,
 * and these are what the node tests pin.
 */

/** The prompt stored on a render produced by "Describe a change": the
 * previous render's prompt, then the instruction as an `Edit:` line. */
export function editPromptHistory(previous: string, instruction: string): string {
  return `${previous.trimEnd()}\n\nEdit: ${instruction.trim()}`;
}

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

/** Spec §2 alt policy: one sentence, ≤125 chars, meaning not style, no
 * "image of". Written from the concept we authored, never vision-captioned. */
export function altFromConcept(concept: string): string {
  const trimmed = concept.trim();
  if (!trimmed) return "";
  const firstSentence = trimmed.split(/(?<=[.!?])\s+/)[0] ?? trimmed;
  const withoutPrefix = firstSentence.replace(/^(an?\s+)?(image|illustration|picture|photo)\s+of\s+/i, "");
  const capitalised = withoutPrefix.charAt(0).toUpperCase() + withoutPrefix.slice(1);
  const noTrailingStop = capitalised.replace(/[.!?]+$/, "");
  return noTrailingStop.length > 125 ? noTrailingStop.slice(0, 125).trimEnd() : noTrailingStop;
}

const HEADING_LINE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/**
 * The markdown the "Suggest prompt" call reads: the section under
 * `heading` (through the next heading of the same or a higher level), or the
 * head of the document when there is no heading above the caret or it can't
 * be found. Capped at `maxChars` so a long section can't blow the prompt up.
 */
export function sliceAroundHeading(markdown: string, heading: string | null, maxChars = 1500): string {
  const lines = markdown.split("\n");
  const wanted = heading?.trim().toLowerCase() ?? "";
  let start = -1;
  let level = 0;
  if (wanted) {
    for (let i = 0; i < lines.length; i++) {
      const m = HEADING_LINE.exec(lines[i]);
      if (m && m[2].trim().toLowerCase() === wanted) {
        start = i;
        level = m[1].length;
        break;
      }
    }
  }
  if (start === -1) return markdown.slice(0, maxChars).trim();
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = HEADING_LINE.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").slice(0, maxChars).trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Removes every `![alt](url)` whose url is in `urls`. A line that becomes
 * empty is dropped together with one adjacent blank line, so deleting an
 * image doesn't leave a double blank; inline references just vanish.
 */
export function stripImageFromMarkdown(markdown: string, urls: string[]): string {
  if (urls.length === 0) return markdown;
  const alternation = urls.map(escapeRegExp).join("|");
  const inline = new RegExp(`!\\[[^\\]]*\\]\\((?:${alternation})(?:\\s+"[^"]*")?\\)`, "g");
  const lines = markdown.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inline.test(line)) {
      out.push(line);
      inline.lastIndex = 0;
      continue;
    }
    inline.lastIndex = 0;
    const stripped = line.replace(inline, "");
    if (stripped.trim().length > 0) {
      out.push(stripped);
      continue;
    }
    // Whole line was the image: drop it and the blank line that followed it
    // (if any) so the surrounding paragraphs keep a single blank between them.
    if (i + 1 < lines.length && lines[i + 1].trim() === "") i++;
  }
  return out.join("\n");
}

/** Blob pathname slug: short, so the pathname stays readable in the Blob UI. */
export function imageSlug(text: string): string {
  const s = slugify(text).slice(0, 40).replace(/-$/, "");
  return s && s !== "update" ? s : "image";
}

export function sizeForRole(role: "cover" | "body" | "library"): "1200x630" | "1200x900" {
  return role === "cover" ? "1200x630" : "1200x900";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/lib/images/actions-support.test.ts`
Expected: PASS. If `imageSlug("!!!")` fails, note `slugify` returns `"update"` for empty input (`src/lib/publishing/slug.ts:14`) — the helper maps that to `"image"` deliberately.

- [ ] **Step 5: Commit**

```bash
git add src/lib/images/actions-support.ts tests/lib/images/actions-support.test.ts
git commit -m "feat: pure helpers for the image editor actions"
```

---

### Task 2: Suggest a concept from surrounding text — `src/lib/images/suggest.ts`

**Files:**
- Create: `src/lib/images/suggest.ts`
- Test: `tests/lib/images/suggest.test.ts`

**Interfaces:**
- Consumes: `resolveModel`, `modelId` (`src/lib/ai/model.ts:4,18`); `recordLlmUsage` (`src/lib/ai/llm-usage.ts`, operation `"illustration_plan"` added by Plan 1); `generateObject` from `ai`.
- Produces:
  ```ts
  export type ImageSuggestion = { concept: string; altText: string };
  export async function suggestImageConcept(a: {
    tenantId: string; title: string; surroundingMarkdown: string; role: "cover" | "body";
    database?: DbClient;
  }, deps?: { generate?: typeof generateObject }): Promise<ImageSuggestion>;
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/lib/images/suggest.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
const recordLlmUsage = vi.fn(async () => {});
vi.mock("../../../src/lib/ai/llm-usage", () => ({ recordLlmUsage: (...a: unknown[]) => recordLlmUsage(...a) }));

import { generateObject } from "ai";
import { suggestImageConcept } from "../../../src/lib/images/suggest";

describe("suggestImageConcept", () => {
  it("asks the text model for a concept and alt text grounded in the surrounding markdown", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { concept: "A magnifying glass over a grid of documents", altText: "Magnifying glass over documents" },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    } as never);

    const out = await suggestImageConcept({
      tenantId: "t1",
      title: "Faster search",
      surroundingMarkdown: "## Search\n\nSearch returns in under a second.",
      role: "body",
    });

    expect(out).toEqual({
      concept: "A magnifying glass over a grid of documents",
      altText: "Magnifying glass over documents",
    });
    const args = vi.mocked(generateObject).mock.calls.at(-1)![0];
    expect(args.prompt).toContain("Search returns in under a second.");
    expect(args.prompt).toContain("Faster search");
    expect(args.system).toMatch(/no text/i);
    expect(recordLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "t1", operation: "illustration_plan" }),
      expect.anything()
    );
  });

  it("uses an injected generator and says 'cover' composition for covers", async () => {
    const generate = vi.fn(async () => ({
      object: { concept: "c", altText: "a" },
      usage: {},
    })) as never;
    await suggestImageConcept(
      { tenantId: "t1", title: "T", surroundingMarkdown: "body", role: "cover" },
      { generate }
    );
    const args = (generate as ReturnType<typeof vi.fn>).mock.calls[0][0] as { system: string };
    expect(args.system).toMatch(/cover/i);
    expect(vi.mocked(generateObject)).toHaveBeenCalledTimes(1); // from the first test only
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/lib/images/suggest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/images/suggest.ts`:

```ts
import { generateObject } from "ai";
import { z } from "zod";
import { db as defaultDb } from "@/db";
import { resolveModel, modelId } from "@/lib/ai/model";
import { recordLlmUsage } from "@/lib/ai/llm-usage";
import type { DbClient } from "@/lib/publishing/destinations/types";

export type ImageSuggestion = { concept: string; altText: string };

const SuggestionSchema = z.object({
  concept: z.string().min(1),
  altText: z.string().max(125),
});

export function buildSuggestPrompt(a: { title: string; surroundingMarkdown: string; role: "cover" | "body" }) {
  const system = [
    "You propose ONE flat, illustrative marketing graphic for a piece of content.",
    a.role === "cover"
      ? "This is the cover image for the whole piece: one visual metaphor for its main idea, composed for a wide 1.91:1 hero with the subject centered."
      : "This is a body illustration for one section: a single-concept visual metaphor for what that section is about.",
    "Describe WHAT the image shows — subject, metaphor, arrangement — in one to three sentences. Never describe style, colours, or medium; those are fixed by the brand.",
    "The image must contain no text, letters, words, logos or UI screenshots. Do not depict real people or brands.",
    "altText: one sentence, at most 125 characters, describing the meaning (not the style), without the words 'image of'.",
  ].join(" ");
  const prompt = [`Title:\n${a.title}`, "", `Section (markdown):\n${a.surroundingMarkdown}`, "", "Propose the image."].join("\n");
  return { system, prompt };
}

export async function suggestImageConcept(
  a: { tenantId: string; title: string; surroundingMarkdown: string; role: "cover" | "body"; database?: DbClient },
  deps: { generate?: typeof generateObject } = {}
): Promise<ImageSuggestion> {
  const generate = deps.generate ?? generateObject;
  const database = a.database ?? defaultDb;
  const spec = process.env.GENERATION_MODEL ?? "anthropic/claude-sonnet-4-5";
  const { system, prompt } = buildSuggestPrompt(a);

  const result = await generate({ model: resolveModel(spec), schema: SuggestionSchema, system, prompt });

  await recordLlmUsage(
    { tenantId: a.tenantId, operation: "illustration_plan", model: modelId(spec), usage: result.usage },
    database
  );

  return { concept: result.object.concept.trim(), altText: result.object.altText.trim() };
}
```

Check `DbClient` really is exported from `src/lib/publishing/destinations/types.ts` (the brief says so); if `recordLlmUsage`'s second parameter is typed `typeof defaultDb` (it is, `src/lib/ai/llm-usage.ts:37`), pass `database as typeof defaultDb` only if the typecheck complains — Plan 1 may already have widened it.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/lib/images/suggest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/images/suggest.ts tests/lib/images/suggest.test.ts
git commit -m "feat: suggest an image concept from the surrounding section"
```

---

### Task 3: Shared-blob guard in `store.ts` (deleteImage and prune)

Two rows can share one blob after Task 4's `setCoverFromImage` copies a render's blob fields onto a cover row (spec §5b: "reuse inserts the existing blob URL, no new render"). Plan 1's `deleteImage` and `addRender` pruning `del()` every pathname they drop; they must skip a pathname still referenced by another `image_renders` row.

**Files:**
- Modify: `src/lib/images/store.ts` — the `deleteImage` function and the prune branch inside `addRender` (read the file; find both call sites of `deleteBlobs`).
- Test: `tests/lib/images/store-shared-blob.test.ts` (new file, own tenant name — do not edit Plan 1's store test).

**Interfaces:**
- Consumes: `createImage`, `addRender`, `deleteImage`, `imageRenders` table; `deleteBlobs` from `src/lib/images/blob.ts` (mocked).
- Produces: non-exported `async function unreferencedPathnames(pathnames: string[], excludingRenderIds: string[], database): Promise<string[]>` used by both sites. Public signatures unchanged.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/images/store-shared-blob.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants } from "../../../src/db/schema";

const deleteBlobs = vi.fn(async (_p: string[]) => {});
vi.mock("../../../src/lib/images/blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/images/blob")>();
  return { ...actual, deleteBlobs: (p: string[]) => deleteBlobs(p) };
});

import { createImage, addRender, deleteImage } from "../../../src/lib/images/store";

const TENANT = "Store Shared Blob Test Tenant";

async function seedShared() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  const a = await createImage({ tenantId: tenant.id, contentPieceId: null, role: "library", concept: "c", altText: "a", sourceKind: "generated" });
  const b = await createImage({ tenantId: tenant.id, contentPieceId: null, role: "library", concept: "c", altText: "a", sourceKind: "generated" });
  const shared = { prompt: "p", blobUrl: "https://blob/shared.png", blobPathname: "tenants/x/library-shared.png", width: 10, height: 10, bytes: 1, model: "m" };
  await addRender({ imageId: a.id, ...shared });
  await addRender({ imageId: b.id, ...shared });
  return { tenant, a, b };
}

describe("deleteImage with a blob shared by another render", () => {
  afterEach(async () => {
    deleteBlobs.mockClear();
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("does not del() a pathname another image still references, then does once it is the last", async () => {
    const { tenant, a, b } = await seedShared();

    expect(await deleteImage(tenant.id, a.id)).toEqual({ ok: true });
    expect(deleteBlobs).toHaveBeenLastCalledWith([]);

    expect(await deleteImage(tenant.id, b.id)).toEqual({ ok: true });
    expect(deleteBlobs).toHaveBeenLastCalledWith(["tenants/x/library-shared.png"]);
  });
});
```

If Plan 1's `deleteImage` skips calling `deleteBlobs` when the list is empty, change the first assertion to `expect(deleteBlobs.mock.calls.flat(2)).not.toContain("tenants/x/library-shared.png")`. Read the function first.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/lib/images/store-shared-blob.test.ts`
Expected: FAIL — the first `deleteImage` deletes the shared pathname.

- [ ] **Step 3: Add the guard**

In `src/lib/images/store.ts`, add (near the other private helpers):

```ts
import { and, inArray, notInArray } from "drizzle-orm"; // merge with the existing drizzle import line

/**
 * Two rows may point at one blob (a cover set "from library" copies the
 * chosen render's blob fields — spec §5b, no new render). Only del() a
 * pathname when no OTHER render row still references it.
 */
async function unreferencedPathnames(
  pathnames: string[],
  excludingRenderIds: string[],
  database: DbClient
): Promise<string[]> {
  if (pathnames.length === 0) return [];
  const stillUsed = await database
    .select({ blobPathname: imageRenders.blobPathname })
    .from(imageRenders)
    .where(
      excludingRenderIds.length > 0
        ? and(inArray(imageRenders.blobPathname, pathnames), notInArray(imageRenders.id, excludingRenderIds))
        : inArray(imageRenders.blobPathname, pathnames)
    );
  const used = new Set(stillUsed.map((r) => r.blobPathname));
  return pathnames.filter((p) => !used.has(p));
}
```

Then, in `deleteImage`, where it collects the image's renders and calls `deleteBlobs(pathnames)`: compute `const pathnames = await unreferencedPathnames(renders.map((r) => r.blobPathname), renders.map((r) => r.id), database);` **before** deleting the rows (the query needs the other rows present, and its own rows excluded by id), then delete rows, then `await deleteBlobs(pathnames)`. In `addRender`'s prune branch do the same with the pruned renders' pathnames/ids before deleting them.

- [ ] **Step 4: Run both this test and Plan 1's store test**

Run: `npx vitest run tests/lib/images/store-shared-blob.test.ts tests/lib/images/store.test.ts` (adjust the second path to Plan 1's actual store test file — `ls tests/lib/images/`).
Expected: PASS for both.

- [ ] **Step 5: Commit**

```bash
git add src/lib/images/store.ts tests/lib/images/store-shared-blob.test.ts
git commit -m "fix: never delete a blob another render still references"
```

---

### Task 4: Render pipeline helper + draft image server actions

**Files:**
- Create: `src/lib/images/generate.ts` (render → compress → upload → `addRender`, deps-injectable)
- Create: `src/app/(dashboard)/drafts/[releaseId]/image-actions.ts` (`"use server"`)
- Test: `tests/lib/images/generate.test.ts`, `tests/app/drafts/image-actions.test.ts`

**Interfaces:**
- Consumes (read before writing — names verified against Plan 1/2 as merged):
  - `renderImage(args, deps = {})` → raw PNG `Buffer` (`src/lib/ai/images.ts`; `editOf` makes `prompt` the instruction; `referenceImages` are ignored when `editOf` is set).
  - `compressPng(input, maxWidth)` (`src/lib/images/compress.ts` — `sharp(input)` autodetects PNG/JPEG/WebP input, so uploads go through it unchanged).
  - `imagePathname`, `uploadPng` (`src/lib/images/blob.ts`).
  - `createImage`, `addRender(a, database = db, deps = {})`, `setCurrentRender`, `getImage`, `getCoverImage`, `deleteImage(tenantId, imageId, database = db, deps = {})`, `findImageByRenderUrl` (`src/lib/images/store.ts`).
  - `imageModelId`, `IMAGE_MODEL_DEFAULT` (`src/lib/ai/image-model.ts`).
  - `getOrCreateCompanyProfile(tenantId, database?)` (`src/lib/workspace/company-profile.ts:5-8`); `compileStyleBlock`, `isVisualIdentityReady` (`src/lib/images/visual-identity.ts`); `buildImagePrompt` (`src/lib/images/prompt.ts`).
  - `suggestImageConcept` (Task 2); `editPromptHistory`, `validateUploadFile`, `altFromConcept`, `sliceAroundHeading`, `imageSlug`, `sizeForRole` (Task 1).
  - `requireSession` (`src/lib/workspace/session.ts:18`, `session.user.tenantId` / `session.user.id`); `assertDraftEditable` (`src/lib/draft-editable.ts`); the `loadOwnedDraft` shape from `drafts/[releaseId]/actions.ts:17-24` (copied, same as that file copies it — its comment at lines 14-16 says why sibling routes don't share it).
  - `DbClient` from `src/lib/publishing/destinations/types.ts:11`.
- Produces:
  ```ts
  // src/lib/images/generate.ts
  export type GenerateDeps = { renderImage?: typeof renderImage; compressPng?: typeof compressPng; uploadPng?: typeof uploadPng };
  export const RENDER_MAX_WIDTH = 1200;
  export async function storeRenderBytes(a: {
    tenantId: string; imageId: string; contentPieceId: string | null; role: ImageRole; slug: string;
    png: Buffer; prompt: string; model: string; database?: DbClient;
  }, deps?: GenerateDeps): Promise<ImageRender>;
  export async function renderAndStore(a: {
    tenantId: string; imageId: string; contentPieceId: string | null; role: ImageRole; slug: string;
    prompt: string; size: "1200x630" | "1200x900"; referenceImages?: (string | Buffer)[]; editOf?: string | Buffer;
    storedPrompt?: string; database?: DbClient;
  }, deps?: GenerateDeps): Promise<ImageRender>;
  export function markdownImage(alt: string, url: string): string;   // `![alt](url)`, brackets stripped from alt

  // src/app/(dashboard)/drafts/[releaseId]/image-actions.ts — contract signatures, plus:
  export async function suggestImagePrompt(a: { contentPieceId: string; surroundingMarkdown: string; heading?: string | null; role?: "cover" | "body" }): Promise<{ prompt: string; concept: string; altText: string }>;
  export type ImageLookup = { imageId: string; role: ImageRole; sourceKind: ImageSourceKind; contentPieceId: string | null; currentRenderId: string | null; currentPrompt: string; renders: { id: string; url: string; prompt: string; createdAt: string }[] };
  export async function lookupImageBySrc(src: string): Promise<ImageLookup | null>;
  export async function setCoverFromImage(a: { contentPieceId: string; imageId: string }): Promise<{ ok: true; url: string } | { ok: false; error: string }>;
  ```
  Contract deviations, both additive: `suggestImagePrompt` takes an optional `heading` (the client can read the nearest heading above the caret from the DOM — Task 6 — while MDXEditor exposes no markdown offset for the caret) and optional `role`; `lookupImageBySrc` returns the render history too, so the editor's toolbar needs one round trip.

Semantics to hold (spec §5):
- The user-facing prompt is a concept; the server wraps it with `buildImagePrompt`. `regenerateImage` mode `"prompt"` sends the given full prompt verbatim; mode `"edit"` renders `editOf: current.blobUrl` with the instruction and stores `editPromptHistory(current.prompt, instruction)`.
- Body-image references: `vi.styleReferenceImages`, plus the piece's current cover URL when `vi.pinStyleToCover` (mirrors Plan 2's `illustratePiece`). Cover references: `vi.styleReferenceImages` only.
- **`regenerateImage` and `restoreRender` also swap the URL in the stored piece body server-side** (plain string replace of the old current URL, no `bodyEditedAt` stamp — a generation path, same discipline as `linkedin-actions.ts:45-47`). The editor still does `replaceImageSrc` + `saveDraftBody` on top (Task 7), which then sees an unchanged body; the server-side swap is what keeps the §5b library's edit actions correct for images that sit in a draft. Judgement call — recorded in Self-review.
- A render that fails for a row created by the same action deletes that row (`deleteImage`; it has no blobs yet) — the panel still holds the prompt, so nothing is lost and the library gets no orphan `failed` rows. Regeneration failures leave the row and its history untouched.
- Every action returns `{ ok: false, error }` for expected failures (no identity, bad upload, missing image) and lets `requireSession`/`assertDraftEditable` throw as the rest of the route does.

- [ ] **Step 1: Write the failing test for the pipeline helper**

Create `tests/lib/images/generate.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, imageRenders } from "../../../src/db/schema";
import { createImage, getImage } from "../../../src/lib/images/store";
import { renderAndStore, storeRenderBytes, markdownImage } from "../../../src/lib/images/generate";

const TENANT = "Generate Helper Test Tenant";

async function seed() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  const image = await createImage({
    tenantId: tenant.id,
    contentPieceId: null,
    role: "library",
    concept: "a rocket",
    altText: "A rocket",
    sourceKind: "generated",
  });
  return { tenant, image };
}

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
});

describe("renderAndStore", () => {
  it("renders, compresses, uploads under the role pathname and records the render as current", async () => {
    const { tenant, image } = await seed();
    const renderImage = vi.fn(async () => Buffer.from("RAW"));
    const compressPng = vi.fn(async (png: Buffer, maxWidth: number) => ({ png: Buffer.concat([png, Buffer.from("!")]), width: maxWidth, height: 900 }));
    const uploadPng = vi.fn(async (pathname: string) => ({ url: `https://blob.example/${pathname}-abc`, pathname: `${pathname}-abc` }));

    const render = await renderAndStore(
      {
        tenantId: tenant.id,
        imageId: image.id,
        contentPieceId: null,
        role: "library",
        slug: "a-rocket",
        prompt: "FULL PROMPT",
        size: "1200x900",
        referenceImages: ["https://blob.example/ref.png"],
      },
      { renderImage, compressPng, uploadPng }
    );

    expect(renderImage.mock.calls[0][0]).toMatchObject({ tenantId: tenant.id, prompt: "FULL PROMPT", size: "1200x900", referenceImages: ["https://blob.example/ref.png"] });
    expect(compressPng).toHaveBeenCalledWith(Buffer.from("RAW"), 1200);
    expect(uploadPng.mock.calls[0][0]).toBe(`tenants/${tenant.id}/content/library/library-a-rocket.png`);
    expect(render).toMatchObject({ imageId: image.id, prompt: "FULL PROMPT", width: 1200, height: 900, bytes: 4 });
    expect(render.blobUrl).toBe(`https://blob.example/tenants/${tenant.id}/content/library/library-a-rocket.png-abc`);

    const stored = await getImage(tenant.id, image.id);
    expect(stored?.currentRenderId).toBe(render.id);
    expect(stored?.status).toBe("ready");
  });

  it("stores `storedPrompt` (the edit history) rather than the instruction it sent, and passes editOf through", async () => {
    const { tenant, image } = await seed();
    const renderImage = vi.fn(async () => Buffer.from("RAW"));
    const render = await renderAndStore(
      {
        tenantId: tenant.id,
        imageId: image.id,
        contentPieceId: null,
        role: "library",
        slug: "a-rocket",
        prompt: "make it darker",
        storedPrompt: "FULL PROMPT\n\nEdit: make it darker",
        size: "1200x900",
        editOf: "https://blob.example/current.png",
      },
      {
        renderImage,
        compressPng: async (png) => ({ png, width: 1, height: 1 }),
        uploadPng: async (pathname) => ({ url: `https://blob.example/${pathname}`, pathname }),
      }
    );
    expect(renderImage.mock.calls[0][0]).toMatchObject({ prompt: "make it darker", editOf: "https://blob.example/current.png" });
    expect(render.prompt).toBe("FULL PROMPT\n\nEdit: make it darker");
  });
});

describe("storeRenderBytes", () => {
  it("skips the model: compresses the given bytes, uploads, and records prompt/model as given", async () => {
    const { tenant, image } = await seed();
    const uploadPng = vi.fn(async (pathname: string) => ({ url: `https://blob.example/${pathname}`, pathname }));
    const render = await storeRenderBytes(
      { tenantId: tenant.id, imageId: image.id, contentPieceId: null, role: "library", slug: "upload", png: Buffer.from("JPEGBYTES"), prompt: "", model: "upload" },
      { compressPng: async (png) => ({ png, width: 640, height: 480 }), uploadPng }
    );
    expect(render).toMatchObject({ prompt: "", model: "upload", width: 640, height: 480 });
    const [row] = await db.select().from(imageRenders).where(eq(imageRenders.id, render.id));
    expect(row.blobPathname).toBe(`tenants/${tenant.id}/content/library/library-upload.png`);
  });
});

describe("markdownImage", () => {
  it("writes the image line and strips brackets from the alt so the markdown stays parseable", () => {
    expect(markdownImage("A [bold] rocket", "https://x/a.png")).toBe("![A bold rocket](https://x/a.png)");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/lib/images/generate.test.ts`
Expected: FAIL — cannot resolve `../../../src/lib/images/generate`.

- [ ] **Step 3: Implement the helper**

Create `src/lib/images/generate.ts`:

```ts
import { db } from "@/db";
import type { ImageRender, ImageRole } from "@/db/schema";
import type { DbClient } from "@/lib/publishing/destinations/types";
import { renderImage as defaultRenderImage } from "@/lib/ai/images";
import { IMAGE_MODEL_DEFAULT, imageModelId } from "@/lib/ai/image-model";
import { compressPng as defaultCompressPng } from "@/lib/images/compress";
import { imagePathname, uploadPng as defaultUploadPng } from "@/lib/images/blob";
import { addRender } from "@/lib/images/store";

/**
 * The one path every editor / cover / library render takes after a row
 * exists: model → compress (spec §7, mandatory before put()) → Blob →
 * `addRender` (which makes it current and prunes history). Plan 2's
 * `illustratePiece` inlines the same sequence for the agent; this is the
 * shared version for user-initiated renders. Deps are injectable so the
 * node tests never touch the model or Blob.
 */
export type GenerateDeps = {
  renderImage?: typeof defaultRenderImage;
  compressPng?: typeof defaultCompressPng;
  uploadPng?: typeof defaultUploadPng;
};

/** Both cover (1200x630) and body (1200x900) masters are 1200 px wide (spec §7). */
export const RENDER_MAX_WIDTH = 1200;

export async function storeRenderBytes(
  a: {
    tenantId: string;
    imageId: string;
    contentPieceId: string | null;
    role: ImageRole;
    slug: string;
    /** Bytes in any sharp-readable format; compressed to PNG here. */
    png: Buffer;
    prompt: string;
    model: string;
    database?: DbClient;
  },
  deps: GenerateDeps = {}
): Promise<ImageRender> {
  const compress = deps.compressPng ?? defaultCompressPng;
  const upload = deps.uploadPng ?? defaultUploadPng;
  const database = a.database ?? db;

  const { png, width, height } = await compress(a.png, RENDER_MAX_WIDTH);
  const { url, pathname } = await upload(
    imagePathname({ tenantId: a.tenantId, contentPieceId: a.contentPieceId, role: a.role, slug: a.slug }),
    png
  );
  return addRender(
    { imageId: a.imageId, prompt: a.prompt, blobUrl: url, blobPathname: pathname, width, height, bytes: png.byteLength, model: a.model },
    database
  );
}

export async function renderAndStore(
  a: {
    tenantId: string;
    imageId: string;
    contentPieceId: string | null;
    role: ImageRole;
    slug: string;
    /** What the model receives: the full prompt, or the instruction when `editOf` is set. */
    prompt: string;
    size: "1200x630" | "1200x900";
    referenceImages?: (string | Buffer)[];
    editOf?: string | Buffer;
    /** What the render row records; defaults to `prompt`. Edits store the history line. */
    storedPrompt?: string;
    database?: DbClient;
  },
  deps: GenerateDeps = {}
): Promise<ImageRender> {
  const render = deps.renderImage ?? defaultRenderImage;
  const raw = await render({
    tenantId: a.tenantId,
    prompt: a.prompt,
    size: a.size,
    referenceImages: a.referenceImages,
    editOf: a.editOf,
    database: a.database,
  });
  return storeRenderBytes(
    {
      tenantId: a.tenantId,
      imageId: a.imageId,
      contentPieceId: a.contentPieceId,
      role: a.role,
      slug: a.slug,
      png: raw,
      prompt: a.storedPrompt ?? a.prompt,
      model: imageModelId(process.env.IMAGE_MODEL ?? IMAGE_MODEL_DEFAULT),
      database: a.database,
    },
    deps
  );
}

/** The body line for an image (spec §3: images join the markdown by blob URL). */
export function markdownImage(alt: string, url: string): string {
  return `![${alt.replace(/[[\]]/g, "").trim()}](${url})`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/lib/images/generate.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the actions**

Create `tests/app/drafts/image-actions.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, users, contentPieces, companyProfiles, contentImages, imageRenders, type VisualIdentity } from "../../../src/db/schema";
import { DEFAULT_VISUAL_IDENTITY } from "../../../src/lib/images/visual-identity";
import { createImage, addRender, getImage, getCoverImage } from "../../../src/lib/images/store";

const TENANT_NAME = "Image Actions Test Tenant";
const USER_EMAIL = "image-actions-test@example.com";
let currentTenantId = "";
let currentUserId: string | null = null;

vi.mock("../../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: currentUserId } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const renderImage = vi.fn(async (_args: { prompt: string; editOf?: unknown; referenceImages?: unknown }) => Buffer.from("PNG"));
vi.mock("../../../src/lib/ai/images", () => ({
  renderImage: (a: { prompt: string; editOf?: unknown; referenceImages?: unknown }) => renderImage(a),
}));
vi.mock("../../../src/lib/images/compress", () => ({
  compressPng: vi.fn(async (png: Buffer, maxWidth: number) => ({ png, width: maxWidth, height: 900 })),
}));
let uploadCount = 0;
vi.mock("../../../src/lib/images/blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/images/blob")>();
  return {
    ...actual,
    uploadPng: vi.fn(async (pathname: string) => {
      uploadCount += 1;
      return { url: `https://blob.example/${pathname}-${uploadCount}`, pathname: `${pathname}-${uploadCount}` };
    }),
    deleteBlobs: vi.fn(async () => {}),
  };
});
const suggestImageConcept = vi.fn(async () => ({ concept: "A rocket over a laptop", altText: "Rocket over a laptop" }));
vi.mock("../../../src/lib/images/suggest", () => ({
  suggestImageConcept: (...a: unknown[]) => suggestImageConcept(...(a as [])),
}));

import {
  generateBodyImage,
  suggestImagePrompt,
  regenerateImage,
  restoreRender,
  generateCover,
  removeCover,
  uploadImageFile,
  lookupImageBySrc,
  setCoverFromImage,
} from "../../../src/app/(dashboard)/drafts/[releaseId]/image-actions";

const VI: VisualIdentity = {
  ...DEFAULT_VISUAL_IDENTITY,
  palette: [
    { hex: "#112233", role: "primary" },
    { hex: "#445566", role: "secondary" },
    { hex: "#ffffff", role: "background" },
  ],
  styleReferenceImages: ["https://blob.example/ref.png"],
  pinStyleToCover: true,
};

async function seed(opts: { identity?: VisualIdentity | null; body?: string } = {}) {
  const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
  const [user] = await db.insert(users).values({ email: USER_EMAIL }).returning();
  currentTenantId = tenant.id;
  currentUserId = user.id;
  await db.insert(companyProfiles).values({
    tenantId: tenant.id,
    topics: [],
    visualIdentity: opts.identity === undefined ? VI : opts.identity,
  });
  const [piece] = await db
    .insert(contentPieces)
    .values({ tenantId: tenant.id, type: "blog_post", title: "Faster search", body: opts.body ?? "# Faster search\n\n## Search\n\nText.", status: "draft" })
    .returning();
  return { tenant, piece };
}

async function seedGeneratedBodyImage(tenantId: string, pieceId: string) {
  const image = await createImage({ tenantId, contentPieceId: pieceId, role: "body", concept: "gears", altText: "Gears", sourceKind: "generated" });
  const render = await addRender({ imageId: image.id, prompt: "FULL PROMPT", blobUrl: "https://blob.example/gears-1.png", blobPathname: "p/gears-1.png", width: 1200, height: 900, bytes: 10, model: "m" });
  return { image, render };
}

afterEach(async () => {
  renderImage.mockClear();
  suggestImageConcept.mockClear();
  uploadCount = 0;
  await db.delete(tenants).where(eq(tenants.name, TENANT_NAME));
  await db.delete(users).where(eq(users.email, USER_EMAIL));
});

describe("generateBodyImage", () => {
  it("creates a body row, renders with the compiled style + brand refs, and returns the markdown line", async () => {
    const { tenant, piece } = await seed();
    const result = await generateBodyImage({ contentPieceId: piece.id, prompt: "A rocket launching from a laptop." });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown).toMatch(/^!\[A rocket launching from a laptop\]\(https:\/\/blob\.example\/tenants\/.+\/body-a-rocket-launching-from-a-laptop\.png-1\)$/);
    const sent = renderImage.mock.calls[0][0];
    expect(sent.prompt).toContain("A rocket launching from a laptop.");
    expect(sent.prompt).toMatch(/No text, letters, words, logos or watermarks/);
    expect(sent.referenceImages).toEqual(["https://blob.example/ref.png"]);
    const row = await getImage(tenant.id, result.imageId);
    expect(row).toMatchObject({ role: "body", sourceKind: "generated", status: "ready", contentPieceId: piece.id });
  });

  it("refuses without a ready visual identity and creates no row", async () => {
    const { tenant, piece } = await seed({ identity: null });
    const result = await generateBodyImage({ contentPieceId: piece.id, prompt: "x" });
    expect(result).toEqual({ ok: false, error: "Set up your visual identity in Company settings before generating images." });
    expect(await db.select().from(contentImages).where(eq(contentImages.tenantId, tenant.id))).toHaveLength(0);
  });

  it("deletes the just-created row when the render fails, and reports the error", async () => {
    const { tenant, piece } = await seed();
    renderImage.mockRejectedValueOnce(new Error("model down"));
    const result = await generateBodyImage({ contentPieceId: piece.id, prompt: "x" });
    expect(result).toEqual({ ok: false, error: "model down" });
    expect(await db.select().from(contentImages).where(eq(contentImages.tenantId, tenant.id))).toHaveLength(0);
  });

  it("refuses a published piece", async () => {
    const { piece } = await seed();
    await db.update(contentPieces).set({ status: "published", publishedAt: new Date() }).where(eq(contentPieces.id, piece.id));
    await expect(generateBodyImage({ contentPieceId: piece.id, prompt: "x" })).rejects.toThrow(/already been published/);
  });
});

describe("suggestImagePrompt", () => {
  it("slices the body around the given heading and returns concept + compiled prompt + alt", async () => {
    const { piece } = await seed({ body: "# T\n\nIntro.\n\n## Search\n\nSearch is faster.\n\n## Billing\n\nBilling moved." });
    const out = await suggestImagePrompt({ contentPieceId: piece.id, surroundingMarkdown: "# T\n\nIntro.\n\n## Search\n\nSearch is faster.\n\n## Billing\n\nBilling moved.", heading: "Search" });
    const args = suggestImageConcept.mock.calls[0][0] as unknown as { surroundingMarkdown: string; role: string; title: string };
    expect(args.surroundingMarkdown).toContain("Search is faster.");
    expect(args.surroundingMarkdown).not.toContain("Billing moved.");
    expect(args.role).toBe("body");
    expect(args.title).toBe("Faster search");
    expect(out.concept).toBe("A rocket over a laptop");
    expect(out.altText).toBe("Rocket over a laptop");
    expect(out.prompt).toContain("A rocket over a laptop");
  });
});

describe("regenerateImage", () => {
  it("mode same: new render with the stored prompt, and the draft body's URL is swapped", async () => {
    const { tenant, piece } = await seed({ body: "## A\n\n![Gears](https://blob.example/gears-1.png)\n\nText." });
    const { image } = await seedGeneratedBodyImage(tenant.id, piece.id);
    const result = await regenerateImage({ imageId: image.id, mode: "same" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(renderImage.mock.calls[0][0]).toMatchObject({ prompt: "FULL PROMPT" });
    const after = await getImage(tenant.id, image.id);
    expect(after?.renders).toHaveLength(2);
    expect(after?.currentRenderId).toBe(result.renderId);
    const [row] = await db.select({ body: contentPieces.body, bodyEditedAt: contentPieces.bodyEditedAt }).from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(row.body).toContain(`![Gears](${result.url})`);
    expect(row.body).not.toContain("gears-1.png");
    expect(row.bodyEditedAt).toBeNull();
  });

  it("mode edit: sends the instruction against the current render and stores the history line", async () => {
    const { tenant, piece } = await seed();
    const { image } = await seedGeneratedBodyImage(tenant.id, piece.id);
    const result = await regenerateImage({ imageId: image.id, mode: "edit", instruction: "make it darker" });
    expect(result.ok).toBe(true);
    expect(renderImage.mock.calls[0][0]).toMatchObject({ prompt: "make it darker", editOf: "https://blob.example/gears-1.png" });
    const after = await getImage(tenant.id, image.id);
    expect(after?.current?.prompt).toBe("FULL PROMPT\n\nEdit: make it darker");
  });

  it("mode prompt: sends the given prompt verbatim", async () => {
    const { tenant, piece } = await seed();
    const { image } = await seedGeneratedBodyImage(tenant.id, piece.id);
    await regenerateImage({ imageId: image.id, mode: "prompt", prompt: "VERBATIM" });
    expect(renderImage.mock.calls[0][0]).toMatchObject({ prompt: "VERBATIM" });
  });

  it("returns not-found for another tenant's image", async () => {
    await seed();
    const [other] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
    const foreign = await createImage({ tenantId: other.id, contentPieceId: null, role: "library", concept: "c", altText: "a", sourceKind: "generated" });
    await addRender({ imageId: foreign.id, prompt: "p", blobUrl: "https://blob.example/f.png", blobPathname: "f", width: 1, height: 1, bytes: 1, model: "m" });
    expect(await regenerateImage({ imageId: foreign.id, mode: "same" })).toEqual({ ok: false, error: "Image not found." });
  });
});

describe("restoreRender", () => {
  it("makes an older render current and swaps the URL in the body", async () => {
    const { tenant, piece } = await seed({ body: "![Gears](https://blob.example/gears-2.png)" });
    const { image, render: first } = await seedGeneratedBodyImage(tenant.id, piece.id);
    await addRender({ imageId: image.id, prompt: "FULL PROMPT", blobUrl: "https://blob.example/gears-2.png", blobPathname: "p/gears-2.png", width: 1200, height: 900, bytes: 10, model: "m" });
    const result = await restoreRender({ imageId: image.id, renderId: first.id });
    expect(result).toEqual({ ok: true, url: "https://blob.example/gears-1.png" });
    const after = await getImage(tenant.id, image.id);
    expect(after?.currentRenderId).toBe(first.id);
    const [row] = await db.select({ body: contentPieces.body }).from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(row.body).toBe("![Gears](https://blob.example/gears-1.png)");
  });
});

describe("generateCover / removeCover / setCoverFromImage", () => {
  it("from_post asks the text model for a cover concept and creates the cover row at 1200x630", async () => {
    const { tenant, piece } = await seed();
    const result = await generateCover({ contentPieceId: piece.id, mode: "from_post" });
    expect(result.ok).toBe(true);
    const args = suggestImageConcept.mock.calls[0][0] as unknown as { role: string };
    expect(args.role).toBe("cover");
    expect(renderImage.mock.calls[0][0]).toMatchObject({ size: "1200x630", referenceImages: ["https://blob.example/ref.png"] });
    const cover = await getCoverImage(tenant.id, piece.id);
    expect(cover).toMatchObject({ role: "cover", concept: "A rocket over a laptop", sourceKind: "generated" });
  });

  it("prompt mode on an existing generated cover adds a render to the SAME row (history survives)", async () => {
    const { tenant, piece } = await seed();
    await generateCover({ contentPieceId: piece.id, mode: "prompt", prompt: "first" });
    const before = await getCoverImage(tenant.id, piece.id);
    await generateCover({ contentPieceId: piece.id, mode: "prompt", prompt: "second concept" });
    const after = await getImage(tenant.id, before!.id);
    expect(after?.renders).toHaveLength(2);
    expect(after?.concept).toBe("second concept");
  });

  it("removeCover deletes the cover row", async () => {
    const { tenant, piece } = await seed();
    await generateCover({ contentPieceId: piece.id, mode: "prompt", prompt: "first" });
    await removeCover({ contentPieceId: piece.id });
    expect(await getCoverImage(tenant.id, piece.id)).toBeNull();
  });

  it("setCoverFromImage copies the chosen render's blob fields into a new cover row without uploading", async () => {
    const { tenant, piece } = await seed();
    const { image } = await seedGeneratedBodyImage(tenant.id, piece.id);
    const result = await setCoverFromImage({ contentPieceId: piece.id, imageId: image.id });
    expect(result).toEqual({ ok: true, url: "https://blob.example/gears-1.png" });
    expect(uploadCount).toBe(0);
    const cover = await getCoverImage(tenant.id, piece.id);
    expect(cover?.current?.blobPathname).toBe("p/gears-1.png");
    expect(cover?.id).not.toBe(image.id);
    // Both rows point at one blob; the render count is 1 + 1.
    expect(await db.select().from(imageRenders).where(eq(imageRenders.blobPathname, "p/gears-1.png"))).toHaveLength(2);
  });
});

describe("uploadImageFile", () => {
  function form(fields: Record<string, string>, file: File) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    fd.set("file", file);
    return fd;
  }

  it("rejects an unsupported mime type before touching the database", async () => {
    const { tenant, piece } = await seed();
    const result = await uploadImageFile(form({ contentPieceId: piece.id, role: "body" }, new File([Buffer.from("GIF")], "a.gif", { type: "image/gif" })));
    expect(result).toEqual({ ok: false, error: "Only PNG, JPEG or WebP images can be uploaded." });
    expect(await db.select().from(contentImages).where(eq(contentImages.tenantId, tenant.id))).toHaveLength(0);
  });

  it("stores an uploaded body image with prompt '' and model 'upload'", async () => {
    const { tenant, piece } = await seed();
    const result = await uploadImageFile(form({ contentPieceId: piece.id, role: "body" }, new File([Buffer.from("JPEG")], "photo.jpg", { type: "image/jpeg" })));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = await getImage(tenant.id, result.imageId);
    expect(row).toMatchObject({ sourceKind: "uploaded", role: "body", status: "ready" });
    expect(row?.current).toMatchObject({ prompt: "", model: "upload" });
    expect(renderImage).not.toHaveBeenCalled();
  });

  it("an uploaded cover replaces the existing cover row", async () => {
    const { tenant, piece } = await seed();
    await generateCover({ contentPieceId: piece.id, mode: "prompt", prompt: "first" });
    const result = await uploadImageFile(form({ contentPieceId: piece.id, role: "cover" }, new File([Buffer.from("PNG")], "c.png", { type: "image/png" })));
    expect(result.ok).toBe(true);
    const cover = await getCoverImage(tenant.id, piece.id);
    expect(cover?.sourceKind).toBe("uploaded");
    expect(await db.select().from(contentImages).where(eq(contentImages.tenantId, tenant.id))).toHaveLength(1);
  });
});

describe("lookupImageBySrc", () => {
  it("maps a render URL to its row and history; unknown URLs return null", async () => {
    const { tenant, piece } = await seed();
    const { image, render } = await seedGeneratedBodyImage(tenant.id, piece.id);
    const found = await lookupImageBySrc("https://blob.example/gears-1.png");
    expect(found).toMatchObject({ imageId: image.id, sourceKind: "generated", currentRenderId: render.id, currentPrompt: "FULL PROMPT" });
    expect(found?.renders.map((r) => r.url)).toEqual(["https://blob.example/gears-1.png"]);
    expect(await lookupImageBySrc("https://blob.example/nope.png")).toBeNull();
  });
});
```

`companyProfiles` requires `topics` (`src/db/schema.ts:254`, `.notNull().default([])`) — the insert passes `[]` explicitly, matching Plan 2's test seed. Confirm `contentPieces` has `bodyEditedAt` (it does — `saveDraftBody` writes it, `actions.ts:117`).

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run tests/app/drafts/image-actions.test.ts`
Expected: FAIL — cannot resolve `image-actions`.

- [ ] **Step 7: Implement the actions**

Create `src/app/(dashboard)/drafts/[releaseId]/image-actions.ts`:

```ts
"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { contentImages, contentPieces, type ImageRole, type ImageSourceKind, type VisualIdentity } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { assertDraftEditable } from "@/lib/draft-editable";
import { getOrCreateCompanyProfile } from "@/lib/workspace/company-profile";
import { compileStyleBlock, isVisualIdentityReady } from "@/lib/images/visual-identity";
import { buildImagePrompt } from "@/lib/images/prompt";
import { suggestImageConcept } from "@/lib/images/suggest";
import { markdownImage, renderAndStore, storeRenderBytes } from "@/lib/images/generate";
import {
  addRender,
  createImage,
  deleteImage,
  findImageByRenderUrl,
  getCoverImage,
  getImage,
  setCurrentRender,
} from "@/lib/images/store";
import {
  altFromConcept,
  editPromptHistory,
  imageSlug,
  sizeForRole,
  sliceAroundHeading,
  validateUploadFile,
} from "@/lib/images/actions-support";

const NO_IDENTITY = "Set up your visual identity in Company settings before generating images.";
const NOT_FOUND = "Image not found.";

// Same tenant-checked load as `actions.ts:17-24` in this directory — a
// separate copy for the same reason that file gives: no reaching into a
// sibling module's private helper.
async function loadOwnedDraft(tenantId: string, contentPieceId: string) {
  const [piece] = await db
    .select()
    .from(contentPieces)
    .where(and(eq(contentPieces.id, contentPieceId), eq(contentPieces.tenantId, tenantId)));
  if (!piece) throw new Error("Update not found for this tenant");
  return piece;
}

/** Style is brand-level (spec §5): every generation needs a ready identity. */
async function loadStyle(
  tenantId: string
): Promise<{ ok: true; vi: VisualIdentity; styleBlock: string } | { ok: false; error: string }> {
  const profile = await getOrCreateCompanyProfile(tenantId);
  const vi = profile.visualIdentity;
  if (!vi || !isVisualIdentityReady(vi)) return { ok: false, error: NO_IDENTITY };
  return { ok: true, vi, styleBlock: compileStyleBlock(vi) };
}

/** Brand refs, plus the piece's cover when the identity pins body style to it (as Plan 2's agent does). */
async function bodyReferences(tenantId: string, contentPieceId: string | null, vi: VisualIdentity): Promise<string[]> {
  const refs = [...vi.styleReferenceImages];
  if (vi.pinStyleToCover && contentPieceId) {
    const cover = await getCoverImage(tenantId, contentPieceId);
    if (cover?.current) refs.push(cover.current.blobUrl);
  }
  return refs;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

/**
 * A generation path, not a hand edit: swaps one render URL for another in the
 * stored body without stamping `bodyEditedAt` (same discipline as
 * `linkedin-actions.ts:45-47`). No-op when the URL isn't in the body.
 */
async function swapUrlInBody(contentPieceId: string, oldUrl: string, newUrl: string): Promise<void> {
  const [piece] = await db.select({ body: contentPieces.body }).from(contentPieces).where(eq(contentPieces.id, contentPieceId));
  if (!piece || !piece.body.includes(oldUrl)) return;
  await db
    .update(contentPieces)
    .set({ body: piece.body.split(oldUrl).join(newUrl) })
    .where(eq(contentPieces.id, contentPieceId));
}

/** Tenant-scoped image load; when the image belongs to a piece, that piece must be editable. */
async function loadOwnedImage(tenantId: string, imageId: string) {
  const image = await getImage(tenantId, imageId);
  if (!image) return null;
  if (image.contentPieceId) assertDraftEditable(await loadOwnedDraft(tenantId, image.contentPieceId));
  return image;
}

export async function generateBodyImage(a: {
  contentPieceId: string;
  prompt: string;
  concept?: string;
}): Promise<{ ok: true; markdown: string; imageId: string } | { ok: false; error: string }> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const piece = await loadOwnedDraft(tenantId, a.contentPieceId);
  // Before the render, not after: a stale tab must not pay for an image
  // `saveDraftBody` will then refuse to persist (mirrors actions.ts:74-76).
  assertDraftEditable(piece);

  const concept = (a.concept ?? a.prompt).trim();
  if (!concept) return { ok: false, error: "Describe what the image should show." };
  const style = await loadStyle(tenantId);
  if (!style.ok) return style;

  const altText = altFromConcept(concept);
  const image = await createImage({ tenantId, contentPieceId: piece.id, role: "body", concept, altText, sourceKind: "generated" });
  try {
    const render = await renderAndStore({
      tenantId,
      imageId: image.id,
      contentPieceId: piece.id,
      role: "body",
      slug: imageSlug(concept),
      prompt: buildImagePrompt({ styleBlock: style.styleBlock, concept, role: "body", allowText: style.vi.allowTextInImages }),
      size: sizeForRole("body"),
      referenceImages: await bodyReferences(tenantId, piece.id, style.vi),
    });
    revalidatePath(`/drafts/${piece.id}`);
    return { ok: true, markdown: markdownImage(altText, render.blobUrl), imageId: image.id };
  } catch (error) {
    // The panel still holds the prompt; a rowless failure leaves nothing to
    // retry from the library, so don't keep an orphan `failed` row.
    await deleteImage(tenantId, image.id);
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * "Suggest prompt": drafts a concept from the section under the caret. The
 * client sends the whole live body plus the nearest heading above the caret
 * (MDXEditor exposes no markdown offset for the caret, so the slice happens
 * here); with no heading the head of the document is used. Read-only — no
 * `assertDraftEditable`. `prompt` is the compiled prompt the concept would be
 * sent as (empty style block if the identity isn't ready yet), for display.
 */
export async function suggestImagePrompt(a: {
  contentPieceId: string;
  surroundingMarkdown: string;
  heading?: string | null;
  role?: "cover" | "body";
}): Promise<{ prompt: string; concept: string; altText: string }> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const piece = await loadOwnedDraft(tenantId, a.contentPieceId);
  const role = a.role ?? "body";
  const source = a.surroundingMarkdown.trim().length > 0 ? a.surroundingMarkdown : piece.body;
  const surroundingMarkdown = role === "cover" ? source.slice(0, 6000) : sliceAroundHeading(source, a.heading ?? null);

  const suggestion = await suggestImageConcept({ tenantId, title: piece.title, surroundingMarkdown, role });
  const style = await loadStyle(tenantId);
  const prompt = buildImagePrompt({
    styleBlock: style.ok ? style.styleBlock : "",
    concept: suggestion.concept,
    role,
    allowText: style.ok ? style.vi.allowTextInImages : false,
  });
  return { prompt, concept: suggestion.concept, altText: suggestion.altText || altFromConcept(suggestion.concept) };
}

export async function regenerateImage(a: {
  imageId: string;
  mode: "same" | "prompt" | "edit";
  prompt?: string;
  instruction?: string;
}): Promise<{ ok: true; url: string; renderId: string } | { ok: false; error: string }> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const image = await loadOwnedImage(tenantId, a.imageId);
  if (!image || !image.current) return { ok: false, error: NOT_FOUND };
  if (image.sourceKind !== "generated") return { ok: false, error: "Uploaded images can only be replaced or removed." };
  const style = await loadStyle(tenantId);
  if (!style.ok) return style;

  const role = image.role;
  const previous = image.current;
  let prompt: string;
  let storedPrompt: string;
  let editOf: string | undefined;
  let referenceImages: string[] | undefined;
  if (a.mode === "edit") {
    const instruction = (a.instruction ?? "").trim();
    if (!instruction) return { ok: false, error: "Describe the change you want." };
    prompt = instruction;
    storedPrompt = editPromptHistory(previous.prompt, instruction);
    editOf = previous.blobUrl;
  } else {
    prompt = a.mode === "prompt" ? (a.prompt ?? "").trim() : previous.prompt;
    if (!prompt) return { ok: false, error: "The prompt can't be empty." };
    storedPrompt = prompt;
    referenceImages =
      role === "cover" ? style.vi.styleReferenceImages : await bodyReferences(tenantId, image.contentPieceId, style.vi);
  }

  try {
    const render = await renderAndStore({
      tenantId,
      imageId: image.id,
      contentPieceId: image.contentPieceId,
      role,
      slug: imageSlug(image.concept),
      prompt,
      storedPrompt,
      size: sizeForRole(role),
      referenceImages,
      editOf,
    });
    if (image.contentPieceId) {
      await swapUrlInBody(image.contentPieceId, previous.blobUrl, render.blobUrl);
      revalidatePath(`/drafts/${image.contentPieceId}`);
    }
    revalidatePath("/images");
    return { ok: true, url: render.blobUrl, renderId: render.id };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function restoreRender(a: {
  imageId: string;
  renderId: string;
}): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const image = await loadOwnedImage(tenantId, a.imageId);
  if (!image) return { ok: false, error: NOT_FOUND };
  const target = image.renders.find((r) => r.id === a.renderId);
  if (!target) return { ok: false, error: "That render is no longer in the history." };

  await setCurrentRender(image.id, target.id);
  if (image.contentPieceId) {
    if (image.current) await swapUrlInBody(image.contentPieceId, image.current.blobUrl, target.blobUrl);
    revalidatePath(`/drafts/${image.contentPieceId}`);
  }
  revalidatePath("/images");
  return { ok: true, url: target.blobUrl };
}

export async function generateCover(a: {
  contentPieceId: string;
  mode: "from_post" | "prompt";
  prompt?: string;
}): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const piece = await loadOwnedDraft(tenantId, a.contentPieceId);
  assertDraftEditable(piece);
  const style = await loadStyle(tenantId);
  if (!style.ok) return style;

  let concept: string;
  let altText: string;
  if (a.mode === "from_post") {
    const suggestion = await suggestImageConcept({ tenantId, title: piece.title, surroundingMarkdown: piece.body.slice(0, 6000), role: "cover" });
    concept = suggestion.concept;
    altText = suggestion.altText || altFromConcept(concept);
  } else {
    concept = (a.prompt ?? "").trim();
    if (!concept) return { ok: false, error: "Describe what the cover should show." };
    altText = altFromConcept(concept);
  }

  // A generated cover keeps its row so the history strip survives a Change;
  // an uploaded cover (or none) is replaced by a fresh generated row.
  const existing = await getCoverImage(tenantId, piece.id);
  let imageId: string;
  let created = false;
  if (existing && existing.sourceKind === "generated") {
    imageId = existing.id;
    await db.update(contentImages).set({ concept, altText, updatedAt: new Date() }).where(eq(contentImages.id, existing.id));
  } else {
    if (existing) await deleteImage(tenantId, existing.id);
    const image = await createImage({ tenantId, contentPieceId: piece.id, role: "cover", concept, altText, sourceKind: "generated" });
    imageId = image.id;
    created = true;
  }

  try {
    const render = await renderAndStore({
      tenantId,
      imageId,
      contentPieceId: piece.id,
      role: "cover",
      slug: imageSlug(piece.title),
      prompt: buildImagePrompt({ styleBlock: style.styleBlock, concept, role: "cover", allowText: style.vi.allowTextInImages }),
      size: sizeForRole("cover"),
      referenceImages: style.vi.styleReferenceImages,
    });
    revalidatePath(`/drafts/${piece.id}`);
    revalidatePath("/board");
    return { ok: true, url: render.blobUrl };
  } catch (error) {
    if (created) await deleteImage(tenantId, imageId);
    return { ok: false, error: errorMessage(error) };
  }
}

export async function removeCover(a: { contentPieceId: string }): Promise<void> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const piece = await loadOwnedDraft(tenantId, a.contentPieceId);
  assertDraftEditable(piece);
  const cover = await getCoverImage(tenantId, piece.id);
  // Task 3's shared-blob guard means a cover set "from library" doesn't take
  // the source image's blob with it.
  if (cover) await deleteImage(tenantId, cover.id);
  revalidatePath(`/drafts/${piece.id}`);
  revalidatePath("/board");
}

/** Fields: `contentPieceId` ("" for a library upload), `role`, `file`. */
export async function uploadImageFile(
  formData: FormData
): Promise<{ ok: true; url: string; imageId: string } | { ok: false; error: string }> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const contentPieceId = String(formData.get("contentPieceId") ?? "") || null;
  const roleField = String(formData.get("role") ?? "body");
  const role: ImageRole = roleField === "cover" ? "cover" : roleField === "library" ? "library" : "body";
  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, error: "Choose an image file to upload." };
  const valid = validateUploadFile({ type: file.type, size: file.size });
  if (!valid.ok) return valid;

  if (contentPieceId) assertDraftEditable(await loadOwnedDraft(tenantId, contentPieceId));
  if (role === "cover" && contentPieceId) {
    const existing = await getCoverImage(tenantId, contentPieceId);
    if (existing) await deleteImage(tenantId, existing.id);
  }

  const baseName = file.name.replace(/\.[a-z0-9]+$/i, "");
  // Uploads have no authored concept, so no alt is invented (spec §2:
  // decorative images get empty alt); the file name is the library caption.
  const image = await createImage({
    tenantId,
    contentPieceId: role === "library" ? null : contentPieceId,
    role,
    concept: baseName,
    altText: "",
    sourceKind: "uploaded",
  });
  try {
    const render = await storeRenderBytes({
      tenantId,
      imageId: image.id,
      contentPieceId: image.contentPieceId,
      role,
      slug: imageSlug(baseName),
      png: Buffer.from(await file.arrayBuffer()),
      prompt: "",
      model: "upload",
    });
    if (contentPieceId) revalidatePath(`/drafts/${contentPieceId}`);
    revalidatePath("/images");
    return { ok: true, url: render.blobUrl, imageId: image.id };
  } catch (error) {
    await deleteImage(tenantId, image.id);
    return { ok: false, error: errorMessage(error) };
  }
}

export type ImageLookup = {
  imageId: string;
  role: ImageRole;
  sourceKind: ImageSourceKind;
  contentPieceId: string | null;
  currentRenderId: string | null;
  currentPrompt: string;
  renders: { id: string; url: string; prompt: string; createdAt: string }[];
};

/** The editor's `<img src>` → row map (spec §3), with history for the toolbar. */
export async function lookupImageBySrc(src: string): Promise<ImageLookup | null> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const found = await findImageByRenderUrl(tenantId, src);
  if (!found) return null;
  const image = await getImage(tenantId, found.image.id);
  if (!image) return null;
  return {
    imageId: image.id,
    role: image.role as ImageRole,
    sourceKind: image.sourceKind as ImageSourceKind,
    contentPieceId: image.contentPieceId,
    currentRenderId: image.currentRenderId,
    currentPrompt: image.current?.prompt ?? "",
    renders: image.renders.map((r) => ({ id: r.id, url: r.blobUrl, prompt: r.prompt, createdAt: r.createdAt.toISOString() })),
  };
}

/**
 * "From library" for the cover (spec §5b): reuse inserts the existing blob —
 * a new cover row whose render copies the chosen render's blob fields, no
 * upload. Task 3's guard keeps deletion of either row from taking the blob.
 */
export async function setCoverFromImage(a: {
  contentPieceId: string;
  imageId: string;
}): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const piece = await loadOwnedDraft(tenantId, a.contentPieceId);
  assertDraftEditable(piece);
  const source = await getImage(tenantId, a.imageId);
  if (!source?.current) return { ok: false, error: NOT_FOUND };

  const existing = await getCoverImage(tenantId, piece.id);
  if (existing?.id === source.id) return { ok: true, url: source.current.blobUrl };
  if (existing) await deleteImage(tenantId, existing.id);

  const cover = await createImage({
    tenantId,
    contentPieceId: piece.id,
    role: "cover",
    concept: source.concept,
    altText: source.altText,
    sourceKind: source.sourceKind as ImageSourceKind,
  });
  await addRender({
    imageId: cover.id,
    prompt: source.current.prompt,
    blobUrl: source.current.blobUrl,
    blobPathname: source.current.blobPathname,
    width: source.current.width,
    height: source.current.height,
    bytes: source.current.bytes,
    model: source.current.model,
  });
  revalidatePath(`/drafts/${piece.id}`);
  revalidatePath("/board");
  return { ok: true, url: source.current.blobUrl };
}
```

If `contentImages.role` / `sourceKind` are already typed as the unions via `$type<ImageRole>()` in Plan 1's schema, drop the two `as ImageRole` / `as ImageSourceKind` casts (lint would flag them as unnecessary only under a strict rule; typecheck accepts either way).

- [ ] **Step 8: Run to verify it passes, then the gates**

Run: `npx vitest run tests/app/drafts/image-actions.test.ts tests/lib/images/generate.test.ts`
Expected: PASS. If `regenerateImage`'s "mode same" test fails on `bodyEditedAt`, the seed inserted a piece with the default `bodyEditedAt` null — check that `swapUrlInBody` sets only `body`.

Run: `npm run typecheck && npm run lint`
Expected: clean. A likely lint hit is `@typescript-eslint/no-unused-vars` on `ImageSourceKind` if the schema already narrows — remove the import then.

- [ ] **Step 9: Commit**

```bash
git add src/lib/images/generate.ts "src/app/(dashboard)/drafts/[releaseId]/image-actions.ts" tests/lib/images/generate.test.ts tests/app/drafts/image-actions.test.ts
git commit -m "feat: image server actions for the draft editor and cover"
```

---

### Task 5: Editor extension points — `insertExtras`, `imageUploadHandler`, `imageToolbar`, and three new `EditorOps`

**Files:**
- Modify: `src/components/markdown/mdx-editor.tsx` — `EditorSurfaces` props/insert surface (lines 174-226), `MdxEditor` props (lines 228-258), the `imagePlugin()` call (line 293), the `toolbarContents` render (line 301).
- Modify: `src/app/(dashboard)/drafts/[releaseId]/agent-edit-context.tsx` — `EditorOps` type (lines 26-47).
- Modify: `src/app/(dashboard)/drafts/[releaseId]/mdx-editor.tsx` — `AgentEditBridge` ops object (lines 36-139), imports (lines 4-15).
- Test: none new — `tests/components/new-brief-editor.test.tsx:55` mocks the editor module and nothing under `tests/components` renders `AgentEditBridge`, so the bridge stays covered by typecheck + the manual checklist (Task 11), exactly as `applyEdit`/`removeSelection` are today.

**Interfaces:**
- Consumes: `imagePlugin` params `imageUploadHandler?: (image: File) => Promise<string>` and `EditImageToolbar?: (() => JSX.Element) | React.FC` — verified in `node_modules/@mdxeditor/editor/dist/index.d.ts:1524-1534`; the toolbar props MDXEditor passes are `{ nodeKey, imageSource, initialImagePath, title, alt, width?, height? }` (`dist/index.d.ts:1131-1139`, a non-exported `declare interface`, rendered by `dist/plugins/image/ImageEditor.js` whenever the editor isn't read-only). `MDXEditorMethods.getMarkdown/insertMarkdown` (`dist/index.d.ts:2288-2318`). `insertMarkdown$` reads `$getSelection()` in the active editor and works with focus elsewhere (`dist/plugins/core/index.js:158-181`), which is what makes the restore-then-insert pattern below valid. `ImageNode` (`getSrc()/setSrc()`, `dist/index.d.ts:1473-1512`) and `$nodesOfType` from `lexical` (`node_modules/lexical/dist/LexicalUtils.d.ts:196`; `lexical` is a hoisted transitive dependency the drafts wrapper already imports from, `mdx-editor.tsx:7-15`).
- Produces:
  ```ts
  // src/components/markdown/mdx-editor.tsx
  export type ImageEditToolbarProps = { nodeKey: string; imageSource: string; initialImagePath: string | null; title: string; alt: string; width?: number | "inherit"; height?: number | "inherit" };
  // new MdxEditor props:
  //   insertExtras?: React.ReactNode;                              rendered in the insert surface after InsertCodeBlock
  //   imageUploadHandler?: (file: File) => Promise<string>;         → imagePlugin({ imageUploadHandler })
  //   imageToolbar?: React.FC<ImageEditToolbarProps>;               → imagePlugin({ EditImageToolbar })

  // agent-edit-context.tsx — EditorOps gains:
  captureInsertPoint: () => void;                                   // snapshot the caret for insertAtCursor
  insertAtCursor: (markdown: string) => Promise<string>;            // restore the snapshot, insertMarkdown, resolve with the post-commit body
  replaceImageSrc: (oldUrl: string, newUrl: string) => Promise<string>; // ImageNode.setSrc on every match, resolve with the post-commit body
  ```

- [ ] **Step 1: Extend the shared editor**

In `src/components/markdown/mdx-editor.tsx`:

After the `type SurfaceMode` line (line 51) add:

```ts
/**
 * The props MDXEditor hands its `EditImageToolbar` (dist/index.d.ts:1131-1139
 * — the interface itself is not exported, so it is restated here). A consumer
 * replaces the default delete/settings toolbar by passing `imageToolbar`.
 */
export type ImageEditToolbarProps = {
  nodeKey: string;
  imageSource: string;
  initialImagePath: string | null;
  title: string;
  alt: string;
  width?: number | "inherit";
  height?: number | "inherit";
};
```

Change `EditorSurfaces` (lines 174-180) to accept and render `insertExtras`:

```tsx
function EditorSurfaces({
  realmChildren,
  selectionExtras,
  insertExtras,
}: {
  realmChildren?: React.ReactNode;
  selectionExtras?: React.ReactNode;
  insertExtras?: React.ReactNode;
}) {
```

and in the insert surface (lines 214-223):

```tsx
      <div
        ref={insertSurfaceRef}
        className="mdx-surface mdx-surface-insert"
        data-open={mode === "insert"}
        style={{ top: pos.top, left: pos.left }}
        onMouseDown={preserveSelection}
      >
        <InsertImage />
        <InsertCodeBlock />
        {insertExtras}
      </div>
```

Extend `MdxEditor`'s props (lines 228-258): add `insertExtras`, `imageUploadHandler`, `imageToolbar` to the destructuring and the type:

```tsx
export default function MdxEditor({
  markdown,
  onChange,
  editorRef,
  realmChildren,
  selectionExtras,
  insertExtras,
  imageUploadHandler,
  imageToolbar,
  contentEditableClassName = "min-h-[65vh]",
  placeholder = <span className="text-muted-foreground/40">Update body</span>,
  parseErrorHint = "Copy your text elsewhere before reloading the page, so a fix doesn't cost you the content.",
}: {
  markdown: string;
  onChange: (md: string, initialMarkdownNormalize: boolean) => void;
  editorRef?: React.RefObject<MDXEditorMethods | null>;
  realmChildren?: React.ReactNode;
  selectionExtras?: React.ReactNode;
  // Rendered in the floating insert surface (empty paragraph) after the
  // built-in InsertImage / InsertCodeBlock buttons.
  insertExtras?: React.ReactNode;
  // Handed to imagePlugin: makes drag-drop, paste and the image dialog's file
  // tab upload the file and insert the returned URL. Without it the plugin
  // stays URL-only, as before.
  imageUploadHandler?: (file: File) => Promise<string>;
  // Replaces the plugin's per-image delete/settings toolbar (rendered top-right
  // of every image while editing).
  imageToolbar?: React.FC<ImageEditToolbarProps>;
  contentEditableClassName?: string;
  placeholder?: React.ReactNode;
  parseErrorHint?: string;
}) {
```

(keep the existing comments on `editorRef`, `contentEditableClassName`, `parseErrorHint` where they are — only the three new entries are added).

Replace `imagePlugin(),` (line 293) with:

```tsx
          imagePlugin({
            imageUploadHandler,
            // imagePlugin types EditImageToolbar as `React.FC` (props {}), so a
            // typed component needs the cast; MDXEditor calls it with the
            // ImageEditToolbarProps shape regardless.
            ...(imageToolbar ? { EditImageToolbar: imageToolbar as unknown as React.FC } : {}),
          }),
```

and the toolbar render (line 301):

```tsx
              <EditorSurfaces realmChildren={realmChildren} selectionExtras={selectionExtras} insertExtras={insertExtras} />
```

- [ ] **Step 2: Extend `EditorOps`**

In `agent-edit-context.tsx`, add to the `EditorOps` type after `getMarkdown` (line 46):

```ts
  /**
   * Snapshots the caret for a later `insertAtCursor`. Called from the insert
   * surface's Generate-image button (whose surface `preventDefault`s mousedown,
   * so the caret is still live) before the panel takes focus.
   */
  captureInsertPoint: () => void;
  /**
   * Restores the captured caret and inserts markdown there; resolves with the
   * editor's authoritative body AFTER Lexical commits (same deferred-commit
   * caveat as `applyEdit`). Resolves with the unchanged body when nothing was
   * captured.
   */
  insertAtCursor: (markdown: string) => Promise<string>;
  /**
   * Points every image node whose src is `oldUrl` at `newUrl` — the render
   * history's restore/regenerate swap (spec §5) — and resolves with the body
   * after commit. Node-level, not setMarkdown: setMarkdown mutes onChange
   * (see the whole-update comment in AgentEditBridge), which would leave
   * DraftBodyEditor's hidden input stale.
   */
  replaceImageSrc: (oldUrl: string, newUrl: string) => Promise<string>;
```

- [ ] **Step 3: Implement the ops in `AgentEditBridge`**

In `drafts/[releaseId]/mdx-editor.tsx`, extend the imports (lines 4 and 7-15):

```ts
import { activeEditor$, useCellValue, ImageNode, type MDXEditorMethods } from "@mdxeditor/editor";
import {
  $getSelection,
  $isRangeSelection,
  $setSelection,
  $getRoot,
  $createParagraphNode,
  $nodesOfType,
  type LexicalEditor,
  type RangeSelection,
} from "lexical";
```

Add a second saved-selection ref next to `savedSelection` (line 30):

```ts
  // Separate from savedSelection: Ask AI's removeSelection consumes and clears
  // that one, and an image insert must not be able to steal or lose it.
  const savedInsertPoint = useRef<RangeSelection | null>(null);
```

Add the three ops to the `ops` object after `getMarkdown` (line 135):

```ts
      captureInsertPoint: () => {
        const editor = activeEditorRef.current;
        if (!editor) return;
        editor.getEditorState().read(() => {
          const sel = $getSelection();
          savedInsertPoint.current = $isRangeSelection(sel) ? sel.clone() : null;
        });
      },
      insertAtCursor: (markdown) =>
        new Promise<string>((resolve) => {
          const editor = activeEditorRef.current;
          const saved = savedInsertPoint.current;
          if (!editor || !saved) {
            resolve(editorRef.current?.getMarkdown() ?? "");
            return;
          }
          // Consume the capture: after insertMarkdown the keys it points at
          // may not survive, so a second insert must re-capture.
          savedInsertPoint.current = null;
          // Same one-shot listener as applyEdit: read the markdown cell only
          // after Lexical's deferred commit has refreshed it.
          const unregister = editor.registerUpdateListener(() => {
            unregister();
            resolve(editorRef.current?.getMarkdown() ?? "");
          });
          // Restore the caret, then insertMarkdown$ imports the image at
          // $getSelection() (dist/plugins/core/index.js:158-181) — it does not
          // need DOM focus, which the panel's textarea has taken.
          editor.update(() => {
            $setSelection(saved.clone());
          });
          editorRef.current?.insertMarkdown(markdown);
        }),
      replaceImageSrc: (oldUrl, newUrl) =>
        new Promise<string>((resolve) => {
          const editor = activeEditorRef.current;
          if (!editor) {
            resolve(editorRef.current?.getMarkdown() ?? "");
            return;
          }
          let changed = false;
          const unregister = editor.registerUpdateListener(() => {
            unregister();
            resolve(editorRef.current?.getMarkdown() ?? "");
          });
          editor.update(() => {
            for (const node of $nodesOfType(ImageNode)) {
              if (node.getSrc() === oldUrl) {
                node.setSrc(newUrl);
                changed = true;
              }
            }
          });
          // No node matched → Lexical skips the commit and the listener would
          // never fire; resolve now with the (unchanged) body instead of
          // hanging the caller. `editor.update` runs its callback synchronously
          // when called outside another update, so `changed` is settled here.
          if (!changed) {
            unregister();
            resolve(editorRef.current?.getMarkdown() ?? "");
          }
        }),
```

`activeEditor$` is the root editor unless the caret sits in a nested editor (a table cell); images in tables are out of scope, so no nested-editor walk.

- [ ] **Step 4: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: clean. If `ImageNode` is reported as not exported at runtime (it is declared at `dist/index.d.ts:1473`), confirm with `grep -n "ImageNode" node_modules/@mdxeditor/editor/dist/index.js` before changing anything.

- [ ] **Step 5: Commit**

```bash
git add src/components/markdown/mdx-editor.tsx "src/app/(dashboard)/drafts/[releaseId]/agent-edit-context.tsx" "src/app/(dashboard)/drafts/[releaseId]/mdx-editor.tsx"
git commit -m "feat: editor seams for image insert, upload and per-image toolbar"
```

---

### Task 6: Generate image — insert-surface button and in-canvas panel

**Files:**
- Create: `src/app/(dashboard)/drafts/[releaseId]/generate-image-button.tsx` (`"use client"`)
- Create: `src/app/(dashboard)/drafts/[releaseId]/generate-image-panel.tsx` (`"use client"`)
- Modify: `src/app/(dashboard)/drafts/[releaseId]/mdx-editor.tsx` — the wrapper's props (lines 183-189) and the `SharedMdxEditor` element (lines 195-212): add `contentPieceId` and `insertExtras`.
- Modify: `src/app/(dashboard)/drafts/[releaseId]/draft-body-editor.tsx` — props (line 9) and the `<MdxEditor>` element (lines 29-48): thread `contentPieceId`.
- Modify: `src/app/(dashboard)/drafts/[releaseId]/page.tsx:316` — `<DraftBodyEditor defaultValue={update.body} contentPieceId={update.id} />`.
- Modify: `src/app/globals.css` — after `.mdx-surface-insert` (lines 339-341) add the `.mdx-surface-panel` rule.

**Interfaces:**
- Consumes: `useAgentEdit().ops` (`captureInsertPoint`, `insertAtCursor`, `getMarkdown` — Task 5), `generateBodyImage`, `suggestImagePrompt` (Task 4), `saveDraftBody` (`actions.ts:103`), `useUnsavedChanges().notifySaved` (`unsaved-changes.tsx:48,147`), `Textarea`, `Button` from `@/components/ui`, `toast` from `sonner`.
- Produces:
  ```tsx
  export function GenerateImageButton({ contentPieceId }: { contentPieceId: string }): JSX.Element;
  export function GenerateImagePanel(props: {
    contentPieceId: string; heading: string | null;
    onInsert: (markdown: string) => Promise<void>; onClose: () => void;
  }): JSX.Element;
  export function nearestHeadingAbove(): string | null;   // DOM walk from the live caret; exported for reuse by Task 7's toolbar
  ```

How it stays in-canvas without a modal: the panel is a child of the insert surface (`.mdx-surface-insert`, `mdx-editor.tsx:214-223`), absolutely positioned under it. `useSelectionSurface.update()` (`mdx-editor.tsx:91-103`) leaves the surface open while `document.activeElement` is inside `insertSurfaceRef`, so focusing the panel's textarea keeps the surface (and thus the panel) visible. The surface's `onMouseDown={preserveSelection}` (`mdx-editor.tsx:188,219`) would prevent the textarea from ever taking focus, so the panel stops mousedown propagation on its root. The caret is captured (`captureInsertPoint`) on the button click, before focus moves, and restored by `insertAtCursor` — the same capture/restore reason `AgentEditBridge` gives at `mdx-editor.tsx:23-24`. "Suggest prompt" sends the whole live body plus the nearest heading above the caret read from the DOM (`nearestHeadingAbove`); MDXEditor exposes no markdown offset for the caret, so slicing happens server-side (`sliceAroundHeading`, Task 4).

- [ ] **Step 1: The panel**

Create `src/app/(dashboard)/drafts/[releaseId]/generate-image-panel.tsx`:

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Sparkles, WandSparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAgentEdit } from "./agent-edit-context";
import { generateBodyImage, suggestImagePrompt } from "./image-actions";

/**
 * The in-canvas "Generate image" block (spec §5 Inserting): a prompt field,
 * a brand-style note, Suggest prompt, Generate. Rendered INSIDE the insert
 * surface by GenerateImageButton — see that file for why that placement is
 * what keeps it open while the textarea has focus.
 */
export function GenerateImagePanel({
  contentPieceId,
  heading,
  onInsert,
  onClose,
}: {
  contentPieceId: string;
  /** Nearest heading above the caret at open time, for Suggest prompt. */
  heading: string | null;
  /** Splices the returned markdown at the captured caret and persists. */
  onInsert: (markdown: string) => Promise<void>;
  onClose: () => void;
}) {
  const { ops } = useAgentEdit();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<"idle" | "suggesting" | "generating">("idle");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  async function suggest() {
    setBusy("suggesting");
    try {
      const out = await suggestImagePrompt({
        contentPieceId,
        surroundingMarkdown: ops.current?.getMarkdown() ?? "",
        heading,
      });
      setPrompt(out.concept);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't suggest a prompt");
    } finally {
      setBusy("idle");
    }
  }

  async function generate() {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    setBusy("generating");
    try {
      const result = await generateBodyImage({ contentPieceId, prompt: trimmed });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      await onInsert(result.markdown);
      toast.success("Illustration added");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong");
    } finally {
      setBusy("idle");
    }
  }

  return (
    <div
      className="mdx-surface-panel w-96 space-y-2 rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-md"
      // The surface's onMouseDown preventDefault would stop the textarea from
      // taking focus; stop it here so clicks inside the panel behave normally.
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          if (busy === "idle") onClose();
        }
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void generate();
      }}
    >
      {busy === "generating" ? (
        <div className="flex items-center gap-3 py-6 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Composing illustration…
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 font-medium">
            <Sparkles className="size-4" /> Generate image
          </div>
          <Textarea
            ref={textareaRef}
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should the image show? e.g. A magnifying glass over a grid of documents"
            disabled={busy !== "idle"}
          />
          <p className="text-xs text-muted-foreground">Matches your brand style — you describe what, not how it looks.</p>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => void suggest()} disabled={busy !== "idle"}>
              {busy === "suggesting" ? <Loader2 className="size-3.5 animate-spin" /> : <WandSparkles className="size-3.5" />}
              Suggest prompt
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy !== "idle"}>
                Cancel
              </Button>
              <Button type="button" size="sm" onClick={() => void generate()} disabled={busy !== "idle" || !prompt.trim()}>
                Generate
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
```

Check `Button` accepts `size="sm"` (`src/components/ui/button.tsx:7-48`, the cva variants) and `Textarea` forwards `ref` (React 19 function components receive `ref` as a prop; `src/components/ui/textarea.tsx` spreads props onto the element — read it; if it doesn't accept `ref`, drop the ref and use `autoFocus` instead, as `agent-edit-dialog.tsx:173` does).

- [ ] **Step 2: The button (and the heading walk)**

Create `src/app/(dashboard)/drafts/[releaseId]/generate-image-button.tsx`:

```tsx
"use client";

import { useState } from "react";
import { ImagePlus } from "lucide-react";
import { toast } from "sonner";
import { useUnsavedChanges } from "../../unsaved-changes";
import { useAgentEdit } from "./agent-edit-context";
import { saveDraftBody } from "./actions";
import { GenerateImagePanel } from "./generate-image-panel";

/**
 * The nearest heading above the live caret, read from the editor DOM. Used
 * to scope "Suggest prompt" to the section being written; null when the
 * caret is above the first heading (or not in the editor).
 */
export function nearestHeadingAbove(): string | null {
  const sel = window.getSelection();
  const anchor = sel?.anchorNode ?? null;
  if (!anchor) return null;
  const el = anchor instanceof Element ? anchor : anchor.parentElement;
  const content = el?.closest(".mdx-content") ?? null;
  if (!el || !content || el === content) return null;
  let block: Element | null = el;
  while (block && block.parentElement !== content) block = block.parentElement;
  for (let n = block?.previousElementSibling ?? null; n; n = n.previousElementSibling) {
    if (/^H[1-6]$/.test(n.tagName)) return n.textContent?.trim() || null;
  }
  return null;
}

/**
 * "Generate image" in the insert surface, beside InsertImage (spec §5). The
 * surface preventDefaults mousedown, so the caret is still live in onClick:
 * capture it (and the heading above it) THEN open the panel, which takes
 * focus. The panel is rendered as a sibling here so it lives inside the
 * surface element — the hook that positions the surface keeps it open while
 * focus is inside it (mdx-editor.tsx useSelectionSurface).
 */
export function GenerateImageButton({ contentPieceId }: { contentPieceId: string }) {
  const { ops } = useAgentEdit();
  const { notifySaved } = useUnsavedChanges();
  const [open, setOpen] = useState<{ heading: string | null } | null>(null);

  async function insert(markdown: string) {
    const editorOps = ops.current;
    if (!editorOps) throw new Error("The editor isn't ready yet — try again in a moment.");
    const body = await editorOps.insertAtCursor(markdown);
    await saveDraftBody({ contentPieceId, body });
    notifySaved();
  }

  return (
    <>
      <button
        type="button"
        title="Generate an image"
        aria-label="Generate an image"
        onClick={() => {
          const editorOps = ops.current;
          if (!editorOps) {
            toast.error("The editor isn't ready yet — try again in a moment.");
            return;
          }
          editorOps.captureInsertPoint();
          setOpen({ heading: nearestHeadingAbove() });
        }}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        <ImagePlus className="size-4" />
      </button>
      {open && (
        <GenerateImagePanel
          contentPieceId={contentPieceId}
          heading={open.heading}
          onInsert={insert}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}
```

`ImagePlus` and `WandSparkles` exist in `lucide-react` ^1.24 (check `node_modules/lucide-react/dist/lucide-react.d.ts` with `grep -c "ImagePlus\|WandSparkles"`; if `WandSparkles` is missing use `Wand2`).

- [ ] **Step 3: Panel CSS**

In `src/app/globals.css`, after the `.mdx-surface-insert` rule (lines 339-341) add:

```css
/* The Generate-image panel hangs below the insert surface, left-aligned with
   it. It is a child of the surface on purpose (see generate-image-button.tsx)
   so the surface's "focus is inside me" check keeps both open. */
.mdx-surface-panel {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
}
```

- [ ] **Step 4: Wire the wrapper, the body editor and the page**

In `drafts/[releaseId]/mdx-editor.tsx`, add the import and extend the wrapper:

```tsx
import { GenerateImageButton } from "./generate-image-button";

export default function MdxEditor({
  markdown,
  onChange,
  contentPieceId,
}: {
  markdown: string;
  onChange: (md: string, initialMarkdownNormalize: boolean) => void;
  contentPieceId: string;
}) {
  const editorRef = useRef<MDXEditorMethods>(null);

  return (
    <SharedMdxEditor
      markdown={markdown}
      onChange={onChange}
      editorRef={editorRef}
      parseErrorHint="Switch to Source mode (the Source button in the action row) to view and edit the raw Markdown safely."
      realmChildren={
        <>
          <ViewModeBridge />
          <AgentEditBridge editorRef={editorRef} />
        </>
      }
      selectionExtras={
        <>
          <AskAiSelectionButton />
          <ExtractSelectionButton />
        </>
      }
      insertExtras={<GenerateImageButton contentPieceId={contentPieceId} />}
    />
  );
}
```

In `draft-body-editor.tsx` line 9 → `export function DraftBodyEditor({ defaultValue, contentPieceId }: { defaultValue: string; contentPieceId: string })` and pass `contentPieceId={contentPieceId}` on the `<MdxEditor>` element (line 29). In `page.tsx:316` → `<DraftBodyEditor defaultValue={update.body} contentPieceId={update.id} />`. (`grep -rn "DraftBodyEditor" src` shows page.tsx is the only consumer.)

- [ ] **Step 5: Gates**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: clean. If lint flags `react-hooks/set-state-in-effect` on the panel's focus effect, it doesn't set state — it only focuses; leave it.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(dashboard)/drafts/[releaseId]/generate-image-button.tsx" "src/app/(dashboard)/drafts/[releaseId]/generate-image-panel.tsx" "src/app/(dashboard)/drafts/[releaseId]/mdx-editor.tsx" "src/app/(dashboard)/drafts/[releaseId]/draft-body-editor.tsx" "src/app/(dashboard)/drafts/[releaseId]/page.tsx" src/app/globals.css
git commit -m "feat: generate an illustration from the editor's insert surface"
```

---

### Task 7: Per-image edit affordances — `image-edit-toolbar.tsx`

**Files:**
- Create: `src/app/(dashboard)/drafts/[releaseId]/draft-image-context.tsx` (`"use client"` — carries `contentPieceId` to components MDXEditor instantiates itself)
- Create: `src/app/(dashboard)/drafts/[releaseId]/image-edit-toolbar.tsx` (`"use client"`)
- Modify: `src/app/(dashboard)/drafts/[releaseId]/mdx-editor.tsx` — the wrapper: wrap `SharedMdxEditor` in `DraftImageProvider` and pass `imageToolbar={ImageEditToolbar}`.

**Interfaces:**
- Consumes: the seam verified in Task 5 — `imagePlugin({ EditImageToolbar })`, whose component MDXEditor renders top-right of every image (`dist/plugins/image/ImageEditor.js`, the `EditImageToolbar` element near the end of the render; CSS `._editImageToolbar_*` in `dist/style.css:1447-1456` is absolute `top:0; right:0`, always visible while editing — there is no hover/selection gate in the plugin, so ours matches: always-visible icons, the image actions behind a popover). The default toolbar's two buttons are reproduced (`dist/plugins/image/EditImageToolbar.js`: delete = `$getNodeByKey(nodeKey)?.remove()` inside `editor.update`, settings = `usePublisher(openEditImageDialog$)({ nodeKey, initialValues: { src, title, altText, width, height } })`); `openEditImageDialog$`, `readOnly$`, `usePublisher`, `useCellValue` are exported (`dist/index.d.ts:2597, 2672` and `export * from "@mdxeditor/gurx"` at 3193); `useLexicalComposerContext` from `@lexical/react/LexicalComposerContext` (hoisted transitive dep, `node_modules/@lexical/react/LexicalComposerContext.d.ts` exists) for the delete update; `parseImageDimension` (`dist/index.d.ts:2612`).
- Consumes: `lookupImageBySrc`, `regenerateImage`, `restoreRender` (Task 4), `saveDraftBody`, `useAgentEdit().ops.replaceImageSrc` (Task 5), `Popover`/`PopoverTrigger`/`PopoverContent` (`src/components/ui/popover.tsx:8-16`; trigger uses Base UI's `render` prop like `user-menu.tsx:28-31`), `useUnsavedChanges().notifySaved`.
- Produces:
  ```tsx
  // draft-image-context.tsx
  export function DraftImageProvider({ contentPieceId, children }): JSX.Element;
  export function useDraftImage(): { contentPieceId: string };
  // image-edit-toolbar.tsx
  export function ImageEditToolbar(props: ImageEditToolbarProps): JSX.Element;   // the imagePlugin EditImageToolbar
  ```

Behaviour (spec §5 Editing): the popover opens with `lookupImageBySrc(imageSource)`. Generated rows get **Edit prompt** (textarea prefilled with the stored full prompt → `regenerateImage({ mode: "prompt" })`), **Describe a change** (one line → `mode: "edit"`), **Regenerate** (`mode: "same"`), and a **History** strip of thumbnails with the current one marked and **Restore** on the others (`restoreRender`). Uploaded rows and unknown URLs (pasted links) show only "This image was uploaded — replace or remove it" / nothing extra. Every successful call does `ops.replaceImageSrc(imageSource, url)` → `saveDraftBody` → `notifySaved` → re-lookup so the strip updates.

- [ ] **Step 1: The context**

Create `src/app/(dashboard)/drafts/[releaseId]/draft-image-context.tsx`:

```tsx
"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * MDXEditor instantiates the per-image toolbar itself (imagePlugin's
 * EditImageToolbar), so it can't take props from our wrapper. React context
 * flows through the plugin's render tree (decorators are portals, which keep
 * context), so this is how the toolbar learns which piece it edits.
 */
const DraftImageContext = createContext<{ contentPieceId: string } | null>(null);

export function DraftImageProvider({ contentPieceId, children }: { contentPieceId: string; children: ReactNode }) {
  return <DraftImageContext.Provider value={{ contentPieceId }}>{children}</DraftImageContext.Provider>;
}

export function useDraftImage() {
  const ctx = useContext(DraftImageContext);
  if (!ctx) throw new Error("useDraftImage must be used within a DraftImageProvider");
  return ctx;
}
```

- [ ] **Step 2: The toolbar**

Create `src/app/(dashboard)/drafts/[releaseId]/image-edit-toolbar.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getNodeByKey } from "lexical";
import {
  openEditImageDialog$,
  parseImageDimension,
  readOnly$,
  useCellValue,
  usePublisher,
} from "@mdxeditor/editor";
import { History, Loader2, PencilLine, RefreshCw, Settings2, Sparkles, Trash2, WandSparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ImageEditToolbarProps } from "@/components/markdown/mdx-editor";
import { useUnsavedChanges } from "../../unsaved-changes";
import { useAgentEdit } from "./agent-edit-context";
import { useDraftImage } from "./draft-image-context";
import { saveDraftBody } from "./actions";
import { lookupImageBySrc, regenerateImage, restoreRender, type ImageLookup } from "./image-actions";

const ICON_BUTTON =
  "flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50";

/**
 * Replaces imagePlugin's default per-image toolbar. Keeps its two buttons
 * (delete, image settings — reproduced from
 * @mdxeditor/editor/dist/plugins/image/EditImageToolbar.js) and adds the
 * spec §5 image actions behind a popover, only for images whose src maps to
 * a generated content_images row.
 */
export function ImageEditToolbar({ nodeKey, imageSource, initialImagePath, title, alt, width, height }: ImageEditToolbarProps) {
  const [editor] = useLexicalComposerContext();
  const readOnly = useCellValue(readOnly$);
  const openEditImageDialog = usePublisher(openEditImageDialog$);

  return (
    <div
      className="absolute right-1 top-1 z-10 flex items-center gap-0.5 rounded-md border bg-background/95 p-0.5 shadow-sm"
      // Keep Lexical from treating clicks here as a click on the image
      // (which would select/deselect the node under the toolbar).
      onMouseDown={(e) => e.stopPropagation()}
    >
      <ImageActionsPopover src={imageSource} />
      <button
        type="button"
        className={ICON_BUTTON}
        title="Image settings"
        aria-label="Image settings"
        disabled={readOnly}
        onClick={() =>
          openEditImageDialog({
            nodeKey,
            initialValues: {
              src: initialImagePath ?? imageSource,
              title,
              altText: alt,
              width: parseImageDimension(width),
              height: parseImageDimension(height),
            },
          })
        }
      >
        <Settings2 className="size-3.5" />
      </button>
      <button
        type="button"
        className={ICON_BUTTON}
        title="Delete image"
        aria-label="Delete image"
        disabled={readOnly}
        onClick={(e) => {
          e.preventDefault();
          editor.update(() => {
            $getNodeByKey(nodeKey)?.remove();
          });
        }}
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}

type View = "menu" | "prompt" | "edit";

function ImageActionsPopover({ src }: { src: string }) {
  const { contentPieceId } = useDraftImage();
  const { ops } = useAgentEdit();
  const { notifySaved } = useUnsavedChanges();
  const [open, setOpen] = useState(false);
  const [lookup, setLookup] = useState<ImageLookup | null | "loading">("loading");
  const [view, setView] = useState<View>("menu");
  const [prompt, setPrompt] = useState("");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);

  async function load(url: string) {
    setLookup("loading");
    try {
      const found = await lookupImageBySrc(url);
      setLookup(found);
      setPrompt(found?.currentPrompt ?? "");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't load this image");
      setLookup(null);
    }
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setView("menu");
      setInstruction("");
      void load(src);
    }
  }

  /** Swap the editor's image to the new render and persist — the shared tail of every action. */
  async function swapTo(url: string) {
    const editorOps = ops.current;
    if (!editorOps) throw new Error("The editor isn't ready yet — try again in a moment.");
    const body = await editorOps.replaceImageSrc(src, url);
    await saveDraftBody({ contentPieceId, body });
    notifySaved();
  }

  async function run(action: () => Promise<{ ok: true; url: string } | { ok: false; error: string }>, success: string) {
    setBusy(true);
    try {
      const result = await action();
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      await swapTo(result.url);
      toast.success(success);
      setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const generated = lookup !== "loading" && lookup !== null && lookup.sourceKind === "generated";

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={<button type="button" className={ICON_BUTTON} title="Image actions" aria-label="Image actions" />}
      >
        <Sparkles className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80" onKeyDown={(e) => e.key === "Escape" && !busy && setOpen(false)}>
        {lookup === "loading" ? (
          <div className="flex items-center gap-2 py-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : lookup === null ? (
          <p className="text-muted-foreground">This image isn&apos;t one of yours — replace or remove it with the buttons beside this one.</p>
        ) : !generated ? (
          <p className="text-muted-foreground">This image was uploaded — replace or remove it with the buttons beside this one.</p>
        ) : busy ? (
          <div className="flex items-center gap-2 py-4 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Composing illustration…
          </div>
        ) : view === "prompt" ? (
          <div className="space-y-2">
            <p className="font-medium">Edit prompt</p>
            <Textarea rows={6} value={prompt} onChange={(e) => setPrompt(e.target.value)} className="text-xs" />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setView("menu")}>
                Back
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!prompt.trim()}
                onClick={() => void run(() => regenerateImage({ imageId: lookup.imageId, mode: "prompt", prompt }), "Illustration regenerated")}
              >
                Regenerate
              </Button>
            </div>
          </div>
        ) : view === "edit" ? (
          <div className="space-y-2">
            <p className="font-medium">Describe a change</p>
            <Input
              autoFocus
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="e.g. make the background darker"
              onKeyDown={(e) => {
                if (e.key === "Enter" && instruction.trim()) {
                  void run(() => regenerateImage({ imageId: lookup.imageId, mode: "edit", instruction }), "Change applied");
                }
              }}
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setView("menu")}>
                Back
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!instruction.trim()}
                onClick={() => void run(() => regenerateImage({ imageId: lookup.imageId, mode: "edit", instruction }), "Change applied")}
              >
                Apply
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <button type="button" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted" onClick={() => setView("prompt")}>
              <PencilLine className="size-4" /> Edit prompt
            </button>
            <button type="button" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted" onClick={() => setView("edit")}>
              <WandSparkles className="size-4" /> Describe a change
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted"
              onClick={() => void run(() => regenerateImage({ imageId: lookup.imageId, mode: "same" }), "Illustration regenerated")}
            >
              <RefreshCw className="size-4" /> Regenerate
            </button>
            {lookup.renders.length > 1 && (
              <div className="space-y-1 border-t pt-2">
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <History className="size-3.5" /> History
                </p>
                <div className="flex gap-1.5 overflow-x-auto">
                  {lookup.renders.map((r) => {
                    const current = r.id === lookup.currentRenderId;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        title={current ? "Current render" : "Restore this render"}
                        disabled={current}
                        className={`relative shrink-0 overflow-hidden rounded border ${current ? "ring-2 ring-primary" : "hover:opacity-80"}`}
                        onClick={() => void run(() => restoreRender({ imageId: lookup.imageId, renderId: r.id }), "Render restored")}
                      >
                        {/* Thumbnails are the blob itself; a plain img keeps this component free of next/image's remotePatterns dependency inside the editor. */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={r.url} alt="" className="h-12 w-16 object-cover" />
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
```

`Input` is `src/components/ui/input.tsx`. If lint's `@next/next/no-img-element` isn't enabled the disable comment is harmless; if `eslint-comments/no-unused-disable` complains, drop the comment.

- [ ] **Step 3: Wire it in the wrapper**

In `drafts/[releaseId]/mdx-editor.tsx` add:

```tsx
import { DraftImageProvider } from "./draft-image-context";
import { ImageEditToolbar } from "./image-edit-toolbar";
```

and wrap the element from Task 6:

```tsx
  return (
    <DraftImageProvider contentPieceId={contentPieceId}>
      <SharedMdxEditor
        markdown={markdown}
        onChange={onChange}
        editorRef={editorRef}
        parseErrorHint="Switch to Source mode (the Source button in the action row) to view and edit the raw Markdown safely."
        realmChildren={
          <>
            <ViewModeBridge />
            <AgentEditBridge editorRef={editorRef} />
          </>
        }
        selectionExtras={
          <>
            <AskAiSelectionButton />
            <ExtractSelectionButton />
          </>
        }
        insertExtras={<GenerateImageButton contentPieceId={contentPieceId} />}
        imageToolbar={ImageEditToolbar}
      />
    </DraftImageProvider>
  );
```

- [ ] **Step 4: Gates**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: clean. If typecheck can't resolve `@lexical/react/LexicalComposerContext`, it isn't hoisted in this install — run `npm ls @lexical/react` and, if nested under `@mdxeditor/editor`, add `"@lexical/react": "^0.48.0"` and `"lexical": "^0.48.0"` to `dependencies` (the versions `@mdxeditor/editor` 4.1.0 declares) rather than importing a deep path.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/drafts/[releaseId]/draft-image-context.tsx" "src/app/(dashboard)/drafts/[releaseId]/image-edit-toolbar.tsx" "src/app/(dashboard)/drafts/[releaseId]/mdx-editor.tsx"
git commit -m "feat: edit prompt, describe a change, regenerate and history on editor images"
```

---

### Task 8: Uploads wiring, `.mdx-content img`, `images.remotePatterns`, action body limit

**Files:**
- Modify: `src/app/(dashboard)/drafts/[releaseId]/mdx-editor.tsx` — the wrapper: an `imageUploadHandler` callback passed to `SharedMdxEditor`.
- Modify: `src/app/globals.css` — after the `.mdx-content hr` rule (lines 274-278; the `.mdx-content` element rules run 208-291).
- Modify: `next.config.ts` (27 lines; `experimental.serverActions` already exists at lines 18-25).

**Interfaces:**
- Consumes: `uploadImageFile(formData)` (Task 4); `imagePlugin({ imageUploadHandler })` (Task 5) — the plugin calls it for drops (`dist/plugins/image/index.js:259-273`), pastes (137-138) and the dialog's file tab (53-74), then inserts the resolved URL.
- `images.remotePatterns` object shape and hostname wildcards from `node_modules/next/dist/docs/01-app/03-api-reference/02-components/image.md:533-581`; `serverActions.bodySizeLimit` (default 1 MB) from `.../05-config/01-next-config-js/serverActions.md:24-42` — the limit applies to the raw multipart body, so leave headroom above the 10 MB file cap.

- [ ] **Step 1: The upload handler**

In `drafts/[releaseId]/mdx-editor.tsx` add `useCallback` to the React import (`toast` is already imported, line 6) and import the action:

```ts
import { uploadImageFile } from "./image-actions";
```

Inside the wrapper component (before `return`):

```ts
  // Drag-drop / paste / file-tab uploads (spec §5): post the file to the
  // upload action and hand the plugin the blob URL to insert. Throwing makes
  // the plugin abandon the insert (it catches and logs); the toast is ours.
  const imageUploadHandler = useCallback(
    async (file: File) => {
      const fd = new FormData();
      fd.set("contentPieceId", contentPieceId);
      fd.set("role", "body");
      fd.set("file", file);
      const result = await uploadImageFile(fd);
      if (!result.ok) {
        toast.error(result.error);
        throw new Error(result.error);
      }
      return result.url;
    },
    [contentPieceId]
  );
```

and pass `imageUploadHandler={imageUploadHandler}` on `<SharedMdxEditor>` (next to `imageToolbar`).

- [ ] **Step 2: The image rule**

In `src/app/globals.css`, after the `.mdx-content hr` block (line 278) add:

```css
/* No img rule existed (spec §5 plumbing note): body illustrations are 1200px
   masters, so cap them at the column and give them the same vertical rhythm
   as paragraphs. Applies inside the editor only — published HTML goes through
   render.ts and the destination's own styles. */
.mdx-content img {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 1rem 0;
  border-radius: 0.5rem;
}
```

- [ ] **Step 3: `next.config.ts`**

Replace the file with:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev-only: allow the app to be loaded through an ngrok tunnel. Without this,
  // Next dev blocks the tunnel origin's HMR/asset requests, the client bundle
  // never hydrates, and nothing interactive works. Wildcards cover the changing
  // free-tier subdomain and static/paid ngrok domains. Has no effect in prod.
  allowedDevOrigins: [
    "1223-2a0d-6fc0-2319-8100-8df9-803a-237a-9a0a.ngrok-free.app",
    "*.ngrok-free.app",
    "*.ngrok.app",
    "*.ngrok.io",
  ],
  // Covers and library thumbnails render through next/image from Vercel Blob
  // (spec §5 plumbing note). Store hosts are `<store-id>.public.blob.vercel-storage.com`.
  images: {
    remotePatterns: [{ protocol: "https", hostname: "*.public.blob.vercel-storage.com", search: "" }],
  },
  experimental: {
    // Server Actions run a CSRF check comparing the request Origin to the host.
    // Over a tunnel the browser Origin is the ngrok host, so allow it or form
    // submits (Server Actions) are silently rejected.
    serverActions: {
      allowedOrigins: [
        "1223-2a0d-6fc0-2319-8100-8df9-803a-237a-9a0a.ngrok-free.app",
        "*.ngrok-free.app",
        "*.ngrok.app",
        "*.ngrok.io",
      ],
      // Image uploads (uploadImageFile) accept files up to 10 MB; the default
      // 1 MB action body would reject them. Headroom for multipart framing.
      bodySizeLimit: "11mb",
    },
  },
};

export default nextConfig;
```

- [ ] **Step 4: Gates**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: clean; `next build` validates the config keys (an unknown key fails the build, so a typo here surfaces now, not in prod).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/drafts/[releaseId]/mdx-editor.tsx" src/app/globals.css next.config.ts
git commit -m "feat: image uploads from the editor, blob host for next/image, img rule"
```

---

### Task 9: Cover panel above the title

**Files:**
- Create: `src/app/(dashboard)/drafts/[releaseId]/cover-panel.tsx` (`"use client"`)
- Modify: `src/app/(dashboard)/drafts/[releaseId]/page.tsx` — imports (after line 32), data loads (after the LinkedIn loads, lines 240-241), and the editor branch: render `<CoverPanel>` right before `<ToastForm` (line 299) so it sits above the title without nesting inside the save form.
- Not modified: `src/app/(dashboard)/board/card.tsx`. The board card thumbnail (spec §3 "read by … the board card thumbnail") needs `BoardCard` (`src/lib/content/board.ts:49-68`) to carry a `coverUrl`, a join in the board query and its tests — a self-contained follow-up, noted in Self-review, not squeezed into a UI task.

**Interfaces:**
- Consumes: `getOrCreateCompanyProfile` (`src/lib/workspace/company-profile.ts:5`), `resolveImagePolicy(policy, type)` (`src/lib/images/policy.ts`), `getCoverImage` (store), `generateCover`, `removeCover`, `uploadImageFile`, `suggestImagePrompt` (Task 4), `next/image` (host allowed in Task 8), `DropdownMenu*` (`src/components/ui/dropdown-menu.tsx:252-268`, trigger via `render` as in `layout.tsx:43`), `Dialog*` (`src/components/ui/dialog.tsx:150-161`), `useRouter().refresh` — the actions `revalidatePath` the page but the panel also keeps local state so the new cover shows the moment the action returns.
- Produces:
  ```tsx
  export type CoverState = { url: string; alt: string; concept: string; sourceKind: "generated" | "uploaded" } | null;
  export function CoverPanel({ contentPieceId, initial }: { contentPieceId: string; initial: CoverState }): JSX.Element;
  ```

Behaviour (spec §5 Cover): no cover → **Add cover** → menu **Generate from post** → **Write a prompt** (dialog pre-filled: the previous concept when changing, otherwise `suggestImagePrompt({ role: "cover" })` — never empty) → **Upload**. A cover shows via `next/image` (1200×630) with hover **Change** (reopens the menu with the previous concept) / **Remove**. Rendered only when the type's policy has `cover: true` (spec §6). Task 10 adds **From library** to this menu.

- [ ] **Step 1: The panel**

Create `src/app/(dashboard)/drafts/[releaseId]/cover-panel.tsx`:

```tsx
"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ImageIcon, Loader2, PencilLine, Sparkles, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { generateCover, removeCover, suggestImagePrompt, uploadImageFile } from "./image-actions";

export type CoverState = { url: string; alt: string; concept: string; sourceKind: "generated" | "uploaded" } | null;

/**
 * The Notion-pattern cover above the title (spec §5 Cover). A per-piece
 * secondary artifact like linkedin-panel.tsx: generate / change / remove,
 * backed by the role:"cover" content_images row — never derived from the
 * first body image.
 */
export function CoverPanel({ contentPieceId, initial }: { contentPieceId: string; initial: CoverState }) {
  const router = useRouter();
  const [cover, setCover] = useState<CoverState>(initial);
  const [busy, setBusy] = useState<string | null>(null); // label of the in-flight step
  const [promptOpen, setPromptOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  async function run(label: string, action: () => Promise<{ ok: true; url: string } | { ok: false; error: string }>, next: (url: string) => CoverState) {
    setBusy(label);
    try {
      const result = await action();
      if (!result.ok) {
        toast.error(result.error);
        return false;
      }
      setCover(next(result.url));
      router.refresh();
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong");
      return false;
    } finally {
      setBusy(null);
    }
  }

  function generateFromPost() {
    void run("Generating cover from the post…", () => generateCover({ contentPieceId, mode: "from_post" }), (url) => ({
      url,
      alt: "",
      concept: "",
      sourceKind: "generated",
    }));
  }

  async function openPrompt() {
    setPromptOpen(true);
    if (cover?.concept) {
      setPrompt(cover.concept);
      return;
    }
    // "Write a prompt" is never empty: pre-fill with the auto-drafted concept.
    setSuggesting(true);
    try {
      const out = await suggestImagePrompt({ contentPieceId, surroundingMarkdown: "", role: "cover" });
      setPrompt((current) => current || out.concept);
    } catch {
      // Leave the field empty; the user can still type.
    } finally {
      setSuggesting(false);
    }
  }

  function generateFromPrompt() {
    const concept = prompt.trim();
    if (!concept) return;
    void run("Generating cover…", () => generateCover({ contentPieceId, mode: "prompt", prompt: concept }), (url) => ({
      url,
      alt: "",
      concept,
      sourceKind: "generated",
    })).then((ok) => ok && setPromptOpen(false));
  }

  function upload(file: File) {
    const fd = new FormData();
    fd.set("contentPieceId", contentPieceId);
    fd.set("role", "cover");
    fd.set("file", file);
    void run("Uploading…", () => uploadImageFile(fd), (url) => ({ url, alt: "", concept: "", sourceKind: "uploaded" }));
  }

  async function remove() {
    setBusy("Removing…");
    try {
      await removeCover({ contentPieceId });
      setCover(null);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  const menu = (trigger: React.ReactElement) => (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuItem onClick={generateFromPost}>
          <Sparkles /> Generate from post
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void openPrompt()}>
          <PencilLine /> Write a prompt
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => fileInput.current?.click()}>
          <Upload /> Upload
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <section aria-label="Cover image" className="space-y-2">
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) upload(file);
        }}
      />

      {busy ? (
        <div className="flex aspect-[1200/630] w-full items-center justify-center gap-3 rounded-lg border bg-muted/30 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {busy}
        </div>
      ) : cover ? (
        <div className="group relative overflow-hidden rounded-lg border">
          <Image src={cover.url} alt={cover.alt} width={1200} height={630} className="h-auto w-full" priority />
          <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            {menu(<Button type="button" size="sm" variant="secondary">Change</Button>)}
            <Button type="button" size="sm" variant="secondary" onClick={() => void remove()}>
              <Trash2 className="size-3.5" /> Remove
            </Button>
          </div>
        </div>
      ) : (
        menu(
          <Button type="button" variant="ghost" className="dashed-outline h-auto w-full justify-center py-6 text-muted-foreground">
            <ImageIcon className="size-4" /> Add cover
          </Button>
        )
      )}

      <Dialog open={promptOpen} onOpenChange={(next) => !next && !busy && setPromptOpen(false)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="size-4" /> Cover prompt
            </DialogTitle>
            <DialogDescription>Describe what the cover shows. Style, colours and mood come from your brand&apos;s visual identity.</DialogDescription>
          </DialogHeader>
          <div className="relative">
            <Textarea
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={suggesting ? "Drafting a suggestion…" : "e.g. A lighthouse beam sweeping across a sea of documents"}
              disabled={suggesting}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") generateFromPrompt();
              }}
            />
            {suggesting && <Loader2 className="absolute right-2 top-2 size-4 animate-spin text-muted-foreground" />}
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button onClick={generateFromPrompt} disabled={suggesting || !prompt.trim()}>
              Generate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
```

`DropdownMenuTrigger render={trigger}` with no children — Base UI renders the `render` element as the trigger and its children are that element's; if the installed `@base-ui/react` requires children, pass the button's content as `DropdownMenuTrigger`'s children instead (the `layout.tsx:43-46` shape). `ImageIcon` is lucide's exported name for the image glyph (`Image` would clash with `next/image`).

- [ ] **Step 2: Load the data and render the panel**

In `page.tsx` add imports after line 32:

```ts
import { getOrCreateCompanyProfile } from "@/lib/workspace/company-profile";
import { resolveImagePolicy } from "@/lib/images/policy";
import { getCoverImage } from "@/lib/images/store";
import { CoverPanel, type CoverState } from "./cover-panel";
```

After the LinkedIn loads (line 241) add:

```ts
  // The per-type image policy (spec §6) decides whether the piece has a cover
  // affordance at all; the profile is one fetch, same as generation reads it.
  const profile = await getOrCreateCompanyProfile(session.user.tenantId);
  const showCover = resolveImagePolicy(profile.imagePolicy, update.type).cover;
  const coverRow = showCover ? await getCoverImage(session.user.tenantId, update.id) : null;
  const cover: CoverState = coverRow?.current
    ? {
        url: coverRow.current.blobUrl,
        alt: coverRow.altText,
        concept: coverRow.concept,
        sourceKind: coverRow.sourceKind === "uploaded" ? "uploaded" : "generated",
      }
    : null;
```

And right before `<ToastForm` (line 299), still inside the providers:

```tsx
          {showCover && <CoverPanel contentPieceId={update.id} initial={cover} />}
```

- [ ] **Step 3: Gates**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(dashboard)/drafts/[releaseId]/cover-panel.tsx" "src/app/(dashboard)/drafts/[releaseId]/page.tsx"
git commit -m "feat: cover image panel above the draft title"
```

---

### Task 10: Image library — nav entry, `/images`, detail, generate, delete, picker

**Files:**
- Modify: `src/app/(dashboard)/nav-links.tsx` — `NAV` (lines 17-24) gains `{ href: "/images", label: "Images", icon: Images }` after Calendar; import `Images` from lucide (lines 5-12).
- Modify: `tests/components/nav-links.test.tsx:26` — `HREFS` gains `"/images"` so "no other entry carries the count" covers it.
- Create: `src/app/(dashboard)/images/actions.ts` (`"use server"`), `page.tsx`, `image-filters.tsx`, `image-card.tsx`, `image-detail.tsx`, `generate-dialog.tsx`, `library-picker.tsx`
- Modify: `src/app/(dashboard)/drafts/[releaseId]/cover-panel.tsx` — add **From library** to the menu; `src/app/(dashboard)/drafts/[releaseId]/generate-image-panel.tsx` — add a **From library** button in the footer row.
- Test: `tests/app/images/actions.test.ts`

**Interfaces:**
- Consumes: `listImages`, `getImage`, `deleteImage`, `createImage` (store); `renderAndStore` (Task 4 helper); `stripImageFromMarkdown`, `imageSlug`, `sizeForRole` (Task 1); `buildImagePrompt`, `compileStyleBlock`, `isVisualIdentityReady`, `getOrCreateCompanyProfile`; `regenerateImage`, `restoreRender`, `lookupImageBySrc`, `setCoverFromImage` (Task 4 — imported by client components as Server Function references, the same way `board/card.tsx:21` imports `generateDraft` from a sibling route); `SearchParamsRecord` shape (`company/filter-params.ts:28`); `Select*` (`select.tsx:190-201`), `Dialog*`, `Badge`, `Card`, `EmptyState` (`src/components/ui/empty-state.tsx` — read its props before use; fall back to a plain `<p>` if it doesn't fit).
- Produces:
  ```ts
  // images/actions.ts
  export async function deleteLibraryImage(imageId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  export async function generateLibraryImage(a: { prompt: string; concept: string }): Promise<{ ok: true; imageId: string; url: string } | { ok: false; error: string }>;
  export type PickerImage = { imageId: string; url: string; concept: string; role: ImageRole; pieceTitle: string | null };
  export async function listImagesForPicker(): Promise<PickerImage[]>;      // additive to the contract: the picker dialog needs a client-callable list
  // image-card.tsx
  export type LibraryImage = { id: string; role: ImageRole; sourceKind: ImageSourceKind; status: string; concept: string; altText: string; contentPieceId: string | null; pieceTitle: string | null; piecePublished: boolean; createdAt: string; url: string | null; prompt: string };
  export function ImageGrid({ images }: { images: LibraryImage[] }): JSX.Element;   // cards + the detail dialog state
  // library-picker.tsx
  export function LibraryPicker({ open, onOpenChange, onPick }: { open: boolean; onOpenChange: (o: boolean) => void; onPick: (image: PickerImage) => void | Promise<void> }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing actions test**

Create `tests/app/images/actions.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, users, contentPieces, companyProfiles, contentImages, type VisualIdentity } from "../../../src/db/schema";
import { DEFAULT_VISUAL_IDENTITY } from "../../../src/lib/images/visual-identity";
import { createImage, addRender, getImage } from "../../../src/lib/images/store";

const TENANT_NAME = "Images Library Actions Test Tenant";
const USER_EMAIL = "images-actions-test@example.com";
let currentTenantId = "";
let currentUserId: string | null = null;

vi.mock("../../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: currentUserId } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const renderImage = vi.fn(async () => Buffer.from("PNG"));
vi.mock("../../../src/lib/ai/images", () => ({ renderImage: () => renderImage() }));
vi.mock("../../../src/lib/images/compress", () => ({
  compressPng: vi.fn(async (png: Buffer, maxWidth: number) => ({ png, width: maxWidth, height: 900 })),
}));
const deleteBlobs = vi.fn(async (_p: string[]) => {});
vi.mock("../../../src/lib/images/blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/images/blob")>();
  return {
    ...actual,
    uploadPng: vi.fn(async (pathname: string) => ({ url: `https://blob.example/${pathname}`, pathname })),
    deleteBlobs: (p: string[]) => deleteBlobs(p),
  };
});

import { deleteLibraryImage, generateLibraryImage, listImagesForPicker } from "../../../src/app/(dashboard)/images/actions";

const VI: VisualIdentity = {
  ...DEFAULT_VISUAL_IDENTITY,
  palette: [
    { hex: "#112233", role: "primary" },
    { hex: "#445566", role: "secondary" },
    { hex: "#ffffff", role: "background" },
  ],
};

async function seed(opts: { published?: boolean } = {}) {
  const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
  const [user] = await db.insert(users).values({ email: USER_EMAIL }).returning();
  currentTenantId = tenant.id;
  currentUserId = user.id;
  await db.insert(companyProfiles).values({ tenantId: tenant.id, topics: [], visualIdentity: VI });
  const [piece] = await db
    .insert(contentPieces)
    .values({
      tenantId: tenant.id,
      type: "blog_post",
      title: "Piece",
      body: "## A\n\n![Gears](https://blob.example/gears.png)\n\nText.",
      status: opts.published ? "published" : "draft",
      publishedAt: opts.published ? new Date() : null,
    })
    .returning();
  const image = await createImage({ tenantId: tenant.id, contentPieceId: piece.id, role: "body", concept: "gears", altText: "Gears", sourceKind: "generated" });
  await addRender({ imageId: image.id, prompt: "p", blobUrl: "https://blob.example/gears.png", blobPathname: "p/gears.png", width: 1, height: 1, bytes: 1, model: "m" });
  return { tenant, piece, image };
}

afterEach(async () => {
  deleteBlobs.mockClear();
  await db.delete(tenants).where(eq(tenants.name, TENANT_NAME));
  await db.delete(users).where(eq(users.email, USER_EMAIL));
});

describe("deleteLibraryImage", () => {
  it("removes the row, its blobs, and the image line from the piece body", async () => {
    const { tenant, piece, image } = await seed();
    expect(await deleteLibraryImage(image.id)).toEqual({ ok: true });
    expect(await getImage(tenant.id, image.id)).toBeNull();
    expect(deleteBlobs).toHaveBeenLastCalledWith(["p/gears.png"]);
    const [row] = await db.select({ body: contentPieces.body }).from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(row.body).toBe("## A\n\nText.");
  });

  it("refuses an image referenced by a published piece, leaving body and row alone", async () => {
    const { tenant, piece, image } = await seed({ published: true });
    expect(await deleteLibraryImage(image.id)).toEqual({ ok: false, reason: "published" });
    expect(await getImage(tenant.id, image.id)).not.toBeNull();
    const [row] = await db.select({ body: contentPieces.body }).from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(row.body).toContain("gears.png");
  });

  it("returns not_found for another tenant's image", async () => {
    await seed();
    const [other] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
    const foreign = await createImage({ tenantId: other.id, contentPieceId: null, role: "library", concept: "c", altText: "a", sourceKind: "generated" });
    expect(await deleteLibraryImage(foreign.id)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("generateLibraryImage", () => {
  it("creates a role:library row with no piece and a ready render", async () => {
    const { tenant } = await seed();
    const result = await generateLibraryImage({ prompt: "A compass on a map", concept: "A compass on a map" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = await getImage(tenant.id, result.imageId);
    expect(row).toMatchObject({ role: "library", contentPieceId: null, sourceKind: "generated", status: "ready" });
    expect(row?.current?.blobUrl).toBe(result.url);
    expect(row?.current?.blobPathname).toContain(`tenants/${tenant.id}/content/library/library-a-compass-on-a-map.png`);
  });

  it("refuses without a ready identity", async () => {
    const { tenant } = await seed();
    await db.update(companyProfiles).set({ visualIdentity: null }).where(eq(companyProfiles.tenantId, tenant.id));
    expect(await generateLibraryImage({ prompt: "x", concept: "x" })).toEqual({
      ok: false,
      error: "Set up your visual identity in Company settings before generating images.",
    });
  });
});

describe("listImagesForPicker", () => {
  it("lists only images with a current render, newest first, with the piece title", async () => {
    const { tenant, piece } = await seed();
    await createImage({ tenantId: tenant.id, contentPieceId: null, role: "library", concept: "no render yet", altText: "", sourceKind: "generated" });
    const out = await listImagesForPicker();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ url: "https://blob.example/gears.png", concept: "gears", role: "body", pieceTitle: "Piece" });
    expect(piece.id).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/app/images/actions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: The actions**

Create `src/app/(dashboard)/images/actions.ts`:

```ts
"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { contentPieces, type ImageRole } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { getOrCreateCompanyProfile } from "@/lib/workspace/company-profile";
import { compileStyleBlock, isVisualIdentityReady } from "@/lib/images/visual-identity";
import { buildImagePrompt } from "@/lib/images/prompt";
import { renderAndStore } from "@/lib/images/generate";
import { createImage, deleteImage, getImage, listImages } from "@/lib/images/store";
import { altFromConcept, imageSlug, sizeForRole, stripImageFromMarkdown } from "@/lib/images/actions-support";

const NO_IDENTITY = "Set up your visual identity in Company settings before generating images.";

/**
 * Library delete (spec §5b): the row, its renders' blobs, AND the piece's
 * markdown line(s) for any of its render URLs — so a draft never keeps a
 * dead image. `deleteImage` refuses for a published piece (Webflow hotlinks)
 * and the UI shows why; the body is only touched once the delete is allowed.
 * The cover pointer needs no extra work: the cover IS the row being deleted.
 */
export async function deleteLibraryImage(imageId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const image = await getImage(tenantId, imageId);
  if (!image) return { ok: false, reason: "not_found" };

  const result = await deleteImage(tenantId, imageId);
  if (!result.ok) return result;

  if (image.contentPieceId && image.renders.length > 0) {
    const [piece] = await db
      .select({ body: contentPieces.body })
      .from(contentPieces)
      .where(eq(contentPieces.id, image.contentPieceId));
    if (piece) {
      const next = stripImageFromMarkdown(piece.body, image.renders.map((r) => r.blobUrl));
      // A human chose to remove content from the draft: stamp it like saveDraftBody does.
      if (next !== piece.body) {
        await db
          .update(contentPieces)
          .set({ body: next, editedBy: session.user.id, bodyEditedAt: new Date() })
          .where(eq(contentPieces.id, image.contentPieceId));
      }
    }
    revalidatePath(`/drafts/${image.contentPieceId}`);
  }
  revalidatePath("/images");
  revalidatePath("/board");
  return { ok: true };
}

/** "Generate new" in the library (spec §5b): a standalone role:"library" row, body-sized. */
export async function generateLibraryImage(a: {
  prompt: string;
  concept: string;
}): Promise<{ ok: true; imageId: string; url: string } | { ok: false; error: string }> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const concept = (a.concept || a.prompt).trim();
  if (!concept) return { ok: false, error: "Describe what the image should show." };

  const profile = await getOrCreateCompanyProfile(tenantId);
  const vi = profile.visualIdentity;
  if (!vi || !isVisualIdentityReady(vi)) return { ok: false, error: NO_IDENTITY };

  const image = await createImage({ tenantId, contentPieceId: null, role: "library", concept, altText: altFromConcept(concept), sourceKind: "generated" });
  try {
    const render = await renderAndStore({
      tenantId,
      imageId: image.id,
      contentPieceId: null,
      role: "library",
      slug: imageSlug(concept),
      prompt: buildImagePrompt({ styleBlock: compileStyleBlock(vi), concept, role: "body", allowText: vi.allowTextInImages }),
      size: sizeForRole("library"),
      referenceImages: vi.styleReferenceImages,
    });
    revalidatePath("/images");
    return { ok: true, imageId: image.id, url: render.blobUrl };
  } catch (error) {
    await deleteImage(tenantId, image.id);
    return { ok: false, error: error instanceof Error ? error.message : "Something went wrong" };
  }
}

export type PickerImage = { imageId: string; url: string; concept: string; role: ImageRole; pieceTitle: string | null };

/** What "From library" lists (spec §5b): every image with a current render, newest first. */
export async function listImagesForPicker(): Promise<PickerImage[]> {
  const session = await requireSession();
  const rows = await listImages(session.user.tenantId);
  return rows
    .filter((r) => r.current !== null)
    .map((r) => ({ imageId: r.id, url: r.current!.blobUrl, concept: r.concept, role: r.role as ImageRole, pieceTitle: r.pieceTitle }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/app/images/actions.test.ts`
Expected: PASS.

- [ ] **Step 5: The page and filters**

Create `src/app/(dashboard)/images/image-filters.tsx`:

```tsx
"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type ImageFilterState = { pieceId: string; role: string; source: string };

const ROLE_OPTIONS = [
  { value: "all", label: "All roles" },
  { value: "cover", label: "Cover" },
  { value: "body", label: "Body" },
  { value: "library", label: "Library" },
];
const SOURCE_OPTIONS = [
  { value: "all", label: "All sources" },
  { value: "generated", label: "Generated" },
  { value: "uploaded", label: "Uploaded" },
];

function labelFor(options: { value: string; label: string }[], value: string) {
  return options.find((o) => o.value === value)?.label ?? value;
}

/**
 * Same shape as company/change-events-filters.tsx: values come from the
 * server-rendered page (searchParams is the source of truth); a change pushes
 * a new URL and the Server Component re-runs `listImages`.
 */
export function ImageFilters({ state, pieces }: { state: ImageFilterState; pieces: { id: string; title: string }[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function push(next: Partial<ImageFilterState>) {
    const merged = { ...state, ...next };
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(merged)) {
      if (value === "all" || value === "") params.delete(key);
      else params.set(key, value);
    }
    const qs = params.toString();
    router.push(`/images${qs ? `?${qs}` : ""}`, { scroll: false });
  }

  const active = state.pieceId !== "all" || state.role !== "all" || state.source !== "all";
  const pieceOptions = [{ value: "all", label: "All pieces" }, ...pieces.map((p) => ({ value: p.id, label: p.title || "Untitled" }))];

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Select value={state.pieceId} onValueChange={(v) => push({ pieceId: String(v) })}>
        <SelectTrigger className="w-56">
          <SelectValue>{labelFor(pieceOptions, state.pieceId)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {pieceOptions.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={state.role} onValueChange={(v) => push({ role: String(v) })}>
        <SelectTrigger className="w-36">
          <SelectValue>{labelFor(ROLE_OPTIONS, state.role)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {ROLE_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={state.source} onValueChange={(v) => push({ source: String(v) })}>
        <SelectTrigger className="w-40">
          <SelectValue>{labelFor(SOURCE_OPTIONS, state.source)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {SOURCE_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {active && (
        <Button type="button" variant="ghost" size="sm" onClick={() => push({ pieceId: "all", role: "all", source: "all" })}>
          Clear
        </Button>
      )}
    </div>
  );
}
```

`onValueChange`'s value type: `change-events-filters.tsx:91` casts it; `String(v)` covers Base UI's `unknown`-typed value.

Create `src/app/(dashboard)/images/page.tsx`:

```tsx
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { contentPieces, type ImageRole, type ImageSourceKind } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { listImages } from "@/lib/images/store";
import { Badge } from "@/components/ui/badge";
import { ImageFilters } from "./image-filters";
import { ImageGrid, type LibraryImage } from "./image-card";
import { GenerateDialog } from "./generate-dialog";

const ROLES: readonly ImageRole[] = ["cover", "body", "library"];
const SOURCES: readonly ImageSourceKind[] = ["generated", "uploaded"];

export default async function ImagesPage({
  searchParams,
}: {
  searchParams: Promise<{ pieceId?: string; role?: string; source?: string }>;
}) {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const sp = await searchParams;
  const role = ROLES.find((r) => r === sp.role);
  const source = SOURCES.find((s) => s === sp.source);
  const pieceId = sp.pieceId && sp.pieceId !== "all" ? sp.pieceId : undefined;

  const [rows, pieces, publishedRows] = await Promise.all([
    listImages(tenantId, { contentPieceId: pieceId, role, sourceKind: source }),
    db
      .select({ id: contentPieces.id, title: contentPieces.title })
      .from(contentPieces)
      .where(eq(contentPieces.tenantId, tenantId))
      .orderBy(desc(contentPieces.createdAt))
      .limit(200),
    // Which pieces are published decides which images can't be deleted (spec
    // §5b, Webflow hotlink safety) — computed here so the button can explain
    // before a click rather than after a refusal.
    db
      .select({ id: contentPieces.id })
      .from(contentPieces)
      .where(and(eq(contentPieces.tenantId, tenantId), isNotNull(contentPieces.publishedAt))),
  ]);
  const published = new Set(publishedRows.map((p) => p.id));

  const images: LibraryImage[] = rows.map((r) => ({
    id: r.id,
    role: r.role as ImageRole,
    sourceKind: r.sourceKind as ImageSourceKind,
    status: r.status,
    concept: r.concept,
    altText: r.altText,
    contentPieceId: r.contentPieceId,
    pieceTitle: r.pieceTitle,
    piecePublished: r.contentPieceId ? published.has(r.contentPieceId) : false,
    createdAt: r.createdAt.toISOString(),
    url: r.current?.blobUrl ?? null,
    prompt: r.current?.prompt ?? "",
  }));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="font-heading text-3xl leading-[1.15] tracking-[0.015em]">Images</h1>
        <Badge variant="secondary">{images.length}</Badge>
        <div className="ml-auto">
          <GenerateDialog />
        </div>
      </div>
      <p className="text-sm text-muted-foreground">Every generated and uploaded image across your content, newest first.</p>
      <ImageFilters state={{ pieceId: pieceId ?? "all", role: role ?? "all", source: source ?? "all" }} pieces={pieces} />
      {images.length === 0 ? (
        <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">No images yet. Generate one here, or from a draft&apos;s editor.</p>
      ) : (
        <ImageGrid images={images} />
      )}
    </div>
  );
}
```

- [ ] **Step 6: Cards, detail, generate dialog**

Create `src/app/(dashboard)/images/image-card.tsx`:

```tsx
"use client";

import { useState } from "react";
import Image from "next/image";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import type { ImageRole, ImageSourceKind } from "@/db/schema";
import { ImageDetail } from "./image-detail";

export type LibraryImage = {
  id: string;
  role: ImageRole;
  sourceKind: ImageSourceKind;
  status: string;
  concept: string;
  altText: string;
  contentPieceId: string | null;
  pieceTitle: string | null;
  piecePublished: boolean;
  createdAt: string;
  url: string | null;
  prompt: string;
};

const ROLE_LABEL: Record<ImageRole, string> = { cover: "Cover", body: "Body", library: "Library" };

/** The thumbnail grid plus the one detail dialog it opens (spec §5b Card). */
export function ImageGrid({ images }: { images: LibraryImage[] }) {
  const [selected, setSelected] = useState<LibraryImage | null>(null);
  return (
    <>
      <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {images.map((image) => (
          <li key={image.id}>
            <button
              type="button"
              onClick={() => setSelected(image)}
              className="group block w-full space-y-2 rounded-lg border p-2 text-left transition-colors hover:bg-muted/50"
            >
              <div className="relative aspect-[4/3] overflow-hidden rounded-md bg-muted">
                {image.url ? (
                  <Image src={image.url} alt={image.altText} fill sizes="(min-width: 1024px) 25vw, 50vw" className="object-cover" />
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    {image.status === "failed" ? "Render failed" : "Rendering…"}
                  </div>
                )}
              </div>
              <p className="line-clamp-2 text-sm">{image.concept || "Untitled image"}</p>
              <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                <Badge variant="outline">{ROLE_LABEL[image.role]}</Badge>
                {image.sourceKind === "uploaded" && <Badge variant="outline">Uploaded</Badge>}
                <span className="ml-auto">{format(new Date(image.createdAt), "d MMM yyyy")}</span>
              </div>
              {image.pieceTitle && <p className="truncate text-xs text-muted-foreground">{image.pieceTitle}</p>}
            </button>
          </li>
        ))}
      </ul>
      <ImageDetail image={selected} onClose={() => setSelected(null)} />
    </>
  );
}
```

Create `src/app/(dashboard)/images/image-detail.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, PencilLine, RefreshCw, Trash2, WandSparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { lookupImageBySrc, regenerateImage, restoreRender, type ImageLookup } from "../drafts/[releaseId]/image-actions";
import { deleteLibraryImage } from "./actions";
import type { LibraryImage } from "./image-card";

type View = "menu" | "prompt" | "edit" | "confirmDelete";

/**
 * Detail view (spec §5b): the render history strip and the same three edit
 * actions as the editor, by imageId. For an image sitting in a draft, the
 * server actions swap the URL in the stored body themselves (Task 4), so
 * this view needs no editor bridge.
 */
export function ImageDetail({ image, onClose }: { image: LibraryImage | null; onClose: () => void }) {
  const router = useRouter();
  const [lookup, setLookup] = useState<ImageLookup | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [view, setView] = useState<View>("menu");
  const [prompt, setPrompt] = useState("");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setView("menu");
    setInstruction("");
    setCurrent(image?.url ?? null);
    setLookup(null);
    if (!image?.url) return;
    let cancelled = false;
    void lookupImageBySrc(image.url).then((found) => {
      if (cancelled) return;
      setLookup(found);
      setPrompt(found?.currentPrompt ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [image]);

  if (!image) return <Dialog open={false} />;

  const generated = image.sourceKind === "generated";

  async function run(action: () => Promise<{ ok: true; url: string } | { ok: false; error: string }>, success: string) {
    if (!image) return;
    setBusy(true);
    try {
      const result = await action();
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setCurrent(result.url);
      const found = await lookupImageBySrc(result.url);
      setLookup(found);
      setPrompt(found?.currentPrompt ?? "");
      setView("menu");
      toast.success(success);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!image) return;
    setBusy(true);
    try {
      const result = await deleteLibraryImage(image.id);
      if (!result.ok) {
        toast.error(result.reason === "published" ? "This image is used by a published piece and can't be deleted." : "Couldn't delete this image.");
        return;
      }
      toast.success("Image deleted");
      onClose();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const imageId = lookup?.imageId ?? image.id;

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{image.concept || "Untitled image"}</DialogTitle>
          <DialogDescription>
            {image.pieceTitle && image.contentPieceId ? (
              <>
                Used in{" "}
                <Link href={`/drafts/${image.contentPieceId}`} className="underline">
                  {image.pieceTitle}
                </Link>
                {" · "}
              </>
            ) : null}
            {image.sourceKind === "uploaded" ? "Uploaded" : "Generated"} · {image.role}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-[1fr_16rem]">
          <div className="relative aspect-[4/3] overflow-hidden rounded-md bg-muted">
            {busy ? (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Working…
              </div>
            ) : current ? (
              <Image src={current} alt={image.altText} fill sizes="(min-width: 640px) 60vw, 100vw" className="object-contain" />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No render</div>
            )}
          </div>

          <div className="space-y-3 text-sm">
            {generated && view === "menu" && (
              <div className="space-y-1">
                <Button type="button" variant="outline" className="w-full justify-start" disabled={busy || !current} onClick={() => setView("prompt")}>
                  <PencilLine className="size-4" /> Edit prompt
                </Button>
                <Button type="button" variant="outline" className="w-full justify-start" disabled={busy || !current} onClick={() => setView("edit")}>
                  <WandSparkles className="size-4" /> Describe a change
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-start"
                  disabled={busy || !current}
                  onClick={() => void run(() => regenerateImage({ imageId, mode: "same" }), "Illustration regenerated")}
                >
                  <RefreshCw className="size-4" /> Regenerate
                </Button>
              </div>
            )}
            {generated && view === "prompt" && (
              <div className="space-y-2">
                <Textarea rows={8} value={prompt} onChange={(e) => setPrompt(e.target.value)} className="text-xs" />
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setView("menu")}>Back</Button>
                  <Button type="button" size="sm" disabled={busy || !prompt.trim()} onClick={() => void run(() => regenerateImage({ imageId, mode: "prompt", prompt }), "Illustration regenerated")}>
                    Regenerate
                  </Button>
                </div>
              </div>
            )}
            {generated && view === "edit" && (
              <div className="space-y-2">
                <Input autoFocus value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="e.g. remove the third figure" />
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setView("menu")}>Back</Button>
                  <Button type="button" size="sm" disabled={busy || !instruction.trim()} onClick={() => void run(() => regenerateImage({ imageId, mode: "edit", instruction }), "Change applied")}>
                    Apply
                  </Button>
                </div>
              </div>
            )}

            {lookup && lookup.renders.length > 1 && (
              <div className="space-y-1 border-t pt-3">
                <p className="text-xs text-muted-foreground">History</p>
                <div className="flex flex-wrap gap-1.5">
                  {lookup.renders.map((r) => {
                    const isCurrent = r.id === lookup.currentRenderId;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        disabled={isCurrent || busy}
                        title={isCurrent ? "Current render" : "Restore this render"}
                        className={`relative size-14 overflow-hidden rounded border ${isCurrent ? "ring-2 ring-primary" : "hover:opacity-80"}`}
                        onClick={() => void run(() => restoreRender({ imageId, renderId: r.id }), "Render restored")}
                      >
                        <Image src={r.url} alt="" fill sizes="56px" className="object-cover" />
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="border-t pt-3">
              {image.piecePublished ? (
                <p className="text-xs text-muted-foreground">Used by a published piece — it can&apos;t be deleted while that page may still link to it.</p>
              ) : view === "confirmDelete" ? (
                <div className="space-y-2">
                  <p className="text-xs">
                    Delete this image and its render history?
                    {image.pieceTitle ? ` It is used in “${image.pieceTitle}” — its line will be removed from that draft too.` : ""}
                  </p>
                  <div className="flex justify-end gap-2">
                    <Button type="button" variant="ghost" size="sm" onClick={() => setView("menu")}>Cancel</Button>
                    <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={() => void remove()}>Delete</Button>
                  </div>
                </div>
              ) : (
                <Button type="button" variant="ghost" size="sm" className="text-destructive" disabled={busy} onClick={() => setView("confirmDelete")}>
                  <Trash2 className="size-4" /> Delete
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

If `Button` has no `variant="destructive"` (check `button.tsx:7-48`), use `variant="outline"` with `className="text-destructive"`. If lint's `react-hooks/set-state-in-effect` flags the effect's synchronous `setView/setCurrent/setLookup` resets, move them into the `onClick` that sets `selected` in `ImageGrid` (reset via a `key={selected?.id}` on `<ImageDetail>` instead — remounting resets state), and keep only the async lookup in the effect.

Create `src/app/(dashboard)/images/generate-dialog.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { generateLibraryImage } from "./actions";

/** "Generate new" (spec §5b): a standalone concept → render into the library. */
export function GenerateDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  async function generate() {
    const concept = prompt.trim();
    if (!concept) return;
    setBusy(true);
    try {
      const result = await generateLibraryImage({ prompt: concept, concept });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Image generated");
      setPrompt("");
      setOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <DialogTrigger render={<Button />}>
        <Sparkles className="size-4" /> Generate new
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Generate an image</DialogTitle>
          <DialogDescription>Describe what it shows; your brand&apos;s visual identity decides how it looks. It lands in the library, ready to reuse in any draft.</DialogDescription>
        </DialogHeader>
        {busy ? (
          <div className="flex items-center gap-3 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Composing illustration…
          </div>
        ) : (
          <Textarea
            autoFocus
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. A compass resting on an unfolded map"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void generate();
            }}
          />
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" disabled={busy} />}>Cancel</DialogClose>
          <Button onClick={() => void generate()} disabled={busy || !prompt.trim()}>
            {busy ? "Working…" : "Generate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

`showCloseButton` on `DialogContent` exists (`agent-edit-dialog.tsx:147` uses it).

- [ ] **Step 7: The picker, and the two "From library" entry points**

Create `src/app/(dashboard)/images/library-picker.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { listImagesForPicker, type PickerImage } from "./actions";

/**
 * "From library" (spec §5b): pick any existing image — library, or any
 * piece's — to reuse. Reuse inserts the existing blob URL; no new render.
 */
export function LibraryPicker({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (image: PickerImage) => void | Promise<void>;
}) {
  const [images, setImages] = useState<PickerImage[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setImages(null);
    listImagesForPicker()
      .then((rows) => !cancelled && setImages(rows))
      .catch((error) => toast.error(error instanceof Error ? error.message : "Couldn't load the library"));
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function pick(image: PickerImage) {
    setBusy(true);
    try {
      await onPick(image);
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>From library</DialogTitle>
          <DialogDescription>Reuse an existing image — no new render.</DialogDescription>
        </DialogHeader>
        {images === null || busy ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {busy ? "Adding…" : "Loading…"}
          </div>
        ) : images.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No images yet.</p>
        ) : (
          <ul className="grid max-h-[60vh] grid-cols-3 gap-3 overflow-y-auto sm:grid-cols-4">
            {images.map((image) => (
              <li key={image.imageId}>
                <button type="button" className="block w-full space-y-1 rounded-md border p-1.5 text-left hover:bg-muted/50" onClick={() => void pick(image)}>
                  <div className="relative aspect-[4/3] overflow-hidden rounded bg-muted">
                    <Image src={image.url} alt="" fill sizes="20vw" className="object-cover" />
                  </div>
                  <p className="line-clamp-2 text-xs">{image.concept || "Untitled"}</p>
                  {image.pieceTitle && <p className="truncate text-[0.7rem] text-muted-foreground">{image.pieceTitle}</p>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

In `drafts/[releaseId]/cover-panel.tsx` (Task 9): import `LibraryPicker` from `"../../images/library-picker"`, `setCoverFromImage` from `"./image-actions"`, `Images` from lucide; add `const [pickerOpen, setPickerOpen] = useState(false);`; add a fourth menu item after Upload:

```tsx
        <DropdownMenuItem onClick={() => setPickerOpen(true)}>
          <Images /> From library
        </DropdownMenuItem>
```

and, at the end of the section (after the prompt `Dialog`):

```tsx
      <LibraryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={async (image) => {
          const ok = await run("Setting cover…", () => setCoverFromImage({ contentPieceId, imageId: image.imageId }), (url) => ({
            url,
            alt: "",
            concept: image.concept,
            sourceKind: "generated",
          }));
          if (!ok) throw new Error("Couldn't set the cover.");
        }}
      />
```

In `drafts/[releaseId]/generate-image-panel.tsx` (Task 6): import `LibraryPicker` and `Images`; add `const [pickerOpen, setPickerOpen] = useState(false);`; in the footer row, next to "Suggest prompt":

```tsx
            <Button type="button" variant="outline" size="sm" onClick={() => setPickerOpen(true)} disabled={busy !== "idle"}>
              <Images className="size-3.5" /> From library
            </Button>
```

and after the panel's closing `</>` of the non-generating branch (inside the root div, so it unmounts with the panel):

```tsx
      <LibraryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={async (image) => {
          await onInsert(`![${image.concept.replace(/[[\]]/g, "")}](${image.url})`);
          toast.success("Image added");
          onClose();
        }}
      />
```

The picker is a portaled Dialog: focus moves out of the insert surface, so the surface hides while the picker is open — the captured insert point (Task 5) is what makes `insertAtCursor` still land in the right place, and `onClose` unmounts the panel afterwards.

- [ ] **Step 8: Nav link + test**

In `nav-links.tsx`: add `Images` to the lucide import list (line 5-12, alphabetical between `History` and `Plug`) and insert `{ href: "/images", label: "Images", icon: Images },` after the Calendar entry (line 20). In `tests/components/nav-links.test.tsx:26` change `HREFS` to `["/signals", "/board", "/calendar", "/images", "/history", "/integrations", "/company"]`.

Run: `npx vitest run tests/components/nav-links.test.tsx`
Expected: PASS.

- [ ] **Step 9: Gates**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: clean. `next/image` with `fill` requires the parent to be `position: relative` — every thumbnail wrapper above has `relative`.

- [ ] **Step 10: Commit**

```bash
git add "src/app/(dashboard)/nav-links.tsx" tests/components/nav-links.test.tsx "src/app/(dashboard)/images" "src/app/(dashboard)/drafts/[releaseId]/cover-panel.tsx" "src/app/(dashboard)/drafts/[releaseId]/generate-image-panel.tsx" tests/app/images/actions.test.ts
git commit -m "feat: image library with filters, detail edits, delete, generate and reuse"
```

---

### Task 11: Final gates and manual verification

**Files:** none new.

- [ ] **Step 1: Automated gates**

```bash
npm run typecheck
npm run lint
npm run build
npx vitest run tests/lib/images/actions-support.test.ts tests/lib/images/suggest.test.ts tests/lib/images/store-shared-blob.test.ts tests/lib/images/generate.test.ts tests/app/drafts/image-actions.test.ts tests/app/images/actions.test.ts tests/components/nav-links.test.tsx
```

Expected: all clean / PASS. Run the vitest line twice if anything fails — the shared-Postgres suite is flaky, and a failure that doesn't repeat is not yours. Also run Plan 1's store test (`ls tests/lib/images/`) once more, since Task 3 touched `store.ts`.

- [ ] **Step 2: Manual verification (dev server, signed in, a tenant with a ready visual identity and a `blog_post` draft)**

The preview sits behind the OAuth wall, so this is run by the user. Set `OPENAI_API_KEY`, `BLOB_READ_WRITE_TOKEN` (and optionally `IMAGE_MODEL`) in `.env.local`, then `npm run dev`.

Editor — insert:
- [ ] Put the caret on an empty paragraph under an H2 → the insert surface shows a third (image-plus) button.
- [ ] Click it → the panel opens under the surface, textarea focused, surface stays visible while typing.
- [ ] Suggest prompt → the textarea fills with a concept about THAT section (not the intro).
- [ ] Generate → "Composing illustration…" → the image appears at the caret; the page's Save button is not dirty (saved by the action); reload shows the image.
- [ ] Esc with the panel focused closes it without inserting; Cancel likewise.
- [ ] From library → picking an image inserts it at the caret without a new render (Images page count unchanged).
- [ ] With the visual identity cleared in Company settings, Generate shows the "Set up your visual identity…" toast.

Editor — edit:
- [ ] Hover a generated image → three small buttons top-right; the sparkle opens the popover with Edit prompt / Describe a change / Regenerate.
- [ ] Regenerate → the image swaps to a new render; reopen → History strip shows 2 thumbnails, the current one ringed.
- [ ] Describe a change ("make the background darker") → the new render reflects it; Edit prompt shows the history line `Edit: make the background darker` appended.
- [ ] Restore the first render → the image swaps back; reload keeps it.
- [ ] Settings (gear) still opens MDXEditor's image dialog; trash still deletes the node.
- [ ] Drag-drop a JPEG onto the editor → uploaded, inserted; the sparkle popover says it was uploaded (no edit actions). Drop a GIF → toast "Only PNG, JPEG or WebP…" and nothing inserted. A 12 MB PNG → the 10 MB toast.

Cover:
- [ ] Above the title: "Add cover" → Generate from post → cover appears (1200×630); Change → Write a prompt is prefilled with the previous concept; Remove clears it.
- [ ] Add cover → Write a prompt on a coverless piece → the textarea is prefilled with a suggestion, never empty.
- [ ] Add cover → Upload → the file becomes the cover; Add cover → From library → picks an existing image as cover, no new blob (Images page shows the same URL under both rows).
- [ ] Set the type's cover to off in Settings → Content images → the panel disappears from the draft page.

Library:
- [ ] Nav shows "Images"; the page lists every image newest first; role / source / piece filters narrow it and Clear resets the URL.
- [ ] Click a card → detail with history strip; Regenerate here → the draft's body (open it in another tab, reload) points at the new URL.
- [ ] Generate new → a Library-role image appears with no piece.
- [ ] Delete an image used in a draft → confirm text names the draft; after delete the draft's body no longer has the line.
- [ ] Publish a piece (or set `published_at` on one) → its images' Delete is replaced by the "published" explanation.

- [ ] **Step 3: Commit anything the checklist changed, then finish the branch**

```bash
git status
git log --oneline main..HEAD
```

Expected: eleven commits on top of Plans 1–2, one per task; a clean tree. Hand off per superpowers:finishing-a-development-branch.

---

## Self-review

**Spec coverage — §5 Editor**
- Inserting: insert-surface button beside `InsertImage`, in-canvas panel (not a modal), prompt field, "matches your brand style" note, Suggest prompt from the surrounding section, Generate → server action patterned on `requestAgentEdit` (`requireSession` → `loadOwnedDraft` → `assertDraftEditable` → render → return markdown, client splices + `saveDraftBody`), pending state, Esc/Cancel — Tasks 4, 5, 6. Deviation: the spec's "placeholder block at the cursor" is a panel anchored under the insert surface rather than a Lexical node; the caret is captured and the image lands exactly there. A shimmer *block in the document* would need a custom Lexical node that `render.ts` sanitisation and `getMarkdown()` would have to ignore mid-flight — not worth it for a 10–30 s wait shown next to the caret.
- Manual uploads through `imagePlugin({ imageUploadHandler })`, recorded as `sourceKind: "uploaded"`, no prompt affordances — Tasks 4, 7, 8.
- One image per action; regeneration is the variant mechanism; history strip with restore that swaps the markdown URL — Tasks 4, 5, 7.
- Editing: Edit prompt (stored prompt reopened, sent verbatim), Describe a change (image+instruction edit against the current render), Regenerate (same prompt) — each a new `image_renders` row and a markdown URL update — Tasks 4, 7. Judgement call: the affordances sit in an always-visible per-image toolbar (MDXEditor's `EditImageToolbar` seam has no selection gate; the default toolbar is always visible too) with the actions behind a popover, rather than appearing only "on select".
- Cover: Add cover → Generate from post → Write a prompt (prefilled, never empty) → Upload (+ From library); hover Change / Remove; Change reopens with the previous concept; first-class `role:"cover"` row; gated by the type's policy — Tasks 4, 9. `next.config.ts` `images.remotePatterns` and the `.mdx-content img` rule — Task 8.

**Spec coverage — §5b Library**
- Nav "Images"; every row for the tenant newest first; filters by piece / role / source; card = thumbnail, concept, piece link, date; detail = history strip + the three edit actions; delete removes rows + blobs and the piece's markdown line, confirm names the piece, published pieces' images can't be deleted and the UI says why; Generate new → `role:"library"`; From library in the insert panel and the cover menu, reusing the blob URL with no new render — Tasks 4, 10 (+ Task 3's shared-blob guard so a reused blob survives either row's deletion).

**Contract deviations (all additive)**
- `suggestImagePrompt` gains optional `heading` and `role`; `lookupImageBySrc` returns render history; `setCoverFromImage` and `listImagesForPicker` are new; `image-actions.ts` exports the `ImageLookup` type. Signatures in the contract are otherwise exact.
- `regenerateImage` / `restoreRender` also rewrite the stored piece body's URL server-side (no `bodyEditedAt`) so the library's edit actions are correct for images sitting in a draft; the editor's `replaceImageSrc` + `saveDraftBody` on top is then a no-op write.

**Judgement calls to flag**
- A render that fails for a row created by the same action deletes that row (nothing to retry from; the prompt is still on screen). Regeneration failures keep the row.
- Uploaded images get `altText: ""` (spec §2: decorative → empty alt) and the file name as concept; the markdown alt is editable through MDXEditor's image dialog.
- `generateCover` on an existing *generated* cover adds a render to the same row (history survives Change) and rewrites concept/altText; an *uploaded* cover is replaced by a fresh row.
- Cover "From library" copies the render as-is: a body-sized (1200×900) source becomes a 4:3 cover. Not resized — the spec says no new render.
- `bodySizeLimit: "11mb"` for Server Actions is a global change (needed for uploads); it only raises the cap.
- The library detail's Delete for a *cover* leaves the piece coverless (the row IS the cover pointer); the confirm copy says "its line will be removed from that draft" only when there is a piece title, which reads slightly off for covers — acceptable for v1.

**Handed elsewhere / not done**
- Board card cover thumbnail (spec §3): needs `BoardCard.coverUrl` in `src/lib/content/board.ts:49-68`, the board query and its tests — follow-up.
- Failed-illustration notice/retry on the draft page and the agent's own placement are Plan 2 (its Task 7); publish-time transfer of the cover (Webflow field, LinkedIn media, webhook) is Plan 4.
- No jsdom tests for the new components: `tests/components` mocks the MDXEditor module wholesale (`new-brief-editor.test.tsx:55`) and nothing there renders the realm bridge, so the editor pieces are gated by typecheck + build + the manual checklist, as the existing Ask AI bridge is.
