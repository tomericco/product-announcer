# Ungrounded Answers — Design

**Date:** 2026-08-23
**Status:** Draft
**Amends:** `2026-08-19-ai-visibility-design.md` ("Metrics", "Signals & briefs")

## Summary

An engine that answers without searching is currently discarded. It should
count toward the metrics that measure **what the engine said**, and be excluded
only from the metrics that measure **what the engine cited**.

## Why now

The first live Gemini calls (2026-08-23, after billing was enabled) showed
Gemini decides per question whether to ground, and it declines on exactly the
prompts the feature exists to answer:

| Intent | Searched? | Share of the generated 30-prompt set |
| --- | --- | --- |
| discovery ("best X for Y") | **no** | 12 |
| alternatives | **no** | 6 |
| how_to | **no** | 6 |
| comparison ("X vs Y") | yes | 8 |
| brand_check | yes | 4 |
| pricing | yes | 4 |

Verified as a property of the model, not our request: an identical body returns
9–10 `groundingChunks` with real `webSearchQueries` on a current-events or
comparison question, and no `groundingMetadata` at all on a discovery question.
`google_search` and `googleSearch` behave identically, so it is not a field-name
problem. The parser is correct.

Today `engines/gemini.ts:227` maps that to `{ kind: "refused" }`, `planRun`
stores the sample as `status: "refused"`, and `isEligible`
(`aggregate.ts:25`) drops anything that is not `ok`. So on **18 of 30 prompts
Gemini contributes nothing**: its `n` never reaches the n ≥ 30 display floor,
the tile reads "Collecting baseline" indefinitely, and we pay $0.069 a call for
answers we throw away.

That is the wrong call, because **a buyer asking Gemini "best content design
tools" also gets an ungrounded answer.** If Gemini names three competitors from
memory and not us, that is the visibility reality — arguably the most important
reading on the page. Grounding is a precondition for *citations*, not for
*mentions*.

## The distinction

Two different questions are being conflated:

- **What did the engine say?** — mention rate, share of voice, recommendation
  rate, and the judge's framing. An ungrounded answer answers this fully.
- **Where did the engine get it?** — citation rate, the cited-domain
  leaderboard, `own_page_cited`, `new_cited_domain`. An ungrounded answer
  cannot answer this at all, and counting it as a zero would be a lie: it is
  not "we were not cited", it is "nothing was cited".

## Decisions

1. **A no-search answer is a successful sample.** `status: "ok"`, plus a new
   boolean `grounded` on `ai_visibility_samples`. It keeps its answer text, its
   deterministic extraction and its judge pass.
2. **`refused` returns to meaning what it says** — the model declined to answer.
   Today it conflates a refusal with an ungrounded answer, which a Phase C
   review already flagged as indistinguishable except by message string. The
   engine clients stop returning `refused` for a missing search; they return a
   normal answer with `searchUsed: false`, which they already compute.
3. **Mention-family metrics count ungrounded samples; citation-family metrics do
   not.** This means an engine has **two denominators**, and they must be stored
   and displayed separately — see "Data model" and "Display".
4. **`n` on a tile means the mention denominator.** It is the larger number and
   the one the headline share of voice is built on. Citation rate carries its
   own, smaller `n`.
5. **Signals split along the same line.** `gap_vs_competitor`, `lost_mention`,
   `gained_mention`, `competitor_gained` and `misdescription` read the mention
   denominator. `own_page_cited`, `new_cited_domain` and `recommended_not_cited`
   read the grounded one. `recommended_not_cited` is the subtle case: it asserts
   "recommended but never cited", which is only meaningful where citations were
   possible — it must use the grounded denominator or it will fire on engines
   that never cite anyone.
6. **No backfill.** Existing `refused` rows stay as they are. They carry no
   answer text worth recovering (the clients discarded it), and a backfill would
   silently move published numbers. The change takes effect from the next run;
   the first window after it will show Gemini's `n` climbing, which is correct
   and should not be read as a spike in visibility.

## Data model

`ai_visibility_samples` gains `grounded boolean not null default false`.
Set from the engine's existing `searchUsed`.

`ai_visibility_aggregates` gains `n_grounded integer not null default 0`
alongside the existing `n`. Aggregates already store counts rather than rates,
so both denominators sum across a window for free.

- `n` — eligible samples, grounded or not. Denominator for mention rate, share
  of voice, recommendation rate.
- `nGrounded` — eligible samples where `grounded` is true. Denominator for
  citation rate.
- `ownCitations` — unchanged, but now only ever incremented on grounded samples.

`isEligible` keeps its existing rules (status `ok`, not flagged, not a branded
or brand-check prompt) and gains nothing — the grounded split happens in the
bucket, not the gate.

## Display

- **Tiles.** Share of voice, mention rate and recommendation rate read `n`.
  Citation rate reads `nGrounded` and renders `—` when `nGrounded` is below the
  per-cut floor, with the tooltip "this engine answered without searching on N
  of these". Silence is better than a zero that reads as "nobody cites you".
- **The n ≥ 30 floor applies per denominator**, not once per engine. An engine
  can legitimately be past the floor on mentions and below it on citations.
- **The prompt × engine matrix** shows an ungrounded cell as a mention result
  with a marker, not as a gap. A cell that says "2 of 3" where none were
  grounded is honest about mentions and must not imply citations.
- **Engine cards** carry a line when the ratio is material: "Gemini answered
  without searching on 18 of 30 prompts". That is a finding about how Gemini
  behaves, not an error state, so it is muted, never `--destructive`.

## Risks

- **Cross-engine comparability drops.** OpenAI grounds far more often than
  Gemini, so their share-of-voice numbers now rest on differently-composed
  denominators. The pooled "all engines" row is the one most affected. Mitigate
  by surfacing the grounded ratio per engine rather than hiding it; do not
  attempt to normalise it away.
- **Ungrounded answers are staler.** They come from training data, so they will
  under-represent recent entrants and over-represent whoever was prominent at
  training time. That is a true fact about what buyers see, but it should be
  said plainly in the UI copy rather than left for someone to infer from a
  surprising number.
- **The judge sees no sources on an ungrounded answer**, so `positioningClaims`
  and `hallucinations` are judged against the model's assertions alone. This is
  the same job it already does; no change, but worth knowing when reading a
  `misdescription` signal that came from an ungrounded sample.

## Out of scope

- Forcing grounding (`tool_choice`-style). It would measure our instruction
  rather than the engine, which is the mistake the system-prompt removal just
  corrected.
- Changing which engines run, or the run shape. Separate open decision.
- Backfilling historical `refused` rows.

## Open question for the reviewer

Whether the pooled "all engines" tile should keep pooling raw counts across
engines with very different grounding rates, or should be dropped in favour of
per-engine rows only. Pooling is currently defended as "summed samples, not an
average of rates"; that defence is weaker when the samples are not like each
other.
