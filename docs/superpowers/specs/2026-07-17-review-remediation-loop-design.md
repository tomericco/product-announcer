# Review Remediation Loop — Design

**Date:** 2026-07-17
**Status:** Approved (pending spec review)
**Sub-project:** D.1 — strengthens sub-project D (post-generation review pass)

## Context

Sub-project D added a post-generation review pass. As shipped, `reviewAndReconcile`
([src/lib/review-draft.ts](../../../src/lib/review-draft.ts)) runs a critique→revise→verify
cycle, but with two limits: the reviewer both critiques **and** rewrites in a *single* call
(the feedback is implicit), and remediation is capped at **exactly one** revision — if that
rewrite still fails, the draft is held as `failed` with no further attempt.

This sub-project turns that into a genuine feedback-remediation **loop**: a critique-only
reviewer, a separate reviser that consumes the issues as explicit feedback, and iteration up
to a configurable cap until the draft is compliant.

The external contract is unchanged — `reviewAndReconcile(draft, brandProfile)` still returns
`{ finalDraft, status, issues }` with the same `ReviewStatus` values — so everything
downstream (the `updates` review columns, `claimBatchAndCreateUpdate` storage, the drafts UI,
the `runBatchForWorkspace` wiring, and the auto-publish gate) is untouched. Only
`review-draft.ts` and its test change.

## Goal

Replace the single inline critique-and-rewrite with an iterative loop that separates critique
from remediation, feeds the specific issues back into a dedicated reviser, and re-reviews
after each fix — up to a configurable number of rounds — before holding the draft.

## Design

### 1. Split the reviewer and the reviser

- `ReviewCritiqueSchema` (Zod): `{ compliant: boolean; issues: string[] }`. Replaces the old
  `ReviewResultSchema` (which also carried `revised`).
- `RevisionSchema` (Zod): `{ title: string; body: string }`.
- `reviewDraft(draft, brandProfile): Promise<ReviewCritique>` — **critique only**; its system
  prompt asks the model to judge compliance and list issues, and no longer to rewrite.
- `buildRevisionPrompt(draft, issues, brandProfile): string` — assembles the brand rules, the
  draft, and the **specific issues** to fix as explicit feedback.
- `reviseDraft(draft, issues, brandProfile): Promise<UpdateDraft>` — a dedicated remediation
  call that rewrites the draft to fix `issues` while keeping the same facts; returns the
  revised `{ title, body }` and preserves the original `category`.

Both `reviewDraft` and `reviseDraft` use `process.env.REVIEW_MODEL ?? "anthropic/claude-sonnet-4-5"`.

### 2. The loop — `reviewAndReconcile`

```
maxRounds = clampMin0(parseInt(process.env.REVIEW_MAX_ROUNDS) or 2)

critique = review(draft)              // retried once on error
if critique.compliant → { finalDraft: draft, status: "passed", issues: [] }

current = draft
for round in 1..maxRounds:
    current  = revise(current, critique.issues)   // retried once on error
    critique = review(current)                     // retried once on error
    if critique.compliant → { finalDraft: current, status: "revised", issues: [] }

→ { finalDraft: current, status: "failed", issues: critique.issues }
```

- **`maxRounds`** comes from `REVIEW_MAX_ROUNDS` (default **2**); a non-positive/invalid value
  clamps to `0`. `0` means no remediation — review once and, if non-compliant, `failed`
  immediately (pure gate).
- **Error handling:** each `review`/`revise` call is wrapped in a retry-once helper; if any
  call still throws, `reviewAndReconcile` returns `{ finalDraft: current, status: "error",
  issues: [] }`, holding the most recent draft (fail-safe). This uniformly generalizes D's
  original "retry the first review once" — every call now gets exactly one retry.
- **`failed` holds the best (last) revision**, not the original draft, so a human editing a
  held draft starts from the most-improved version; `issues` are the final review's remaining
  violations.

### 3. Statuses (unchanged meaning)

- `passed` — compliant on the first review (0 revisions).
- `revised` — compliant after ≥1 revision round.
- `failed` — still non-compliant after `maxRounds` rounds (best revision + last issues held).
- `error` — a review/revise call failed unrecoverably (held, fail-safe).

### 4. Testing (`tests/lib/review-draft.test.ts`, rewritten)

- `buildReviewPrompt` (critique) includes tone / reading level / do / don't / preferred
  phrasing + the draft.
- `buildRevisionPrompt` includes the brand rules, the draft, **and** the specific issues.
- `reviewDraft` parses a `ReviewCritique`; `reviseDraft` parses a `Revision` and preserves
  `category`.
- `reviewAndReconcile` via sequenced `generateObject` mocks:
  - compliant first review → `passed`, 1 call;
  - non-compliant → revise → compliant → `revised` (finalDraft = revision), 3 calls;
  - two rounds → `revised` after the second revision, 5 calls;
  - still non-compliant at the cap → `failed` with the last critique's issues and the last
    revision as `finalDraft` (asserts the loop ran `maxRounds` times);
  - a review call throwing twice → `error`; a revise call throwing twice → `error` (holding
    the latest draft);
  - `REVIEW_MAX_ROUNDS` override (e.g. `1`) changes the number of rounds attempted.

## Scope boundaries (explicitly NOT in D.1)

- No change to `reviewAndReconcile`'s signature or `ReviewOutcome` shape — downstream code
  (columns, storage, UI, wiring, gate, and Task 5's review-draft test stub) is untouched.
- No new `updates` columns (e.g. a revision-count) and no UI change — the badge/issues surface
  is unchanged.
- No change to generation (A→B→C) — this only strengthens the review→fix loop.

## Accepted trade-offs

1. **Cost/latency:** worst case ~5 LLM calls per update at the default cap (1 review +
   2×(revise + review)). Accepted as the cost of a real remediation loop; `REVIEW_MAX_ROUNDS`
   tunes it (down to `0` for pure gating).
2. **Every call now retries once** (vs D's original "first review only"). Simpler and more
   resilient inside a loop; the fail-safe `error` outcome is unchanged.
