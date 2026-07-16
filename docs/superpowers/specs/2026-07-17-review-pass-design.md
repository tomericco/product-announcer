# Post-Generation Review Pass — Design

**Date:** 2026-07-17
**Status:** Approved (pending spec review)
**Sub-project:** D of the "smarter AI generation" initiative

## Context

Fourth and final sub-project improving AI-generated product updates:

- **A — Per-commit enrichment** (done).
- **B — Curated example library** (done).
- **C — Prompt composition** (done): the generation prompt now consumes A's enrichment and
  B's examples plus full brand/persona voice.
- **D — Post-generation review pass** (this doc): after generation, review the draft against
  brand requirements; revise once if it violates them; gate auto-publish on the result.

D is independent of the A→B→C prompt work — it wraps the *output* of generation rather than
its input. It is most valuable on the auto-publish path, where no human sees the draft before
it ships.

### Current flow (insertion point)

`runBatchForWorkspace` ([src/lib/run-schedule.ts](../../../src/lib/run-schedule.ts)):
generate `draft` via `generateUpdateDraft` (with one retry) → `claimBatchAndCreateUpdate`
stores it → an auto-publish gate publishes + dispatches the webhook when the tenant has
`autoPublish` **and** an active webhook. D inserts a review step between generation and that
auto-publish gate. `runNow` (manual "Draft update now") also routes through
`runBatchForWorkspace`, so the review runs on **every** generated update, not just
auto-published ones.

## Goal

After a draft is generated, send it to a review LLM to check it against the tenant's brand
requirements. If it violates them, rewrite it once to comply and re-check. Store the
(possibly revised) draft with its review outcome, and only allow auto-publish when the review
passed. A draft that still fails after one revision — or that could not be reviewed — is held
as a draft for a human, with the specific issues attached.

## Design

### 1. Data model

New columns on the `updates` table (D requires a migration):

| Column | Type | Meaning |
|---|---|---|
| `review_status` | `review_status` enum: `passed` / `revised` / `failed` / `error` (nullable) | null = not reviewed (pre-D updates) |
| `review_issues` | `jsonb` `string[]`, default `[]` | brand-rule violations from the final review; populated when `failed` |
| `reviewed_at` | `timestamptz` (nullable) | when the review ran |

Status meanings: `passed` = compliant on first check; `revised` = violated, rewritten, now
compliant; `failed` = still non-compliant after one revision (issues attached); `error` =
review LLM unavailable after a retry (fail-safe — held, not shipped).

### 2. Review module — `src/lib/review-draft.ts`

- `ReviewResult` (Zod): `{ compliant: boolean; issues: string[]; revised: { title: string; body: string } | null }`.
  When non-compliant, the LLM returns `revised` (the rewritten draft) and `issues`; when
  compliant, `revised` is null and `issues` is empty.
- `buildReviewPrompt(draft, brandProfile)` — **pure**; assembles the compliance rubric from
  `tone`, `readingLevel`, `doList`, `dontList`, and `examplePhrases`, plus the draft.
- `reviewDraft(draft, brandProfile)` → `generateObject` with
  `process.env.REVIEW_MODEL ?? "anthropic/claude-sonnet-4-5"` (a capable model — it both
  judges and rewrites). May throw on model error.
- `type ReviewOutcome = { finalDraft: UpdateDraft; status: "passed" | "revised" | "failed" | "error"; issues: string[] }`.
- `reviewAndReconcile(draft, brandProfile)` orchestrates:
  1. `r1 = reviewDraft(draft)`, **retrying once** on error;
  2. `r1.compliant` → `{ finalDraft: draft, status: "passed", issues: [] }`;
  3. else re-review the revision: `r2 = reviewDraft(r1.revised)` →
     `{ finalDraft: r1.revised, status: r2.compliant ? "revised" : "failed", issues: r2.compliant ? [] : r2.issues }`.
     (If a non-compliant `r1` returns no `revised`, treat as `failed` with `r1.issues` and
     `finalDraft: draft`.)
  4. If review still throws after the retry → `{ finalDraft: draft, status: "error", issues: [] }`.

The re-review in step 3 is a single call (no retry) — the retry policy covers the *first*
review only, matching "retry the review once on error".

### 3. Wiring in `runBatchForWorkspace`

After `draft` is generated and before storage:

```ts
const review = await reviewAndReconcile(draft, brandProfile);
```

`claimBatchAndCreateUpdate` is extended to accept the review outcome and persist
`review_status`, `review_issues`, and `reviewed_at = now()` on the created update, storing
`review.finalDraft` as the update's title/body. The auto-publish gate gains a clause:

```ts
const reviewPassed = review.status === "passed" || review.status === "revised";
if (tenant?.autoPublish && activeWebhook && reviewPassed) { …publish + dispatch… }
```

So `failed` and `error` both block auto-publish; the update remains a `draft` for a human.

### 4. UI surfacing

- **Drafts list** ([drafts/page.tsx](<../../../src/app/(dashboard)/drafts/page.tsx>)): a
  review-status badge per update.
- **Draft detail** ([drafts/[updateId]/page.tsx](<../../../src/app/(dashboard)/drafts/[updateId]/page.tsx>)):
  the `review_issues` list rendered for a `failed` draft so a human sees which brand rules to fix.
- A pure `reviewStatusLabel(status)` helper (unit-tested, like B's `changeItemFacingState`)
  maps status → badge text (e.g. `failed` → "Failed review", `revised` → "Auto-revised",
  `error` → "Review unavailable", `passed`/null → no badge).

### 5. Testing

- **`buildReviewPrompt`**: includes tone / reading level / do / don't / preferred phrasing and
  the draft title+body.
- **`reviewDraft`**: parses a `ReviewResult` from a mocked `generateObject`.
- **`reviewAndReconcile`** (mocked `ai`): passed-first → `passed`; non-compliant then
  revised-compliant → `revised` with the revised draft; non-compliant then still-failing →
  `failed` with issues and the revised draft; first review throws twice → `error` (and the
  retry is actually attempted — `generateObject` called twice).
- **`run-schedule`** (integration, mocked `ai`): a `failed`/`error` review blocks auto-publish
  (update stays `draft` despite `autoPublish` + active webhook); a `passed`/`revised` review
  auto-publishes and dispatches.
- **Migration round-trip**: insert/read an update with the review columns.
- **`reviewStatusLabel`**: each status maps to the expected label (or none).

## Scope boundaries (explicitly NOT in D)

- The review checks **brand-voice compliance** (tone, reading level, do/don't, preferred
  phrasing) — **not** the factual accuracy of the changelog.
- **One** revision pass only; not iterative.
- No new review controls beyond surfacing status + issues — no "re-run review" button, no
  manual compliance override UI.
- No change to what generation itself produces (A→B→C) — D wraps the output.

## Accepted trade-offs

1. **The review runs on every generated update**, including manual runs for tenants who never
   auto-publish — an extra LLM call (sometimes two) per batch they would have reviewed by hand
   anyway. Accepted: it gives every draft a compliance signal and a status badge, and keeps the
   pipeline uniform (one code path for scheduled, threshold, and manual runs).
2. **`error` status blocks auto-publish** (fail-safe). A review-model outage will stall
   auto-publishing and accumulate held drafts until it recovers — chosen over shipping
   unreviewed content. The one-retry softens transient blips.
