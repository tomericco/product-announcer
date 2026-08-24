# AI Visibility — Design

**Date:** 2026-08-19
**Status:** Approved
**Inputs:** `docs/research/2026-08-19-ai-mentions-tactics.md` (Tactic 1),
`docs/research/tactic1-ai-visibility/01-aeo-expert-checks.md`,
`02-ux-research.md`, `03-ux-design.md`. Builds on the content hub pivot
(`2026-08-03-content-hub-pivot-design.md`).

## Summary

A fourth source agent. Versional generates a buyer-intent prompt set from the
company profile, runs it weekly against ChatGPT, Gemini and Claude
through their APIs, measures how often the tenant and its competitors are
named and cited, and turns material gaps and changes into `ai_visibility`
signals with the raw answer as evidence. The brief agent joins those with
competitor and shipped-work signals and proposes content; the human accepts.
Nothing here publishes, and no prompt runs that a human has not approved. A
new nav item, `/ai-visibility`, holds the weekly-read dashboard and the prompt
set.

## Why now

- 44% of B2B SaaS companies are invisible to AI-assisted buyers
  (https://norfolkdailynews.com/online_features/press_releases/derivatex-44-of-b2b-saas-companies-are-invisible-to-ai-assisted-buyers-benchmark-study-finds/article_d7a96dfb-bba6-5b6a-b67b-0c601d68c95e.html);
  half of B2B software buyers now start research with an AI chatbot
  (https://www.prnewswire.com/news-releases/new-g2-research-half-of-b2b-software-buyers-now-start-their-research-with-ai-chatbots-302742807.html).
- Gumlet went 0 → ~20% of inbound revenue from ChatGPT in ~8 months on a
  30-day prompt re-test loop (https://derivatex.agency/case-studies/gumlet/).
  The loop is the product; the content is what Versional already makes.
- Only ~11% of domains are cited by both ChatGPT and Perplexity
  (https://leadsnow.ai/chatgpt-vs-perplexity-citation-overlap-per-engine-aeo/),
  and 66% of brand recommendations cite no page of the brand's own — a
  content tool that cannot see where engines get their answers is guessing.
- Every monitoring vendor stops at analytics ("monitoring, not optimization",
  https://geoptie.com/blog/peec-ai-review). Versional's loop — signal → brief
  with evidence → draft → published → re-measured — is the part nobody ships.

## Primary user & jobs

The content marketer on a 2–5 person team (pivot spec). Weekly:

1. **Know if we are being named** — per engine, trending, without a
   methodology they cannot explain to their CMO.
2. **Find the gaps that are worth content** — prompts where competitors are
   named and we are not, and which pages the engines cite there.
3. **Act inside the calendar they already run** — gaps arrive as briefs with
   evidence, not as a checklist on another tab.
4. **Keep the prompt set honest** — approve monthly suggestions, pause stale
   prompts, stay inside a cost they can see.

## Scope

**v1**

- Prompt generation from company context; review → approve; edit/pause/add;
  monthly suggestion refresh as proposals; hard cap 5 active prompts (was 30
  as specced; cut for cost — see §Engines & run mechanics).
- Three engines via API: OpenAI Responses + web search, Gemini + Google
  Search grounding, Claude + web search. Per-tenant engine toggles; all on by
  default. (Perplexity was specced and built as a fourth, then removed before
  launch — see "Engines & run mechanics".)
- Weekly run, 3 samples per prompt × engine (brand-check prompts 1×),
  "Run now", hard monthly cost cap.
- Deterministic extraction + one batched Claude judge call; four metrics;
  prompt × engine matrix; cited-domain leaderboard; prompt detail with raw
  answers.
- Eight `ai_visibility` signal types into the existing signals table and
  brief agent; evidence dialog; brief evidence chip.
- `/ai-visibility` nav item, `/company` status card, `/settings` card.

**v2 (deferred, named)**

- Average position / reciprocal-rank score, sentiment split, attribute
  heatmap, positioning coverage, citation share, intent/persona cuts,
  answer-type mix; "How engines describe us" card.
- `negative_framing`, `attribute_gap` signals.
- Google AI Overviews / AI Mode through a SERP vendor (DataForSEO or SerpApi).
- Locale tags and per-locale runs; GSC-seeded prompts.
- Wilson bands drawn on sparklines; single-run "noisy" view.
- SOV tiles on the board home.
- Placement/outreach as a task-shaped piece (Tactic 2).

**Out**

- Scraping consumer ChatGPT/Gemini/Claude UIs (OpenAI ToS; irreproducible).
- Daily runs; >30 active prompts; >6 tracked competitors per tenant.
- A composite 0–100 score; prompt-volume estimates; AI-referral traffic
  attribution.
- Auto-activating generated prompts; auto-publishing from signals.

## Concepts & data model (non-technical)

- **Prompt** — one question a buyer might ask. Fields: text, `intent`
  (discovery | comparison | alternatives | how_to | brand_check | pricing),
  `persona?`, `competitor?`, `branded` (bool; brand-check prompts are
  excluded from SOV), `origin` (generated | user), `status`
  (proposed | active | paused), `cluster` (the template it came from),
  `supersedes?` (see editing), created/approved/paused timestamps and who.
  Lifecycle: generated as `proposed` → human approves → `active` → paused or
  edited. **Editing creates a new prompt and pauses the old one**; history
  stays attached to the wording that produced it. Unapproved proposals
  rejected by the human are stored as `rejected` and fed to the next
  generation as negatives (the dismiss-reason pattern). Delete is allowed
  only when a prompt has no runs; otherwise pause.
- **Run** — one scheduled or manual execution over the active set: started,
  finished, engines, samples, call count, cost, per-engine failures, and the
  model/tool version seen per engine. A tenant has one run in flight at a time.
- **Sample** — one answer: `(run, prompt, engine, sampleIndex)`, raw response
  JSON, model id, whether search was used and the queries issued, cited URLs
  in order. Stored 180 days; per-run aggregates kept indefinitely.
- **Extraction** — per sample. Deterministic (D): tenant and tracked-brand
  mentions via an alias table with word boundaries (never inside URLs or the
  echoed prompt), own-domain citation by eTLD+1 after resolving redirectors,
  cited-domain classification via a lookup table (own / competitor / review /
  community / publisher / docs / wiki). Judged (J): one batched Claude call per
  run returns, per sample, the ordered brand list, `mentioned → described →
  recommended` level, one-line framing, positioning claims present/contradicted,
  hallucinated facts, answer type — **every label carries a verbatim evidence
  quote**. D and J must agree on "mentioned" or the row is flagged and
  excluded from rates.
- **Aggregates** — per (run, engine) and per (run, prompt, engine): mention
  rate, SOV, citation rate, recommendation rate, n. Computed once at run end.
- **Engines** — a table in data, not code: id, display label ("GPT-5.x API +
  web search"), cost per call, enabled per tenant.
- **Model-version annotation** — when an engine's model id changes between
  runs, the run is flagged; change-signals for that engine are suppressed for
  that run and the sparkline shows a tick mark with the model name.
- **Signals** — existing `signals` table, new kind `ai_visibility`; payload in
  the existing jsonb shape: type, prompt id/text, engine, window, samples,
  answer excerpt, cited URLs, model, run date.
- **Source** — one `sources` row of new type `ai_visibility` per tenant so
  `SourceStatusBadge` health and last-error work unchanged.

## Metrics

Per engine, over a rolling 4-run window (~12 samples per prompt); `n` =
samples in the cut after excluding errors, no-search refusals, flagged rows
and brand-check prompts. One mention per brand per sample.

| Metric | Formula |
| --- | --- |
| Mention rate | samples naming tenant ÷ n |
| Share of voice | tenant mentions ÷ Σ mentions of all tracked brands (tenant + competitors) × 100 |
| Citation rate | samples citing an own-domain URL ÷ n |
| Recommendation rate | samples where judge level = recommended ÷ n |

Display rules:

- `n` shown next to every number. Aggregates hidden below n ≥ 30 ("Collecting
  baseline"); per-prompt cells hidden below n ≥ 3.
- Headline tiles carry a Wilson 95% interval as "±x pp"; per-prompt cells show
  "2 of 3 samples", never a boolean.
- Deltas are 30-day only, muted, never coloured; the sparkline carries
  week-by-week. Tooltip copy: "Content changes show in 60–90 days."
- SOV footnote: "Adding a competitor lowers every share."
- "All engines" tile = pooled samples, not an average of engine rates.

v2 metrics are listed under Scope.

## Engines & run mechanics

| Engine | Call | Label in UI | Cost basis |
| --- | --- | --- | --- |
| ChatGPT | Responses API, `web_search` tool, `search_context_size: medium` | "GPT-5.x API + web search" | $10/1k searches + tokens (https://developers.openai.com/api/docs/pricing) |
| Gemini | Gemini 3.x, `google_search` grounding; resolve redirect URIs | "Gemini API, grounded" | 5k grounded prompts/month free, then $14/1k (https://ai.google.dev/gemini-api/docs/pricing) |
| Claude | `web_search` tool, Messages API | "Claude API + web search" | $10/1k searches + tokens |

- Neutral fixed system prompt; default temperature (we want the natural
  distribution); no `user_location` in v1 (locale is v2); English.
- **3 samples** per prompt × engine per run; brand-check prompts 1×. As
  specced this was 30 × 3 × 3 ≈ 270 calls per run, weekly → ~1,170
  calls/month ≈ **$12–35/tenant/month** at list prices (parent research). The
  measured per-call costs came in higher than that range assumed (openai
  $0.252, anthropic $0.094, gemini $0.069 — $0.415 per prompt-sample across
  all three), so the prompt cap was cut to 5: **5 × 3 × 3 = 45 calls per run,
  ≈ $6.20**, weekly → ≈ $27/month, less with Gemini's 5k/month free grounded
  tier. **Target: $20/tenant/month.** Samples per prompt is a setting (1 / 3 /
  5) with "3 recommended — single samples are noisy"; if the estimate exceeds
  the cap, the settings card suggests dropping to 1 sample on the most
  expensive engine before dropping prompts.
- **Cadence**: weekly (default, day-of-week configurable, UTC), fortnightly,
  or off. No daily.
- **Cost cap**: per-tenant monthly USD, default $20. Estimated cost is
  checked before each run and each batch; tripping it **hard-pauses** runs
  for the month and shows the paused badge. Warning-only would silently bill.
- **"Run now"**: header button and `/company` card; confirmation dialog with
  the estimated cost; disabled with a visible reason while a run is in flight
  or the cap is hit. Intended after a launch or a positioning/competitor edit.
  First run after approval is triggered from the same button so the tenant has
  numbers within minutes, not next Monday.
- Raw JSON, model id and tool version stored per sample. Errors and no-search
  answers stored, excluded from rates, shown as coverage gaps.
- Judge QA: D/J disagreement flags the row; a monthly 20-row human spot check
  is an operator task, not a UI.

## Prompt generation

- **Inputs**: category (+ synonyms), positioning claims, personas (role + team
  size), competitors, topics. If category or positioning is empty, generation
  is disabled with a hint linking to `/company`.
- **Mix** (the offer for an empty prompt set, summing to 40; `allocateMix`
  scales it to the slots left under the 5-prompt cap, which yields discovery
  2, comparison 1, alternatives 1, how-to 1 and nothing for brand-check or
  pricing): 12 discovery ("best {category} for {persona}"),
  8 comparison ("{us} vs {comp}", "{compA} vs {compB}"), 6 alternatives,
  6 how-to from topics, 4 brand-check ("what is {us}", "{us} pricing"),
  4 pricing/buying. Claude generates from templates; every prompt carries
  intent, persona, competitor, cluster.
- **Bad-prompt checks** at generation and after three runs: tenant name in an
  unbranded prompt; keyword-ese instead of a question; >25 words or two
  questions; refusal/no-search or zero brands on every engine; identical
  brand list to another prompt for three runs. Flagged prompts get a badge
  and a "Pause" suggestion; nothing is paused automatically.
- **Review**: a suggestions section at the top of `/ai-visibility/prompts`,
  rows checked by default, text editable inline, **"Approve N of M"** commits
  the batch; unchecked rows are stored as rejected negatives. Batch with
  exclusions, not one-by-one — 30 individual accepts is the Peec complaint.
- **Monthly expansion**: on the first run of each month, generate up to 10
  `proposed` prompts by varying persona/modifier on clusters where competitors
  are named and we are not, plus engine-issued search queries and titles of
  top cited listicles. Shown as a collapsed strip "6 new suggestions — Review".
  Never auto-activated.
- **Profile edits**: adding/removing a competitor, persona or positioning
  claim shows a strip on the prompts page and a line on the overview:
  "Profile changed since prompts were generated — Suggest more". Generation
  happens on click (it costs a call). Prompts tagged to a removed competitor
  are paused automatically with a note; they would otherwise ask engines
  about a comparison the tenant no longer cares about.
- **Edit = new history**: editing wording creates a new prompt with
  `supersedes` set and pauses the old one; the detail page links both ways.
  No carry-over option.

## Signals & briefs

Kind `ai_visibility`, written at run end, **capped at ~10 per run** ranked by
materiality, so the browser never floods. All triggers use the rolling window
and, where stated, require two consecutive runs so that single-run noise
(~73% repeat consistency, https://scitechdaily.com/chatgpt-was-asked-the-same-question-10-times-the-answers-kept-changing/)
does not produce briefs.

| Type (v1) | Trigger | Content action the brief agent may propose |
| --- | --- | --- |
| `gap_vs_competitor` | Non-brand prompt: a competitor ≥2/3, tenant 0/3, two consecutive runs | Comparison or "best X for persona" page; placement on cited domains |
| `lost_mention` | Tenant ≥2/3 → 0/3, two runs | Refresh the previously cited page; re-pitch listicle |
| `gained_mention` | 0/3 → ≥2/3, two runs | Identify the moved URL; replicate across the cluster |
| `competitor_gained` | Competitor <1/3 → ≥2/3 on ≥3 prompts | Join with competitor_move signals; counter-positioning piece |
| `new_cited_domain` | Domain enters top-10 or is cited on ≥3 prompts where tenant is absent | Placement/outreach (brief now; task-shaped piece in Tactic 2) |
| `own_page_cited` | First own-URL citation on a prompt | Reinforce: internal links, refresh, add stats/FAQ |
| `recommended_not_cited` | Recommended ≥2/3, own domain never cited | Publish the page the engine wants (comparison/pricing/FAQ) |
| `misdescription` | Positioning claim contradicted or fact hallucinated in ≥2 samples | Grounding page / FAQ quoting the wrong claim |

Deferred to v2: `negative_framing`, `attribute_gap` (need the sentiment and
attribute displays to be trustworthy first). `prompt_candidate` is not a
signal — it is the monthly suggestion mechanism above.

Also: engine SOV moving ≥10 pp window-over-window emits one `competitor_gained`
or `lost_mention` summary signal rather than per-prompt ones. Model-version
change suppresses change-signals for that engine for that run.

**Evidence payload**: prompt text, engine label, model id, run date, sample
count ("0 of 3, two runs"), the answer excerpt containing the mention sentence
(≤400 chars, judge quote), ordered cited URLs with class, competitor id when
one is concerned.

**Brief agent**: reads these like any other kind. The rules that already earn
their place — favour clusters, swap test, why-now must be dated — apply. The
valuable joins are "B cited 3/3 for prompt P" + "B shipped Y" (competitor
signal) + "we shipped Y in March" (shipped work) → comparison brief; and
`misdescription` + an existing page → refresh brief. Positioning fit already
ranks briefs, so gaps on owned messages rank high. Content types stay as they
are — a comparison page is a `blog_post`.

**On the board**: no card change. The brief editor's `BriefEvidence` chips gain
"AI visibility"; the evidence popover shows the excerpt and cited domains.
A content piece whose brief cites an `ai_visibility` signal lists "Targets
prompts: …" linking to prompt detail; the prompt's sparkline gets a
publish-date marker labelled "published" with no causal copy.

**Deferred to Tactic 2**: anything whose accept action is "email this editor"
or "get on this G2 list". In v1 a `new_cited_domain` signal yields a normal
brief, and the cited-domain table's **"Propose brief"** action opens
`/briefs/new` prefilled with that signal selected (spec 6 path). The
pitched → live → verified lifecycle waits for the task-shaped piece.

## UX

### Placement — decided: top-level nav item

`/ai-visibility` is a seventh `NAV` entry (icon `ScanSearch`), plus one card on
`/company` and one on `/settings`. Not a company tab, because:

1. `/company` is a nine-card configuration stack with no tab system; "describe
   yourself once" and "read every Monday" are different jobs, and a weekly
   dashboard three scrolls down a config page is the Profound "seven reports"
   problem in miniature.
2. Precedent: signals also derive from competitors and topics, and signals got
   a nav item.
3. Cost is one array entry and one `WIDE_ROUTES` line; active matching already
   covers nested routes.

What the researcher wanted — proximity to the profile it derives from — is
kept by the `/company` card ("prompts generated from 5 competitors, 3
personas — 2 changed since") and by competitor/persona chips on every prompt.

### IA

```
/ai-visibility                      overview
/ai-visibility/prompts              prompt set + suggestions section
/ai-visibility/prompts/[promptId]   prompt detail
/signals?kind=ai_visibility         existing browser, new kind
/company   → "AI visibility" card   on/off, health, last run, links
/settings  → "AI visibility" card   cadence, engines, samples, cost cap
```

Setup is not a route; it is the empty state of the overview leading to the
suggestions section on the prompts page.

### Screens

**Setup / first run.** Overview with no prompts: `EmptyState` "No prompts yet"
+ **Generate prompt set** (disabled with `DisabledHint` if category/positioning
missing). Click → inline "Drafting prompts…" → suggestions section on
`/ai-visibility/prompts` (header "30 suggested prompts — review, edit, then
approve"; footer "Approve 28 of 30", Regenerate, "28 / 30 limit"). After
approval the header gains **Run first audit now** with "≈ 28 × 4 engines × 3
samples, about $3".

**Prompt management.** Header: count badge "28 / 40", "Paused prompts keep
their history but are not run.", **Suggest more** (disabled at 40 with
reason), **Add prompt**. Collapsed suggestions strip when unreviewed proposals
exist. Filters (URL-driven, `SignalsFilters` shape): intent, persona,
competitor, status. Rows: text, badges, per-engine chips ("GPT 2/3 · Pplx
0/3 · Gem 3/3 · Claude 1/3"), active/paused `Switch`, overflow (Edit, Delete
when no runs). Inline edit with the "creates a new prompt; history stays on
the old one" note. Add row like the competitors editor; manual prompts carry a
"user" badge. Paused rows at `opacity-85` with the stale dashed outline.

**Overview.** Header: title, "API-observed" `Badge` with tooltip, last-run
line, **Run now**. Row 1 — four engine `Card`s + "All engines": SOV big
number, "±x pp", muted 30-day delta, 12-week `Sparkline`, "n = 84 answers";
the other three metrics as a small line under SOV. Row 2 — competitor
benchmark bar list (CSS widths), us first, per-engine breakdown in a
`PreviewCard`. Row 3 — cited-domain `Table`: domain, citations (count, % of
answers), engines, own/competitor/third-party badge, **Propose brief** for
third-party. Row 4 — prompt × engine matrix: one row per active prompt, cell
"3/3"/"0/3" chip (brand-subtle fill at 3/3, outline at 0), click → prompt
detail with that engine tab open; 20 rows then "Show all 28" in place.

**Prompt detail.** Back link, prompt as `h1`, badges, `Switch`, Edit, link to
superseded/superseding prompt. Section 1 — per-engine `Card`: 12-run
sparkline, "named in 7 of last 12 runs", top 3 other brands. Section 2 —
`Tabs` per engine, each stacking the samples: index, timestamp, model id,
`HighlightedAnswer` (us brand-subtle `<mark>`, competitors outline), framing
line, cited domains as chips, clamp ~12 lines. Section 3 — cited sources for
this prompt, 90 days. Section 4 — "Related pieces" (via brief_signals) and
publish markers on the sparklines.

**Signals list + evidence.** New kind in `KIND_LABEL`, `KIND_OPTIONS`,
`SIGNAL_KIND_LABEL`. Row title e.g. "Absent from 'best X for startups' on
ChatGPT — A and B named 3/3". New read-only `AiVisibilityEvidence` `Dialog`
(the existing `EvidenceDrawer` is an atomic-update curation tool; do not
extend it): prompt, engine, model, date, highlighted excerpt, cited URLs,
"Open prompt" link. Loaded on open via a server action.

**Settings card.** `ToastForm`: cadence `Select` (weekly / fortnightly / off +
day), engine `Switch`es with "(API)" in names and a cost note each, samples
`Select`, monthly cap `Input` with "Spent this month $4.10 of $20", computed
"≈ $X/month at current settings", Save. **Company card** mirrors `NewsToggle`:
"Track AI visibility" `Switch`, `SourceStatusBadge` health, last ran, last
error, "Edit prompts" / "View results".

### States

| State | Overview | Prompts |
| --- | --- | --- |
| Off | `EmptyState` "AI visibility is off — turn it on in Company" | same |
| No prompts | Generate CTA | Generate CTA |
| Generating | — | inline "Drafting prompts…", retry on error |
| No run yet | tiles "—", rows 2–4 `EmptyState` "First audit Mon — or run it now" | chips empty |
| Running | header "Running… 41 / 270 calls", tiles keep last values | — |
| Collecting baseline (n<30) | tiles "Collecting baseline", sparkline grows | — |
| Partial failure | destructive line "Gemini failed on 9 prompts — rate limited"; cells "–" | — |
| Paused by cap | destructive `Badge` "Paused — monthly cap reached" → settings; Run now disabled with reason | — |
| Model changed | tick on sparkline with model name; note under tile | — |

### Component reuse (designer's map, adopted)

- **As-is**: `EmptyState`, `DisabledHint`, `Tooltip`, `NewsToggle` +
  `SourceStatusBadge` + `DATE_FORMAT` (UTC), `Badge`, `Table`, `Tabs`,
  `PreviewCard`, `Dialog`, `ToastForm`.
- **Extend**: `nav-links.tsx` `NAV` (one entry), `main-container.tsx`
  `WIDE_ROUTES`, `signals-filters.tsx` + `lib/signals/params.ts` (new parsers),
  `brief-evidence.tsx` label map, the three kind maps, `sources`
  `source_type` enum (`ai_visibility`), `signal_kind` enum.
- **Pattern reuse, new component**: `PromptsEditor` (competitors editor
  shape), prompt rows (`SignalRow` chrome), settings card (`ScheduleForm`
  shape), `RunningBadge` (look of `generating-badge.tsx`).
- **New**: charts via **Recharts through the shadcn `chart` component**
  (`npx shadcn add chart`; the repo already uses shadcn, see
  `components.json`). `Sparkline` = a `LineChart` with axes hidden and
  `ReferenceLine`/`ReferenceDot` for model-change and publish markers; SOV
  bars = horizontal `BarChart`. Chosen over hand-rolled SVG to simplify
  implementation (tooltips, markers, responsive sizing come free); theme via
  `ChartConfig` CSS variables so the brand guide's muted 1px look holds.
  Client-only components, loaded lazily on `/ai-visibility` routes.
  `HighlightedAnswer` (alias split → `<mark>`). `AiVisibilityEvidence` dialog.

### Trust cues

One "API-observed" header badge with tooltip (not a banner — wallpaper within
a week) and "(API)" in engine names; "2 of 3 samples" everywhere; `n` on every
number; "Content changes show in 60–90 days" on deltas; plain "≈ $X/month at
current settings" next to the cap and in the Run-now dialog — no credits.

## User stories

**Setup**

1. *(v1)* As a content marketer I want a prompt set generated from my company
   profile so that I never start from a blank list.
   - Given a profile with category and positioning, when I click Generate, then
     ~30 proposed prompts appear with intent/persona/competitor badges.
   - Given a profile missing category or positioning, then Generate is disabled
     with a hint linking to `/company`.
   - Given generation fails, then I see a toast and can retry; the empty state
     stays.
2. *(v1)* As a content marketer I want to approve suggestions as a batch with
   exclusions so that review takes a minute.
   - Given the suggestions section, when I uncheck 2 and click "Approve 28 of
     30", then 28 become active and 2 are stored as rejected.
   - Given approval, then the header shows "Run first audit now" with a cost
     estimate.
3. *(v1)* As a content marketer I want numbers shortly after approving so that
   the feature does not look broken for a week.
   - Given an approved set, when I click Run first audit now and confirm, then
     a run starts and the overview shows progress; tiles fill when it ends.

**Prompt management**

4. *(v1)* As a content marketer I want to add, pause and edit prompts so the
   set reflects what my buyers ask.
   - Given an active prompt, when I pause it, then it is excluded from runs and
     current SOV and its history remains visible in detail.
   - Given I edit wording, then a new prompt is created, the old one is paused,
     and both link to each other.
   - Given a prompt with runs, then Delete is unavailable and the hint says why.
5. *(v1)* As a content marketer I want a visible cap so I know the boundary.
   - Given 30 active prompts, then Add and Suggest more are disabled with "30
     / 30 limit".
6. *(v1)* As a content marketer I want monthly suggestions as proposals so the
   set grows without silent changes.
   - Given the first run of a month, then up to 10 `proposed` prompts appear
     in a collapsed strip; none run until approved.
7. *(v1)* As a content marketer I want to be told when my profile outgrew the
   prompts.
   - Given a competitor was added since generation, then a strip offers Suggest
     more; given a competitor was removed, then its comparison prompts are
     paused with a note.
8. *(v1)* As a content marketer I want bad prompts flagged so I am not
   measuring noise.
   - Given a prompt with zero brands on every engine for three runs, then it
     carries a "No brands named" badge and a Pause suggestion.
9. *(v2)* As a content marketer I want locale tags so I can track a second
   market.

**Runs & cost**

10. *(v1)* As a content marketer I want a weekly run I do not have to remember.
    - Given cadence weekly/Monday, then a run starts each Monday (UTC) and the
      `/company` card shows last/next run.
11. *(v1)* As a content marketer I want "Run now" after a launch, with the cost
    shown first.
    - Given I click Run now, then a dialog states the estimated cost; given a
      run is in flight or the cap is hit, then the button is disabled with the
      reason.
12. *(v1)* As an owner I want a hard monthly cap so spend is bounded.
    - Given spend + next-run estimate exceeds the cap, then the run does not
      start and the overview shows "Paused — monthly cap reached".
    - Given a new month, then runs resume without action.
13. *(v1)* As an owner I want a plain cost estimate, not credits.
    - Given settings, then "≈ $X/month at current settings" recomputes as I
      toggle engines or samples.
14. *(v1)* As a content marketer I want partial failures visible, not silent.
    - Given Gemini rate-limits 9 prompts, then the header says so and the
      matrix shows "–" with a tooltip for those cells; rates exclude them.

**Results**

15. *(v1)* As a content marketer I want SOV per engine with trend in ten
    seconds.
    - Given ≥30 samples on an engine, then its tile shows SOV, ±pp, n, and a
      12-week sparkline; below 30 it reads "Collecting baseline".
16. *(v1)* As a content marketer I want to see where engines get their
    answers.
    - Given a run, then the cited-domain table lists domains with count, % of
      answers, engines and class; third-party rows offer Propose brief.
17. *(v1)* As a content marketer I want the prompt × engine matrix to find
    gaps.
    - Given 28 active prompts, then 20 rows show with "Show all 28"; a cell
      click opens prompt detail on that engine.
18. *(v1)* As a content marketer I want to read the raw answer.
    - Given prompt detail, then each sample shows highlighted mentions, model
      id, timestamp, framing line and cited domains.
19. *(v1)* As a content marketer I want to know when the model changed so I do
    not misread a jump.
    - Given an engine's model id changed, then the sparkline shows a tick with
      the name and no change-signal is emitted for that engine that run.
20. *(v2)* As a content marketer I want a "How engines describe us" card.

**Signals & briefs**

21. *(v1)* As a content marketer I want gaps to arrive as briefs with evidence.
    - Given a competitor ≥2/3 and us 0/3 on a prompt for two runs, then one
      `gap_vs_competitor` signal exists with excerpt and cited URLs; given the
      brief agent proposes from it, then the brief shows an "AI visibility"
      evidence chip and the popover shows the excerpt.
22. *(v1)* As a content marketer I want the signals browser to filter this
    kind.
    - Given `?kind=ai_visibility`, then only these rows show; clicking opens the
      evidence dialog with "Open prompt".
23. *(v1)* As a content marketer I want to see which prompts a piece targets
    without being told it caused anything.
    - Given a published piece whose brief cites an `ai_visibility` signal, then
      prompt detail lists it and the sparkline shows a "published" marker; no
      causal copy.
24. *(v1)* As a content marketer I want no more than a handful of signals per
    run.
    - Given a run, then at most ~10 `ai_visibility` signals are written, ranked
      by materiality.
25. *(v2)* As a content marketer I want placement gaps to become outreach
    tasks with pitched → live → verified status.

**Settings**

26. *(v1)* As an owner I want to choose engines, samples and cadence.
    - Given I turn Gemini off, then the next run skips it and the estimate
      drops; given samples = 1, then the hint warns it is noisy.
27. *(v1)* As an owner I want to turn the feature off from Company.
    - Given the switch is off, then no runs start and `/ai-visibility` shows
      the off state; history is kept.

**Observability**

28. *(v1)* As an operator I want run health in the usual place.
    - Given a failed run, then the `sources` row of type `ai_visibility` shows
      `failing` with `lastError`; given a run, then cost and call counts are
      recorded per engine in `llm_usage`-style rows.
29. *(v1)* As an operator I want D/J disagreements counted.
    - Given a run, then the count of flagged rows is recorded and excluded from
      rates; a monthly 20-row spot-check list can be exported from the DB.

## Decisions log

| Decision | Choice | Rationale | Source |
| --- | --- | --- | --- |
| Build vs buy | DIY via four APIs | No vendor offers an embeddable per-tenant API; $20–60/tenant/month | parent research, open decision 1 |
| Placement | Nav item `/ai-visibility` + company card + settings card | Config stack ≠ weekly dashboard; signals precedent; one-line cost | 03 §1, 02 §6 |
| Engines in v1 | All four, per-tenant toggles, on by default | Gemini's 5k/month free tier makes it the cheapest; per-engine divergence is the point | 01 §4, 03 Q4 |
| AI Overviews | v2 via SERP vendor, never scrape | No API; ToS | 01 §4, parent open decision 4 |
| "API-observed" | Good enough for v1; one badge + engine labels | Honest proxy; UI scraping out | 02 §4, 03 §5.4 |
| Samples | 3 per prompt × engine; brand-check 1× | Floor at which 0/3 ↔ 3/3 means anything | 01 §4 |
| Cadence | Weekly, configurable day; fortnightly/off; no daily | Actionable for a 2–5 person team; effects take 60–90 days | parent research |
| Prompt cap | 5 active (specced 30); proposals/paused do not count | Cost target $20/tenant/month, against measured per-call costs | 01 §7, 02 §2 |
| Cost cap | Hard pause, default $20 (target spend) | Warning-only bills silently | 03 Q2 |
| Cost display | Plain "≈ $X/month" | Credits are hated for unpredictability | 02 §4, Q7 |
| Edit a prompt | New prompt, old paused, linked | History must stay on the wording that produced it | 03 Q6, §5.2 |
| Paused history | Kept, shown in detail, excluded from current SOV; resurrect by toggling | Nobody does soft-archive well; cheap to do right | 02 Q6 |
| Suggestion approval | Batch, checked by default, exclusions stored as negatives | One-by-one is the Peec complaint | 02 Q3, 03 §5.1 |
| Profile-edit regeneration | Strip + overview line, generation on click; removed-competitor prompts auto-paused | Avoid silent spend; avoid dead comparisons | 03 Q7 |
| Competitor SOV lines | Benchmark card by default; not overlaid on tiles | Motivating without 5-line spaghetti | 02 Q4 |
| Sentiment/framing | Per-answer framing line in v1; overview card and signals v2 | Noisy at small n | 03 Q5, 01 §2 |
| Composite score | None | Untrusted everywhere it exists | 01 §7, 02 §3 |
| Window & noise | Rolling 4 runs; n thresholds 30/3; Wilson ±pp on tiles; bands v2 | Vendor deltas sit inside noise | 01 §5 |
| Change-signals | Two-run hold on band moves; ≥10 pp engine SOV; cap ~10/run | No briefs from single-run noise; no flood | 01 §5–6, 03 §5.9 |
| Model change | Annotate + suppress change-signals that run | Jumps would otherwise become briefs | 01 §5 |
| Propose placement | v1 "Propose brief" → `/briefs/new` prefilled; task piece in Tactic 2 | Uses spec 6 path now; no new piece shape | 03 Q3 |
| Piece ↔ prompt | List + publish marker, no causal copy | Attribution is unknowable at this n | 02 Q5 |
| Board home tiles | Not in v1 | Board is the home; revisit with usage data | 02 Q1 |
| Chart approach | Recharts via shadcn `chart` component | Simpler implementation: tooltips, markers, responsiveness for free; shadcn already in repo | 03 §4 |
| First run | Immediately after approval via Run first audit now, not in onboarding | Numbers within minutes; onboarding stays short | 02 §4, 03 §3a |
| Locale | Not in v1 | No HQ field; engines differ on geo params | 01 §4 |
| Judge | One batched Claude call, labels with quotes, D cross-check | Already the provider; LLM-only "mentioned" is an anti-pattern | 01 §1, §7 |
| Retention | Samples 180 days, aggregates forever | 12-week sparklines + 90-day sources | — |

## Risks & mitigations

- **Non-determinism** (~73% repeat consistency) — 3 samples, rolling 4-run
  window, two-run hold on signals, n thresholds, ±pp on headlines.
- **Cost creep** — hard cap, 5-prompt cap, per-tenant engine/sample toggles,
  estimate before every run, Gemini free tier, Claude via Batches.
- **API ≠ consumer UI** — "API-observed" labelling, engine names carry "API",
  tooltip explains the proxy.
- **Attribution lag** — 30-day muted deltas, "60–90 days" copy, "Collecting
  baseline" for four weeks; publish markers without causal claims.
- **Brand-name matching** — alias table, word boundaries, judge confirmation
  for generic-word brands, eTLD+1 after redirect resolution, never inside
  URLs or the echoed prompt; D/J disagreement excluded.
- **Model changes** — model id per sample, annotation, signal suppression.
- **ToS** — APIs only; no consumer scraping; Gemini grounding display rules
  respected where suggestion HTML is shown (it is not, in v1).
- **Judge bias** (Claude judging Claude) — deterministic mention check is the
  arbiter for the metric that matters most; judge only adds levels and quotes.
- **Signal flood** — cap per run; summary signals for engine-level moves.

## Success metrics (feature)

- **Activation**: ≥60% of tenants who open `/ai-visibility` approve a prompt
  set in the same session; ≥80% of those run the first audit within 24h.
- **Weekly return**: ≥50% of tenants with an active set view the overview in
  the 7 days after a run, measured from week 3.
- **Loop closure**: ≥1 brief with `ai_visibility` evidence accepted per active
  tenant per month by month 2; dismiss rate of such briefs not worse than other
  kinds.
- **Cost**: median ≤$20/tenant/month; zero tenants exceeding their cap without
  the pause firing.
- **Trust**: no support questions of the form "why did my number jump"
  attributable to a model change without an annotation (qualitative).

## Deferred / open

| Item | Who decides | By when |
| --- | --- | --- |
| AI Overviews via DataForSEO vs SerpApi, and whether it is worth the per-request cost | Tomer | v2 planning, after four weeks of v1 data |
| Default cost cap ($20 set; confirm) and whether cost is passed through to billing or absorbed per tier | Tomer | before v1 ships |
| Tactic 2 task-shaped piece (unblocks true placement briefs) | Tomer, with the Tactic 2 spec | separate spec |
| SOV tiles on the board home | Tomer | after weekly-return data exists |
| Locale/multi-market runs (needs an HQ/market field on the profile) | Tomer | v2 |
| Whether the seventh nav item stays or the sidebar gets grouped as items grow | design | when an eighth item is proposed |
