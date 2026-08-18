# Briefs as Documents — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make a brief a markdown document you edit, and make drafting read that document.

**Architecture:** Ideation keeps returning its validated structured object. A pure renderer turns it into markdown once at creation; from then on `briefs.body` is the source of truth and `BriefForPrompt` carries it. Reads go through one accessor that falls back to the same renderer, so no backfill is needed and there is no second code path.

**Spec:** `docs/superpowers/specs/2026-08-14-briefs-as-documents-design.md` — read it before Task 1.

**Tech Stack:** Drizzle + Postgres, Next.js 16.2.10 App Router, `@mdxeditor/editor`, Vitest 4 (node + jsdom projects).

## Global Constraints

- **Read the relevant guide in `node_modules/next/dist/docs/` before writing route or server-action code.** This Next.js has breaking changes vs. training data; `searchParams` and `params` are Promises.
- **`"use server"` files may export ONLY async functions.** No `const`, no type alias, no re-exported type. This has broken this repo's build twice.
- **Never import a runtime value from a server module into a `"use client"` file.** Importing *any* export from a module with a top-level `db` import pulls `pg` into the client bundle — Next does not tree-shake it. `renderBriefBody` is imported on both sides of that boundary, which is exactly why it must have no `@/db` import.
- **`npm run build` is a mandatory gate on every task touching a route or component**, and it is the only thing that catches either failure above. `rm -rf .next` first if route types go stale. After building, grep `.next/static` for `pg`/`pg-protocol` — and **sanity-check the grep** by confirming a string from the new UI *does* appear there, or a clean result proves nothing.
- Tenant scoping is the security boundary, enforced per-query in the WHERE clause. A brief id arriving from the browser is untrusted.
- **No test may reach the real Anthropic API.** Generation is injected through the existing `deps` seam in `generateDraftForPiece`.
- Migrations: edit `src/db/schema.ts`, then `npm run db:generate` (writes `0061_*.sql`), then `npm run db:migrate` **and** `npm run db:migrate:test`. **Never hand-write the SQL.**
- Tests live in `tests/`, mirroring `src/`. **The repo now has two Vitest projects** — `node` for everything touching Postgres, `jsdom` for component and hook tests. Check `vitest.config.ts` for the globs; the two must not overlap. `tests/helpers/fixtures.ts` provides `seedTenant`/`dropTenant`.
- The suite is flaky against one shared Postgres — re-run a failing file once. Baseline: **180 files / 1477 tests**.
- The UI cannot be visually verified; the dev preview is behind an OAuth wall.
- **The working tree has pre-existing uncommitted changes that are NOT ours:** `src/app/(dashboard)/board/column.tsx`, `src/app/(dashboard)/layout.tsx`, untracked `src/app/(dashboard)/main-container.tsx`. **Never `git add -A`.**

---

### Task 1: `briefs.body` and the pure renderer

**Files:** `src/db/schema.ts`, migration `0061_*.sql`, `src/lib/briefs/body.ts`, `tests/lib/briefs/body.test.ts`

**Produces:** `renderBriefBody(fields)` and `briefBody(brief)`. Every later task uses them.

- [ ] **Step 1: Write the failing tests**

`renderBriefBody` takes the structured fields and returns markdown with `## Angle`, `## Why now`, `## Key points` (a `-` list), `## Audience`. Cover: all sections present; a null `audience` omits its heading entirely; an empty `keyPoints` array omits that heading; the title is **not** in the body.

`briefBody(brief)` returns `brief.body` when non-null, and otherwise `renderBriefBody(brief)`. Assert the fallback is **byte-identical** to calling the renderer directly for the same fields — that equality is what makes the missing backfill safe.

- [ ] **Step 2: Run them, confirm they fail**

- [ ] **Step 3: Write `src/lib/briefs/body.ts`**

**No imports from `@/db`.** It takes plain field values, not a row type read from the database — a `Pick<>` of the shape it needs. This module is imported by client components.

- [ ] **Step 4: Add the column**

In `src/db/schema.ts`, on `briefs`, next to `editedAt`:

```ts
  // The brief as a markdown document. Null on briefs created before this
  // existed, and on those `briefBody()` renders the same markdown from the
  // structured fields on demand — the fallback IS the renderer, so there is
  // no second code path and no backfill to get wrong. The first save writes a
  // real body and the fallback stops applying to that row.
  //
  // Source of truth once set: the structured fields are NEVER re-derived from
  // it. There is no markdown-to-fields parse anywhere and there must not be.
  body: text("body"),
```

Then `npm run db:generate`, `npm run db:migrate`, `npm run db:migrate:test`. Confirm exactly one new file containing a single `ALTER TABLE "briefs" ADD COLUMN "body" text;`. Anything else means schema drift — stop and report.

- [ ] **Step 5: Run the tests, then commit**

---

### Task 2: Creation writes a body

**Files:** `src/lib/briefs/run.ts`, `src/app/(dashboard)/briefs/new/actions.ts`, their tests

**Consumes:** `renderBriefBody` from Task 1.

Both paths that insert a brief must store a rendered body: the ideation run's `.insert(briefs)` in `src/lib/briefs/run.ts` (it builds its values from a local `const b = action.brief`), and the manual form's at `src/app/(dashboard)/briefs/new/actions.ts:76`. Grep for `insert(briefs)` rather than trusting those locations — if a third insert exists, it needs a body too, and missing one would leave briefs that silently never reflect an edit.

- [ ] **Step 1: Write the failing tests** — a brief created by each path has a non-null `body` equal to `renderBriefBody` of its own fields.

- [ ] **Step 2: Run them, confirm they fail**

- [ ] **Step 3: Set `body: renderBriefBody(...)` on both inserts**

Do **not** change what the ideation model returns or its Zod schema. The structured object stays exactly as it is; you are rendering it, not replacing it.

- [ ] **Step 4: Verify and commit** — full suite, `npx tsc --noEmit`.

---

### Task 3: Drafting reads the body

**Files:** `src/lib/ai/compose-prompt.ts`, `src/lib/briefs/draft.ts`, their tests

**This is the task the spec exists for.** If it regresses, briefs are editable but editing them changes nothing.

- [ ] **Step 1: Write the failing test**

Give a brief a stored `body` that differs from what its fields would render, run `generateDraftForPiece` with an **injected** generator, and assert the prompt the generator received contains the stored body — and does **not** contain the field-rendered text. A test that only checks "the body appears" would pass on the fallback too.

- [ ] **Step 2: Run it, confirm it fails**

- [ ] **Step 3: Narrow `BriefForPrompt`**

```ts
export type BriefForPrompt = {
  title: string;
  body: string;
  contentType: ContentType;
  targetLength: number | null;
};
```

- [ ] **Step 4: Rewrite the prompt lines**

In `composeBriefPrompt`, lines 378-385 currently read:

```ts
    `Write this piece. Title: "${brief.title}".`,
    `Angle: ${brief.angle}`,
    `Why now: ${brief.whyNow}`,
    brief.keyPoints.length > 0
      ? `Cover these points, in order:\n${brief.keyPoints.map((p, i) => `${i + 1}. ${p}`).join("\n")}`
      : null,
    brief.targetLength ? `Target length: about ${brief.targetLength} words.` : null,
    FORMAT_GUIDANCE[brief.contentType],
```

Replace the three field lines with the body. Keep the title line, the target-length line and `FORMAT_GUIDANCE` exactly as they are — they are not part of the commission prose.

Just below, an existing comment explains that evidence is fenced apart from the commission "because the model otherwise treats the angle as one more signal". `angle` is no longer passed, so that sentence now names a field that does not exist on `BriefForPrompt`. **Update it to refer to the body** — the reasoning still holds, only the noun changes.

- [ ] **Step 5: Build the input from the accessor**

In `src/lib/briefs/draft.ts`, replace the five-field `briefForPrompt` literal with one built from `briefBody(brief)`.

- [ ] **Step 6: Verify and commit** — the new test, the full suite, `npx tsc --noEmit`.

---

### Task 4: The brief editor route

**Files:** move `drafts/[releaseId]/draft-editor-context.tsx` → `src/components/markdown/editor-context.tsx`; create `src/app/(dashboard)/briefs/[briefId]/{page.tsx,brief-body-editor.tsx,brief-title-field.tsx,actions.ts}`

- [ ] **Step 1: Move the editor context, do not copy it**

It is named for drafts but is not coupled to them. Move it, re-point the drafts route's imports, and confirm the drafts editor still builds and its tests pass. **A copy here would be a new duplication introduced by a spec whose point is reuse.**

- [ ] **Step 2: Write `saveBriefBody`**

`actions.ts`, `"use server"`, one async export. Takes `{ briefId, body }`, resolves `tenantId` from `requireSession()`, updates the brief scoped by `id AND tenantId`, and sets `editedAt`. **Refuses a brief whose status is `accepted` or `dismissed`** — per the spec those open read-only, and the server is the boundary, not the UI.

- [ ] **Step 3: Build the route**

An async Server Component at `/briefs/[briefId]` — `params` is a Promise, await it. Reads the brief tenant-scoped, renders the title field and `MdxEditor` (`src/components/markdown/mdx-editor.tsx`, props `{ markdown, onChange }`) seeded from `briefBody(brief)`. Mirror `drafts/[releaseId]`'s dirty-state and save wiring rather than inventing another.

Accept and Dismiss go in the header, reusing the existing handlers and the dismiss-reason picker from `brief-card.tsx`.

- [ ] **Step 4: Test it**

`saveBriefBody` is tenant-scoped (asserted **by id**, not by an empty result), sets `editedAt`, and refuses an accepted or dismissed brief. Delete each guard in turn and confirm the matching test fails.

**The repo now has jsdom and `@testing-library/react`** — use `renderHook`/`render` for the dirty-state and save wiring rather than extracting pure functions to work around a limitation that no longer exists. Three bugs on this branch lived in untested effect wiring.

- [ ] **Step 5: Verify and commit** — tests, `npx tsc --noEmit`, `npm run lint`, `rm -rf .next && npm run build`, plus the client-chunk `pg` grep with its sanity check.

---

### Task 5: `/briefs` becomes a list

**Files:** `src/app/(dashboard)/briefs/{page.tsx,briefs-list.tsx,brief-card.tsx}`

- [ ] **Step 1: Convert the card grid to list rows**

Mirror `/drafts/page.tsx`: each row shows title, content type, status, score and the `suggestedChannel` badge, with a full-row `Link` to `/briefs/[briefId]`. Keep the existing filters working.

- [ ] **Step 2: Remove Accept and Dismiss from the row**

They now live in the editor (Task 4). Removing them is the point — a row-level Accept lets you accept a brief you never opened. Delete the now-unused state and handlers from `brief-card.tsx`; if nothing remains of that component, delete it and say so.

- [ ] **Step 3: Verify and commit** — full suite, `npx tsc --noEmit`, `npm run lint`, `rm -rf .next && npm run build`.

## Out of scope

- Spec B (brief-run progress + creation modal) and spec C (briefs on the board). C will link these rows' cards at `/briefs/[briefId]`.
- Changing the ideation model call or its Zod schema.
- Deleting `suggestedChannel` — it is read in three places (see the spec).
