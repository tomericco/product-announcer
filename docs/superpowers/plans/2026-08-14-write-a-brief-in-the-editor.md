# Write a Brief in the Editor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** `/briefs/new` becomes the same markdown editor a proposed brief uses, seeded with a template, instead of a field-by-field form.

**Tech Stack:** `@mdxeditor/editor`, Next.js 16.2.10, Drizzle, Vitest 4 (node + jsdom), `@testing-library/react`.

## The shape, decided

`/briefs/new` stays its own page and **nothing is saved until Create is pressed** — unlike the proposal modal, an abandoned draft-in-progress leaves no row.

The page carries three inputs:
- a **title** field,
- a **content type** select,
- the **`MdxEditor`**, seeded with the template.

Title and content type are there because neither can be inferred from prose, and **content type is not cosmetic** — `generateDraftForPiece` forks on `brief.contentType === "product_update"` into the release composition. A hand-written product update with the wrong type drafts down the wrong branch.

**The shared editor at `/briefs/[briefId]` is not changed.** Content type stays a read-only badge there.

## The template

The same headings `renderBriefBody` emits — `## Angle`, `## Why now`, `## Key points`, `## Audience` — so a hand-written brief and a proposed one are indistinguishable downstream, and `briefBody`'s fallback semantics stay coherent.

**It belongs beside `renderBriefBody` in `src/lib/briefs/body.ts`**, not inlined in the page. If the renderer's headings ever change, the template must move with them, and colocation is what makes that obvious. That module has **no `@/db` import** and must keep it that way — it crosses into client components.

## The writer problem — read this before touching `createManualBrief`

`createManualBrief` currently **renders** the body from the structured fields: `renderBriefBody({ angle, whyNow, keyPoints, audience })`. The new page supplies a body *directly*.

**Do not add a second insert path.** `briefs.body` has had exactly this bug class twice on this branch — "one writer guarded, its sibling forgotten" — and both times a guard was missed. `createManualBrief` takes an **optional explicit `body`**, uses it when given, and falls back to rendering when not. One writer, one blank-body guard (`isBlankBriefBody`), one `brief_signals` link.

## The NOT NULL fields the editor does not collect

`angle`, `whyNow`, `suggestedChannel` and `score` are `NOT NULL` with no default. The existing form already supplies `suggestedChannel: ""`, `score: 0.5`, `scoreRationale: ""` — read its defaults (`brief-form.tsx:62-67`) and its comment on why a manual brief's score "means less here" before choosing yours.

For a body-first brief, `angle`/`whyNow`/`keyPoints`/`audience` have no meaningful value. Empty strings satisfy the constraint. **That is safe here specifically because `body` is set**, so `briefBody`'s fallback — which would render `""` from empty fields — never fires. Say so in a comment where you write them; a future reader will otherwise see empty NOT NULL columns and "fix" them.

## Global Constraints

- **Read the relevant guide in `node_modules/next/dist/docs/` before touching route code.** `searchParams` is a Promise here.
- **`"use server"` files may export ONLY async functions.**
- **Never import a runtime value from a server module into a `"use client"` file** — type-only is safe.
- **`npm run build` is a mandatory gate.** `rm -rf .next` first, then grep `.next/static` for `pg`/`pg-protocol` with a **positive control from a `"use client"` file and a negative control from a server-only file**.
- Tenant scoping is the security boundary. Signal ids arrive from a URL and are untrusted — `createManualBrief` already re-reads them tenant-scoped; reuse that, do not write a second guard.
- jsdom and `@testing-library/react` are available — render and drive.
- The suite is flaky against one shared Postgres — re-run a failing file once. Baseline: **193 files / 1641 tests**.
- The tree is clean; stage explicit paths, never `git add -A`.

---

### Task 1: The template and the explicit-body path

**Files:** `src/lib/briefs/body.ts`, `src/app/(dashboard)/briefs/new/actions.ts`, their tests

- [ ] **Step 1: Write the failing tests**

- `BRIEF_TEMPLATE` contains exactly the headings `renderBriefBody` emits. **Assert this against the renderer's own output**, not against a hardcoded copy — a test that duplicates the string cannot catch them drifting apart.
- `createManualBrief` with an explicit `body` stores that body verbatim and does **not** render from fields.
- Without a `body`, it renders from fields exactly as it does today (the existing tests should still pass untouched — check).
- An explicit blank/whitespace body is refused by the existing `isBlankBriefBody` guard, same as a rendered blank one.

- [ ] **Step 2: Run them, confirm they fail**

- [ ] **Step 3: Implement**

`BRIEF_TEMPLATE` in `body.ts`; an optional `body` on `ManualBriefInput`. **One insert path.**

- [ ] **Step 4: Delete the blank guard, confirm the explicit-body refusal test fails, restore**

- [ ] **Step 5: Verify and commit**

---

### Task 2: The page

**Files:** `src/app/(dashboard)/briefs/new/{page,brief-form}.tsx` (the form is replaced), tests

- [ ] **Step 1: Write the failing tests**

- The page renders the `MdxEditor` seeded with `BRIEF_TEMPLATE`.
- Title and content type are present and editable; content type offers every `contentType` enum value.
- Create calls `createManualBrief` with the edited body, the title, and the chosen content type.
- Cancel navigates away and creates nothing.
- **`?signals=…` still seeds evidence selection** — this is the proposal modal's failure fallback and must keep working.
- Submitting with only the untouched template is refused, or reaches the blank guard — decide which and test it. A brief whose body is nothing but empty headings is not a brief.

- [ ] **Step 2: Run them, confirm they fail**

- [ ] **Step 3: Build the page**

Reuse `MdxEditor` (`src/components/markdown/mdx-editor.tsx`) and the `editor-context` bridge the shared editor already uses — **do not fork either**. Follow `/briefs/[briefId]`'s wiring so the two read alike.

Delete whatever of `brief-form.tsx` is left unused. If the whole file goes, say so.

- [ ] **Step 4: Verify by mutation**

Remove the template seeding, confirm that test fails; restore.

- [ ] **Step 5: Verify and commit** — full suite, `npx tsc --noEmit`, `npm run lint`, `rm -rf .next && npm run build` with the controlled grep.

## Out of scope

- Making content type editable on `/briefs/[briefId]`. It stays a read-only badge there.
- Any change to `briefBody`, `renderBriefBody`'s output, or the drafting fork.
