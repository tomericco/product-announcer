# AI visibility — UX design (Tactic 1)

**Date:** 2026-08-19
**Status:** Design proposal, not a spec. Companion to `../2026-08-19-ai-mentions-tactics.md` (Tactic 1).

## 1. Placement

**Recommendation: a new top-level nav item, "AI visibility" (`/ai-visibility`), plus one status card on `/company` and one settings card on `/settings`.**

Why not a Company tab (the research doc's first instinct): `/company` is a nine-card configuration stack with no tabs (`src/app/(dashboard)/company/page.tsx`) whose job is *describe yourself once*; the results dashboard is a weekly-read surface with drill-down. Prompts derive from competitors/personas, but so do signals, and signals got a nav item.

Split by the existing product's own rules:

| Concern | Lives at | Pattern it follows |
| --- | --- | --- |
| Results, trend, matrix, drill-down | `/ai-visibility` (nav item) | Signals browser: a page with header, filters, rows |
| Prompt set (the config that *is* the feature) | `/ai-visibility/prompts` | Competitors editor: list + add row + per-row actions |
| Is it on, is it healthy, last run | card on `/company` next to "Industry news" | `NewsToggle` + `SourceStatusBadge` (`company/news-toggle.tsx`, `company/source-status.tsx`) |
| Schedule, engines, samples, cost cap | card on `/settings` under "Publishing schedule" | `ScheduleForm` + `ToastForm` (`settings/schedule-form.tsx`) |
| Run now | header of `/ai-visibility`, and on the `/company` card | Competitors' "Find pages to watch" button — action + toast |

**Cost of a nav item:** `nav-links.tsx` is a static `NAV` array; one entry plus a lucide icon (`ScanSearch`). Active matching already covers nested routes. Six items today; a seventh fits. `MainContainer` caps non-wide routes at `max-w-4xl`; add `/ai-visibility` to `WIDE_ROUTES` for the matrix (one line).

## 2. Information architecture

```
/ai-visibility                    Overview: SOV per engine, trend, benchmark, cited domains, latest-run status
/ai-visibility/prompts            Prompt set: list, tags, enable/pause, add, suggestions inbox, count
/ai-visibility/prompts/[promptId] Prompt detail: engine × run history, latest answers, cited sources
/signals?kind=ai_visibility       Existing browser, new kind
/company  → "AI visibility" card  on/off, run health, link out
/settings → "AI visibility" card  cadence, engines, samples/prompt, monthly cost cap
```

Setup (first run) is not a route: it is the empty state of `/ai-visibility/prompts`, reached from the empty state of `/ai-visibility`.

## 3. Screens

### (a) Setup / first run

*Purpose:* get from zero to an approved prompt set without a blank page.

`/ai-visibility` with no prompts renders an `EmptyState` (title "No prompts yet", description explaining prompts derive from category, personas and competitors) with one primary button **Generate prompt set**. If `companyProfiles.category`/`positioning` are empty, the button is disabled with a `DisabledHint` ("Add a category and positioning on the Company page first") and a link.

Clicking opens the **suggestions review** — a section at the top of `/ai-visibility/prompts`, not a modal (30 rows in a modal is a scroll trap). Header: "30 suggested prompts — review, edit, then approve". Each row: checkbox (checked by default), editable prompt text (`Input`), `Badge`s for intent (category / comparison / alternatives / how-to), persona, competitor. Footer: **Approve 28 of 30** primary, Regenerate outline, "28 / 40 limit".

States: *generating* — inline "Drafting prompts…" on the button; *error* — toast + retry, empty state stays; *approved* — rows join the list, header gains **Run first audit now** with a cost note ("≈ 30 × 3 engines × 3 samples, about $2").

### (b) Prompt set management — `/ai-visibility/prompts`

*Purpose:* curate the prompt set over time.

Header: title, count badge "28 / 40", description ("Paused prompts keep their history but are not run."), primary **Suggest more** (disabled at 40 with a hint), outline **Add prompt**. Below it the suggestions section from (a), shown only when unreviewed suggestions exist (monthly refresh, or after a competitor/positioning edit), collapsed to a strip "6 new suggestions — Review".

Filter bar (`SignalsFilters` shape: `Select`s pushing `searchParams`): intent, persona, competitor, status (active/paused).

List: bordered rows in the `SignalRow` layout — prompt text (truncate, `Tooltip` for full), intent / persona / competitor badges; right: latest appearance chips per engine ("GPT 2/3 · Pplx 0/3"), a `Switch` (active/paused), overflow menu (Edit, Delete). Row click → detail. Edit is inline (`Input` + Save/Cancel, the custom-persona pattern). Add: a bottom row like the competitors add row — `Input`, intent `Select`, optional persona/competitor, **Add**; manual prompts carry an `origin` badge.

States: *empty* → (a); *at limit* → Add/Suggest disabled with visible reason; *paused prompt* → row at `opacity-85` with the dashed outline the stale `SignalRow` uses.

### (c) Results overview — `/ai-visibility`

*Purpose:* answer "are we being named, and is it moving?" in ten seconds.

Header: title, `Badge` "API-observed" (tooltip: engines are queried by API, not the consumer apps — a proxy), last-run line ("Last run Aug 17 · next Mon · 28 prompts × 3 engines × 3 samples"), **Run now** outline button behind a confirmation `Dialog` stating the estimated cost.

Row 1 — **Share of voice per engine**: a `Card` per engine in a `grid`: engine name, big "31%", 30-day delta in muted text (never red/green week-over-week — results move over 60–90 days), a 12-week sparkline, footnote "n = 84 answers". An "All engines" card when more than one.

Row 2 — **Competitor benchmark**: one `Card`, horizontal bar list (CSS widths): us first, then each competitor, sorted by share, per-engine breakdown on hover (`PreviewCard`), "Others" last.

Row 3 — **Where engines get their answers**: `Table` of cited domains — domain, citations (count, % of answers), engines, ours / competitor / third-party `Badge`, and for third-party a "Propose placement" action (v1: link to `/briefs/new` prefilled; Tactic 2 later). This is the "where to get placed" list, the most actionable thing on the page, so it sits above the matrix.

Row 4 — **Prompt × engine matrix**: `Table`, row per active prompt, column per engine, cell = appearance chip ("3/3", "0/3"; brand-subtle fill at 3/3, outline at 0). Cell click → prompt detail with that engine open. Sortable columns. 20 rows, then "Show all 28" in place — no pagination, max is 40.

States: *no prompts* → `EmptyState` + Generate; *no run yet* → cards show "—", rows 2–4 an `EmptyState` ("First audit Mon — or run it now"); *running* → header "Running… 41 / 252 calls", cards keep last values; *partial failure* → destructive line under the header ("Perplexity failed on 9 prompts — rate limited"), missing cells "–" with tooltip; *cost cap hit* → destructive `Badge` "Paused — monthly cap reached" linking to settings; *disabled* → `EmptyState` "AI visibility is off — turn it on in Company".

### (d) Prompt detail — `/ai-visibility/prompts/[promptId]`

Header: back link (`ArrowLeft` + "Prompts", as on the brief page), prompt text as `h1`, badges (intent, persona, competitor, status), active/paused `Switch`, Edit.

Section 1 — **History**: a small `Card` per engine: 12-run sparkline, "named in 7 of last 12 runs", top 3 other brands named as chips.

Section 2 — **Latest answers**: `Tabs` per engine. Each tab stacks the N sampled answers: sample number, timestamp, answer text with mentions highlighted (`<mark>`: brand-subtle for us, neutral outline for competitors), the classifier's "Framing" line ("described as: 'lightweight, for small teams'"), cited domains as chips (ours marked). Clamp to ~12 lines with "Show full answer".

Section 3 — **Cited sources for this prompt** (last 90 days): overview row 3's `Table`, scoped.

States: *no runs* → "Not run yet"; *paused* → banner "Paused — history kept"; *engine failed* → that tab shows the error in destructive.

### (e) In Signals, on the board

*Signals list:* new `kind = ai_visibility`. Row: `Badge` "AI visibility", competitor badge when the gap concerns one, title ("Absent from 'best X for startups' on ChatGPT — A and B named 3/3"), excerpt (the mention sentence), date, score. Three hard-coded kind maps need the entry: `signal-row.tsx` `KIND_LABEL`, `signals-filters.tsx` `KIND_OPTIONS`, `briefs/brief-evidence.tsx` `SIGNAL_KIND_LABEL`.

*Evidence drawer:* `SignalRow` opens `EvidenceDrawer` only for `shipped_work`, and that drawer is an atomic-update curation dialog — do not extend it. Add a read-only `Dialog` for `ai_visibility`: prompt, engine, highlighted answer excerpt, cited domains, "Open prompt" link → (d); loaded on open via a server action like `loadSignalEvidence`.

*Board / brief:* no card change — `BriefCardItem` shows content type + score; brief detail's `BriefEvidence` chips gain "· AI visibility". Content types stay as they are (a comparison page is a `blog_post`); placement tasks need Tactic 2's piece shape.

### (f) Settings — card on `/settings`

"AI visibility runs" `Card`, a `ToastForm` like `ScheduleForm`:

- **Cadence** `Select`: weekly (default) / fortnightly / off, plus day-of-week (UTC wording as in "Run daily at").
- **Engines**: a `Switch` per engine (ChatGPT API, Perplexity, Gemini, Claude) with a one-line cost note.
- **Samples per prompt** `Select` 1 / 3 / 5 ("3 recommended — single samples are noisy").
- **Monthly cost cap** `Input` (USD) with "Spent this month $4.10 of $25"; tripping it pauses runs.
- Estimated monthly cost recomputed from the above, then **Save**.

The `/company` card mirrors `NewsToggle`: `Switch` "Track AI visibility", health row (`SourceStatusBadge`, last ran, last error), links "Edit prompts" / "View results".

## 4. Component reuse map

| UI need | Existing component / pattern | Verdict |
| --- | --- | --- |
| Nav entry | `(dashboard)/nav-links.tsx` `NAV` | extend (1 entry) |
| Wide page | `(dashboard)/main-container.tsx` `WIDE_ROUTES` | extend |
| Page header + count badge + description | `signals/page.tsx` header block | reuse as-is (copy markup) |
| Empty / first-run states | `components/ui/empty-state.tsx` | as-is |
| Disabled control with reason | `(dashboard)/_components/disabled-hint.tsx`, `Tooltip` | as-is |
| On/off + health row | `company/news-toggle.tsx`, `company/source-status.tsx` (`SourceStatusBadge`, `DATE_FORMAT`) | as-is for the card; `sources` needs a new `source_type` (`ai_visibility`) |
| List editor with add row, per-row actions | `company/competitors-editor.tsx` | pattern reuse; new `PromptsEditor` |
| Row chrome, badges, stale/paused look | `signals/signal-row.tsx` | pattern reuse |
| URL-driven filters | `signals/signals-filters.tsx` + `lib/signals/params.ts` | extend (new param parsers) |
| Settings form with toast | `settings/schedule-form.tsx`, `settings/toast-form.tsx` | pattern reuse |
| Tags | `components/ui/badge.tsx` | as-is |
| Tables (matrix, cited domains) | `components/ui/table.tsx` | as-is (currently only used in members/import) |
| Engine tabs on prompt detail | `components/ui/tabs.tsx` | as-is |
| Hover breakdown on benchmark bars | `components/ui/preview-card.tsx` | as-is |
| Run-now confirmation, suggestions dialog | `components/ui/dialog.tsx` | as-is |
| "Running…" indicator | `components/generating-badge.tsx` is bound to content-piece generation | new small `RunningBadge` (same look), or generalise |
| Evidence dialog for `ai_visibility` signals | `signals/evidence-drawer.tsx` is atomic-update specific | **new** `AiVisibilityEvidence` dialog |
| Brief evidence chips | `briefs/brief-evidence.tsx` | extend label map |
| Sparklines / trend | **none — no chart library in `package.json`** (no recharts/d3/visx) | **new** `Sparkline` inline SVG (~40 lines: polyline + last-point dot, `currentColor`); SOV bars as CSS-width `div`s. Don't add recharts for two sparklines and a bar list — client-only, ~100 kB, and the brand guide's crisp 1px look is what SVG gives free. Revisit if a real axis chart is demanded |
| Mention highlighting | none | **new** `HighlightedAnswer` (splits text on brand aliases → `<mark>`) |
| Dates | `DATE_FORMAT` pinned UTC (source-status.tsx / signal-row.tsx) | as-is; sparkline tick labels use it too |

## 5. Interaction details worth deciding

1. **Approving suggestions.** Checked rows commit on "Approve N"; unchecked ones are stored as rejected and fed to the next generation as negatives (the dismiss-reason idea). Nothing is added silently.
2. **Editing a prompt** creates a new prompt and pauses the old one — history stays attached to the wording that produced it. Say so inline. Recommend no "keep history" option.
3. **Pausing** stops runs, keeps history, drops the prompt from current SOV. Delete only when a prompt has no runs.
4. **"API-observed"**: one header `Badge` with tooltip, plus "(API)" in engine names in settings. Not a banner — wallpaper within a week.
5. **Deltas**: 30-day only, muted; the sparkline carries week-by-week. First 4 weeks read "Collecting baseline".
6. **Counts**: hard cap 40; matrix collapses past 20 with "Show all"; no pagination anywhere.
7. **Run now**: confirmation with estimated cost; disabled with a visible reason while running or capped.
8. **Narrow screens**: the app is desktop-first (fixed `w-60` sidebar, wide board). Tables in `overflow-x-auto`, cards wrap in `grid`. Nothing more.
9. **Signal volume**: one signal per *material* gap/change, capped per run (~10), not one per prompt per run — or the browser floods.

## 6. Open questions for the PM

1. Nav item vs Company tab — accept the nav item and its seventh sidebar slot?
2. Is the cost cap per tenant a hard stop (pause runs) or a warning? Proposal: hard stop, with the paused badge.
3. Should cited third-party domains get a "Propose placement" action now (creating a manual brief), or wait for Tactic 2's task-shaped piece?
4. Which engines ship in v1 — all four, or Perplexity + ChatGPT-API + Claude (the cheap one) with Gemini behind a flag?
5. Do we show competitor sentiment/framing anywhere beyond prompt detail (e.g. a "How engines describe us" card on the overview)?
6. Does editing a prompt start fresh history (recommended) or carry it over?
7. Should the monthly suggestion refresh also trigger automatically on competitor/positioning edits, and if so how loudly (strip on the prompts page only, vs a toast on save)?
