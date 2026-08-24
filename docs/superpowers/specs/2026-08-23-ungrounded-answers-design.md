# Ungrounded Answers — Design

**Date:** 2026-08-23
**Status:** Approved (simplified after review)
**Amends:** `2026-08-19-ai-visibility-design.md` ("Metrics", "Signals & briefs")

## Summary

An engine that answers without searching is currently discarded. It should
count toward the metrics that measure **what the engine said**, and be excluded
only from the metrics that measure **what the engine cited**.

Deliberately the smallest honest change: one column, one guard, five small
edits. Accuracy work that this makes possible is listed under "Deferred" and
none of it is harder to add later for being skipped now.

## Why now

The first live Gemini calls (2026-08-23, after billing was enabled) showed
Gemini decides per question whether to ground, and it declines on exactly the
prompts the feature exists to answer. Measured against the real 30-prompt
allocation (`allocateMix(30)`):

| Intent | Prompts | Searched? |
| --- | --- | --- |
| discovery ("best X for Y") | 9 | **no** |
| alternatives | 5 | **no** |
| how_to | 4 | **no** |
| comparison ("X vs Y") | 6 | yes |
| brand_check | 3 | yes |
| pricing | 3 | yes |

**18 of 30.** Verified as a property of the model, not our request: an identical
body returns 9–10 `groundingChunks` with real `webSearchQueries` on a
comparison question and no `groundingMetadata` at all on a discovery one.
`google_search` and `googleSearch` behave identically, so it is not a
field-name problem. The parser is correct.

Today the clients map that to `{ kind: "refused" }`
(`gemini.ts:224-230`, and the same branch in `openai.ts:231-238`,
`anthropic.ts:252-259`), the sample is stored `status: "refused"`, and
`isEligible` (`aggregate.ts:25`) drops anything that is not `ok`.

**The harm is per-prompt, not per-engine.** Gemini's engine-level `n` does
clear the n ≥ 30 floor on its grounded intents alone (9 eligible prompts × 3
samples × a 4-run window = 108), so the tile is fine. What breaks is the cell:
on each of the 18 ungrounded prompts Gemini's `n` is 0, never reaches
`MIN_N_PROMPT = 3`, so `band()` returns null and **no Gemini signal can ever
fire on discovery, alternatives or how_to** — the intents the feature exists
for. We also pay $0.069 a call for answers we then throw away, and
`engineFailureSummary` counts every one as a failure, so each run stamps
"gemini failed on N calls" onto the source row and can flip it to `failing`.

That is the wrong call, because **a buyer asking Gemini "best content design
tools" also gets an ungrounded answer.** If Gemini names three competitors from
memory and not us, that is the visibility reality. Grounding is a precondition
for *citations*, not for *mentions*.

## The distinction

- **What did the engine say?** — mention rate, share of voice, recommendation
  rate. An ungrounded answer answers this fully.
- **Where did the engine get it?** — citation rate and the cited-domain
  leaderboard. An ungrounded answer cannot answer this, and counting it as a
  zero would be a lie: it is not "we were not cited", it is "nothing was cited".

## Decisions

1. **A no-search answer is a successful sample.** Delete the three
   `!searchUsed → refused` branches; return the answer with
   `searchUsed: false`. All three clients already build `text` and `citations`
   before that check, so this is a deletion, not a restructure.
2. **No new per-sample column.** `ai_visibility_samples.search_used` already
   exists (`schema.ts:667`), is already written from the engine result
   (`run.ts:440`), and is read nowhere in `src`. It is exactly the flag needed.
3. **`refused` returns to meaning the model declined.** It currently conflates a
   refusal with an ungrounded answer, which a Phase C review already flagged as
   distinguishable only by message string.
4. **One new aggregate column: `n_grounded`.** Counts eligible samples where
   `search_used` is true. Aggregates already store counts, so it sums across a
   window for free.
5. **`citationRate = ownCitations / nGrounded`; every other rate keeps `n`.**
   Null below `MIN_N_AGGREGATE`, which already renders as `—` rather than `0%`.
6. **The cited-domain leaderboard uses the grounded denominator too.**
   `cited-domains.ts:222` currently sets `denominator = eligible.size`, so
   `answerShare` — a citation-family rate — is built on the mention
   denominator. Uncorrected, every domain's "% of answers" deflates by the
   ungrounded share. This is the surface the first draft missed.
7. **One signal guard, not a five-versus-three split.** `own_page_cited` and
   `new_cited_domain` are event-driven off citation rows, which only exist on
   grounded answers, so they cannot misfire. Only `recommended_not_cited` needs
   a guard, and the first draft had the mechanism backwards: ungrounded samples
   enter both sides of its ratio, so dilution makes it fire *less*. The misfire
   comes from its two zero-citation conditions, which are trivially true on a
   prompt the engine never searched. Require at least one citation row for that
   (prompt, engine) in the window — which is the trigger's own stated meaning.
8. **Enforce `ownCitations ≤ nGrounded` rather than asserting it.** OpenAI and
   Anthropic collect citations independently of the flag that sets
   `searchUsed`, so a citation without a search flag would push citation rate
   over 100%. Set `searchUsed ||= citations.length > 0` in those two; Gemini
   already does this.
9. **Keep the pooled "all engines" tile, pooling raw counts, unchanged.** The
   first draft worried this change would hurt comparability. It is the reverse:
   *today* Gemini contributes only comparison and pricing answers to the pool,
   so the pooled mention numbers are skewed toward two intents. Afterwards every
   engine contributes across the whole prompt set. Pooled citation rate falls
   out of decision 5 for free.
10. **No backfill** — but this is a choice, not a one-way door: samples live 180
    days, so `n_grounded` is recomputable for historical runs by re-running
    `computeAggregates`. Existing `refused` rows keep no answer text (the
    clients discarded it), so those specific rows are unrecoverable regardless.

## Consequences worth stating

- **`refused` changes meaning across the cutover.** Historical rows mean
  "refusal *or* no-search"; new ones mean refusal. Distinguishable only by the
  error string. This surfaces solely in `runEngineHealth.refusedSamples`, which
  nothing renders today.
- **Judge cost rises.** `judgeRun` only sends `status = 'ok'` rows, so Gemini's
  judged samples go from ~27 to ~81 per run — roughly +25–30% judge tokens
  run-wide. Small, but this spec argues from money, and the engine cost
  constants were only just corrected upward.
- **The `EngineMetrics` doc block becomes wrong.** `types.ts:150-157` states
  that `mentionRate === null` iff the window is too thin and that every other
  rate is null with it. A per-denominator floor makes `citationRate` null while
  `mentionRate` is a number. Nothing in `src` relies on the invariant, so the
  code cost is zero — but the comment must be rewritten or it is a trap.
- **Ungrounded answers are staler.** They come from training data, so they
  under-represent recent entrants. True of what buyers see; worth one sentence
  of UI copy whenever the copy is next touched.

## Deferred — all additive, none expensive later

- A matrix marker distinguishing grounded from ungrounded cells. `MatrixCell` is
  `{named, samples, failed}` and makes no citation claim, so an ungrounded cell
  simply starts rendering "2/3" instead of "–" with no code change.
- The engine-card "answered without searching on N of 30" line. Needs a grounded
  count on the card; note that `runEngineHealth.refusedSamples` will *not* be
  reusable for it after this change.
- A citation-rate tooltip explaining the smaller denominator.
- Generalising the per-denominator floor beyond citation rate.
- UI copy about ungrounded answers being staler.

## Out of scope

- Forcing grounding (`tool_choice`-style). It would measure our instruction
  rather than the engine — the mistake the system-prompt removal just corrected.
- Changing which engines run, or the run shape. Separate open decision.

## Build order

1. Delete the three `refused` branches; add `searchUsed ||= citations.length > 0`
   to OpenAI and Anthropic. (Engine tests assert the current behaviour.)
2. Migration: `n_grounded` on `ai_visibility_aggregates`.
3. `aggregate.ts` — select `searchUsed`, one `if` in the bucket loop.
4. `metrics.ts` — `citationRate` over `nGrounded`; rewrite the `EngineMetrics`
   doc block.
5. `cited-domains.ts` — grounded denominator.
6. `signals.ts` — the one `recommended_not_cited` guard.
