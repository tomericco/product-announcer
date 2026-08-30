# Product Update Structure — Design

**Date:** 2026-08-30
**Status:** implemented
**Spec:** an addendum to the atomic-updates architecture (2026-07-21) and unified
drafting (2026-08-12). It changes how a product update is *shaped*, not how its
material is acquired.

## Problem

Product update output is judged inaccurate, and the inaccuracy is **structural**,
not factual: the wrong things are emphasised, sections come and go between
releases, and the same change can appear twice. Three independent causes.

**1. The format is described, never shown.** Everything the composer knows about
structure is prose. `analyzeBrandStyle` reads the tenant's changelog page and
writes a `## How we structure updates` section in English; `buildSystemPrompt`
hands that prose to another model, which reconstitutes a format from it. The real
artifacts — their actual published updates — are fetched once in
`importBrandStyleForTenant` and **discarded**.

The other structural input is few-shot examples, and they are largely absent.
`selectExamples` requires an industry OR persona match and filters `s > 0`
(`select-examples.ts:45`), and migration `0045` seeds 11 `product_update` rows
across four industries. A tenant outside `SaaS | Developer Tools | Fintech |
Healthcare` whose personas don't match gets **zero** exemplars and free-styles the
entire structure. When it does match, it gets our generic changelog, not theirs.

**2. Layout is driven by sizes decided in isolation.** `SIZE_GUIDANCE`
(`compose-prompt.ts:135`) is the only real structural instruction — XL leads, L
gets a paragraph, S gets bulleted. But `size` is set per atomic update, by Haiku,
from a one-line summary, with no view of the other items in the release
(`resolve-atomic-updates.ts`, `regenerate-atomic-summary.ts`). A release can come
back with five XLs or none, and the composer then produces five competing
headlines or a flat list with no lead.

**3. Near-duplicate items reach the composer.** Grouping (`resolveAtomicUpdates`)
decides "same change?" from a title and one sentence, and the only intra-batch
dedup is an **exact** lowercased-title match (`apply-resolution.ts:74`). "Shared
dashboards" and "Shared dashboard" become two atomic updates, two items in the
prompt, and two paragraphs about one feature. That reads as a structure defect to
the user even though its cause is grouping.

## Non-goals

Each of these was considered in the 2026-08-30 discussion and deliberately left
out. Named here so they are known gaps, not oversights.

- **PR diffs into enrichment.** Tier-2 enriches a merged PR from title +
  description only (`ingest-pull-request.ts:72`), while `ingest-push` drops the
  PR's own commits because "the PR is its own rich item". Fetching
  `pulls.listFiles` would close that, and was rejected as too technical a signal
  for the classifier. **Consequence, accepted:** a templated or empty PR body
  still yields a vague `impactSummary`.
- **Evidence into the composer.** The composer sees `"title" (category, SIZE) —
  summary` per item and never a diff, PR body, or URL. Passing evidence through
  would fix *fabricated specifics* — it does nothing for structure and tends to
  produce longer, more technical copy. **Revive this if** the complaint ever
  becomes "it announced something we didn't ship."
- **The brief on the release path.** `generateDraftForPiece` builds
  `briefForPrompt` and uses it only in the generic branch (`draft.ts:487`), so a
  product-update brief's angle and key points do not reach `generateRelease`.
  Confirmed as intended.
- **Merging resolver and refresh.** `resolveAtomicUpdates` and
  `regenerateAtomicSummary` both write title + summary + size from evidence, at
  different triggers. Two prompts doing one job; worth unifying, not here.
- **Storing the scraped updates.** The template is derived and stored; the page
  text is discarded, as today. Regeneration is a re-scrape, and the re-import
  panel on `/company` already exposes it.
- **Few-shot examples on this path.** Retired (Part 2). `systemContentExamples`
  and `selectExamples` stay in place, uncalled from product updates.
- **A duplicate check at compose time.** Part 4 attacks duplicates at their
  source. A second, compose-time near-duplicate merge would silently combine
  items a human deliberately split via `reassign.ts`.

---

## Part 0 — Shared prompt rules

Several rules are stated in more than one system prompt, in wordings that have
already drifted. Part 2 adds a **third** consumer of one of them — in
TypeScript — so this goes first.

What exists today, all verified on 2026-08-30:

| Rule | Where | State |
|---|---|---|
| Size rubric (`s`/`m`/`l`/`xl`) | `resolve-atomic-updates.ts:57-61`, `regenerate-atomic-summary.ts:29-33` | **byte-identical** |
| Category rubric | `resolve-atomic-updates.ts:52`, `enrich-change-item.ts:39` | near-identical |
| Title + summary style | `resolve-atomic-updates.ts:56`, `regenerate-atomic-summary.ts:27` | same rule, two wordings |
| Grounding | `compose-prompt.ts:62` (canonical), `linkedin-copy.ts:26` (paraphrase), `REVISION_SYSTEM` (**absent**) | drifted + a hole |
| No invented links | `compose-prompt.ts:63` only | absent everywhere else |
| `<brand-guidelines>` fence | `compose-prompt.ts:106`, `review-draft.ts:71` | duplicated construction |
| Body truncation | `compose-prompt.ts:223, 258, 283, 315` | four inline copies |

The grounding row is the one that is a defect rather than untidiness:
`reviseDraft` rewrites the entire body under a three-line system prompt with
neither the grounding rule nor the link rule, so a revision pass can introduce an
unsupported claim or a fabricated URL that the original generation was forbidden
from writing.

### The module

`src/lib/ai/prompt-rules.ts` — plain exported constants and two pure functions.
The precedent is `src/lib/briefs/signal-fence.ts`, which already does exactly
this for `ideate` and `propose`. Explicitly **not** a prompt framework: no
registry, no builder, no per-call configuration. Call sites still compose their
own system prompts; they just stop restating shared clauses.

```ts
/**
 * Size bands, most significant FIRST. This order is load-bearing twice: it is
 * the order the composer lists changes in (Part 2), and it is what `SIZE_RUBRIC`
 * describes to the model. One array, so the two can never disagree.
 */
export const SIZE_BANDS = [
  { key: "xl", gloss: "a flagship or headline change — a major new capability or overhaul you would lead an announcement with" },
  { key: "l",  gloss: "a significant feature or major improvement worth calling out to many users" },
  { key: "m",  gloss: "a standard improvement or small feature noticeable to users of that area" },
  { key: "s",  gloss: "a minor fix, tweak, or polish — small individual user impact" },
] as const;

export type SizeKey = (typeof SIZE_BANDS)[number]["key"];

/** Descending significance. Part 2 sorts the prompt's item list on this. */
export const SIZE_RANK: Record<SizeKey, number>;

/** Rendered ascending, preserving today's wording verbatim. */
export const SIZE_RUBRIC: string;

export const CATEGORIES: readonly { key: string; gloss: string }[];
export const CATEGORY_RUBRIC: string;
export const TITLE_SUMMARY_STYLE: string;
export const GROUNDING_RULE: string;          // compose-prompt.ts:62, verbatim
export const NO_INVENTED_LINKS_RULE: string;  // compose-prompt.ts:63, verbatim

/** truncateGuidelines + the <brand-guidelines> wrap, in one place. */
export function fenceGuidelines(guidelines: string | null): string | null;

/** Replaces the four inline copies in compose-prompt.ts. */
export function truncateForPrompt(text: string, maxChars?: number): string;
```

`SIZE_BANDS` is a data structure rather than a string because it has two
consumers of different kinds. A shared string constant would have satisfied the
two prompts and left the composer's sort free to hardcode its own ordering —
precisely the divergence this part exists to prevent, just moved.

### Call sites

| File | Change |
|---|---|
| `resolve-atomic-updates.ts` | `SIZE_RUBRIC` + `CATEGORY_RUBRIC` + `TITLE_SUMMARY_STYLE` |
| `regenerate-atomic-summary.ts` | `SIZE_RUBRIC` + `TITLE_SUMMARY_STYLE` |
| `enrich-change-item.ts` | `CATEGORY_RUBRIC`, keeping its own announcement caveat |
| `compose-prompt.ts` | both rules, `fenceGuidelines`, `truncateForPrompt` ×4 |
| `review-draft.ts` | `fenceGuidelines`; `REVISION_SYSTEM` gains both rules |
| `linkedin-copy.ts` | its paraphrase → `GROUNDING_RULE` |
| `compose-prompt.ts` (Part 2) | imports `SIZE_RANK` to order the item list |

### Three rules for carrying it out

1. **Every extraction is a prompt change unless the text is byte-identical.** The
   size rubric is identical, so it is free. The category rubric and the
   title/summary rule are only *near*-identical, so canonicalising one wording
   changes behaviour at the other call site. Do those one at a time, adopting the
   wording from the higher-stakes call site (`resolve-atomic-updates` in both
   cases — it both groups and names, where the other only maintains).
2. **Share the mechanism, not the policy.** `fenceGuidelines` shares the fence;
   the framing sentence stays at each call site, because `buildSystemPrompt`
   varies it by content type and `brandRubric` has a "no requirements configured"
   fallback. Same for `enrich-change-item`'s announcement caveat, which is a real
   instruction to a weaker model and not noise to be tidied away.
3. **`ideate` and `propose` stay out.** They lack a grounding rule too, and
   adding one is a genuine behaviour change to two prompts tuned against
   recorded spike results (see `ideate.ts`'s header). A separate decision, not a
   cleanup — bundling it here would hide it.

### Cost

~120 lines of new module, seven files touched, net negative line count. The only
intended behaviour changes are `REVISION_SYSTEM` gaining two rules and whichever
wording loses under rule 1.

---

## Part 1 — The product update template

### Storage

One column on `company_profiles`:

```
product_update_template   text        -- null until derived or saved
```

Not a new table, and not a section inside `guidelines`. Separate from
`guidelines` because the two have different jobs and different failure modes:
guidelines are voice (prose, read as advice), the template is structure (a
literal artifact, read as a form to fill). Folding the skeleton into the
guidelines document would put it back through the same "model describes a format
to a model" hop this spec exists to remove.

**Null is meaningful and must stay reachable**, exactly as `guidelines` does:
null means never configured, and the composer falls back to today's
`SIZE_GUIDANCE`-only behaviour. Every existing tenant is null on migration, so
the fallback is the live path until they re-import. Blank strings normalize to
null at every write, per the `importBrandStyleForTenant` precedent.

### Variables

A headline is not always a named change. Three real shapes, all of which a
template must be able to express:

| Headline | Needs |
|---|---|
| "20+ updates this August" | a rounded count and a period |
| "Many performance updates across the board" | no items named at all — a theme |
| "A new MCP server, developer key custom prompt, and other stability updates" | several items named, plus a catch-all |

None of these needs the composer to invent a number, and two of them need one it
must not get wrong. So templates may contain variables:

```
{count}  {count_new}  {count_improvement}  {count_fix}  {count_announcement}
{count_s}  {count_rounded}  {month}  {year}
```

```ts
export const TEMPLATE_VARIABLES = ["count", "count_new", "count_improvement",
  "count_fix", "count_announcement", "count_s", "count_rounded",
  "month", "year"] as const;
```

All are **substituted in code** before the prompt is built (Part 2), never filled
by the model. Models miscount, and a wrong number in a headline is precisely the
class of inaccuracy this spec exists to remove — so the digits are ours and only
the grammar around them is the model's.

- `{count}` is every atomic update in the piece.
- `{count_rounded}` rounds **down** to the nearest ten, floored at ten, for the
  "20+" idiom — 23 and 29 both give "20", and a template writes `{count_rounded}+`.
  Rounding down is what makes the `+` honest. Below ten it returns the exact
  count, because "0+ updates" is absurd and a template using this form on a thin
  month should simply read oddly rather than lie.
- `{month}` / `{year}` come from the **latest evidence date** across the items,
  not from the composition date. A changelog published on 2 September
  covering August work says August; `now` would say September. Both loaders must
  therefore select the evidence date. When no item carries one, they fall back to
  the composition date.

Everything outside the slots is literal: headings, ordering, sign-off, whatever
the page showed. That literalness is the point — it is the part prose cannot
carry.

### Title and body

A draft is `{ title, body }` — two fields on `UpdateDraftSchema`, two columns on
`contentPieces`. The template governs **both**, as one document: its first line is
an H1 and is the title pattern; everything after it is the body skeleton.

```
# {count_rounded}+ updates in {month}

## What's new

## Also fixed

— The Acme Team
```

The composer still returns the two fields separately (Part 2), so nothing
downstream changes — the split happens when the template is parsed, not in the
model's output shape.

**A template with no leading H1 leaves the title untemplated**, generated as it is
today. That is the degradation path for a derivation that only recovered body
structure, and it must work: a title pattern is the easiest thing for the
analyzer to get wrong, and a bad one is more visible than none.

Note what the template does *not* contain: any marker saying which change goes
where. The sections are literal and the changes are supplied alongside; deciding
that this release leads with the MCP server and gathers four small fixes under
"Also fixed" is an editorial judgement, and the model has the same title,
summary, category and size to make it with that any ranking function here would.
An earlier draft of this spec assigned items to named slots deterministically —
cut, because a fixed set of sections already prevents the failure that motivated
it (a model deciding proportion freehand and producing five competing leads).
What is left is a structure the model fills and a reviewer that checks it did.

### Derivation

New `src/lib/workspace/derive-update-template.ts`, mirroring
`analyze-brand-style.ts` in shape (Sonnet, `generateObject`, `recordLlmUsage`,
returns null rather than throwing) and called from `importBrandStyleForTenant`
alongside `analyzeBrandStyle`, on the same scraped `pageText`.

The system prompt must demand a **skeleton, not advice**: emit the markdown
structure their updates actually use — heading levels, section order, and any
sign-off, verbatim — leaving each section empty for the composer to fill, and
using the `TEMPLATE_VARIABLES` where the page shows a count or a date. Return null if the page shows no consistent
structure — an invented template is worse than none, because null falls back to
behaviour we already understand.

Written under the same rule `importBrandStyleForTenant` already applies: only
fields the analysis actually produced are written, so a null derivation never
clears a template the team wrote by hand.

### Editing

`/company` gets a Product update template card, following the page's existing
conventions exactly:

- `product-update-template-editor.tsx`, modelled on `guidelines-editor.tsx`,
  including the untouched-template trick: when the column is null and the user
  hasn't touched the field, submit `""` so the column stays null.
- `DEFAULT_PRODUCT_UPDATE_TEMPLATE` in `product-update-template.ts`, seeded into
  the editor when null, demonstrating all three slots.
- `saveProductUpdateTemplate`, scoped to its one column. `saveGuidelines`'
  comment (`company/actions.ts:29`) explains why widening a save on this page
  nulls another card's column; that rule holds here.

---

## Part 2 — Composition

`composeReleasePrompt` gains `template: string | null`. `items` stays a flat
array, ordered most-significant-first via `SIZE_RANK` (Part 0) — a sort, not an
assignment.

**With a template**, three things happen in order, and the first two are code:

1. **Parse.** Split the leading H1 (the title pattern) from the remainder (the
   body skeleton), and scan for `TEMPLATE_VARIABLES`. An unrecognised `{token}`
   is left untouched and treated as the author's own literal text, not an
   error — a template is a human-edited document and must never fail to render
   because someone wrote a brace.
2. **Substitute variables.** Every `TEMPLATE_VARIABLES` token present is replaced
   with its value before the prompt is built. The model never sees one of these
   placeholders and never produces a count or a date itself. This is the only
   determinism worth buying here: a wrong number in a headline is a visible
   factual error, where a debatable choice of lead is not.
3. **Fence and instruct.** The substituted skeleton goes in verbatim
   (`<template>` … `</template>`, the same delimiter discipline
   `<brand-guidelines>` uses, and for the same reason — the team's artifact must
   not read as further instructions), followed by the changes as a flat list with
   their category and size. The instruction is to follow the template's structure
   exactly — its sections, order, headings and sign-off — placing each change
   where it belongs, omitting a section with nothing to put in it rather than
   inventing filler, and treating any number already present as authoritative:
   never recomputed, never adjusted to match its own prose.

**Without one**, the prompt is unchanged from today: `SIZE_GUIDANCE` over a flat
list. Existing tenants keep working, and the fallback is a path we already have
in production rather than a new untested one.

**Examples stop being passed on this path.** `buildSystemPrompt` receives `[]`
for `product_update`; the parameter and `selectExamples` stay for blog and
social. Follow-on deletions, since their only callers are the release paths:

- `atomicUpdateCategories` (`draft.ts:70`) and `distinctCategories`
  (`catch-up.ts:32`) — duplicates of each other, both only for example biasing.
- The `categories` argument on `prepareGenerationContext`, which loses its only
  caller.
- `DRAFT_STEPS`' `"preparing"` label, currently "Preparing brand profile &
  examples".

**Both catch-up entry points get the template**, or a merged draft drifts
off-template the moment anything is added to it:

- `startOverRelease` → `generateReleaseDraft`: identical treatment to a fresh
  compose.
- `catchUpRelease` → `composeMergePrompt`: the template is framed as the
  structure the current body already follows, so folding new items in preserves
  it. `composeMergePrompt`'s "preserve existing wording" stance is unchanged;
  the template tells it *where* new items go.

---

## Part 3 — Structural review

`reviewDraft` / `reviseDraft` take the template and check structure alongside
brand compliance.

This is where the review pass becomes real for the first time. Today
`brandRubric` returns "No specific brand requirements are configured" when
`guidelines` is null (`review-draft.ts:76`) — the reviewer is then a no-op that
passes everything. A template gives it something concrete to compare against even
for a tenant that never wrote guidelines.

The reviewer is given exactly two things: the **draft** and the **template**, and
is asked one question — *does this draft follow this template?* If it does not,
it names the specific gaps. Nothing prescribes a checklist of what conformance
means; a rubric enumerating "section presence, order, heading level, sign-off"
would both miss cases and fire on legitimate variation, and the model reading two
documents side by side is better at this than a list we write in advance.

The template it receives is the **substituted** one — the same artifact the
composer got, every variable already replaced. Not the raw template: a reviewer
shown `{count}` literals would flag every draft in existence for omitting them.

It is deliberately **not** given the change list. With only the two documents it
can compare shape and nothing else, which is what makes "the headline doesn't
mention the MCP server" structurally impossible for it to raise. Which change
leads is an editorial call the composer already made; the reviewer's job is
whether the result follows the template, not whether it would have chosen
differently.

`REVIEW_SYSTEM` gains a template-conformance clause on that basis. The gaps come
back as ordinary `issues` strings, so the `compliant` / `issues` schema, the
≤2-round loop, the per-call retry and the `error` fail-safe are all unchanged,
and `reviseDraft` acts on a structural gap exactly as it already acts on a
brand-compliance one. No new plumbing.

`REVISION_SYSTEM` (`review-draft.ts:58`) carries no grounding rule and no link
rule, yet `reviseDraft` rewrites the whole body — so a revision pass can
introduce an unsupported claim or a fabricated URL that the original generation
was forbidden from writing. It gains both, from the shared constants.

---

## Part 4 — Grouping

Three fixes to `resolveAtomicUpdates` and `applyResolutionInTx`, targeting cause
3. All three are inside the existing tenant advisory lock and change nothing
about the transaction shape.

### 4a. Give the resolver the descriptions it already has

`buildResolverPrompt` sees `type`, `title`, `repoName`, and the one-line
`impactSummary`. `prDescription` and `taskDescription` are already stored on
`change_events` and are simply not selected by `pipeline.ts:36`.

Add both to the select and the prompt, truncated per event:

```ts
export const RESOLVER_CONTEXT_CHARS = 500;
```

At the `RESOLVER_BATCH_SIZE` of 25 that is ~12.5k characters of added context,
comfortably inside budget. Deliberately **not** the diff — see Non-goals.

### 4b. A tolerance band on the same-batch merge

`applyResolutionInTx` merges two `create` actions only on an exact
trimmed-lowercased title match. `RESOLVER_SYSTEM` explicitly instructs the model
to give co-describing events **the same** title, so this is a near-miss on an
intended exact match, not open-ended clustering — which is what makes widening it
safe.

Replace with a pure, testable predicate: normalize (lowercase, strip
non-alphanumerics, collapse whitespace), then merge when the token sets have
Jaccard similarity ≥ 0.8. Merging two genuinely different updates is worse than
splitting them, so the threshold is deliberately strict, it applies **only**
within one batch's `create` actions, and it never touches `assign`.

### 4c. Bound the candidate set

`loadOpenAtomicUpdates` returns every `status='open'` atomic update for the
tenant, unbounded. As a backlog builds, the prompt grows and assign precision
drops.

Order by `updatedAt` descending and cap at `MAX_OPEN_CANDIDATES = 100`, **always
including** any open update with a non-null `contentPieceId` regardless of the
cap — those are the in-flight-draft rows the query's missing `contentPieceId`
filter exists to serve (see its comment), and dropping one reintroduces the exact
duplicate it was written to prevent.

**Honest assessment:** this is the weakest of the three and the only one with a
downside — a candidate excluded by the cap means a late commit creates a
duplicate instead of assigning. Recency ordering plus the linked-row exemption
makes that rare. If we want less machinery, this is the one to cut.

---

## Rollout

No backfill. Every existing tenant has `product_update_template = null` and keeps
today's behaviour until someone re-imports from `/company` or edits the template
by hand. New onboardings get it derived automatically. Parts 0 and 4 apply
immediately to everyone — they are independent of the template and improve the
null-template path too.

## Testing

- `prompt-rules` — `SIZE_RUBRIC` renders byte-identically to the text it
  replaces (a snapshot; this is the one extraction that must not change
  behaviour), and `SIZE_RANK` agrees with `SIZE_BANDS` order.
- `reviseDraft` — its system prompt carries the grounding and link rules. The
  regression this part exists to close.
- Item ordering — `SIZE_RANK` puts the most significant change first, with
  human-pinned sizes respected.
- Template parsing — the leading H1 becomes the title pattern, the remainder the
  body skeleton, and a template without one leaves the title untemplated.
- Variable substitution — every variable; `{count_rounded}` at 9, 10, 23, 29, 30;
  `{month}`/`{year}` taken from the latest evidence date rather than `now`,
  including the month-boundary case and the no-evidence fallback; a template
  using none; and a template containing an unrecognised `{token}` that must
  survive untouched.
- Review — asserts the reviewer receives the substituted template and no item
  list, and that a structural gap comes back as an `issues` string the existing
  reviser consumes.
- Title-similarity predicate — pure, including the near-misses that motivated it
  and the pairs that must *not* merge.
- `composeReleasePrompt` / `composeMergePrompt` — template present vs null;
  assert the null path renders today's prompt unchanged.
- `deriveUpdateTemplate` — mocked model, including the null-derivation path.
- `importBrandStyleForTenant` — a null template never clears an existing one.
- `resolveAtomicUpdates` — descriptions reach the prompt and are truncated.
- `loadOpenAtomicUpdates` — the cap, and the linked-row exemption surviving it.
- Existing `review-draft` tests extended for the structural clause.

## Open question

`MAX_OPEN_CANDIDATES = 100` and the Jaccard threshold of 0.8 are first guesses.
Both are cheap to change and both are pure functions, but nothing in the codebase
measures whether they are right — there is no eval set for this pipeline, so
tuning them will be by inspection of real output.

The larger open question is whether the template plus the review loop is enough
on its own to fix emphasis, or whether some of the placement decision has to come
back into code. This spec bets it is enough. If real output shows the composer
consistently leading with the wrong change, the evidence for reopening that is
the drafts themselves — not an argument from first principles, which is how the
cut version got built the first time.
