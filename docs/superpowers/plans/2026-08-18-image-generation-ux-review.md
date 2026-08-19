# Image Generation — UX Review of Plans 1–4

**Date:** 2026-08-19
**Reviewed:** `2026-08-18-image-generation-{1-foundation,2-agent,3-editor,4-delivery}.md` against the spec's user stories, the existing app's conventions (files cited per finding), and industry patterns (Notion covers, Gamma/Notion inline prompting, Ghost/Canva history strips).
**Method:** every concrete fix was edited into the plans in place; findings below record what changed and why. Data models and server-action contracts were not touched except by *additive* actions, called out explicitly.

---

## (a) Findings

### 1. BLOCKER — Cover alt text was uneditable anywhere
**Where:** Plan 3 (Tasks 4, 9), affects Plan 4 (everything that publishes `cover.alt`).
**Wrong:** Spec §2 says alt is "always human-editable" and a user story is *"I fix the alt text on an image before publishing."* Body images are covered (the markdown alt is the live alt; MDXEditor's image-settings dialog edits it — no other alt UI exists anywhere in the app, verified by grep). The **cover is not in the markdown**, and no plan gave its alt any edit path — yet Plan 4 publishes exactly that alt to Webflow (`{ url, alt }`), LinkedIn (`media.altText`) and the webhook. The accessibility promise was unkeepable for the most-published image.
**Changed:** Added an additive `updateCoverAlt({ contentPieceId, altText })` action (+ tests) to Plan 3 Task 4, an "Alt text" hover control + small dialog on the `CoverPanel` (Task 9), and manual-verification lines (Task 11). Copy explains the alt travels to publish destinations.

### 2. BLOCKER — The "set up your visual identity" nudge was never built
**Where:** Plan 2 / Plan 3 gap (fixed in Plan 3 Task 9).
**Wrong:** Spec §4 user story: *"drafts come without images and the page points me to the setup card."* The agent correctly skips (`skipped: "no_visual_identity"`), but no plan rendered any pointer — the content lead would just see image-less drafts forever with no explanation, and an "Add cover" button whose Generate options fail with a toast.
**Changed:** Plan 3 Task 9's page load now computes `needsVisualIdentity` (policy wants images ∧ identity not ready) and renders a dashed pointer — "This draft has no images — add your palette and style in Company → Visual identity…" — **instead of** the cover affordance. Manual check added.

### 3. MAJOR — Stale failure count in the warning banner, contradicting the live notice
**Where:** Plan 2 Task 6 (with Task 7).
**Wrong:** "N illustrations failed to render." was appended to `generationError`. That column only clears on the next body-changing save, so after a successful Retry the amber "Generation notes" banner still claimed a failure while the notice (driven by live rows) had disappeared — two adjacent surfaces disagreeing. Worse, `board/card.tsx` renders **"Flagged copy"** for any `generationError` on a draft, so an image hiccup mislabeled the copy on the board. (The plan's own self-review admitted this and offered the fix.)
**Changed:** Failure counts are no longer written to `generationError`; the failed-rows notice owns that state (accurate count, Retry, disappears on success/dismiss). `generationError` keeps only the competitor scan and the whole-pass-threw warning ("Images could not be generated. The draft is complete without them."). Tests, schema comment, banner comment and self-review updated. Compared against: `drafts/[releaseId]/page.tsx` amber banner, `board/card.tsx` badge logic.

### 4. MAJOR — One concept, four names: "illustration" / "image" / "render" / "graphic"
**Where:** all four plans, every surface.
**Wrong:** The same object was "Generate image" (button) → "Composing illustration…" (loader) → "Illustration added" (toast) → "Render restored" (history) → "Images" (nav) → "Body illustrations" (settings) → "1 illustration failed to render" (notice). "Render" is internal jargon that leaked into five user-facing strings. Users build a mental model per word; this taught them four.
**Changed:** Enforced the glossary in §(b) across all plans: a naming-rule blockquote added at the top of Plans 1–3, and every user-facing string normalized ("image", "version", "Generating…"). The loader step label became **"Creating images"** — a deliberate deviation from the spec's literal "Creating illustrations" (step *key* `illustrating` unchanged); see open decision 2.

### 5. MAJOR — The failed-images notice was not dismissible
**Where:** Plan 2 Task 7.
**Wrong:** Spec §4: *"the draft page shows a **dismissible** notice."* The plan's notice only disappeared after every Retry succeeded — a user happy with the draft as-is would carry a permanent amber box (and dead "failed" cards in the library).
**Changed:** Added an X (ghost `icon-xs`, `aria-label="Dismiss"` — the exact `webflow-code-warning.tsx` idiom) backed by an additive `dismissFailedIllustrations` action that deletes the piece's still-failed generated rows (+3 tests). Explicit dismissal is not a *silent* loss of the concept, and it keeps the library clean.

### 6. MAJOR — Cover "Remove" destroyed data with no confirmation
**Where:** Plan 3 Task 9.
**Wrong:** Remove called `removeCover` directly, which deletes the row, its whole version history **and its blobs** — irreversible — from a hover button with no confirm. The app's rule (see `board/board.tsx`: "Delete this draft?", "…will be deleted permanently.") is a question-form Dialog for anything destructive. Notion's instant cover-remove is not a precedent here: Notion doesn't destroy the asset.
**Changed:** Remove now opens "Remove this cover?" / "The cover and its earlier versions will be deleted permanently. You can add a new one at any time." with Cancel (ghost) + `variant="destructive"` Remove — `sm:max-w-md`, busy-gated dismissal, matching the board confirms exactly.

### 7. MAJOR — A failed agent cover did not pre-fill the Add-cover prompt
**Where:** Plan 3 Task 9 (spec §4: "A failed cover saves the draft coverless with the Add-cover menu pre-filled with the failed prompt").
**Wrong:** The page built `CoverState` only from `coverRow.current`; a failed cover row (no current render) collapsed to `null`, so "Write a prompt" opened with a fresh suggestion and the agent's concept was silently unused (only Plan 2's notice exposed it).
**Changed:** The page now derives `coverPromptSeed` from a render-less cover row and threads it as a `promptSeed` prop; `openPrompt()` prefers previous concept → seed → suggestion. Manual check added.

### 8. MAJOR — The insert panel locked the user out for the whole 10–30 s generation
**Where:** Plan 3 Task 6.
**Wrong:** While generating, Esc was ignored and Cancel disabled — a 20-second modal-feeling lock inside the canvas, contradicting the spec's "Esc/Cancel removes it" and the app's own long-wait pattern (`generation-modal.tsx`: Close is never disabled; "Closing won't stop it").
**Changed:** The generating state is now dismissible (Esc or a ghost Close): "Generating image… Takes ~20 seconds. Closing won't stop it — the image appears at your cursor when it's ready." The async closure still completes the insert + save after dismissal (the captured caret makes this safe), so closing loses nothing.

### 9. MINOR — Two near-identical image glyphs side by side in the insert surface
**Where:** Plan 3 Task 6.
**Wrong:** The new `ImagePlus` button sat directly beside MDXEditor's built-in `InsertImage` frame icon — two icon-only image buttons with no visible difference between "insert by URL/upload" and "generate with AI". Hidden/ambiguous affordance.
**Changed:** The generate button now uses **Sparkles** — the app's established AI glyph (Ask AI's selection button, brand-style import, cover "Generate from post") — with `title`/`aria-label` "Generate image". A comment records the reasoning.

### 10. MINOR — "Render" jargon in five user-facing strings
**Where:** Plan 3 Tasks 7, 10; Plan 2 Task 7.
**Wrong/Changed:** "Render restored" → "Earlier version restored"; "Rendering…" → "Generating…"; "Render failed" → "Generation failed"; "No render" → "No image yet"; "Reuse an existing image — no new render." → "…it's inserted as-is, nothing new is generated."; "Restore this render" → "Restore this version"; retry-action errors reworded ("The image could not be generated: …").

### 11. MINOR — History strips were mouse-only for assistive tech
**Where:** Plan 3 Tasks 7 and 10.
**Wrong:** Thumbnail buttons had `title` only (tooltips are not accessible names) and `alt=""` images inside; no current-item semantics.
**Changed:** Added `aria-label` ("Current version" / "Restore this version") and `aria-current` on both strips (editor popover + library detail).

### 12. MINOR — Library empty state ignored the app's `EmptyState` primitive
**Where:** Plan 3 Task 10.
**Wrong:** A hand-rolled dashed `<p>` where every other page-level empty state (`/signals`, `/history`) uses `EmptyState`/`EmptyStateTitle`/`EmptyStateDescription` (`src/components/ui/empty-state.tsx`).
**Changed:** Switched to the primitive: "No images yet" / "Generate one here, or from a draft's editor — every generated and uploaded image lands in this library."

### 13. MINOR — Library delete confirm read wrong for covers, and lacked the app's confirm anatomy
**Where:** Plan 3 Task 10 (self-review had flagged the cover case as "reads slightly off — acceptable").
**Changed:** Copy now branches — cover: "It is the cover of "X" — that draft will lose its cover."; body: "…it will be removed from that draft too." — plus "This can't be undone." and a "Deleting…" pending label, matching `board/board.tsx` confirm anatomy (the inline confirm stays inside the detail dialog to avoid stacked dialogs).

### 14. MINOR — Derive-from-website result note missed the import card's styling idiom
**Where:** Plan 1 Task 12.
**Wrong:** Success and failure notes were both muted, while the direct precedent (`company/brand-style-import.tsx`) renders success in `text-emerald-600` and failure muted.
**Changed:** Note carries `{ ok, text }`; success is emerald, failure muted. (The rest of the derive row — `Loader2`/`Sparkles` swap, "Analyzing…", disabled-until-URL — already matched the import card exactly; "Derive" also matches the existing "Derive from your updates page" card title. Verified, no change.)

### 15. MINOR — Settings column "Body illustrations" broke the glossary
**Where:** Plan 1 Task 13. **Changed:** Column header and Select `aria-label` → "Body images". Card deliberately has no `CardDescription` — the settings page convention (`settings/page.tsx`) keeps explanations as `text-xs` lines inside the form, which the card already has.

### 16. MINOR — New "Cover image" mapping option exposed the stale "Update …" labels
**Where:** Plan 4 Task 5.
**Wrong:** `SOURCE_OPTIONS` mixed "Update title" / "Update body" (pre-pivot naming, where "update" meant the piece) with the new "Cover image" — an inconsistent set in one Select.
**Changed:** Renamed to "Title" / "Body" inside the block the plan already replaces, with a comment. (Webflow copy elsewhere — "Cover image can only be mapped to an Image field", the required-field error — was checked and is clear.)

### Verified consistent, no change needed
- Loader: Plan 2 reuses `DRAFT_STEPS`/`GenerationChecklist`/`slow: true` exactly; gerund-led step label matches "Generating the draft" et al.
- Per-card saves on /company and /settings; the visual-identity card's dirty-tracked outline Save matches the personas idiom; unsaved-changes guard wired.
- Toast idioms (sonner; short past-tense successes, "Couldn't X — try again" errors) after the glossary pass; success toasts correctly omitted where the UI change is its own confirmation (cover appearing/being removed).
- Editor reuse of the two floating-surface seams and the `EditorOps` bridge; in-canvas panel (not a modal) matches Gamma/Notion inline prompting; Cmd/Ctrl+Enter submit + Esc close match `agent-edit-dialog.tsx`.
- Cover flow order (Generate from post → Write a prompt (never empty) → Upload → From library) is the Notion pattern done right; cover is a first-class row, never derived from the first body image.
- Library: filters follow `change-events-filters.tsx` (URL as source of truth); picker grid, drag-drop upload with clear mime/size errors, published-piece delete refusal explained up front rather than failing.
- Webflow: option hidden on non-Image fields *and* validated server-side; required-image-with-no-cover produces the existing readable "required field is empty" error. Webhook card copy documents the payload where the user configures it.

---

## (b) Naming glossary (enforced across all four plans)

| Term | Meaning | Never say |
|---|---|---|
| **image** | Any picture, everywhere users read: nav "Images", "Generate image", "Image added", "Image regenerated", "N images failed to generate", loader "Creating images", settings "Body images" | illustration, graphic, asset, render (as a noun for the picture) |
| **cover** | The `role:"cover"` image: "Add cover", "Remove this cover?", "Cover alt text", Webflow "Cover image" | hero, featured image, thumbnail |
| **body image** | An image placed in the body (settings column, notice copy "placed under the section…") | body illustration, inline image |
| **version** | One entry in an image's history strip: "History", "Restore this version", "Current version", "Earlier version restored", "…and its earlier versions will be deleted" | render, revision |
| **generate / regenerate** | The act; pending copy "Generating image…" / "Generating…" / "Generation failed" | compose, render, create (except the loader's "Creating images") |
| **prompt** | The user-editable description of *what* the image shows: "Suggest prompt", "Edit prompt", "Write a prompt" | description, instruction (reserved for "Describe a change") |
| **library** | The /images page and reuse source: "Images" (nav), "From library" | gallery, media, assets |
| Missing-identity error (verbatim on every surface) | "Set up your visual identity in Company settings before generating images." | — |

Code identifiers (`illustratePiece`, `illustration_plan`, `imageRenders`, step key `illustrating`) intentionally keep their internal names.

---

## (c) Open decisions for the product owner

1. **Board card cover thumbnail — RESOLVED (product owner, 2026-08-19): build it in v1.** Plan 3 gained a dedicated task for it; the deferral note is gone.
2. **Loader label — RESOLVED (product owner, 2026-08-19): keep "Creating images".** The spec (§4 and the drafting user story) was updated to match, so spec and plans now agree. The step key stays `illustrating`.
3. **"Flagged copy" board badge** — any `generationError` on a draft still renders that badge (`board/card.tsx`), including the new "Images could not be generated" whole-pass warning. Misleading label for a non-copy warning; fixing it means widening the badge logic/copy outside these plans' scope. I left it.
4. **Amber warnings vs. the brand guide** — `docs/brand-style-guide.md` says "Do not introduce an amber warning colour", but the draft page's three existing banners and the new failed-images notice all use amber. The plans follow the de facto pattern; someone should reconcile the guide or the app.
5. **Does inserting an AI image freeze regeneration?** The editor insert path persists via `saveDraftBody`, which stamps `bodyEditedAt` and freezes whole-draft regeneration — while the server-side swap paths (retry, regenerate, restore) deliberately don't stamp. Is a user-initiated AI insert a "hand edit"? Contract-frozen territory; I changed nothing.
6. **Body-sized covers via "From library"** — reusing a 1200×900 (4:3) render as the 1.91:1 cover ships without re-render (spec: "no new render"), so LinkedIn/OG will crop or letterbox it. Consider filtering the cover picker to cover-sized images, or accept the mismatch for v1.
7. **Two nits left to the implementer:** cover-panel "From library" seeds local state with `sourceKind: "generated"` even for uploaded sources (self-corrects on refresh; `PickerImage` carries no sourceKind); "Write a prompt" on a coverless piece fires a paid `suggestImagePrompt` model call on open — cheap, but it's a model call from a menu click.
