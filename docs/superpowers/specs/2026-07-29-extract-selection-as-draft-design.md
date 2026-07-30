# Extract a selection as a separate update

**Date:** 2026-07-29
**Status:** Approved design

## Goal

Let an editor split one draft into two. Highlight a passage in the draft
editor, click **Extract as a separate update** in the selection toolbar, and
the highlighted text is removed from the current draft and becomes a new draft
of its own — rewritten by the same generate → review → validate-links pipeline
that produces every other draft, so it reads as a standalone announcement
rather than an orphaned fragment.

The need comes from batching: a scheduled run composes one draft from every
open atomic update in the window, so two unrelated shipments frequently land in
one announcement. Today the only remedy is manual copy-paste into a draft that
never existed, which the app has no way to create.

## Decisions

| Decision | Choice | Consequence |
| --- | --- | --- |
| New draft's body | Rewritten through the pipeline | Comes out standalone, in brand voice, with a generated title — not a raw fragment. |
| Prompt path | A third composer, `composeExtractPrompt` | Reuses `buildSystemPrompt`; no lying about prose being an atomic update. |
| Atomic updates | New draft gets none | Simple; the ledger goes slightly stale (see Known consequences). |
| Source body | Persisted in the same transaction | No window where the passage exists in two drafts. |
| Remaining body | Computed client-side via Lexical | Server-side string removal would be lossy; see Why the client computes it. |
| After success | Stay on the source draft, toast with a link | Splitting a long draft several times needs no navigation. |
| Click behavior | Confirm step, with an optional instruction | The excerpt is shown before committing; the instruction steers the rewrite. |
| Progress UI | The existing stepped-checklist modal | Same NDJSON stream and `EDIT_STEPS` as the compose and Ask AI flows. |

## Why the client computes the remaining body

`getSelectionMarkdown()` is not guaranteed to return a verbatim substring of
`getMarkdown()`. MDXEditor serializes a selection independently of the whole
document, so a partial list, a selection spanning block boundaries, or
differing escape sequences all produce an excerpt that no string search will
find in the full body. Removing the passage server-side by string match would
therefore fail silently — or worse, match the wrong occurrence.

So the deletion happens where the structure is known: the client restores the
captured Lexical range, deletes it, reads back the committed markdown, and
sends both halves to the server. The server persists what it is given; it never
tries to re-derive one from the other.

The request carries `{ releaseId, excerpt, remainingBody, instruction }`.

## Client

### Entry point

`ExtractSelectionButton` joins `selectionExtras` in
`src/app/(dashboard)/drafts/[releaseId]/mdx-editor.tsx`, beside the existing
`AskAiSelectionButton`, with a `Split` icon from lucide. No new selection
plumbing is needed: the surface's `onMouseDown={preserveSelection}` in the
shared editor already keeps the DOM selection alive through the click, which is
what lets `captureSelection()` see it.

### Context

`agent-edit-context.tsx` gains `"extract"` in its mode union and an
`openExtract()` action, so the provider's existing "snapshot the selection
before the modal steals focus" logic is reused as-is rather than duplicated.
`AgentEditDialog` and the new `ExtractDialog` each render only for their own
modes, so the Ask AI modal's behavior is unchanged.

`EditorOps` gains one operation:

```ts
/**
 * Restores the captured selection, deletes it, and resolves with the editor's
 * authoritative full Markdown AFTER Lexical commits. Same deferred-commit
 * caveat as applyEdit: getMarkdown() read synchronously returns the PRE-edit
 * body, so this awaits a one-shot update listener.
 */
removeSelection: () => Promise<string>;
```

It is implemented in `AgentEditBridge` alongside `applyEdit`, reusing the same
`savedSelection` ref and the same one-shot `registerUpdateListener` pattern
documented there.

### Dialog flow

`ExtractDialog` opens showing the excerpt (read-only) and an optional
instruction box, with an **Extract** button. On confirm:

1. Snapshot `originalBody = ops.getMarkdown()`.
2. `remainingBody = await ops.removeSelection()`.
3. If `remainingBody` is blank, restore and refuse (see Guards).
4. `POST /api/drafts/extract`, driving the step checklist from the NDJSON
   stream exactly as `runWholeEdit` does today.
5. On `done`: `notifySaved()` (the server persisted the source body, so the
   editor is no longer dirty) and toast "Extracted as a new draft" with a link
   to `/drafts/{newReleaseId}`.
6. On any failure: `await ops.applyEdit("whole", originalBody)` to put the
   passage back, then surface the error. The editor is the only place the
   passage still exists at that point, so this restore is load-bearing.

## Server

### Route

`POST /api/drafts/extract`, streaming `application/x-ndjson`. Its preamble is
the one already established by `src/app/api/drafts/edit/route.ts`:
`getServerSession` → `hasValidSession` → `resolveActiveTenant` from the cookie
→ plain 401 (not a redirect — a `fetch()` caller cannot follow a redirect into
a page render) → re-check the release id against the *resolved* tenant rather
than trusting the body.

Request validation: `releaseId` and `excerpt` must be non-empty;
`remainingBody` must be non-blank; `instruction` is optional.

### Pipeline

New module `src/lib/ai/extract-release.ts`:

```ts
export async function runExtractForRelease(
  args: {
    releaseId: string;
    excerpt: string;
    remainingBody: string;
    instruction: string;
    editedBy: string;
  },
  database: Database = defaultDb,
  onProgress?: OnDraftProgress,
  deps: ExtractDeps = {}
): Promise<{ releaseId: string; title: string } | null>;
```

It mirrors `runWholeEditForRelease` step for step — that is the existing
precedent for running the pipeline over something other than a set of atomic
updates:

1. **preparing** — load the source release (tenant-scoped), then brand profile,
   persona catalog, and examples, identically to `runBatchForWorkspace`.
   `selectExamples` is called with `categories: []`, as the whole-edit path
   does, since prose carries no category.
2. **generating** — `generateExtractedDraft(...)`, returning `{ title, body }`.
3. **reviewing** — `reviewAndReconcile`, threading its `detail` events through
   the shared `onProgress`.
4. **saving** — `validateDraftLinks` on the reviewed body, then one
   transaction (below).

The `deps` parameter follows `WholeEditDeps`, so tests inject fakes for
generation and review rather than stubbing the model layer.

### The transaction

```ts
await database.transaction(async (tx) => {
  const [created] = await tx.insert(releases).values({
    tenantId: source.tenantId,
    title: draft.title,
    body: validatedBody,
    composedAt: now,
    reviewStatus: review.status,
    reviewIssues: review.issues,
    reviewedAt: now,
    editedBy: args.editedBy,
  }).returning();

  await tx.update(releases)
    .set({ body: args.remainingBody, bodyEditedAt: now, editedBy: args.editedBy })
    .where(eq(releases.id, args.releaseId));

  return created;
});
```

No atomic updates are linked, so `claimReleaseFromAtomicUpdates` is not used —
it requires at least one claimable atomic update and returns null otherwise.
This is a direct insert instead. `composedAt` is set explicitly rather than
left to its DB default, matching the claim path's reasoning: it is the baseline
catch-up deltas measure against, so it should be visible in the code that
creates it.

Everything before the transaction is a pure read plus LLM calls. A generation
or review failure therefore leaves both rows untouched — the source draft still
holds the passage, and no half-made draft is left behind.

### Prompt

`composeExtractPrompt` in `src/lib/ai/compose-prompt.ts`, exported next to
`composeReleasePrompt` and `composeMergePrompt`, and reusing `buildSystemPrompt`
unchanged so brand guidelines, personas, industry, and examples all apply — as
does the existing standing instruction never to fabricate links.

The user prompt states the task plainly: this passage was lifted out of a
larger product update and must be rewritten as a complete, self-contained
announcement with its own title; keep it grounded strictly in the passage and
add nothing that is not there. The optional user instruction is appended in its
own delimited block. The excerpt is truncated at `DEFAULT_MAX_PROMPT_CHARS`,
consistent with the other composers.

`generateExtractedDraft` lands in `src/lib/ai/generation.ts` beside
`generateReleaseDraft` and `mergeReleaseDraft`, sharing their exact shape:
same `UpdateDraftSchema`, same `GENERATION_MODEL` resolution, same
`recordLlmUsage({ operation: "generation" })` call.

## Guards

- **Blank excerpt** — the toolbar button no-ops; nothing opens.
- **Whole-body extraction** — if `remainingBody` is blank, refuse with "You
  can't extract the entire update", restore the editor, and make no request.
  This is not merely cosmetic: `resolveBody` in `drafts/actions.ts` treats a
  blank submitted body as evidence of an editor parse failure and falls back to
  the stored body, so an emptied source draft would silently resurrect its old
  text on the next save. The server repeats the check for a crafted request.
- **Excerpt length** — capped in the composer, as the other prompt inputs are.

## Known consequences

Two follow directly from the decision that the new draft links no atomic
updates. Both are accepted:

- Publishing the *source* draft marks all of its atomic updates `released`,
  including any whose story now lives only in the still-unpublished new draft.
  The work is recorded as shipped slightly early.
- The new draft's catch-up banner counts every open, unlinked atomic update
  created after its `composedAt` (per `computeReleaseDelta`), none of which are
  necessarily related to it. It may therefore offer a catch-up that has nothing
  to do with its content.

Neither is fixable without moving atomic-update links between the two releases,
which was considered and deliberately left out of scope.

## Tests

Following the existing layout:

- `tests/lib/` — `composeExtractPrompt` includes the excerpt, the guidelines
  block, and the instruction when given one; omits the instruction block when
  not; truncates an over-long excerpt.
- `tests/lib/ai/extract-release.test.ts` — against the test database, with
  generation and review injected via `deps` (alongside the existing
  `edit-release.test.ts`, which tests the sibling orchestrator the same way):
  - both writes commit together: the new release exists with the generated
    title/body and the source body equals `remainingBody`;
  - a generation failure leaves the source body unchanged and creates no
    release;
  - a blank `remainingBody` is refused;
  - a release id belonging to another tenant is refused.
