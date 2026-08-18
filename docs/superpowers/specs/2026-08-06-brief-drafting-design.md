# Drafting From a Brief — Design

**Date:** 2026-08-06
**Status:** approved, not implemented
**Spec:** 5c — the third and final part of spec 5, after the brief agent (5a) and the inbox (5b).

## Context

Accepting a brief creates a `content_pieces` row whose body is a deterministic
scaffold: the angle, the why-now, and the key points as headings. No model call.
That was 5b's deliberate boundary — real drafting was deferred here.

The failure model is already settled and must not be re-litigated: **accept is
an instant state change that cannot fail; generation runs after it and is
retryable.** A generation failure must never cost the human their decision.

## Non-goals

- Channel variants, publishing, the pipeline board, the calendar.
- Regenerating a draft a human has already edited. `contentPieces.bodyEditedAt`
  exists and freezes regeneration elsewhere in this codebase; the same rule
  applies, and enforcing it is a one-line guard, not a feature.
- Changing the existing product-update generation path. Its three prompt
  composers and `generateReleaseDraft` keep working byte-identically.

## Part 1 — Correct a 5b defect, and record generation state

### `acceptBrief` sets the wrong status

`contentPieceStatusEnum` includes `"brief"`, and both `schema.ts:571` and the
pivot design doc define it as *approved, draft not yet generated* — explicitly so
"a lead can approve five briefs Monday and generate drafts across the week." 5b's
`acceptBrief` sets `"draft"`.

Fix it: accept sets `"brief"`. Generation moves `brief → draft`. This gives 5c
its state machine with no new status and restores the workflow the design doc
describes.

### Two nullable columns on `content_pieces`

```
generation_error   text          -- null on success; the reason otherwise
generated_at       timestamptz   -- when a model last wrote this body
```

`generationError` is not optional polish. Without it a piece sitting at status
`brief` cannot distinguish "generation has not run yet" from "generation ran and
failed" — the identical ambiguity already fixed twice in this project (the news
agent's silent stale-drops, and `brief_runs`). A retry button that cannot say why
it is offering a retry is a worse version of no button.

`generatedAt` distinguishes a scaffold body from a generated one, which the UI
needs and which `bodyEditedAt` cannot express.

## Part 2 — Where generation runs

`after()` from `next/server`, called inside `acceptBrief`. Verified available in
this repo's Next.js 16.2.10 at
`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md`.

Accept returns immediately; the callback runs once the response is finished, so
generation never blocks the human and never fails the accept.

**Constraint from the docs, load-bearing:** request-time APIs (`cookies`,
`headers`) are not available inside `after`. Everything the callback needs —
tenant id, user id, the brief, the content piece id — must be read BEFORE it and
closed over. `acceptBrief` already has all of them in scope.

**On failure:** set `generationError`, leave `status` at `"brief"`, leave the
scaffold body in place. The piece then shows a **Generate draft** button that
calls the same generation path. Retry and the design doc's deferred-generation
workflow are therefore the same code, not two.

The generation entry point is a plain exported function in `src/lib/briefs/`,
not a server action, so `after()` and the button both call it and it stays
testable without mocking Next internals.

## Part 3 — The prompt

### What stays universal

`buildSystemPrompt` gains a fourth parameter, `contentType`, defaulting to
`"product_update"` so all five existing callers in `compose-prompt.ts` are
untouched.

These rules apply to **every** content type and must not be made conditional:

- the grounding rule (never invent features, metrics, dates, quotes);
- the no-fabricated-links rule and its `[add link]` placeholder;
- **the naming prohibition** — never name, compare to, or reference other
  companies.

### The naming prohibition is deliberately kept for all types

This was decided explicitly, against the alternative. The validation spike's
highest-value brief was a response to a named competitor's security advisory, so
this rule costs real range: a draft must cover an industry development without
naming who did it. That cost is accepted.

It has a consequence the prompt must handle head-on: **the evidence will contain
company names.** Cited signals carry competitor names, article titles and
publication names. The prompt therefore cannot merely omit permission — it must
state that the sources are context, that names appearing in them are not to be
reproduced, and that the draft should describe developments in general terms.

### What varies by type

Only the opening role line and the format/length guidance:

| Type | Role line | Shape |
|---|---|---|
| `product_update` | the existing announcement line, unchanged | existing `SIZE_GUIDANCE` |
| `blog_post` | an industry piece for this company's audience | longer, sections, Markdown headings |
| `social_post` | a short post for one platform | one idea, no headings, tight |

### `composeBriefPrompt`

New, alongside the existing composers. Takes the brief (title, angle, why-now,
key points) plus its cited signals, and serializes them as evidence — the
analogue of `serializeAtomicUpdates`, which serializes atomic updates and is
wrong for this input.

The brief is a **commission**: its angle and key points are instructions to
follow, while the signals are source material to ground against. The prompt must
distinguish them, or the model treats the commission as more evidence.

## Part 4 — Checking the naming rule

Instruction alone will not hold this, so it is verified after generation.

The `competitors` table already lists this tenant's competitors by `name`
(NOT NULL) and `websiteUrl`. After a draft is generated, scan its title and body
for those names, and for the hostnames of the cited signals.

A hit sets `generationError` to a warning naming what was found, and **leaves
the draft in place** at status `draft`. This is detection, not blocking: a false
positive that discarded a good draft would be worse than the problem it guards.
The human sees the warning on a real draft and edits it.

Matching must be word-boundary anchored and case-insensitive. A competitor named
"Lilt" must not fire on "quilted", and a one-or-two-character competitor name
must be skipped entirely rather than matching everything.

## Part 5 — Plumbing

`generateBriefDraft` mirrors `generateReleaseDraft` exactly: `generateObject`,
the existing `UpdateDraftSchema` (`{ title, body }`), `resolveModel`,
`recordLlmUsage`. Only the prompt composer differs.

`prepareGenerationContext` currently hardcodes `contentType: "product_update"`
when selecting few-shot examples (`generation-context.ts:35`). It gains a
parameter defaulting to that value, so existing callers are unaffected.

**`LlmOperation` is a CLOSED string-literal union** in `src/lib/ai/llm-usage.ts`
(12 members today) while the database column is free text. A new operation must
be added to the union or `tsc` fails — and omitting it fails only at compile
time, never at runtime. Add `"brief_draft"`.

## Part 6 — UI

On a content piece at status `"brief"`:

- show that it is awaiting generation;
- if `generationError` is set, show it;
- offer **Generate draft**, which calls the same path `after()` calls.

On a piece at status `"draft"` with `generationError` set — the naming-check
warning case — show the warning above the editor without implying the draft is
broken.

The drafts list must not present a `"brief"`-status piece as a finished draft.

## Testing

Per the standing rule, every guard below gets deleted and the test re-run to
confirm it fails.

1. `acceptBrief` sets status `"brief"`, not `"draft"`.
2. Generation moves `brief → draft`, sets `generatedAt`, clears `generationError`.
3. A generation failure leaves status `"brief"`, sets `generationError`, and
   **leaves the scaffold body intact** — the human's decision survives.
4. A failure does not fail the accept: the brief stays `accepted` and the piece
   still exists.
5. Generation refuses to overwrite a piece whose `bodyEditedAt` is set.
6. `buildSystemPrompt` with no fourth argument produces **byte-identical** output
   to today's, proving the three existing paths are untouched.
7. Each content type produces its own role line, and every type still carries the
   grounding, link and naming rules.
8. The naming check fires on a competitor name, is case-insensitive, respects
   word boundaries (no "Lilt" inside "quilted"), and skips very short names.
9. A naming hit warns and leaves the draft at `"draft"` — it never discards it.
10. `recordLlmUsage` is called with the new operation.

**Not testable here:** the UI. The dev preview is behind an OAuth wall.
`npm run build`, `tsc` and `eslint` are the gates — and **`npm run build` is
mandatory**, because it caught a `"use server"` export rule that 1216 passing
tests missed.

## Files

- Modify: `src/db/schema.ts` — two columns on `contentPieces`
- Create: `src/db/migrations/<n>_*.sql`
- Modify: `src/app/(dashboard)/briefs/actions.ts` — status `"brief"`, `after()`
- Create: `src/lib/briefs/draft.ts` — the generation entry point and the naming check
- Modify: `src/lib/ai/compose-prompt.ts` — `contentType` parameter, `composeBriefPrompt`
- Modify: `src/lib/ai/generation.ts` — `generateBriefDraft`
- Modify: `src/lib/ai/generation-context.ts` — parameterise the content type
- Modify: `src/lib/ai/llm-usage.ts` — `"brief_draft"`
- Modify: the drafts UI — the `"brief"` state, the warning, the Generate button
- Tests alongside each

## Open items for whatever follows

- **The naming rule will visibly constrain output.** Drafts about industry
  developments must describe them without attribution. Worth reading the first
  real drafts specifically for whether they read as evasive; the decision is
  reversible by relaxing the rule for non-product types.
- Regeneration after a human edit is refused, not offered as an override.
- `generationError` carries two different meanings — a hard failure at status
  `brief`, a naming warning at status `draft`. If a third meaning appears, it
  needs a real column rather than a third overload.
