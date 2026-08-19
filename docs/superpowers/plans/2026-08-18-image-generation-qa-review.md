# Image Generation — QA Review of Plans 1–4

**Date:** 2026-08-19
**Reviewed:** `2026-08-18-image-generation-design.md` (spec), the UX review
(already applied), and all four plans, against the real codebase and the real
test suite. Every assertion below cites a file and line I actually read.
**Method:** two passes — (A) correctness of the plans, (B) sufficiency of their
automated tests. Fixes small enough to make surgically were **edited into the
plans in place**; everything else is written up here with what it would take.

**Environment facts this review rests on** (verified, not assumed):

- `vitest.config.ts` runs two projects: `node` (`tests/**`, excluding
  `tests/components/**`, setup `vitest.setup.ts`) and `jsdom`
  (`tests/components/**`, setup `vitest.setup.jsdom.ts`). No `globals: true`.
- **There is no DB isolation.** `vitest.setup.ts` only points `DATABASE_URL` at
  a `_test` database (lines 21–46). No truncate, no transaction-per-test, no
  `globalSetup`. Isolation is one thing only: a tenant name unique per file,
  dropped in `afterEach`, cascading (`tests/helpers/fixtures.ts:5-18`).
  Flakiness is documented at
  `docs/superpowers/plans/2026-08-13-shared-fixtures-and-selection-hook.md:29`.
- `tests/helpers/fixtures.ts` had exactly two exports (`seedTenant`,
  `dropTenant`); ~40 test files hand-roll everything else.
- Network is faked three ways: `vi.mock("ai")`, injected `deps` objects
  (`src/lib/workspace/brand-import.ts:8-26` is the model), and
  `vi.stubGlobal("fetch")`. No msw. **`@testing-library/user-event` is not
  installed.** `vitest.setup.jsdom.ts` has **no** `ResizeObserver`/`matchMedia`
  stub, so no Base UI Popover/Select/DropdownMenu has ever been rendered in a test.
- Highest migration is `0062_next_dazzler.sql`; `_journal.json` last entry is
  `idx: 62`. Nothing in CI applies migrations to the test DB.
- `recordLlmUsage`'s `database` param is `typeof defaultDb`
  (`src/lib/ai/llm-usage.ts:37`), which `DbClient` is **not** assignable to.

---

## (a) Defects

Severity: **blocker** = ships broken or unsafe; **major** = real bug or a test
gap that would hide one; **minor** = cost or clarity.

### 1. BLOCKER — `recordLlmUsage`'s `database` parameter blocks three plans, and the widening was written as conditional
**Where:** Plan 1 Task 9 Step 4 (trailing note), consumed by Plan 2 Task 3 and Plan 3 Task 2.
**Wrong:** `recordLlmUsage(entry, database: typeof defaultDb = defaultDb)`
(`src/lib/ai/llm-usage.ts:37`). `typeof defaultDb` is
`NodePgDatabase<typeof schema> & { $client: NodePgClient }`; `DbClient`
(`src/lib/publishing/destinations/types.ts:11`) is the same type without
`$client` and is therefore **not** assignable. `renderImage`,
`planIllustrations` and `suggestImageConcept` all forward a `DbClient`. Plan 1
said "if `tsc` rejects, widen it"; it will reject, every time, and Plan 3 Task 2
independently proposed a *cast* as the workaround — two plans papering over one
type hole in two different ways.
**Changed:** moved the widening into **Plan 1 Task 3** as a required step (it is
where `llm-usage.ts` is already being edited), with the import, the new
signature, a comment explaining it, and `npx tsc --noEmit` added to that task's
verification. Removed the conditional note from Task 9.

### 2. BLOCKER — a test would call Vercel Blob's `del()` for real
**Where:** Plan 2 Task 4 (`illustratePiece` leftover cleanup) and its test.
**Wrong:** `illustratePiece` calls `deleteImage(tenantId, id, database)` with no
`StoreDeps`, so `deleteImage` falls through to the real `deleteBlobs` →
`@vercel/blob`'s `del()`. The plan's own constraint is "No test may reach a real
model, Blob, or OpenAI". It passes today only by accident: the single leftover
test seeds a row with **no renders**, and `deleteBlobs([])` early-returns. The
realistic case — regenerating a draft whose previous run succeeded — has renders,
and would fire a real network call from the test process (swallowed by
`deleteBlobs`' catch, so it would not even fail loudly).
**Changed:** added `deleteBlobs` to `IllustrateDeps` (type + implementation +
the forwarding call), added it to the test's `fakes()`, and added two tests:
a leftover row **with** a render (asserts the injected `deleteBlobs` was called
with its pathname) and an uploaded leftover (asserts it is spared). Updated the
Global Constraints line to name `deleteBlobs` and say why it is the easy one to
miss.

### 3. MAJOR — Plan 3's shared-blob guard changes two call sites and tests one
**Where:** Plan 3 Task 3.
**Wrong:** the task correctly says to apply `unreferencedPathnames` to both
`deleteImage` **and** `addRender`'s prune branch, but
`tests/lib/images/store-shared-blob.test.ts` only exercises `deleteImage`. The
prune path is the one that fires unprompted — every regeneration past
`MAX_RENDER_HISTORY` — so a guard applied to only one site leaves a
"From library" cover pointing at a blob that a body image's sixth regeneration
quietly deleted, and nothing surfaces it until a published page 404s the image.
The plan's Step 2 ("expect FAIL") would have gone green with half the fix in.
**Changed:** added a second `describe` covering the prune path (shared blob
spared, row still pruned, the other image still resolves it) plus an unshared
control; rewrote the brittle `toHaveBeenLastCalledWith([])` assertion as an
absolute `deletedPaths()` check that works whether the guard passes `[]` or
skips the call; added a case proving the deleted image's *own* unshared blobs
are still removed; changed Step 2's expectation to "**two** cases fail".

### 4. MAJOR — nothing produces, checks, or even records a 1200×630 cover — **RESOLVED (decision 1)**
**Where:** spec §7 / Plan 1 Tasks 6+7+9 / Plan 2 Task 4 / Plan 3 Task 4 / Plan 4 Task 2.
**Wrong:** `renderImage` passes `size: "1200x630"` to `generateImage`, but
gpt-image models round to their own supported sizes (1024×1024, 1536×1024, …).
`compressPng(raw, 1200)` resizes by **width only, with
`withoutEnlargement: true`** — it never touches the aspect ratio. A 1024×1024
render is therefore stored as `width: 1024, height: 1024`, published to the
webhook as `coverImage: { width: 1024, height: 1024 }`, sent to LinkedIn as the
post image, and rehosted by Webflow as the blog hero. Spec §7's "one 1200×630
master serves hero + og:image + LinkedIn" and its centre-safe-zone reasoning
both quietly stop being true. No test anywhere asserted a cover's dimensions.
**Resolved (product owner, 2026-08-19): generate wide, never crop.** Cropping
was rejected outright — it cuts detail the concept deliberately placed. Instead:
every render states its shape twice (`size` + the new `IMAGE_ASPECT_RATIOS`
entry, Plan 1 Task 6); cover renders pass `enforceAspect: true` and
`renderImage` measures the returned bytes, warns and **re-asks once** if the
aspect is off 1.91:1 by more than `ASPECT_TOLERANCE` (2%), then stores whatever
comes back **with its true width/height** (Plan 1 Task 9). The guard lives in
the one render seam so Plan 2's `illustratePiece` and Plan 3's `renderAndStore`
cannot drift; `compressPng` keeps its width-only resize and now asserts the
no-crop invariant. The Plan 4 test pinning the render's *actual* dimensions
stays, re-commented as the deliberate outcome rather than a gap.

### 5. MAJOR — the "4 MB guaranteed" claim is not guaranteed and not tested — **RESOLVED (decision 2)**
**Where:** spec §7 + §8 / Plan 1 Task 7 / Plan 3 Task 4 / Plan 4 Task 5.
**Wrong:** spec §8 says Webflow's 4 MB rehost cap is "guaranteed by the
compression pass"; LinkedIn's is 5 MB. `compressPng` resizes to ≤1200 px and
palette-quantises, which makes a flat graphic tiny — but Plan 3's
`uploadImageFile` accepts **up to 10 MB** of JPEG/WebP and pushes it through the
same function, and a photograph quantised to PNG at 1200 px can exceed 4 MB.
Webflow would then 400 at publish with a message the user cannot act on.
**Resolved (product owner, 2026-08-19): a 1 MB ceiling on every image we
store — generated AND uploaded.** The owner asked for "a 1MB limit for the
generated images we create"; it is applied to *everything stored* because that
is the only way the Webflow 4 MB cap is actually guaranteed (an uploaded
photograph goes through the same `compressPng`) and because it keeps one code
path instead of two. `compressPng` now enforces `MAX_IMAGE_BYTES = 1_000_000`:
palette step-down, then bounded width step-down (×0.85, ≤4 iterations),
**never** a change of aspect ratio; if it still cannot get under, it returns the
smallest result it achieved and logs — it never throws, because a slightly-over
image beats a failed draft. `uploadImageFile` keeps its 10 MB *input*
validation and stores through `storeRenderBytes` → `compressPng` (verified in
Plan 3 Task 4), so nothing over 1 MB reaches Blob. `MAX_DELIVERABLE_BYTES`
stays exported as the external contract the ceiling satisfies.

### 6. MAJOR — the cover's partial unique index has no guard on any of its three writers
**Where:** Plan 3 Task 4 (`generateCover`, `setCoverFromImage`, `uploadImageFile`).
**Wrong:** `content_images_cover_unique` is a partial unique index on
`(content_piece_id) where role = 'cover'` (Plan 1 Task 2). All three actions do
read-then-insert — `getCoverImage` → (several awaits) → `createImage` — with no
transaction. Two overlapping calls (double-click on "Generate from post";
Generate racing an Upload) both read null and the second insert raises Postgres
23505. Critically, `createImage` sits **outside** each action's `try/catch`, so
this surfaces as an unhandled Server Action rejection — not the
`{ ok: false, error }` toast every other failure in that file produces. Plan 2's
`illustratePiece` handles the same index deliberately (it deletes leftovers
first); the editor actions do not.
**Changed:** added three failing tests to Plan 3 Task 4 (two concurrent
`generateCover`s; `generateCover` racing `uploadImageFile`; the
existing-generated-cover reuse control), with a block comment spelling out the
fix — catch the unique violation by walking `error.cause` for `code === "23505"`
(the shape `src/lib/publishing/dispatch.ts:33-41` already uses) and return a
readable error — and an explicit note that these cases are expected RED against
the code as written.

### 7. MAJOR — the retried body image loses the whole-post style pin
**Where:** Plan 2 Task 7 (`retryFailedIllustration`).
**Wrong:** the retry re-rendered with `referenceImages: vi.styleReferenceImages`
only. `illustratePiece` (Plan 2 Task 4) and Plan 3's `bodyReferences` both add
the piece's current cover when `pinStyleToCover` is on — spec §2 calls that "the
cheapest whole-post consistency win". So the one image the user explicitly asked
to be re-made is the one rendered without it, and it visibly differs from its
siblings.
**Changed:** the retry now loads `getCoverImage` and appends the cover URL for
`role === "body"` when `pinStyleToCover`; added two tests (body retry includes
the cover reference; cover retry does not).

### 8. MAJOR — three different slug functions feed one `imagePathname`
**Where:** Plan 1 Task 8 (`slugForImage`, 40 chars), Plan 2 Task 4
(`slugify` from `src/lib/publishing/slug.ts`, **200** chars, `"update"`
fallback), Plan 3 Task 1 (`imageSlug`, a third re-derivation).
**Wrong:** `slugify` is the *public CMS slug* function — 200 characters, and it
returns `"update"` for pure punctuation because Webflow requires a non-empty
slug (`src/lib/publishing/slug.ts:14`). Using it for Blob pathnames gives the
agent's covers pathnames up to five times longer than the editor's, stored on
every render row and shown in the Blob UI. Plan 3's `imageSlug` then had to
special-case the string `"update"` back to `"image"` — a workaround for a
function it should not have been using.
**Changed:** Plan 2 now imports `slugForImage` and uses it at all three call
sites (cover, body, retry); Plan 3's `imageSlug` now delegates to
`slugForImage`; added a test asserting the two agree for a range of inputs, and
a Plan 2 test asserting a 200-character title still yields a ≤50-character
filename.

### 9. MAJOR — no end-to-end test that drafting actually produces image markdown
**Where:** Plan 2 Task 6.
**Wrong:** every illustration test in `draft.test.ts` stubs `deps.illustrate`
wholesale and asserts the stub's return value was saved. `illustratePiece`'s own
test never goes through `generateDraftForPiece`. So the wiring
`generateDraftForPiece → illustratePiece → planIllustrations →
spliceImageAfterHeading → the body write` — the thing the whole plan exists to
build — has no test that would catch a break in it. The spec's headline user
story ("the draft opens with a cover and 2–3 illustrations already placed") was
unverified end to end.
**Changed:** added `end to end: a ready tenant gets a cover row and image
markdown in the SAVED body` — the real `illustratePiece` with only the three
network seams faked, using the new shared fixtures. It asserts the persisted
body matches `## Alpha\n\n![Gears turning](https://blob.example/tenants/…)`, that
the cover is **not** in the body, that both rows are `ready` with a current
render, and that the body row carries its anchor.

### 10. MAJOR — no shared fixtures; six copies of the same seed
**Where:** Plans 2, 3 and 4 (six hand-rolled "profile + piece + image + render"
seeds).
**Wrong:** `tests/helpers/fixtures.ts` exported only `seedTenant`/`dropTenant`,
so each plan re-implemented `db.insert(companyProfiles).values({ tenantId,
topics: [], visualIdentity: VI })`, its own `VI` constant, and its own
"insert image, insert render, update currentRenderId" triple. One schema change
breaks five files, and the six copies of `VI` can drift out of agreement about
what "ready" means.
**Changed:** added **Plan 1 Task 10b**, which creates `READY_VISUAL_IDENTITY`,
`seedCompanyProfile`, `seedVisualIdentity`, `seedContentPiece` and
`seedContentImage` in `tests/helpers/fixtures.ts` **once**, with a smoke test.
Added a Global Constraints line to Plans 2, 3 and 4 requiring their use, and
pointed Plan 4's two cover seeds at `seedContentImage`.

### 11. MAJOR — migration indices are unallocated and will collide
**Where:** Plan 1 Task 2 (`0063`), Plan 2 Task 2 (`<next>`), Plan 4 Task 1 (`<next>`).
**Wrong:** drizzle-kit numbers by "highest existing + 1". Plans 2 and 4 both say
"`<next>`", so two branches cut from the same base both generate `0064_*.sql`
and conflicting `meta/_journal.json` entries. The plans state a sequential
dependency in prose but never turn it into a checkable number — and this session
has parallel agents.
**Changed:** allocated explicitly — **Plan 1 → 0063, Plan 2 → 0064, Plan 3 →
none, Plan 4 → 0065** — written into all four Global Constraints sections, with
the recovery procedure (rebase, delete the `.sql` + snapshot + journal entry,
re-generate; never renumber by hand) and a final-task step in Plans 2 and 4 that
verifies the index and the journal's last `idx`. Also added the reminder that
nothing in CI runs `npm run db:migrate:test`.

### 12. MAJOR — a spec user story is not implemented by any task — **RESOLVED (decision 3)**
**Where:** spec §2 / Plan 1 Tasks 8 + 12 / Plan 3 Task 1.
**Wrong:** *"As a content lead, I upload two or three of our existing blog
illustrations as references"* (§2 `styleReferenceImages`, described as the
strongest consistency mechanism). Plan 1 Task 12 ships URL inputs and says file
upload "arrives with Plan 3's `uploadImageFile`" — but **no task in Plan 3
touches `visual-identity-editor.tsx`**. The story ships as "paste a public URL",
which most users cannot do for a file on their desktop.
**Resolved (product owner, 2026-08-19): built in Plan 1, so the card is
self-contained.** Plan 1 Task 12 gains `uploadStyleReference(formData)` and
`removeStyleReference(url)` on `company/actions.ts` (the standard
`requireSession` → tenant scope → mutate → `revalidatePath` preamble), and the
Advanced section's URL inputs are replaced by a file input plus thumbnails with
a Remove each. Storage is a new `brandAssetPathname` →
`tenants/{tenantId}/brand/{slug}.png` with **no `content_images` row**: these
are brand inputs, not content, so they never surface in the library. They still
go through `compressPng` + `uploadPng`, so decision 2's ceiling covers them.
The cap of `MAX_REFERENCE_IMAGES` (4) is enforced *before* the upload with a
message that says what to do. The upload validator moved to Plan 1's `blob.ts`
(`UPLOAD_MAX_BYTES` / `UPLOAD_MIME_TYPES` / `validateUploadFile`) and Plan 3
Task 1 **re-exports** it rather than defining a second copy. Plan 1 Task 12 also
now owns `next.config.ts`'s `images.remotePatterns` and
`serverActions.bodySizeLimit` (the thumbnails and the upload need them first);
Plan 3 Task 8 states them as a no-op check.

### 13. MINOR — an order-dependent assertion in Plan 3 Task 2
**Where:** `tests/lib/images/suggest.test.ts`, second case.
**Wrong:** `expect(vi.mocked(generateObject)).toHaveBeenCalledTimes(1); // from
the first test only` — no `mockReset` between cases, so the number is a running
total. It breaks the moment a case is added, reordered, or the file is run with
`-t`.
**Changed:** added a `beforeEach` reset and rewrote the assertion as the
absolute `expect(generateObject).not.toHaveBeenCalled()`. Also added three real
gaps while there: usage recorded against the caller's `database` handle,
concept/alt trimming, and a model failure propagating (rather than silently
returning an empty concept).

### 14. MINOR — cross-tenant tests reuse one tenant name
**Where:** Plan 3 Tasks 4 and 10, Plan 4 Task 2.
**Wrong:** `db.insert(tenants).values({ name: TENANT_NAME })` for the *second*,
"other" tenant. It works only because `tenants.name` has no unique constraint
(`src/db/schema.ts:16-18`), and it makes a failing assertion unreadable ("which
tenant is this row from?"). Plan 2's tests already use a separate `OTHER_NAME`.
**Changed:** added `OTHER_NAME` constants and second `dropTenant` calls in Plan 3
Task 4 and Plan 4 Task 2, updated the existing cross-tenant cases, and wrote the
rule into three Global Constraints sections.

### 15. MINOR — `compileStyleBlock` could emit a multi-line block
**Where:** Plan 1 Task 4.
**Wrong:** the test asserted `block).not.toContain("\n")`, but
`customStyleDescriptors` comes from a `<Textarea>` and rule text is free input,
so either can contain a newline that flows straight into the compiled block —
which is stored verbatim on every render row for reproducibility. The final
prompt survives only because `buildImagePrompt` happens to collapse newlines.
**Changed:** `compileStyleBlock` now ends with `.replace(/\s+/g, " ").trim()`,
with a comment; added tests for newline-bearing descriptors and rules, an empty
palette (must omit the clause entirely, not emit "Palette, used strictly: ."), a
full six-colour palette in role order, and hex lowercasing.

### 16. MINOR — `npm test` (whole suite) was a gate in two plans
**Where:** Plan 1 Task 14 Step 3, Plan 4 Task 8 Step 2.
**Wrong:** the suite is documented as flaky against one shared Postgres
(`docs/superpowers/plans/2026-08-13-shared-fixtures-and-selection-hook.md:29`)
and there is no per-test isolation, so neither a red nor a green whole-suite run
is evidence. Making it a gate trains the implementer to ignore red.
**Changed:** demoted to "informational, not a gate" in both, with the reasoning
inline; replaced with targeted re-runs of the files each plan touches **plus**
the files whose contract it changed (`recordLlmUsage`'s signature, the fixtures
module, `store.ts`, `generateDraftForPiece`'s default deps).

### 17. MINOR — no gates task in Plan 2 at all
**Where:** Plan 2 ended at Task 7.
**Changed:** added **Task 8: Final verification** — the touched-file list run
twice, a regression run over everything that reaches `generateDraftForPiece`
through `after()` (with the "no test suddenly takes tens of seconds longer"
check that would catch an accidental real model call), the three gates, and the
migration-index check.

### 18. MINOR — the LinkedIn image flow lengthens a held row lock
**Where:** Plan 4 Task 7. **Accepted, documented, not changed.**
`deliver` runs inside `claimAndDeliver`'s transaction holding
`SELECT … FOR UPDATE` on the `delivery_attempts` row for the whole call
(`src/lib/publishing/dispatch.ts:88-153`). The new flow adds a blob download, an
upload and up to five one-second polls — roughly 1 s of lock becomes 5–10 s. One
row, one table, one contender (the hourly sweep), so it is fine; but it is not
fine to grow the poll budget later without revisiting.
**Changed:** wrote that reasoning into the constants block in Plan 4 Task 7, with
the escape hatch named (return `retryable` with the URN sooner and let the sweep
own the wait).

### 19. MINOR — `deleteLibraryImage` stamps `bodyEditedAt`, freezing regeneration — **RESOLVED (decision 4)**
**Where:** Plan 1 Task 10 / Plan 3 Task 10 / spec §5b.
Deleting an image from the library rewrote the piece's body and stamped
`editedBy` + `bodyEditedAt`, which permanently freezes whole-draft regeneration
for that piece (`generateDraftForPiece` refuses a hand-edited body,
`src/lib/briefs/draft.ts`). Deleting one image the agent generated is a thin
reason to retire the draft's Generate button.
**Resolved (product owner, 2026-08-19): images enter the library only after a
draft is completed**, i.e. the piece's `status` is anything other than `brief`
or `draft` (the enum is `brief|draft|review|scheduled|published|archived`,
`src/db/schema.ts:89-97`); standalone `role: "library"` images always appear.
A new `listLibraryImages(tenantId, filter, database)` in Plan 1's `store.ts`
applies that predicate — a dedicated function rather than a flag, so the
editor's per-piece `listImages` cannot be filtered by accident — and Plan 3's
library page and "From library" picker both call it. Because a library image can
no longer belong to an in-flight draft, `deleteLibraryImage` **stops stamping
`bodyEditedAt`** (and `editedBy`): it still strips the dead markdown reference,
still refuses images referenced by a published piece. The editor-side body swaps
in `regenerateImage` / `restoreRender` / the retry action are unchanged — they
already never stamped, and they act on a draft their author has open.

### 20. MINOR — a paid model call fires from a menu click, on any owned piece
**Where:** Plan 3 Task 4 `suggestImagePrompt` / Task 9 `openPrompt`.
**Flagged, not changed.** `suggestImagePrompt` has no `assertDraftEditable`
(correct — it is read-only) and no throttle, and `CoverPanel.openPrompt()` calls
it on opening the "Write a prompt" dialog for a coverless piece. Cheap, and the
UX review already noted it as a nit; recording it here because it is also the
only unauthenticated-by-editability model call the feature adds.

---

## (b) Consolidated automation test plan

| Module / surface | Test file | Cases covered | Left manual, and why |
|---|---|---|---|
| Schema: `content_images`, `image_renders`, jsonb columns, `image_count` | `tests/db/content-images-schema.test.ts` (P1 T2) | insert + current pointer; library image with no piece; **partial unique cover index rejects a 2nd cover**; cascade from piece and from image; jsonb round-trip; `image_count` with null tokens | — |
| Schema: `anchor_heading` | `tests/db/content-images-anchor.test.ts` (P2 T2) | null default, round-trip | — |
| Schema: `delivery_attempts.metadata` | `tests/db/delivery-attempts-metadata.test.ts` (P4 T1) | null default, URN round-trip | — |
| `recordLlmUsage` | `tests/lib/ai/llm-usage.test.ts` (P1 T3) | `image_generation` + `imageCount`, null tokens; `illustration_plan` token row with null count; **`DbClient` accepted (typecheck)** | — |
| `visual-identity.ts` | `tests/lib/images/visual-identity.test.ts` (P1 T4) | defaults match spec; `compileStyleBlock` full/one-line/deterministic, **empty palette**, **6-colour palette in role order**, **newline-bearing descriptors and rules**, **hex lowercasing**, no-`Always`, no-rules; readiness at 2/3 colours; `parseVisualIdentity` normalise + reject bad hex/preset/>6/>200/non-URL/>4 refs/non-object; empty palette allowed | — |
| `policy.ts` | `tests/lib/images/policy.test.ts` (P1 T5) | defaults match the §6 table; **every `contentTypeEnum` value resolves** (totality); null/missing fallback; `auto`→3, `off`→0, number→itself; parse accepts partial, rejects unknown type / cap 4 / wrong types / array | — |
| `prompt.ts` | `tests/lib/images/prompt.test.ts` (P1 T6) | ordering concept→style→composition→aspect→no-text; body composition + 4:3; no-text dropped when allowed; sizes | — |
| `compress.ts` | `tests/lib/images/compress.test.ts` (P1 T7) | resize to width keeping aspect; never enlarge; never grows a flat graphic; **under `MAX_IMAGE_BYTES` (1 MB)**; **JPEG in → PNG out**; **square stays square — the no-crop invariant (decision 1)**; **a large noisy photo lands under 1 MB with the aspect intact (decision 2)**; **an already-small image is left alone**; **the bounded loop returns its best rather than throwing**; **non-image bytes reject**; `imageDimensions` reads real dimensions / throws on junk | Real gpt-image output sizes — provider-dependent, cannot be pinned offline |
| `blob.ts` | `tests/lib/images/blob.test.ts` (P1 T8) | pathname with/without piece; **`brandAssetPathname` keeps brand inputs out of the content tree and inside the tenant prefix**; slug lowercase/hyphenate/clamp/fallback; **path-traversal cannot escape the tenant prefix**; **`validateUploadFile` mime + 10 MB cap (the one shared definition, decision 3)**; **`blobPathnameFromUrl` round-trip**; `put` options exactly `{access, addRandomSuffix, contentType}`; `del` batched, no-op on empty, swallows + logs | Real Blob quota behaviour; `addRandomSuffix` semantics |
| `image-model.ts` / `images.ts` (`renderImage`) | `tests/lib/ai/image-model.test.ts`, `tests/lib/ai/images.test.ts` (P1 T9) | prefix strip; provider/model id; string prompt + size **+ aspectRatio**; reference images downloaded to bytes; **`editOf` path**; usage row `imageCount: 1`; failure records nothing; **cover aspect guard: right shape → one call; square → one retry then stored at its true 1024×1024 with two usage rows; body renders unguarded; unmeasurable bytes stored as-is (decision 1)** | Whether `openai.image` or `openai.imageModel` exists, and whether the provider accepts `size`+`aspectRatio` together (Task 1 Step 2 / Task 9 Step 5 check at install) |
| `store.ts` | `tests/lib/images/store.test.ts` (P1 T10) | **`listLibraryImages` excludes brief/draft pieces, includes review/scheduled/published/archived and standalone, honours filters + tenant scope, and leaves `listImages` unfiltered (decision 4)**; create→pending→ready; cross-tenant `getImage` null; prune keeps newest 5 + deletes blobs; **exactly at 5 prunes nothing, at 6 prunes one**; **restored-oldest render pruned without dangling `currentRenderId`**; published piece never prunes; restore; mark failed; cover lookup; list + 3 filters + piece title; `findImageByRenderUrl` hit/miss; **`findImageByRenderUrl` cross-tenant null**; **`getCoverImage`/`listImages` cross-tenant empty**; delete rows+blobs; refuse published; not_found cross-tenant | — |
| Shared fixtures | `tests/lib/images/fixtures-smoke.test.ts` (P1 T10b) | ready identity; null identity; idempotent per tenant; image with/without render; distinct blob URLs per seed | — |
| `derive-visual-identity.ts` | `tests/lib/workspace/derive-visual-identity.test.ts` (P1 T11) | colour extraction (hex/`#rgb`/`rgb()`/theme-color weight/order/cap/none); analyzer returns proposal + records `brand_analysis`; null on model throw; full derive merged over defaults; heuristic fallback; scrape error passthrough; no-colors | SSRF itself — inherited from `fetchPageText`, already covered by `tests/lib/workspace/fetch-page.test.ts:50-201` |
| `/company` visual identity actions | `tests/app/company-visual-identity-actions.test.ts` (P1 T12) | validate+normalise+persist; reject invalid without writing; derive passes tenant + trimmed URL and writes nothing; empty URL refused; **`uploadStyleReference` stores under the brand prefix, appends to the identity and writes no `content_images` row; rejects bad mime / >10 MB without storing; refuses the 5th with a readable cap message; `removeStyleReference` drops the URL + deletes the blob and is a no-op for a foreign URL (decision 3)** | The card UI (OAuth wall) |
| `/settings` image policy action | `tests/app/settings-image-policy-actions.test.ts` (P1 T13) | persist valid matrix; reject cap 9 without writing | The card UI |
| `splice.ts` | `tests/lib/images/splice.test.ts` (P2 T1) | H2 list order + fence skip + other levels; insert after matched heading; case-insensitive + trim; **fenced heading not matched**; missing heading no-op; **duplicate heading uses first only**; two splices independent; **prefix does not match** | — |
| `plan.ts` | `tests/lib/images/plan.test.ts` (P2 T3) | prompts built in code, model has no prompt field; title + H2 list + rules in the call; **anchor canonicalised, non-existent anchor dropped**; **cap truncation + cover dropped**; **duplicate anchor dropped**; alt policy enforced (length + "image of"); no model call when nothing wanted; usage recorded | Model output quality; "never pad to quota" adherence |
| `illustrate.ts` | `tests/lib/images/illustrate.test.ts` (P2 T4) | skip: no identity / policy off; cover-first sizes + references **+ `enforceAspect` on the cover only (decision 1)**; body parallel with cover pinned; rows + anchors + splice; cover absent from body; **one silent retry**; twice-failed body kept `failed` + omitted + counted; failed cover → coverless, body renders without it; `pinStyleToCover: false`; policy `wantCover/bodyCap` forwarded; **leftover cleanup incl. blobs via the injected seam**; **uploaded leftovers spared**; **pathname length clamped**; tenant scoping | Real parallelism against the model |
| Loader step | `tests/components/paced-steps.test.tsx` (P2 T5) | `illustrating` present and `slow` | Visual pacing |
| `generateDraftForPiece` + illustration | `tests/lib/briefs/draft.test.ts` (P2 T6) | step written; reviewed body handed over; spliced body saved; release branch; illustrate throw → warning not failure; **failed renders NOT in `generationError`**; competitor + images warnings compose; not run when generation failed; real default skips with no identity; **end-to-end: real `illustratePiece`, faked network, image markdown in the saved body + rows** | — |
| Retry / dismiss actions | `tests/app/drafts/illustration-actions.test.ts` (P2 T7) | re-render from concept + current style; **a cover retry is aspect-guarded at 1200x630, a body retry is not (decision 1)**; splice at stored anchor; **no `bodyEditedAt` stamp**; cover retry leaves body alone; anchor gone → `placed:false`; not-failed refused; cross-tenant refused; wrong-piece refused; non-editable refused; two failures → `failed` + error; **cover used as reference for a body retry**; **not for a cover retry**; dismiss deletes failed generated rows only; cross-tenant | The notice UI |
| `actions-support.ts` | `tests/lib/images/actions-support.test.ts` (P3 T1) | edit-prompt history chaining; **`validateUploadFile` is Plan 1's function re-exported, not a second copy (decision 3)**; upload mime/size validation; alt from concept (first sentence, prefix strip, 125 cap, empty); `sliceAroundHeading` (section bounds, case, fallback, cap); `stripImageFromMarkdown` (line + inline + no-op); **`imageSlug` ≡ `slugForImage`**; **traversal-safe**; role→size | — |
| `suggest.ts` | `tests/lib/images/suggest.test.ts` (P3 T2) | grounded prompt + system copy; injected generator + cover wording; **usage recorded against the caller's handle**; **trimming**; **model failure propagates** | Suggestion quality |
| Shared-blob guard | `tests/lib/images/store-shared-blob.test.ts` (P3 T3) | `deleteImage` spares a shared pathname, then deletes it; **own unshared blobs still deleted**; **prune spares a shared pathname while pruning the row**; **prune deletes an unshared one** | — |
| `generate.ts` | `tests/lib/images/generate.test.ts` (P3 T4) | render→compress→upload→current; **`enforceAspect` set for a cover and not for a body/library render (decision 1)**; `storedPrompt` vs sent prompt; `editOf` passthrough; `storeRenderBytes` skips the model; `markdownImage` bracket strip | — |
| Draft image actions | `tests/app/drafts/image-actions.test.ts` (P3 T4) | body generate (row + refs + markdown); no identity → refuse + no row; render fail → row deleted; published → throws; suggest slices to the section; regenerate `same`/`edit`/`prompt` + body URL swap + no `bodyEditedAt`; cross-tenant not-found; restore swaps back; cover from_post/prompt/remove/from-library-no-upload; `updateCoverAlt` trim + not-found; upload mime reject / stored as uploaded / cover replace; **non-image bytes → no orphan row**; **>10 MB rejected before the DB**; **upload at another tenant's piece refused**; `lookupImageBySrc` hit/miss; **`lookupImageBySrc` cross-tenant null**; **cover uniqueness under concurrency (3 cases, expected RED until the guard lands)** | Editor bridge ops, toolbar, cover panel, dialogs — jsdom cannot render Base UI popovers without observer stubs that do not exist |
| `nearestHeadingAbove` | `tests/components/nearest-heading.test.tsx` (P3 T6, **new**) | nearest preceding heading; nested inline caret; heading after caret ignored; above first heading → null; outside editor → null; no selection → null; trimming + whitespace-only heading | — |
| Library actions | `tests/app/images/actions.test.ts` (P3 T10) | delete removes row + blobs + the markdown line **and leaves `bodyEditedAt`/`editedBy` null (decision 4)**; refuse for a published piece; cross-tenant not_found; generate library row (no piece, library pathname); refuse without identity; picker lists only rows with a current render **and never a still-drafting piece's image** | Grid, filters, detail dialog (UI) |
| Nav | `tests/components/nav-links.test.tsx` (P3 T10) | `/images` entry | — |
| `cover-image.ts` | `tests/lib/publishing/cover-image.test.ts` (P4 T2) | ready cover → payload; no row → null; failed → null; **ready but no current render → null**; **empty alt passes through**; **actual dimensions reported**; cross-tenant → null | — |
| Webhook payload | `tests/lib/publishing/destinations/webhook.test.ts` + `dispatch.test.ts` (P4 T3) | `coverImage: null` + exact key set; full `coverImage`; reader called with tenant+piece+db; dispatch's exact-keys assertion updated | Receiver behaviour |
| Webflow mapping | `tests/lib/integrations/webflow/mapping.test.ts` (P4 T4) | `{url, alt}` emitted; key omitted when coverless; omitted with no option; **empty alt still emitted**; **other sources unaffected when coverless**; validate accept on Image / reject on RichText naming field + type; suggest first Image only; MultiImage never | — |
| Webflow destination | `tests/lib/publishing/destinations/webflow.test.ts` (P4 T5) | `{url, alt}` in `fieldData`; key omitted when optional + coverless; required-image + no cover → readable permanent error, no item write; cover not read when unmapped | Real Webflow rehosting; in-body `<img>` sideloading (spec calls it undocumented) |
| LinkedIn client | `tests/lib/integrations/linkedin-client.test.ts` (P4 T6) | initialize wrapper body + headers; PUT octet-stream + bearer + exact bytes; non-2xx → `LinkedinApiError`; status mapping incl. `WAITING_UPLOAD`→PROCESSING; `createPost` with/without `content.media` | Real LinkedIn API shapes |
| LinkedIn destination | `tests/lib/publishing/linkedin-destination.test.ts` (P4 T7) | download→init→upload→poll→post + metadata; still-processing → retryable **with** URN, never posts; stored URN skips upload; stored `FAILED` → one fresh upload; fresh `FAILED` → permanent; post 5xx carries URN; blob download failure → retryable, Images API untouched; existing `externalId` short-circuits before the cover; **empty alt still attaches media**; **not-ready cover → no media at all**; **stored URN still PROCESSING does not re-upload**; **poll 5xx carries the URN** | Real upload processing latency |
| Dispatch end-to-end | `tests/lib/publishing/dispatch.test.ts` (P4 T7 Step 5) | metadata persisted on a failed attempt; sweep retry reuses the URN; one initialize, one upload, one post | — |

**Explicitly manual, for the record** (the dev preview is behind an OAuth wall —
see the project memory note): every UI surface in Plans 1 and 3. The manual
checklists in Plan 1 Tasks 12–13, Plan 2 Task 7, and Plan 3 Task 11 are the
coverage, and they are good ones. The blocker is real: `vitest.setup.jsdom.ts`
stubs nothing, so rendering a Base UI `Popover`, `Select` or `DropdownMenu` in
jsdom is unproven territory. If component coverage becomes a priority, the first
task is a separate one — add `ResizeObserver` and `matchMedia` stubs to
`vitest.setup.jsdom.ts` and prove one existing Select renders — not a step
smuggled into these plans.

---

## (c) Pre-merge verification checklist

Run in order. Each plan's branch must be merged before the next one's is cut
(this is what makes the migration indices come out right).

**0. Once, before anything**
```bash
npm install                     # no node_modules in this worktree
```
Expected: `@ai-sdk/openai`, `@vercel/blob`, `sharp` present after Plan 1 Task 1.

**1. Plan 1 (foundation)**
```bash
npm run db:migrate && npm run db:migrate:test
ls src/db/migrations | tail -2          # -> 0062_next_dazzler.sql, 0063_*.sql
npx vitest run tests/db/content-images-schema.test.ts tests/lib/ai/llm-usage.test.ts \
  tests/lib/images tests/lib/ai/image-model.test.ts tests/lib/ai/images.test.ts \
  tests/lib/workspace/derive-visual-identity.test.ts \
  tests/app/company-visual-identity-actions.test.ts tests/app/settings-image-policy-actions.test.ts
npx vitest run tests/lib/ai tests/lib/workspace tests/lib/briefs   # recordLlmUsage + fixtures blast radius
npx tsc --noEmit && npm run lint && npm run build
```
Expected: all PASS on a repeated run; tsc/lint/build clean. Report which of
`openai.image` / `openai.imageModel` exists and any `@vercel/blob` typing
adaptation.

**2. Plan 2 (agent)**
```bash
npm run db:migrate && npm run db:migrate:test
ls src/db/migrations | tail -2          # -> 0063_*.sql, 0064_*.sql
npx vitest run tests/lib/images/splice.test.ts tests/db/content-images-anchor.test.ts \
  tests/lib/images/plan.test.ts tests/lib/images/illustrate.test.ts \
  tests/components/paced-steps.test.tsx tests/components/generation-checklist.test.tsx \
  tests/lib/briefs/draft.test.ts tests/app/drafts/illustration-actions.test.ts
npx vitest run tests/app/briefs-actions.test.ts tests/app/board-actions.test.ts tests/lib/content
npm run typecheck && npm run lint && npm run build
```
Expected: PASS twice. Watch the wall-clock of the second command — a jump of
tens of seconds means something reached a real model through `after()`.

**3. Plan 3 (editor + library)**
```bash
npm run db:generate     # must produce NOTHING; this plan adds no schema
npx vitest run tests/lib/images/actions-support.test.ts tests/lib/images/suggest.test.ts \
  tests/lib/images/store-shared-blob.test.ts tests/lib/images/generate.test.ts \
  tests/app/drafts/image-actions.test.ts tests/app/images/actions.test.ts \
  tests/components/nav-links.test.tsx tests/components/nearest-heading.test.tsx
npx vitest run tests/lib/images tests/app/drafts/illustration-actions.test.ts   # store.ts + imageSlug blast radius
npm run typecheck && npm run lint && npm run build
```
Expected: PASS twice. **The three cover-uniqueness cases must be red first and
green only after the 23505 guard lands** (defect 6). Then run Plan 3 Task 11's
manual checklist — it is the only coverage the editor, cover panel and library
UI have.

**4. Plan 4 (delivery)**
```bash
npm run db:migrate && npm run db:migrate:test
ls src/db/migrations | tail -2          # -> 0064_*.sql, 0065_*.sql
npx vitest run tests/db/delivery-attempts-metadata.test.ts \
  tests/lib/publishing/cover-image.test.ts tests/lib/publishing/destinations/webhook.test.ts \
  tests/lib/publishing/destinations/webflow.test.ts tests/lib/publishing/linkedin-destination.test.ts \
  tests/lib/publishing/dispatch.test.ts tests/lib/integrations/webflow/mapping.test.ts \
  tests/lib/integrations/linkedin-client.test.ts
npm run typecheck && npm run lint && npm run build
grep -n "webhookDestination, webflowDestination, linkedinDestination" src/lib/publishing/dispatch.ts
```
Expected: PASS twice; the grep must still hit `dispatch.ts:12` (Webflow before
LinkedIn).

**5. Informational only, never a gate**
```bash
npm test
```
One shared Postgres, no per-test isolation. Read it for signal, do not merge or
block on it. A file this work touched failing twice in a row is real; anything
else is the known flakiness.

---

## (d) Residual risks

1. **Cover aspect ratio (defect 4 — resolved, residue remains).** The guard
   asks twice and never crops, so a cover can still legitimately ship square if
   the provider insists twice. That is now a *known, recorded* outcome (true
   dimensions everywhere) rather than a silent one, and the log line is the
   signal. If it turns out to happen often, the lever is the prompt and the
   provider, not a crop. Cost: a guarded retry is a second billed image, and
   Plan 2's silent retry wraps it, so a pathological cover can cost four
   renders.
2. **Byte ceilings (defect 5 — resolved).** Every stored PNG is held to 1 MB by
   a bounded loop that never throws, so the worst case is an image slightly over
   1 MB — still far under Webflow's 4 MB and LinkedIn's 5 MB. The residual risk
   is quality, not failure: a photograph upload can be stepped down to ~60% of
   its requested width before the ceiling is met. Watch for the
   `[images/compress]` warning.
3. **Cover unique-index race (defect 6)** is fixed only if the implementer
   actually adds the 23505 guard. The tests are written to force it, but they
   are the only thing standing between a double-click and an unhandled Server
   Action error.
4. **Nothing verifies the provider contract.** `openai.image` vs
   `openai.imageModel`, `generateImage`'s `prompt: { images, text }` shape, and
   whether `size: "1200x630"` is accepted at all are all "checked at install"
   (Plan 1 Task 1 Step 2) — sensible, but no test proves the real call works, and
   the first real render happens in production-shaped code.
5. **No live-API verification of Webflow or LinkedIn.** Both flows are mocked
   end to end. Webflow's rehosting of an API-written Image field and LinkedIn's
   `content.media` shape are taken from documentation. Plan 4's own report step
   says so; it is worth one real publish against a scratch Webflow site and a
   test LinkedIn page before anyone believes it.
6. **In-body images in Webflow are hotlinked**, which the spec accepts — and the
   protection (never delete a blob a published piece references) now rests on
   two code paths (`deleteImage`, `addRender`'s prune) and one shared-blob guard
   in a third. All three are tested after this review's edits; none is enforced
   by a database constraint. A future writer of `del()` has nothing stopping
   them.
7. **The whole feature's UI is unverified by machine.** Two settings cards, an
   in-canvas panel, a per-image toolbar, a cover panel with four dialogs, and a
   library page ship on typecheck + build + a human reading a checklist. That is
   the project's existing posture (OAuth wall), not a new risk — but this is by
   some distance the largest UI surface added at once.
8. **Blob orphans on partial failure.** If `uploadPng` succeeds and the
   subsequent `addRender` insert fails (connection drop mid-write), the blob is
   paid for and unreferenced, and there is no `list()`-based sweep by design
   (spec §7). Rare, unbounded, invisible.
9. **Test-suite flakiness is unchanged.** These plans add ~14 new DB-backed test
   files to a suite with no isolation. Each uses a unique tenant name (checked),
   so they should not collide — but they do add load to the shared Postgres, and
   "run it twice" is now the standing instruction in four places.

---

## Resolutions (product owner, 2026-08-19)

The four items above that needed a human call were decided. Each was applied
surgically to the spec and the plans; nothing else in those documents moved.

### Decision 1 — covers are GENERATED wide, never cropped (defect 4)

Cropping to 1200×630 was rejected: it cuts detail the concept deliberately
placed. The render must come back wide.

| Where | What changed |
|---|---|
| spec §7 | The dimensions paragraph now says covers are generated at 1200×630 natively, describes the measure-and-re-ask guard and the store-the-truth fallback, and states that nothing anywhere crops, extends or letterboxes. |
| Plan 1 Task 6 | New `IMAGE_ASPECT_RATIOS` (`1200x630` → `40:21`, `1200x900` → `4:3`) + a test that the ratios agree with the sizes. |
| Plan 1 Task 7 | The "two things this function does NOT do" block became the two guarantees it *does* make; the square-stays-square test is now the no-crop invariant rather than a documented gap. |
| Plan 1 Task 9 | `RenderImageArgs.enforceAspect`, exported `ASPECT_TOLERANCE = 0.02`, every call sends `size` **and** `aspectRatio`, and the guard (measure → warn → one retry → store as-is) lives here, in the one render seam. Four new tests, including "square render → exactly two calls, stored 1024×1024, two usage rows". |
| Plan 2 Task 4 | The cover branch passes `enforceAspect: true`; the fakes record it and the happy-path test asserts cover-guarded / body-unguarded. |
| Plan 2 Task 7 | The retry action derives `enforceAspect` from the role; two new tests. |
| Plan 3 Task 4 | `renderAndStore` sets `enforceAspect: a.role === "cover"` — by construction, so no call site can forget — plus a cover test and an assertion that a library render is unguarded. |
| Plan 4 Task 2 | The "actual dimensions" test comment now describes the deliberate outcome instead of an open decision. |

**Consequence a reader should know:** a guarded cover can cost two billed
renders (and up to four when Plan 2's silent retry wraps it), and a cover may
still be stored non-1.91:1 — with honest `width`/`height` — if the provider
returns the wrong shape twice.

### Decision 2 — a 1 MB ceiling on every image we store (defect 5)

The owner asked for a 1 MB limit on generated images; it is applied to **all**
stored PNGs, uploads included, because that is the only way Webflow's 4 MB cap
is genuinely guaranteed and it keeps one code path.

| Where | What changed |
|---|---|
| spec §7 | New bullet: the 1 MB ceiling, the bounded palette-then-width step-down, "never the aspect ratio", and why it covers uploads. The Hobby-quota bullet now says "hard-capped at 1 MB". |
| spec §8 | Webflow's "4 MB cap — guaranteed by the compression pass" now names the 1 MB ceiling and says it applies to uploaded images too. |
| Plan 1 Task 7 | `MAX_IMAGE_BYTES = 1_000_000`; `compressPng` loops palette 256→128→64 then width ×0.85 (≤4 steps, floor 400 px), returns the smallest result and logs rather than throwing; `imageDimensions` exported for decision 1's guard; four new tests (large noisy photo under the ceiling with aspect intact, small image untouched, bounded-failure returns, dimensions helper). `MAX_DELIVERABLE_BYTES` stays as the external contract. |
| Plan 1 Global Constraints | Ceiling stated up front. |
| Plan 3 Global Constraints + Task 4 | The 10 MB check is explicitly *input* validation; `uploadImageFile` → `storeRenderBytes` → `compressPng` was **verified** to be the storage path, so no change was needed there. |

**Consequence:** uploads are re-encoded harder than before — a photograph can
lose width to meet the ceiling. Nothing over 1 MB reaches Blob.

### Decision 3 — style-reference upload is built in Plan 1 (defect 12)

| Where | What changed |
|---|---|
| spec §2 | The `styleReferenceImages` row says they are uploaded from the card, stored as brand assets, absent from the library, and saved immediately. |
| Plan 1 Task 8 | `brandAssetPathname({tenantId, slug})` → `tenants/{tenantId}/brand/{slug}.png`; `blobPathnameFromUrl`; and the **single** upload validator (`UPLOAD_MAX_BYTES`, `UPLOAD_MIME_TYPES`, `validateUploadFile`) with tests. |
| Plan 1 Task 12 | `uploadStyleReference(formData)` and `removeStyleReference(url)` with the standard action preamble; the Advanced section's URL rows replaced by thumbnails + a file input with a Remove each; both actions re-baseline the card's dirty tracking; `next.config.ts` gains `images.remotePatterns` and `serverActions.bodySizeLimit`; six new action tests; manual checklist extended. |
| Plan 3 Task 1 | Re-exports the validator from `blob.ts` instead of defining it, with a test asserting it is literally the same function. |
| Plan 3 Task 8 | Its `next.config.ts` step is now a "verify, don't duplicate" check. |
| Plan 1 Self-review | The "open gap (defect 12)" paragraph is replaced by what was built. |

**Consequence:** reference images are the one thing on the Visual identity card
that saves without pressing Save, and they get no `content_images` row, so they
never appear in the /images library.

### Decision 4 — images enter the library only after a draft is completed (defect 19)

"Completed" is concrete: `status` is not `brief` and not `draft`, using the
`content_piece_status` enum verbatim (`src/db/schema.ts:89-97`).

| Where | What changed |
|---|---|
| spec §5b | States the completed-piece rule, why it makes the library safe for in-flight drafts, and the tradeoff in one line. The Delete bullet says the body cleanup happens without `bodyEditedAt`. |
| Plan 1 Task 10 | `listLibraryImages(tenantId, filter, database)` + `LIBRARY_HIDDEN_PIECE_STATUSES` + `ImageFilter`, sharing one private query builder with `listImages`; three new tests covering every status, standalone images, filters and tenant scope. A dedicated function, not a flag, so the editor's listing cannot be filtered by accident. |
| Plan 3 Task 10 | The library page, `listImagesForPicker` and the actions module read `listLibraryImages`; `deleteLibraryImage` no longer stamps `bodyEditedAt` or `editedBy` (it still strips the markdown reference and still refuses published pieces); the test seed defaults to `review`; new tests for the no-stamp rule and for the picker skipping a drafting piece. |
| Plan 3 Task 11 | Two manual checks added. |

**Consequences:** (1) the /images page and every "From library" picker are
smaller than before — an image in a piece you are still drafting lives in that
draft's editor only; (2) the `bodyEditedAt` freeze problem is moot for library
actions, and the editor-side swaps (`regenerateImage`, `restoreRender`, the
Plan 2 retry) are untouched — they already never stamped.

**Not re-litigated:** UX review open decision 5 (does a user-initiated AI
*insert* count as a hand edit?) is a different path — the editor's own
`saveDraftBody` — and is still open.
