# Image Generation — Design

**Date:** 2026-08-18
**Status:** Proposed.
**Depends on:** the content-hub pivot (merged to `main`): content pieces,
content types, briefs, unified drafting (`generateDraftForPiece`).

## Summary

Versional generates the words; this spec adds the pictures. Four capabilities:

1. **Visual brand guidelines** — a new section of company settings capturing
   the inputs image generation needs (palette, style preset, do/don't rules,
   references), bootstrapped from the company's site like the existing
   brand-style import.
2. **An illustration agent** — a step in draft generation that reads the
   generated content, decides how many images the piece needs, where they go,
   and what each depicts, then renders them. Surfaced as its own step in the
   draft-generation loader.
3. **Editor tools** — insert an AI image anywhere in the body from the editor
   surfaces, edit any image by prompting in place, and set/regenerate a cover
   image. Whether a piece type gets a cover is a settings-page control.
4. **Delivery** — images stored on Vercel Blob, carried to Webflow, LinkedIn,
   and webhooks with the content.

Scope guard: **graphic images only** — flat/illustrative marketing graphics
derived from the content and the brand. No photorealistic/stock-photo lane, no
screenshots, no diagrams-with-text in v1 (`allowTextInImages` defaults false).

## User stories

The persona throughout is the content lead from the pivot design: owns the
calendar, accountable for brand consistency, no design resource on call.

**Setup**

- *As a content lead onboarding, I paste my website and get a proposed
  visual identity — palette, style, mood — that I confirm or tweak, so I
  never fill in a brand form from scratch.* (§2 bootstrap)
- *As a content lead, I upload two or three of our existing blog
  illustrations as references so every generated image looks like it came
  from the same illustrator.* (§2 `styleReferenceImages`)
- *As a content lead, I add "always include our product's blue orb" and "no
  people, no hands" to the image rules once and every future image respects
  both.* (§2 `imageGenerationRules`)
- *As a content lead, I decide that blog posts get a cover and up to three
  illustrations, product updates get a cover only, and social posts get
  nothing — in one settings card.* (§6)

**Drafting**

- *As a content lead accepting a brief, I watch the loader go through
  drafting → review → "Creating illustrations", and the draft opens with a
  cover and 2–3 on-topic illustrations already placed under the right
  headings — I never see an image-less draft and then wait for pictures.*
  (§4)
- *As a content lead, when an illustration failed to render I see a notice
  and one-click Retry, and the draft is otherwise complete.* (§4 failure)
- *As a content lead whose company hasn't set up visual identity yet, drafts
  come without images and the page points me to the setup card, instead of
  generating something off-brand.* (§4)

**Editing**

- *As a content lead, I put my cursor on an empty line, click Generate
  image, accept the suggested prompt drawn from the section, and get an
  illustration in place ~20 s later.* (§5 insert)
- *As a content lead, I select an image and type "make the background
  darker" and get a revised version of the same image, not a brand-new
  one.* (§5 describe a change)
- *As a content lead, I regenerated an image three times, preferred the
  first, and restore it from the history strip.* (§5 history)
- *As a content lead, I click Add cover → Generate from post and get a
  1200×630 cover; I hit Change and edit the pre-filled prompt to shift the
  concept.* (§5 cover)
- *As a content lead, I drag a screenshot from my desktop into the body and
  it uploads and inserts like any other image, without prompt controls.*
  (§5 uploads)
- *As a content lead, I fix the alt text on an image before publishing.*
  (§2 alt policy)

**Library**

- *As a content lead, I open Images from the nav to see every image generated
  or uploaded across my pieces, filter by piece or role, delete the ones I
  don't want, and generate a new standalone image to use anywhere.* (§5b)

**Publishing**

- *As a content lead publishing to Webflow, the cover lands in my
  collection's Image field and body illustrations render in the rich-text
  field — with the Site API token I already pasted, no reconnect.* (§8)
- *As a content lead whose LinkedIn post announces the blog, the post carries
  the cover as its own image — larger than a link card, and shown instead of
  the link's og:image.* (§8)
- *As a developer consuming the webhook, I get `coverImage.url/alt/width/
  height` alongside the body and can render a card without fetching.* (§8)

**Not in v1** (so nobody expects it): pick from four variants; text-bearing
covers with the post title; the logo composited on the cover; photorealistic
imagery; per-tenant image budgets.

## 1. Engine and routing

**Model: `openai/gpt-image-2`, called directly via `@ai-sdk/openai`,**
configured as `IMAGE_MODEL` with a code default, mirroring `GENERATION_MODEL`.

Why this model:

- Graphic/flat illustration quality and prompt adherence are state of the art;
  per-image cost ($0.03–0.08 by resolution) is 4–5× cheaper than the Google
  alternative (`gemini-3-pro-image`, $0.134–0.24), whose advantage —
  best-in-class text rendering inside images — we deliberately don't use.
- It accepts up to 16 reference images and has a style-fidelity control —
  the mechanism behind `styleReferenceImages` and `pinStyleToCover` (§2).
- Its edits endpoint takes image + instruction — the mechanism behind the
  editor's "describe a change" (§5).
- `gpt-image-1` sunsets Oct 2026; target 2 from the start.

Why direct provider and not the Vercel AI Gateway: `src/lib/ai/model.ts`
documents the no-gateway decision for text models and Anthropic has no image
model, so image generation is necessarily the first call outside that
abstraction. Adding `@ai-sdk/openai` + `OPENAI_API_KEY` keeps the "direct
provider, billed on our key" stance consistent instead of introducing a
gateway key for one modality. A small `src/lib/ai/image-model.ts` mirrors
`model.ts` (`resolveImageModel(spec)` strips an `openai/` prefix), so swapping
models later is an env change.

All rendering goes through one function, `renderImage()` in a new
`src/lib/ai/images.ts`: compiled style block + per-image prompt + reference
images in, compressed PNG out, usage recorded (§9). The AI SDK's stable
`generateImage` (in the installed `ai` v7) is the call surface for both
generation and reference-image edits.

Rejected: Recraft (best brand-style API — `style_id` from reference images,
exact-RGB palette — but a third vendor for ~10% marginal consistency);
Gemini (cost, and its strengths are text-in-image and search grounding);
per-tenant fine-tuning/LoRA (operationally heavy, reference images get ~90%).

## 2. Visual brand guidelines

A new **Visual identity** card on `/company`, following the page's
each-card-owns-its-save convention, feeding every image generation. Research
ranking of what actually drives consistency: a fixed style-descriptor block
first, style-reference images second, a role-tagged palette third, explicit
do/don't rules fourth. Two findings that defy intuition: the **logo must never
enter a generation prompt** (models distort marks; compositing the real file
post-generation is the standard practice — deferred, §10), and **typography is
irrelevant while images contain no text**, so there are no font fields.

### Settings schema

One jsonb column on `company_profiles`:
`visual_identity jsonb $type<VisualIdentity>` (null until first save, like
`guidelines`). Fields:

**Core (bootstrap-prefilled, confirmed at first use):**

| Field | Type | Default | Why |
|---|---|---|---|
| `palette` | `{hex, role}[]`, 3–6; roles `primary\|secondary\|accent\|background\|neutral` | extracted | Roles let the prompt say "background in X, accents in Y"; >6 colors dilutes consistency |
| `stylePreset` | `flat \| geometric \| line_art \| isometric \| gradient \| duotone \| hand_drawn` | `flat` | The strongest lever; an enum keeps prompts on tested vocabulary |
| `moodWords` | 2–4 strings | `["clean","modern"]` | Cheap tone steering |
| `allowTextInImages` | boolean | `false` | Wrong-font + gibberish liability; off by default |

**Advanced (all optional):**

| Field | Type | Default | Why |
|---|---|---|---|
| `styleReferenceImages` | 1–4 Blob URLs | none | Strongest consistency mechanism; passed as reference images on every render |
| `customStyleDescriptors` | string ≤200 chars | empty | Escape hatch for brands with a named look |
| `imageGenerationRules` | `{kind: "do" \| "dont", text}[]` | don'ts: `no photorealism`, `no stock-photo look`, `no 3D render`, `no clip-art` | Living list of dos and don'ts, appended verbatim to every prompt as "Always: …" / "Never: …" |
| `backgroundTreatment` | `solid \| subtle_pattern \| scene` | `solid` | Images sitting side by side must share a ground |
| `texture` | `none \| grain \| paper \| halftone` | `none` | Cheap differentiator from the generic-AI flat look |
| `peopleStyle` | `none \| abstract_figures \| diverse_characters` | `abstract_figures` | Avoids uncanny faces; a real brand decision |
| `pinStyleToCover` | boolean | `true` | Reuse the piece's cover as a style reference for its body images — the cheapest whole-post consistency win |

A single `compileStyleBlock(visualIdentity)` function turns the fields into
one prompt paragraph (descriptors + palette-with-roles + background + texture
+ mood + rules). Generation code consumes only the compiled block, so
prompt assembly lives in exactly one place. Reproducibility comes from each
render storing the full prompt it used (§3), not from versioning the settings.

### Website bootstrap

Extends the existing import pattern, not a new vendor: `fetchPageText`
(`src/lib/workspace/fetch-page.ts`) already returns the page **`html`**, which
today goes unused. A `deriveVisualIdentity(html, screenshotless)` analyzer
extracts candidate palette (CSS colors by frequency/role) and proposes
`stylePreset`/`moodWords` via the LLM from the same crawl the company
bootstrap already does — SSRF hardening, timeouts, and byte caps for free.
Flow copies `importBrandStyleFromUrl`: derive → prefill the card → user
confirms/edits → save. Brandfetch's API (free tier 100 req/month) is noted as
a fallback if extraction quality disappoints, not a v1 dependency.

### Alt text policy

Alt text is written from the image's *concept* (which we authored), not by
vision-captioning the output: one sentence, ≤125 chars, meaning not style, no
"image of", always human-editable. Decorative images get empty alt.

## 3. Data model

Two new tables, one column, one jsonb, following the repo's "vocabulary in
TypeScript, columns free-form text" convention throughout.

```ts
export const contentImages = pgTable("content_images", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  // Null for standalone library images (§5b); set when the image belongs to
  // a piece. Cascade keeps piece deletion tidy; library images outlive pieces.
  contentPieceId: uuid("content_piece_id")
    .references(() => contentPieces.id, { onDelete: "cascade" }),
  role: text("role").notNull(),                    // "cover" | "body" | "library"
  // What the image is for — survives regeneration, powers alt text and retry.
  concept: text("concept").notNull(),
  altText: text("alt_text").notNull(),
  sourceKind: text("source_kind").notNull(),       // "generated" | "uploaded"
  status: text("status").notNull(),                // "pending" | "ready" | "failed"
  currentRenderId: uuid("current_render_id"),      // FK to image_renders, set null on delete
  createdAt: ..., updatedAt: ...,
});
// Partial unique index: (content_piece_id) where role = 'cover'.

export const imageRenders = pgTable("image_renders", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  imageId: uuid("image_id").notNull().references(() => contentImages.id, { onDelete: "cascade" }),
  // The exact prompt sent to the model (style block + concept + any user
  // instruction). Full reproducibility per render; "edit prompt" reopens this.
  prompt: text("prompt").notNull(),
  blobUrl: text("blob_url").notNull(),
  blobPathname: text("blob_pathname").notNull(),   // what del() takes
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  bytes: integer("bytes").notNull(),
  model: text("model").notNull(),
  createdAt: ...,
});
```

- The render history strip (§5) is the `image_renders` list; "current" is the
  pointer on `content_images`. History is capped at **5 renders per image**;
  pruning deletes the blob (§7) unless the piece has been published since that
  render was current (Webflow hotlink safety, §8).
- **Body images join the markdown by blob URL.** The body stays plain
  markdown — `![alt](https://…blob…)` — and the URL is unique per render, so
  the editor maps `<img>` nodes to rows without markup extensions that would
  break `render.ts` sanitization. The markdown alt is the live alt;
  `content_images.altText` seeds it.
- The cover is **not** in the body markdown. It is the `role: "cover"` row,
  read by the draft page, publish dispatch, and the board card thumbnail.
- `company_profiles` gains `visual_identity jsonb` (§2) and
  `image_policy jsonb` (§6).
- `llm_usage` gains nullable `image_count integer` (§9).

## 4. The illustration agent

Runs **only inside `generateDraftForPiece`** (`src/lib/briefs/draft.ts`) —
draft creation and whole-draft regeneration. Never on agent edits, extract, or
catch-up merges. Skipped entirely when the piece's type has images off (§6) or
the tenant has no confirmed `visual_identity` (no brand inputs → no images —
the draft page nudges toward setup instead of generating off-brand).

### Two-stage: plan, then render

**Stage 1 — the plan.** After review completes, one `generateObject` call to
the text model (the same family that wrote the draft reads it better than an
image model reads long prompts) returns an illustration plan:

```ts
{ cover: { concept, prompt, altText } | null,
  body: { anchorHeading, concept, prompt, altText }[] }
```

Plan rules, encoded in the prompt:

- Cover (if the type has one) + ~1 body image per 2 H2 sections, **capped at
  the type's limit (default 3)**. Go under the cap when a section has nothing
  visualizable; **never pad to quota** — decorative auto-images are the top
  user complaint about tools that do this.
- Body placement: directly after an H2, before the section's first paragraph.
  Never right after the intro when a cover exists (double-hero), never two
  images within ~150 words, never in a closing/CTA section.
- Prompts follow the fixed template: concept metaphor → compiled style block →
  composition → aspect. The concept is also the alt-text source.

**Stage 2 — render.** Cover first; then body images in parallel
(`Promise.all`), each passing the fresh cover as a style reference when
`pinStyleToCover` is on, plus any `styleReferenceImages`. Wall-clock ≈ two
render round-trips (~30–60 s) regardless of image count.

### Pipeline placement and the loader

A new step key between `"reviewing"` and `"saving"`:

- `DraftStepKey` and `DRAFT_STEPS` in `src/lib/drafting/draft-progress.ts`
  gain `{ key: "illustrating", label: "Creating illustrations", slow: true }`.
  No migration — `generationStep` is deliberately free text. The persisted-
  step poller (`GenerationChecklist` → `pollGenerationProgress`) picks it up
  with zero changes; `slow: true` exempts it from step pacing.
- In `generateDraftForPiece`: `setStep("illustrating")` after review, run
  plan + render inside the existing `try`, splice `![alt](url)` lines into
  `result.body` at their anchors, insert `content_images`/`image_renders`
  rows, set the cover row — then the existing `setStep("saving")` writes
  `draftWrite` as today. Rows are written in the same transaction as the body
  on the release branch (alongside `linkAtomicUpdatesToPiece`).

**Images block draft readiness — a deliberate reversal of the usual
"stream images in after the text" pattern.** The body is one text column with
hand-edit-freeze semantics (`bodyEditedAt`); making the draft editable while
a background job splices image markdown into the same column is a race with
the user's first edit that the current model cannot express. Blocking costs
~30–60 s inside a step the loader already knows how to pace, and the
piece stays in `status: "brief"` + generating until fully illustrated — one
state, no reconciliation. Revisit only if the added latency shows up in
usage. (Flagged as the one place this spec overrides the UX-research
recommendation.)

### Failure handling

Renders retry once, silently. A still-failed body image is **omitted from the
body markdown** but its `content_images` row persists with `status:"failed"` —
the draft page shows a dismissible notice ("1 illustration failed — Retry")
and retry splices it at its stored anchor. A failed cover saves the draft
coverless with the Add-cover menu pre-filled with the failed prompt. A failed
*plan* call degrades to no images and a `generationError` warning, never a
failed draft. The concept is never silently lost.

## 5. Editor: insert, edit, cover

Style and model are brand-level and fixed — the editor exposes *what* an
image shows, never *how it looks*. The machinery reuses the two seams the
editor already has: the floating insert surface (`.mdx-surface-insert` in
`src/components/markdown/mdx-editor.tsx`) and the `EditorOps` imperative
bridge from the Ask-AI feature (`agent-edit-context.tsx` +
`AgentEditBridge`), whose capture-selection → generate → `insertMarkdown`
flow is exactly what image insertion needs.

### Inserting

The insert surface (cursor on an empty paragraph) gains a **Generate image**
button beside the existing `InsertImage`. It inserts a placeholder block at
the cursor — in-canvas, not a modal (the Notion/Gamma pattern; side-pane
flows tested worse) — holding a prompt field, a "matches your brand style"
note, and a **Suggest prompt** action that drafts the prompt from the
surrounding section via the text model. Generate calls a server action
(`requestAgentEdit` is the template: `requireSession` → `loadOwnedDraft` →
`assertDraftEditable` → generate → return, client splices + `saveDraftBody`),
which renders, uploads, writes the rows, and returns the markdown to splice.
The block shows a shimmer + the concept while pending; Esc/Cancel removes it.

Manual uploads ride the same path: `imagePlugin` is already enabled URL-only;
giving it an `imageUploadHandler` that posts to a Blob-upload action makes
drag-drop and file insert work, recorded as `sourceKind: "uploaded"` (no
prompt affordances — replace/remove only).

### One image, not variants

One render per action; regeneration is the variant mechanism (at 10–30 s and
real per-image cost, a 4-up grid quadruples both). Every generated image keeps
its render **history strip** (thumbnails from `image_renders`) — regenerate
and edit are never destructive; any prior render can be restored (swaps the
URL in the markdown). Revisit a variants grid for covers only if unit cost
proves negligible.

### Editing

Selecting a generated image shows three actions:

1. **Edit prompt** — opens the current render's stored prompt; edit and
   regenerate from scratch.
2. **Describe a change** — a one-line instruction applied to the *current*
   image via the model's image+instruction edit mode ("make the background
   darker", "remove the third figure").
3. **Regenerate** — same prompt, new render.

Each produces a new `image_renders` row and updates the markdown URL.

### Cover

The Notion pattern, above the title on the draft page: **Add cover** → menu
ordered **Generate from post** (agent writes the prompt from title + body) →
**Write a prompt** (pre-filled with the auto-drafted prompt as editable
starting text, never empty) → **Upload**. An existing cover hovers to
Change / Remove; Change reopens the menu with the previous prompt. The cover
is the first-class `content_images` row, never derived from the first body
image (Medium's implicit derivation confuses users). Structurally this is the
`linkedin-panel.tsx` + side-table precedent: a per-piece secondary artifact
with generate/regenerate/save.

Plumbing notes: `next.config.ts` needs `images.remotePatterns` for the Blob
host if covers render via `next/image`; `globals.css` needs a `.mdx-content
img` rule (none exists today).

## 5b. Image library

A new **Images** entry in the nav (`nav-links.tsx`), listing every
`content_images` row for the tenant — generated and uploaded, across all
pieces — newest first, as a thumbnail grid.

- **Filters**: by piece, by role (cover / body / library), by source
  (generated / uploaded).
- **Card**: current render thumbnail, concept, the piece it belongs to (link
  to the draft), created date. Click opens a detail view with the render
  history strip and the same three edit actions as the editor (§5).
- **Delete**: removes the row and its renders' blobs (`del()` on every
  `blobPathname`). If the image is referenced by a piece, the confirm dialog
  says so and the piece's markdown line / cover pointer is removed too. Images
  referenced by a *published* piece cannot be deleted from the library
  (Webflow hotlink safety, §8) — the button explains why rather than failing
  silently.
- **Generate new**: a standalone prompt → render flow producing a
  `role: "library"` row with no piece. The editor's insert block and the
  cover menu gain a **From library** option listing these (plus any piece's
  images) so a generated-once asset can be reused anywhere; reuse inserts the
  existing blob URL, no new render.

Server actions live in `src/app/(dashboard)/images/actions.ts`, following the
`requireSession` → tenant-scoped load → mutate → `revalidatePath` preamble.
The library is a read view plus delete/generate over the same rows the editor
writes — no second source of truth.

## 6. Per-content-type image settings

The user-facing control lives on **`/settings`** as a **Content images**
card — one row per content type, two controls:

| Type | Cover image | Body illustrations |
|---|---|---|
| `blog_post` | on | Auto (cap 3) |
| `product_update` | on | off |
| `social_post` | off | off |

- **Cover**: on/off. Off → the editor shows no cover affordance and the agent
  plans no cover (the WordPress per-post-type featured-image precedent).
- **Body illustrations**: Off / Auto / cap 1–3.

Stored as `image_policy jsonb` on `company_profiles` (read at generation time
with the rest of the profile — one fetch), defaults in a TypeScript
`Record<ContentType, …>` in a new `src/lib/content/image-policy.ts` so the
column stays null until a tenant changes something. Turning a type off never
deletes existing images. No per-type style/model/aspect — style is
brand-level (§2).

## 7. Storage: Vercel Blob

New dependency `@vercel/blob` + `BLOB_READ_WRITE_TOKEN`; images are public.

- **Pathname**: `tenants/{tenantId}/content/{contentPieceId}/{role}-{slug}.png`
  with `addRandomSuffix: true` — tenant prefix for accounting, random suffix
  for immutability + unguessability (Vercel's documented Google-Docs-link
  model). Public-but-unguessable is fine: these are marketing images that go
  public at publish anyway; the only exposure is unpublished drafts.
- **Immutable, never overwritten** (overwrite has a 60 s CDN propagation
  window and browser-cache staleness). Regeneration writes a new blob; the
  replaced one is deleted via `del(pathname)` when its render is pruned from
  history (cap 5) — unless published-referenced (§3). **No `list()`-based
  orphan sweeps**: `list` is an advanced op and the Hobby quota is 2K/month.
- **Hobby limits are the binding constraint**: 1 GB storage, 10 GB transfer,
  10K simple + 2K advanced ops/month, and breaching a limit **cuts Blob off
  for 30 days**. Mandatory mitigations: a **compression pass before `put()`**
  (sharp: resize to target width, palette-quantized PNG — models emit
  multi-MB PNGs; compression turns ~300 storable images into thousands) and
  delete-on-prune above.
- **Dimensions/format**: one master per image. Cover **1200×630 (1.91:1)** —
  one render serves blog hero, `og:image`, and the LinkedIn post image (a 16:9
  hero would force a second OG render; not worth 2× cost in v1). Body images
  **~1200 px wide**. **PNG masters, no WebP** — LinkedIn's image API rejects
  WebP, and flat graphics quantize well. Keep cover subjects inside a center
  safe zone; platforms crop edges.
- No custom domain in v1 (Blob doesn't support one natively; proxying costs
  more and buys nothing for CMS-bound images).

## 8. Image transfer to integrations

The body markdown carries images as `![alt](https://…blob…)`; both render
paths already pass `img` through sanitized (`src/lib/markdown/render.ts`
allowlists http(s) srcs; `markdown-to-html.ts`'s Webflow tag set includes
`img`). The cover travels as a structured field per destination.

### Webflow

**Pass the Blob URL in `fieldData`; skip the assets API entirely.** Webflow's
image field type accepts `{ url, alt }` with a public URL and **fetches +
rehosts the file on Webflow's CDN** (4 MB cap — guaranteed by the compression
pass). This goes through the CMS item endpoints, which need only `cms:write`
— **existing pasted Site API tokens keep working**; the assets flow would
require `assets:write` and force every tenant to reconnect.

Code seams: `WebflowFieldMapping` gains a `{ source: "coverImage" }` member;
`buildFieldData` emits `{ url, alt }` for it; `suggestMapping` auto-maps the
first `Image`-type field; the mapping form adds it to `SOURCE_OPTIONS`.
Pieces without a cover send the field empty — `findEmptyRequiredField`
already turns a required-field miss into a clear config error.

In-body images inside the rich-text field are the one soft spot: Webflow's
sideloading of `<img>` from API-written rich text is undocumented and
inconsistent, so we treat body images as **hotlinked** — which is why blobs
referenced by published pieces are exempt from deletion (§3, §7). The user's
Webflow template should still map its OG-image setting to the cover field so
other social surfaces (X, Slack, Facebook) get the card for free.

### LinkedIn

**The cover is attached as the post's own image**, not left to the link's
`og:image` — a native image post renders larger in the feed, gets better
reach, and shows even when the blog page's OG tags are missing or stale.
The link stays in the commentary as today.

Flow, added to `src/lib/integrations/linkedin/client.ts` and called from the
destination when the piece has a ready cover:

1. `POST /rest/images?action=initializeUpload` with `{ owner: organizationUrn }`
   → `{ uploadUrl, image: "urn:li:image:…" }`.
2. `PUT` the PNG bytes (fetched from Blob) to `uploadUrl`.
3. `POST /rest/posts` with `content: { media: { id: imageUrn, altText } }`
   alongside the existing `commentary` (`createPost` gains an optional
   `media` arg).

Constraints, all already satisfied by §7: PNG/JPEG only (no WebP), <36 M
pixels, ≤5 MB. Uploads are async (`PROCESSING → AVAILABLE`); the client polls
`GET /rest/images/{urn}` briefly before posting and treats a stuck upload as
`retryable`, riding the existing `delivery_attempts` retry. Scopes are the
same `w_organization_social` the connection already holds — no re-auth.
Pieces without a cover post text + link exactly as today. The image URN is
kept on the attempt row so a retry after a failed post step doesn't
re-upload.

### Webhook

The payload gains a top-level `coverImage: { url, alt, width, height } | null`
(naming follows JSON Feed 1.1's `image`; dimensions save receivers a fetch).
Body markdown already carries absolute image URLs; payload docs state that
URLs are stable and hotlinkable. Non-breaking addition.

## 9. Cost tracking and limits

- `LlmOperation` gains `"illustration_plan"` (a normal token-usage row) and
  `"image_generation"`. Image renders bill per image, not per token, so
  `llm_usage` gains a nullable `image_count integer`; token columns stay null
  on image rows. `recordLlmUsage` keeps its never-fails contract.
- Structural caps double as cost caps: ≤1 cover + ≤3 body images per
  generation, ≤5 renders of history per image, one-render-no-variants in the
  editor. Worst-case auto-generation cost per blog post ≈ 4 images ≈ $0.15–
  0.35 at gpt-image-2 prices. Per-tenant monthly budgets are deferred until
  there's a usage surface to show them on.

## 10. Out of scope / deferred

- **Logo compositing** onto covers (store the logo now, composite later).
- **Photorealistic/stock lane**, screenshots, and text-bearing covers
  (`allowTextInImages` exists but v1 templates never enable it).
- **Brandfetch** as an extraction fallback; scraping ships first.
- **Variants grid for covers** — revisit if unit cost proves negligible.
- **Per-tenant image budgets / usage UI.**
- **Non-blocking image delivery** (stream-in-after-text) — requires a body
  representation that tolerates concurrent splices; revisit with evidence
  that the blocking latency hurts.
- **Notion as a publish target** (source-only today).

## Decisions taken (for the record)

1. gpt-image-2 direct via `@ai-sdk/openai`; documented exception to the
   Anthropic-only rule, not a gateway reintroduction.
2. Two-stage agent: text model plans, image model renders. The plan
   (concept + anchor) is persisted per image — the fix for irrelevant
   auto-images and the engine of retry/regenerate.
3. Images block draft readiness (reversing the UX-research recommendation)
   because the single-text-column body makes post-save splicing racy.
4. Cover is a first-class row, never the first body image; one 1200×630
   master serves hero + OG + LinkedIn.
5. Webflow gets URL-in-fieldData (existing tokens keep working); LinkedIn
   posts carry the cover as a native image (Images API, same scopes);
   webhook gets `coverImage`.
6. PNG masters, compression before upload, delete-on-prune, no `list()`
   sweeps — all forced by Hobby-plan Blob limits.
7. Per-type policy on `/settings`, stored as jsonb on `company_profiles`,
   TypeScript defaults.
