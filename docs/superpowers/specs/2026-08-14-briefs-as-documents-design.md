# Briefs as Documents — Design

**Date:** 2026-08-14
**Status:** approved, not implemented
**Spec:** A of three. B (brief-run progress + creation modal) is independent; C
(briefs on the board) depends on this one.

## Context

A brief is a structured record: `title`, `angle`, `whyNow`, `suggestedChannel`,
`audience`, `keyPoints[]`, `targetLength`, `score`. The ideation model returns
that as a validated object, and `BriefForPrompt`
(`src/lib/ai/compose-prompt.ts:332`) feeds five of those fields into drafting.

You read a brief as a card in an inbox and either Accept or Dismiss it. You
cannot edit it as a document the way you edit a draft.

This spec makes a brief a document you write, while keeping the reliability that
structured generation buys.

## The model: fields generate the body once, the body rules after

`briefs.body` — markdown — becomes the brief's content.

- **Ideation keeps returning a validated structured object.** Nothing about the
  model call changes. Free-form markdown generation would trade schema
  validation for nothing we need.
- **A pure renderer turns that object into the body, once, at creation.**
- **From then on the body is the source of truth.** Editing writes the body. The
  structured fields are never re-derived from it — no markdown-to-fields
  round-trip, which is the fragile half of every design like this.
- The fields remain for what they are actually used for: `score` and
  `scoreRationale` rank the inbox, `contentType` and `targetLength` steer
  drafting, and the rest is creation-time provenance.

### No backfill, and no nullable-forever ambiguity

The column is nullable, and reads go through one accessor:

```
briefBody(brief) = brief.body ?? renderBriefBody(brief)
```

A brief created before this spec has a null body and renders from its fields on
demand, identically to how it would have been rendered at creation. So there is
no data migration to get wrong, no half-migrated state, and no second code path
that behaves differently — the fallback *is* the renderer.

The first save writes a real body and the fallback stops applying to that row.

## `renderBriefBody`

Pure, in `src/lib/briefs/body.ts`, with no imports from `@/db`. It takes the
structured fields and returns markdown:

```markdown
## Angle
<angle>

## Why now
<whyNow>

## Key points
- <keyPoints[0]>
- <keyPoints[1]>

## Audience
<audience>
```

The title is **not** part of the body — it is a separate field, edited by a
separate control, exactly as a draft's title is. Sections whose field is null or
empty are omitted rather than emitted with an empty body; an empty `## Audience`
heading reads as a mistake rather than as an absence.

Being pure and `@/db`-free is what lets the accessor be called from a client
component without dragging `pg` into the bundle.

## Drafting reads the body

`BriefForPrompt` narrows from five fields to:

```ts
export type BriefForPrompt = {
  title: string;
  body: string;
  contentType: ContentType;
  targetLength: number | null;
};
```

`composeBriefPrompt` embeds the body where it previously listed angle, why-now
and key points. The commission the model receives is the document the human
actually edited — which is the entire point of making it editable.

`generateDraftForPiece` builds this from `briefBody(brief)`, so an unedited brief
produces the same commission it does today.

**The release branch is unaffected.** A `product_update` brief's commission
already does not steer its draft (decided 2026-08-13), so that fork keeps
composing from atomic updates and ignores the body, as now.

## `/briefs` becomes a list

The inbox card grid becomes a list of rows, matching `/drafts`: title, content
type, status, score, and a full-row `Link` to `/briefs/[id]`. The existing
filters stay.

**Accept and Dismiss move into the editor.** They are decisions about a brief you
have read, and reading now means opening it. Leaving them on the row would mean
accepting a brief you have not opened — which is what the current card grid
already encourages and what this change is meant to end.

## `/briefs/[id]` is an editor

Same shape as `/drafts/[releaseId]`, reusing its parts rather than restating
them:

- `MdxEditor` (`src/components/markdown/mdx-editor.tsx`) verbatim — it takes
  `{ markdown, onChange }` and nothing draft-specific.
- The editor-bridge context and source/rich-text toggle from
  `drafts/[releaseId]/draft-editor-context.tsx`. It is named for drafts but is
  not coupled to them; **move it to `src/components/markdown/` and re-point the
  drafts route**, rather than copying it.
- A title field and save/dirty-state wiring mirroring `draft-title-field.tsx`
  and `draft-body-editor.tsx`.

`saveBriefBody({ briefId, body })` mirrors `saveDraftBody`, tenant-scoped, and
sets `briefs.editedAt`. That column already exists and **nothing writes it
today** — verified, not assumed. This spec gives it its first writer, which is
also what makes "has a human touched this brief?" answerable for the first time.

Accept and Dismiss sit in the header with the same confirmation behaviour they
have on the card today, including the dismiss-reason picker.

**A dismissed or accepted brief opens read-only.** Editing a brief whose draft
has already been generated would silently diverge the two, and the draft is the
live document at that point.

## Testing

- `renderBriefBody` omits sections whose field is empty or null, and emits key
  points as a markdown list.
- `briefBody` returns the stored body when present and the rendered fallback when
  null — asserted to be byte-identical to what `renderBriefBody` produces for the
  same fields.
- `BriefForPrompt` carries the **stored** body once one exists, so an edit
  reaches the prompt. This is the requirement the whole spec exists for and must
  be pinned by a test that fails if drafting falls back to the fields.
- `saveBriefBody` is tenant-scoped — asserted by id, refusing another tenant's
  brief — and sets `editedAt`.
- The editor route refuses a brief belonging to another tenant.
- An accepted or dismissed brief renders read-only.
- Per the standing rule, each guard is deleted and its test re-run to confirm it
  fails.

The repo now has jsdom and `@testing-library/react`, so the editor's dirty-state
and save wiring can be tested by rendering rather than only through extracted
pure functions. Use it — three bugs on this branch lived in untested effect
wiring.

**`npm run build` is a mandatory gate.** The editor is a client component reading
through server actions, and `renderBriefBody` is imported on both sides of that
boundary — the exact shape that has leaked `pg` into the client bundle before.
Verify by grepping `.next/static` after building, and sanity-check that grep.

## Files

- Modify: `src/db/schema.ts` + migration — `briefs.body`, nullable text
- Create: `src/lib/briefs/body.ts` (`renderBriefBody`, `briefBody`) and its tests
- Modify: `src/lib/ai/compose-prompt.ts` — `BriefForPrompt`, `composeBriefPrompt`
- Modify: `src/lib/briefs/draft.ts` — build the prompt input from `briefBody`
- Move: `drafts/[releaseId]/draft-editor-context.tsx` → `src/components/markdown/`
- Create: `src/app/(dashboard)/briefs/[briefId]/{page,brief-body-editor,brief-title-field,actions}.tsx|ts`
- Modify: `src/app/(dashboard)/briefs/{page,briefs-list}.tsx` — list rows
- Modify: `src/app/(dashboard)/briefs/brief-card.tsx` — Accept/Dismiss move out

## Open items

- The ideation prompt could emit the body directly once the fields are no longer
  load-bearing anywhere. Not now: structured output is what makes it reliable.
- Spec C will link board brief cards at `/briefs/[id]`.
- `suggestedChannel` is deliberately **not** a body section. It is a one-word
  label, not prose: the card renders it as a badge (`brief-card.tsx:130`), the
  manual form collects it as a field, and the ideation schema requires it. It
  stays a field and keeps its badge on the list row. (An earlier draft of this
  spec claimed nothing read it — that was wrong.)
- `audience` is a body section here, unlike `suggestedChannel`, because it is
  free prose that genuinely belongs in the commission the model reads.
