# QA review — AI Visibility implementation plan

**Date:** 2026-08-20 (verification pass 2026-08-21)
**Plan reviewed:** `docs/superpowers/plans/2026-08-20-ai-visibility.md` (now 20,555 lines, 46 tasks, phases A–I)
**Spec:** `docs/superpowers/specs/2026-08-19-ai-visibility-design.md`
**Contract:** scratchpad `contract.md`
**Verdict: approve** — all 24 findings from the 2026-08-20 review are fixed and
re-verified against the edited plan (see "Verification pass" below). One new
minor (V-1, a stale comment) was found; nothing above minor remains.

Original 2026-08-20 verdict, for the record: *needs revision* — 5 blockers,
8 majors, 11 minors. The cross-part
symbol table is in unusually good shape (one real signature break, QA-6); the
blockers are two spec-level functional holes (QA-1, QA-2) and three tests that
fail deterministically as written (QA-3, QA-4, QA-5).

---

## Verification pass — 2026-08-21

Three fix agents edited the plan concurrently (phases A–C, D–G, H–I). Every
finding was re-derived from the edited plan, not taken on faith. All plan line
references below are into the current 20,555-line plan.

**Result: 24 / 24 fixed, 0 partially fixed, 0 not fixed. 1 new minor issue.**

### Per-finding status

| ID | Status | Evidence (plan lines) |
| --- | --- | --- |
| QA-1 | fixed | D4 resolves redirects before all domain work: design note 6912–6925, `resolveCitations` + per-slice cache 7361–7391, called before `extractDeterministic` 7444–7450, `ExtractSampleDeps.fetchImpl` 7393–7406, `RunDeps` widened with `fetchImpl`/`extract` and wired into `runSlice` 7494–7532. Both required tests present: redirect→competitor 7151–7172, redirect→own domain with `ownDomainCited: true` + one-hop cache assertion 7174–7196. Schema comment agrees ("eTLD+1, after redirect resolution", A1 citations table) |
| QA-2 | fixed | H3 chose option 1 and says so: `after()` drive loop documented 14505–14518, implemented 15222–15247 (slice loop → cap stop → resumable `finalizeRun`, never-throw, ~240s budget via `RUN_NOW_*` constants 14921–14924). Tests use a captured-`after` mock (14587–14593) and pin: drives-to-complete without cron 14796–14811, multi-slice loop 14813–14823, cap-pause stops before finalize 14825–14834, refusal schedules nothing 14836–14840, callback never throws 14842–14847. H4 copy now honest: "Most runs finish in a few minutes; anything left over completes with the next daily sweep" 15694–15695; no stale "Answers land" copy anywhere |
| QA-3 | fixed | D3 cap test plans under the permissive default cap, then tightens to $0.015 via a direct settings update before slicing (6607–6618, with the arithmetic explained in the comment); `runSlice` re-reads settings at slice start, so the mid-slice `reached` path is genuinely exercised (asserts `pausedByCap`, `remaining > 0`, `paused_by_cap`, source `failing` 6627–6636) |
| QA-4 | fixed | `engineMetrics(tenantId, database?, now?: () => Date)` — injectable clock in the interface block 9453, threaded into `deltaBefore` 9953–9962. Every test passes the frozen `CLOCK = () => new Date("2026-03-30T00:00:00Z")` 9653, both delta tests re-derived and correct at that instant 9720–9741. (H6 calls `engineMetrics(tenantId)` and takes the real-clock default — correct for production, so the review's "H6 passes its page-level now" is satisfied in spirit) |
| QA-5 | fixed | Option (a): tests click Review first. Component keeps the ≤10 collapse heuristic 17460; tests now assert the collapsed strip for a small batch, expand via the Review button, then find the checkboxes (17315–17335), the send-unchecked test also expands first (17349–17371), and a new test pins that a 12-proposal batch mounts expanded with no Review button (17337–17347) |
| QA-6 | fixed | H11 loads `tenants.name` (18782, with a comment naming the category-as-brand bug 18778–18781), then `buildAliases(tenantName)` single-arg per brand, flattened to `AnswerAlias[]` with `kind`/`label` 18811–18830. Import comment pins the one-argument contract signature 18507–18509 |
| QA-7 | fixed | I2 does the identical thing: `tenants.name` read 19362–19364, `buildAliases(name)` per brand 19376–19390; `profile.category` no longer appears in any alias construction |
| QA-8 | fixed | New `personaFilterOptions(refs, catalog)` in H7's `filter-params.ts` resolves through `resolvePersonaRefs` exactly as B5 does — options AND whitelist from display names (16961–16978); H9 loads the `systemPersonas` catalog and calls it (18015–18028); dedicated test seeds a system ref and asserts the key never matches and the `?persona=Head of Design` deep link survives (16911–16931) |
| QA-9 | fixed | Documented deviation from contract decision 6: middle slot is the signal's *subject* — promptId, domain, or competitorId for both `competitor_gained` forms; `"all"` only for the subject-less engine-wide `lost_mention` summary (note 11181–11190, `externalId` helper doc 11897–11914). Tests pin distinct keys for two competitors on one engine 11407–11433 and the riser form's competitorId key 11664. One stale restatement survives — see V-1 |
| QA-10 | fixed | Whole review runs in `database.transaction` (2196–2248); the unique-index collision rolls everything back and maps to `duplicate` (2249–2255). New test: two edits where the second collides → first proposal's text and status unchanged, `countActivePrompts` unchanged (2031–2055) |
| QA-11 | fixed | Trigger is now `nowBand === "strong" && prevBand === "strong" && beforeBand === "absent"` (12095–12100); not-firing test for 3/3 after 1/3 after 0/3 (11357–11362) and the two-run-hold positive (11352–11355) |
| QA-12 | fixed | New pure `publishMarkerRunIds(runs, publishedAts)` — first run at-or-after each publish, newest-run fallback — in H1 with five unit tests incl. the between-runs Wednesday case that the same-day scheme would have missed (14047–14081, impl 14194–14206); H11 consumes it per engine over that engine's own history (18801–18806, 18886–18897) |
| QA-13 | fixed | F2 seeds a THREE-run history (strong → absent → absent, `seedLostMention` 12475–12506) and asserts both directions: fires without a model change 12534–12541, suppressed with `modelIds` flipped to gpt-5.2 12544–12553 — the vacuous 2-run window is gone and the run.modelIds → `modelChanged` seam is genuinely exercised |
| QA-14 | fixed | Cap compares only the still-`proposed` slice of the batch (2171–2191); test: replayed approve form at the cap returns `{ok:true, approved:0, rejected:0}`, not a cap error (2057–2070) |
| QA-15 | fixed | `ReferenceDot x={markerPoint.label}` — the category value, with a comment explaining why an index silently fails (14249–14258) |
| QA-16 | fixed | Markers use `fill="var(--chart-4)"` (14263), competitor bars `var(--brand)` / `var(--chart-3)` (14341), both with comments that `--color-*` exists only for ChartConfig series keys |
| QA-17 | fixed | H6 JSX renders `citedDomainRows` (16555–16561, built 16670–16677); `listSignals` is in the import list (16174, 16317) |
| QA-18 | fixed | `isoWeekKey` is a hand-rolled `Date.UTC` ISO-week (11801–11807), F1's Consumes note explicitly rejects date-fns for the timezone reason (11140), and boundary tests pin W09/W10 across a UTC midnight (11280–11296) |
| QA-19 | fixed | One name everywhere: `saveAiVisibilityConfig` in I4's Files bullet (19875), signature (19898), mock (19933), impl (20043) and form (20077, 20169); `saveAiVisibilitySettingsAction` no longer appears in the plan |
| QA-20 | fixed | `src/lib/briefs/query.ts` is in I5's Files: Modify list with the exact change spelled: `CitedSignal` gains `payload: AiVisibilityPayload | null` and `listBriefSignals` selects `payload: signals.payload` (I5 Files block + Note, incl. the verified today-shape at line 5) |
| QA-21 | fixed | Judge budget test now seeds 90 samples (5 chunks); clock reads (30ms step, 50ms budget) let wave 1's 4 chunks complete and cut wave 2 — asserts `judged: 80`, `remaining: 10`, `generate` called 4 times, i.e. real partial progress for the resume path (8210–8240) |
| QA-22 | fixed | Refusals record `lastError`/`failing` but deliberately do NOT touch `lastRunAt` (comment 13628–13630); test pins `source.lastRunAt` still null after a cap refusal (13317–13321) |
| QA-23 | fixed | I2 states the 60-day window is deliberate, with the rationale, and ties it to the "may have aged out" copy (19395–19397, copy at 19485) |
| QA-24 | fixed | `loadBrandTargets` hoisted to once per `runSlice` (7513–7517), passed via `ExtractSampleDeps.brandContext` (7397–7403); the standalone default still re-reads for the operator re-extract path, exactly as the review asked |

### Cross-part regression check (concurrent fixers)

All clean:

- **`RunDeps`** — declared `{database?, engines?}` in D2 (6256–6260), widened in
  D4 Step 4 with `fetchImpl`/`extract` (7500–7508) as a sequential edit to the
  same file; D8's `FinalizeDeps = RunDeps & {...}` (8926, 9227) absorbs the
  widening harmlessly. G1/H3 call `runSlice(runId, opts)` with no deps —
  compatible.
- **`engineMetrics` trailing `now`** — optional with a real-clock default
  (9453, 9953–9960); H6's `engineMetrics(tenantId)` (16592) is valid and
  correct for production.
- **`approveProposals` semantics vs H3/H8 copy** — H3's coordinated-contract
  note ("a bad batch changes nothing", 14528–14529) is now literally true for
  both the `invalid` and `duplicate` arms; the cap arm's
  `available`/`requested` shape is unchanged and H3's import comment matches
  (14464–14467). `requested` now counts the still-`proposed` slice — a
  strictly-more-correct number, no consumer breaks.
- **`aiVisibilityCitations.url` stores resolved URLs** — A1's schema comment
  ("eTLD+1, after redirect resolution"), C5's "resolveRedirect follows them at
  extraction time" note (5016–5020) and D4's implementation now all describe
  the same behavior; H11/I2 display citation URLs directly and benefit.
- **`publishMarkerRunIds`** — produced and unit-tested in H1
  (14047–14081/14194), exported, imported by H11 (18511) and fed
  `PromptHistoryPoint[]` whose `{runId, runDate}` matches the parameter type
  (9457).
- **`AI_VISIBILITY_CONCURRENCY`** — documented in G1's `.env.example` step
  (13680–13682), consumed by G1's `SWEEP_CONCURRENCY` (13474) and H3's
  `RUN_NOW_CONCURRENCY` (14924).

### Mechanical checks

- `grep -c '^### Task'` = 46 — unchanged.
- No `TBD`, `TODO`, or "similar to Task" placeholders anywhere in the plan.
- No duplicated or skipped step numbers in any task (checked programmatically
  across all 232 step headings).
- Every test file the fixes touch appears in a task's **Files:** block:
  `extract.test.ts` (D4), `run.test.ts` (D2/D3/D8), `ai-visibility-actions.test.ts`
  (H3), `charts.test.tsx` (H1), `signals.test.ts` (F1/F2),
  `related-pieces.test.ts` (H11), `prompts.test.ts` (B2),
  `metrics.test.ts` (E1), `judge.test.ts` (D6), `prompts-editor.test.tsx` (H8).

### New issues found in this pass

| ID | Severity | Where | Issue and fix |
| --- | --- | --- | --- |
| V-1 | minor | H11, plan 18564–18571 | The `related-pieces` test sketch's comment restates the contract's literal externalId scheme — `` `${type}:${promptId ?? domain ?? "all"}:${engine ?? "all"}:${isoWeek}` `` — without QA-9's documented deviation (the middle slot is the signal's *subject*, which can also be a competitorId). The test's actual point (match on `payload->>'promptId'`, never on externalId) is unaffected and still correct; this is doc drift only. Fix: reword the comment to "the middle slot is the signal's subject (promptId, domain, or competitorId)". Does not block execution. |

*Method note: every fix was re-derived from the edited plan text (implementation
AND its tests), not from fixer claims; line numbers were re-resolved against the
current 20,555-line file since all three fixers shifted the numbering the
original review used.*

---

## Findings table

| ID | Severity | Phase/Task | Where (plan lines) | One-line summary |
| --- | --- | --- | --- | --- |
| QA-1 | blocker | C5/D4 | 4948–4956, 7253–7273, 7137–7144 | `resolveRedirect` is built and tested but never called — every Gemini citation lands as `google.com`, class `other`, `ownDomainCited` always false |
| QA-2 | blocker | H3/H4/G1 | 14563–14592, 15030–15033, 13135+ | "Run now" only plans; nothing slices outside the once-daily cron — answers land next day, not "in a few minutes" |
| QA-3 | blocker | D3 | 6533–6553 | Mid-run cap test can never reach `runSlice`: `planRun` refuses `cap_reached` at plan time (estimate 0.036 > cap 0.015) |
| QA-4 | blocker | E1 | 9701–9713, 9465–9485 | `engineMetrics` uses real `new Date()`; both 30-day-delta tests fail deterministically once wall-clock passes ~2026-04-04 (it already has) |
| QA-5 | blocker | H8 | 16713 vs 16590–16624 | `SuggestionsSection` initializes collapsed for ≤10 proposals; its own tests render 2 proposals and query checkboxes that are not mounted |
| QA-6 | major | H11 | 18046–18059 vs 3993 | `buildAliases` called with an object; real signature is `(name: string): string[]`; "tenantName" derived from `profile.category`/`oneLiner`, tenant name never loaded |
| QA-7 | major | I2 | 18583–18591 | Evidence dialog highlights `profile.category` as the tenant brand ("Issue tracking software" marked "you") |
| QA-8 | major | H9 | 17274–17276 | Persona filter whitelist uses system-persona `key`; stored `prompt.persona` is the resolved display `name` — selecting a system persona filters to zero rows |
| QA-9 | major | F1/F2 | 11550–11558, 11636–11668, 11815–11834 | `externalId` collision: all `competitor_gained` signals on one engine share `competitor_gained:all:<engine>:<week>` — different competitors (and the engine-level summary) silently dedupe each other away |
| QA-10 | major | B2 | 2117–2152, 2009–2029 | `approveProposals` multi-edit batches half-apply: a duplicate on edit #2 returns `{error:"duplicate"}` with edit #1 already written; comment claims "writes nothing at all"; test covers only the single-edit case |
| QA-11 | major | F1 | 11738 | `gained_mention` fires with prev run merely "weak" (1/3); spec trigger is "0/3 → ≥2/3, **two runs**" — two consecutive strong runs |
| QA-12 | major | H11 | 18040–18044, 18113–18118 | Publish markers only render when a run starts on the same UTC day as publication — in practice the marker almost never appears |
| QA-13 | major | F2 | 12111–12131 | DB-level model-change suppression test is vacuous: with only 2 runs in the window, `lost_mention` cannot fire regardless of suppression |
| QA-14 | minor | B2 | 2126–2131 | Cap check counts already-active ids in `requested`; re-submitting a stale approve form at the cap returns a spurious cap error instead of the no-op |
| QA-15 | minor | H1 | 13739–13750 | `ReferenceDot x={points.findIndex(...)}` — numeric index against a category `XAxis dataKey="label"`; markers won't position; pass the point's `label` |
| QA-16 | minor | H1 | 13745, 13820 | `var(--color-chart-4)` / `var(--color-brand)` — `ChartContainer` only defines `--color-<seriesKey>`; these resolve to nothing (should be `var(--chart-4)` / `var(--brand)`) |
| QA-17 | minor | H6 | 15890–15893, 16002 | JSX uses `citedDomains` (the imported *function*) where `citedDomainRows` is meant; `listSignals` used but never in the import list (both are tsc-catchable, but the plan is quoted as canonical) |
| QA-18 | minor | F1 | 11461–11463 | `isoWeekKey` via date-fns `getISOWeek` is local-timezone-dependent — dedupe keys differ between a UTC server and a dev machine near week boundaries |
| QA-19 | minor | I4 | 19075 vs 19096/19241 | Files bullet names the action `saveAiVisibilitySettingsAction`; every code block names it `saveAiVisibilityConfig` |
| QA-20 | minor | I5 | 19544–19551 | `CitedSignal` today is `{id,title,url,kind}` (`src/lib/briefs/query.ts:5`) — the required `payload` addition is only in a prose note; `src/lib/briefs/query.ts` is missing from I5's Files list |
| QA-21 | minor | D6 | 7979–7997 | Judge budget test spends the budget before the *first* wave (45 samples = 3 chunks ≤ one wave of 4); partial-progress resume is never exercised |
| QA-22 | minor | G1 | 13191–13203 | Refusals (incl. cap) update `sources.lastRunAt`, which is also the fortnightly cadence anchor — a cap-refused fortnightly tenant re-waits 13 days after the month resets |
| QA-23 | minor | I2 | 18561–18566 | Evidence loaded via `listSignals` (60-day window) — the dialog reads "No evidence" for any signal older than the window even though the payload row still exists |
| QA-24 | minor | D4 | 7280–7303 | `extractSample` re-runs `loadBrandTargets` (3 queries) per sample inside `runSlice` — ~1,400 extra queries on a 360-call run; hoist per run |

---

## Blockers in detail

### QA-1 (blocker) — Gemini redirect resolution is never wired in

- **Where:** C1 builds and tests `resolveRedirect` (plan 3606–3752); C5's Gemini
  client stores raw `vertexaisearch.cloud.google.com/...` handles with the
  comment "`domains.resolveRedirect` follows them at extraction time" (4948–4956).
  D4's `extractSample` then does `toRegistrableDomain(citation.url)` directly
  (7256) and `extractDeterministic` compares `toRegistrableDomain(c.url)` to
  `ownDomain` (7137–7144). Nothing in D4–D8, E, or F ever imports
  `resolveRedirect`.
- **Consequence:** every Gemini citation reduces to `google.com` (`vertexaisearch.
  cloud.google.com` → last two labels), class `other`. Gemini's citation rate is
  permanently 0, `own_page_cited` can never fire on Gemini, and the leaderboard's
  loudest row is `google.com`. The spec is explicit twice: "own-domain citation
  by eTLD+1 **after resolving redirectors**" (§Concepts, Extraction) and
  "Gemini … resolve redirect URIs" (§Engines table).
- **Fix:** in D4, before computing `domain` and `ownDomainCited`, resolve each
  citation URL: `const resolved = isRedirector(citation.url) ? await
  resolveRedirect(citation.url, deps.fetchImpl) : citation.url;` — store
  `resolved` as `aiVisibilityCitations.url` (or keep the raw URL and add the
  resolved domain), pass resolved URLs into `extractDeterministic`, and add a
  `fetchImpl` seam to `extractSample`'s deps so the D4 tests can stub the 302.
  Add a test: a sample whose raw citations contain a
  `vertexaisearch.cloud.google.com` URL, with a stubbed 302 to
  `https://acme.com/pricing`, yields `domain: "acme.com"`, `domainClass: "own"`,
  `ownDomainCited: true`. Note `resolveRedirect` is network I/O per citation —
  cache per-URL within a slice.

### QA-2 (blocker) — "Run now" produces no answers until the next daily cron

- **Where:** `runNowAction` (14563–14592) calls only `planRun`. The sole callers
  of `runSlice`/`finalizeRun` are `sweepAiVisibility` (G1) via the scheduler
  route (G2), and `vercel.ts` runs that cron **once per day** (`0 9 * * *`,
  Hobby plan — repo `vercel.ts:26–29`). The H4 dialog copy promises "Answers
  land in a few minutes" (15032), the overview renders "Running… 0 / 360 calls",
  and the spec's decision log says "First run … Numbers within minutes, not
  next Monday" (stories 3 and 11).
- **Consequence:** every manual run — including the critical first-audit run —
  sits `pending` up to 24h with a header claiming it is running. The feature's
  activation metric (≥80% run first audit within 24h and presumably see numbers)
  is structurally unreachable on the same session.
- **Fix (pick one, and say which in the plan):**
  1. `runNowAction` kicks processing after responding: `import { after } from
     "next/server"` (Next 16) → `after(async () => { await runSlice(runId,
     {budgetMs, concurrency, now}); ... finalizeRun ... })`, with the same
     never-throw discipline as the sweep; or
  2. add a lightweight `/api/ai-visibility/run-tick` route the client polls
     after `runNowAction`, each tick doing one slice + finalize.
  Either way, add a test that a manual run reaches `complete` without the cron.
  Also update the H4 dialog copy if the answer is genuinely "next cron tick".

### QA-3 (blocker) — the mid-run cap-pause test never reaches `runSlice`

- **Where:** D3, 6533–6553: `planned({ monthlyCapUsd: 0.015 })`.
- **What's wrong:** `planned()` calls `planRun`, which calls `capExceeded`:
  1 prompt × 1 engine × 3 samples × $0.012 = $0.036 estimate; $0 spent;
  `0.036 > 0.015` → `exceeded` → `planRun` returns
  `{ok:false, reason:"cap_reached"}` → the helper throws
  `planRun refused: cap_reached`. The test fails in setup; the mid-slice
  `reached` path — the one behavior D1's two-boolean design exists for — ships
  untested.
- **Fix:** plan under a permissive cap, then tighten it before slicing:
  ```ts
  const { tenant, runId } = await planned();                    // cap default 20
  await db.update(aiVisibilitySettings)
    .set({ monthlyCapUsd: 0.015 })
    .where(eq(aiVisibilitySettings.tenantId, tenant.id));
  ```
  (`runSlice` re-reads settings at slice start, so the tightened cap takes
  effect.) Keep the rest of the assertions unchanged.

### QA-4 (blocker) — `engineMetrics`'s 30-day delta is wall-clock-bound; both delta tests already fail

- **Where:** implementation 9701–9713 (`const now = new Date(); const
  deltaBefore = now - 30d`); tests 9465–9485 seed runs at fixed dates
  2026-01-05 / 2026-03-05.
- **What's wrong:** with today's real date (2026-08-20, and any later date),
  `deltaBefore ≈ 2026-07-21`, so the "before" window contains **both** seeded
  runs. "computes a 30-day delta" gets `deltaPp = 0`, expected `10`; "has a
  null delta when there is no earlier window" gets `0`, expected `null`. Both
  fail on the first execution of the plan. This is also the flakiness class the
  repo memory warns about (real time in tests).
- **Fix:** give `engineMetrics` an injectable clock —
  `engineMetrics(tenantId, database?, now: Date = new Date())` (or an opts
  object) — thread it into `deltaBefore`, and have the tests pass
  `new Date("2026-03-30T00:00:00Z")`. H6 (the only production caller) passes its
  page-level `now`.

### QA-5 (blocker) — `SuggestionsSection` default-collapses under its own tests

- **Where:** implementation 16713:
  `useState(proposals.length > 0 && proposals.length <= 10)`; tests 16590–16624
  render 2 proposals and immediately `getAllByRole("checkbox")` /
  `getByRole("button", { name: "Approve 2 of 2" })`.
- **What's wrong:** with 2 proposals the section mounts collapsed ("2 new
  suggestions — Review" + a Review button; no checkboxes, no approve button).
  Both the "checks every row by default" and "sends the unchecked rows" tests
  fail. The heuristic itself is defensible (monthly ≤10-prompt batches arrive
  collapsed per the spec; the initial ~30 arrive expanded), but the tests and
  the component disagree.
- **Fix:** either (a) have the tests click "Review" first (and add an assertion
  that the collapsed strip renders for a small batch), or (b) drive collapsing
  off an explicit `initiallyCollapsed` prop the page computes (monthly
  expansion vs. first batch) and default it false in tests. (b) is better: "≤10
  means monthly" is a guess that breaks for a tenant who generates into 8 free
  slots.

---

## Majors in detail

### QA-6 (major) — H11 calls `buildAliases` with a shape it does not have

Plan 18046–18059:

```ts
const aliases: AnswerAlias[] = buildAliases({
  tenantName: profile.oneLiner ? profile.category ?? "" : "",
  competitors,
  profile,
}).map((alias) => ({ name: alias.name, kind: alias.isTenant ? ... }))
```

C2's contract-pinned export is `buildAliases(name: string): string[]` (plan
3993–4023; contract "NOTE: one argument"). The mapped fields (`.name`,
`.isTenant`, `.label`) do not exist on `string`. Worse, the "tenantName"
expression is `profile.category` gated on `oneLiner` — the tenant's *market
category*, and only sometimes. The page never loads `tenants.name` at all.
The step does say "read the real module and map to it", but the sample code is
what an executor will paste. **Fix:** load the tenant name (session or a
`tenants` read, as D4's `loadBrandTargets` does), then:

```ts
const aliases: AnswerAlias[] = [
  ...buildAliases(tenantName).map((n) => ({ name: n, kind: "tenant" as const, label: tenantName })),
  ...competitors.flatMap((c) =>
    buildAliases(c.name).map((n) => ({ name: n, kind: "competitor" as const, label: c.name }))),
];
```

Consider exporting a small `loadAnswerAliases(tenantId)` from `extract.ts` (it
already builds exactly this via `loadBrandTargets`) so H11 and I2 share one
definition of "what the extractor counted".

### QA-7 (major) — I2 highlights the category as the tenant

Plan 18583–18591 builds the dialog's alias list as
`{ name: profile.category, kind: "tenant" }` plus competitor names. The tenant's
brand is its **name**, not its category — the dialog would mark "Issue tracking
software" as "you" and never mark "Acme". The excerpt is a judge quote about
brands; with these aliases the tenant highlight is always wrong. **Fix:** same
as QA-6 — tenant name through `buildAliases`, ideally via the shared helper.
The plan's own closing note ("read `buildAliases` before shipping … call it
instead") concedes this; make it the primary path, not a fallback.

### QA-8 (major) — persona filter whitelist uses keys, prompts store names

H9, 17274–17276: `personas = profile.userPersonas.map(p => p.type === "system"
? p.key : p.name)`. Repo reality (`src/lib/workspace/personas.ts:11`,
`src/db/schema.ts:600`): system personas have distinct `key` ("…_manager"-style)
and display `name`, and B5's generator stores `resolvePersonaRefs(...).name` on
`ai_visibility_prompts.persona` (plan 3335, 3350). So for system personas the
filter option is a key that matches no stored row: selecting it filters the
list to nothing, and `readPromptsFilters`' whitelist rejects a legitimate
`?persona=Head of Design` deep link. **Fix:** resolve exactly as B5 does —
`resolvePersonaRefs(profile.userPersonas, await db.select().from(systemPersonas)).map(p => p.name)`
— or export a shared `personaNames(profile)` helper used by both B5 and H9.
Add an H7/H9 test seeding a system persona ref.

### QA-9 (major) — `competitor_gained` externalId collisions drop real signals

The contract's key is `${type}:${promptId ?? domain ?? "all"}:${engine ?? "all"}:${isoWeek}`.
F1 emits `competitor_gained` with `subject: null` from **two** rules (engine-SOV
summary, 11636–11652; cross-prompt ≥3, 11815–11834). Two different competitors
gaining on the same engine in the same ISO week produce identical
`competitor_gained:all:openai:2026-Wnn` keys: `onConflictDoNothing` writes the
first and silently discards the second — a materially different signal (different
`competitorId`, different brief). Duplicates also occupy slots in the ten-cap
before the insert dedupes them. **Fix:** put the competitor into the subject
slot when no promptId/domain exists: `subject: entry.competitorId` (and
`riser` for the summary). This stays inside the contract's shape (the middle
slot is "the subject"); note the deviation in a "Note" line as the contract
instructs. Add an F1 test: two competitors qualifying on one engine → two
candidates with distinct externalIds.

### QA-10 (major) — `approveProposals` half-applies multi-edit batches

B2, 2117–2152: edits are applied one `update` at a time; a unique-index
collision on edit N returns `{ok:false, error:"duplicate"}` after edits 1…N-1
are already committed — on rows still `proposed`, whose wording the reviewer
then re-reviews without knowing it changed. The docstring says "Validated
before any write, so a bad edit cannot half-apply a batch", which is true only
for the `invalid` arm. The test at 2009–2029 uses a single edit, so it passes
while the invariant is false. **Fix:** pre-check collisions before writing
(select existing non-rejected texts for the tenant matching any edited text →
return `duplicate` before the loop), or wrap the edit+approve+reject sequence
in `database.transaction(...)`. Extend the test: two edits where the second
collides → first proposal's text unchanged.

### QA-11 (major) — `gained_mention` trigger looser than spec

F1 line 11738 fires on `nowBand === "strong" && prevBand !== "absent" &&
beforeBand === "absent"` — `prevBand === "weak"` (1/3) qualifies. Spec table:
`0/3 → ≥2/3, two runs`, i.e. **strong in both** of the last two runs, mirroring
`lost_mention`'s two consecutive absents. As written, 3/3 after 1/3 after 0/3
emits a "now named" brief off a pattern that is half noise. **Fix:**
`prevBand === "strong"` (and update the F1 test at 11073–11075, whose fixture
`runBand("r2", 2)` is already strong, so only the condition changes).

### QA-12 (major) — publish markers require a same-day run

H11 18040–18044 keys `publishedByDate` by the piece's `publishedAt` calendar
day and looks it up by `runDate.slice(0,10)`. Weekly runs on Mondays vs.
publishes on any weekday: the marker renders only when the two coincide on one
UTC day. Spec: "the prompt's sparkline gets a publish-date marker labelled
'published'". **Fix:** for each published piece, mark the first history point
with `runDate >= publishedAt` (the run that could first observe the change),
falling back to the nearest point. Add this as a small pure helper next to
`sparklineMarkers` with a unit test — it is exactly the kind of derivation H1's
test file exists for.

### QA-13 (major) — DB-level model-change suppression is untested

F2's test (12111–12131) sets up a 2-run window; per-prompt `lost_mention` needs
`runs[2]` (`beforeBand === "strong"`), so it cannot fire even with suppression
removed — the `not.toContain("lost_mention")` assertion passes vacuously. The
pure-function suppression is tested in F1, but the seam this test exists for
(run.modelIds → `EngineWindow.modelChanged`) is not exercised. **Fix:** seed a
third complete run so the sequence is strong → absent → absent with a model
change on the newest run, and assert `lost_mention` absent with the change and
present without it (two assertions, one seeding helper).

---

## Minor notes (concrete fixes)

- **QA-14:** In `approveProposals`, compute `requested` from ids that are
  actually `proposed` (one `select ... where status='proposed' and id in (...)`)
  before the cap comparison, so replayed forms no-op instead of erroring.
- **QA-15:** `ReferenceDot` on a category axis needs `x={point.label}` (the
  category value), not a numeric index. Untestable in jsdom — fix at source.
- **QA-16:** Use the theme tokens directly: `fill="var(--chart-4)"`,
  `fill={row.isTenant ? "var(--brand)" : "var(--chart-3)"}`. `--color-*`
  variables exist only for `ChartConfig` series keys.
- **QA-17:** Rename the destructured `domains` → use `citedDomainRows` in the
  JSX at 15890–15893, and add `listSignals` (from `@/lib/signals/query`) to
  H6's import list. Both would surface at `typecheck`, but the plan quotes this
  code as canonical.
- **QA-18:** Compute the ISO week from UTC components (e.g. the classic
  `Date.UTC`-based algorithm) or document that app servers must run TZ=UTC;
  otherwise the same run gets different dedupe keys in dev vs. prod near
  week boundaries.
- **QA-19:** Pick one name (`saveAiVisibilityConfig` matches the code and the
  I4 test mock) and fix the Files bullet.
- **QA-20:** Add `src/lib/briefs/query.ts` to I5's **Files: Modify** list, and
  spell the change: `CitedSignal` gains `payload: AiVisibilityPayload | null`
  and `listBriefSignals`' select adds `payload: signals.payload`. Verified
  today's shape has no payload (`src/lib/briefs/query.ts:5`).
- **QA-21:** Make the judge budget test's first clock reads cheap (step 0 for
  the first N reads, or budget 100ms with step 30) so wave 1 completes and
  wave 2 is cut — asserting `judged > 0 && remaining > 0`.
- **QA-22:** Consider only updating `sources.lastRunAt` on actual runs (use a
  different field or leave it untouched on refusals), or accept and document
  that a refusal re-anchors the fortnight.
- **QA-23:** Accepted if intentional (signals themselves go stale), but the
  dialog copy "may have aged out" should then be the designed behavior — add
  one line to I2 saying the 60-day window is deliberate.
- **QA-24:** Hoist `loadBrandTargets` to once per `runSlice` invocation and
  pass the `BrandContext` into `extractSample` (keep the standalone re-read for
  the operator "re-extract after alias fix" path).

---

## Verified clean (checked, no defect found)

**Cross-part symbol table** — every one of these is produced and consumed with
identical name, parameter order, and result shape:
`getAiVisibilitySettings` / `saveAiVisibilitySettings` / `ensureAiVisibilitySource` /
`setAiVisibilityEnabled` (A2/A3 ↔ D2/D3/G1/H6/H9/I3/I4);
`approveProposals` incl. the coordinated `edits` arg and all three error arms
(B2 ↔ H3, incl. `available`/`requested` on the cap arm); `getPrompt` →
`PromptDetail.supersededById` (B1 ↔ H11); `planRun`/`runSlice`/`finalizeRun`
incl. `now: () => Date` and `budgetMs` (D2/D3/D8 ↔ G1 ↔ H3);
`capExceeded` two-boolean `CapState` and which boolean gates where (D1 ↔
D2/D3/H6/I4 — H6 correctly uses `exceeded`, `runSlice` uses `reached`);
`estimateRunCost` returning a bare number (D1 ↔ H6); `wilsonPp` (math checked:
half-width at p=.5, n=100 ≈ 9.6pp ✓); `windowCounts` (sums counts, engine-level
vs prompt-level rows never mixed); `engineMetrics` rates 0–100 with nulls below
n≥30 (E1 ↔ H4's `tileReading`/`metricsLine`, which correctly do **not**
re-multiply); pooled "all" row = summed counts, not averaged rates (E1 test
pins 18% vs the 50% average trap); `promptMatrix` un-thresholded ↔ H5
`cellReading` applying n≥3; `promptHistory(promptId, engine, db?)` (page
pre-scopes tenant via `getPrompt` before calling it); `latestRun` (any
status — the running/paused states depend on this and it is right);
`engineHistory` (null-break below threshold, not zero); `runEngineHealth`
(errored vs refused separated; H6 correctly uses `erroredSamples` only);
`promptSamples` per-engine limit semantics (E2 ↔ H11);
`citedDomains(tenantId, {runs, limit, promptId})` (E3 ↔ H6/H11/F2);
`emitSignals` ↔ D8's `emit` dep shape; `sweepAiVisibility` ↔ G2;
`EngineClient.ask` ↔ `runSlice`; `AiVisibilityPayload` / `SampleExtraction`
field-for-field against the contract.

**D8→F2 stub handoff** — F2 Step 4 replaces the stubbed `emit` and adds a
wiring test ("calls the real emitSignals when none is injected"); the only
exposure is executing D8–F1 and stopping, which the plan flags loudly.

**Schema/contract fidelity** — all six tables match the contract column-for-
column, incl. `searchUsed`/`searchQueries`/`costUsd` notNull with defaults, the
samples identity unique, and the two partial uniques on aggregates (with the
correct NULL-promptId rationale). `signals.payload` nullable jsonb typed
`AiVisibilityPayload`.

**Repo-reality anchors** — all verified against the worktree:
migrations end at `0065_*` → `0066_ai_visibility` is correct; enum `ADD VALUE`
precedent exists (0014/0027/0029/0032); `signalKindEnum`/`sourceTypeEnum` at
schema.ts:337/339 with exactly the contract's values;
`sources_tenant_type_null_url_unique` partial index exists and `label` is
notNull / `url` nullable (A3's upsert target is valid); `sourceStatusEnum` =
active|failing|disabled (matches every status write in the plan);
`signals_tenant_kind_external_unique` exists; `signals` has
`excerpt`/`competitorId`/`occurredAt`/`externalId` (F2's insert is valid);
`companyProfiles` has `category`/`positioning`/`topics`/`oneLiner`/
`userPersonas`/`websiteUrl`/`updatedAt`; `competitors` has
`websiteUrl`/`createdAt`; `tests/helpers/fixtures.ts` exports
`seedTenant(name)`/`dropTenant(name)`/`seedCompanyProfile(tenantId, overrides)`
exactly as used — and `seedTenant` **inserts** (no name unique), so E2's
double-`seedTenant(TENANT)` "other tenant" trick genuinely creates a second
tenant and `dropTenant` cleans both (checked; not a bug);
`LlmOperation` union at llm-usage.ts:5 with `"brief_proposal"` present and
`TokenUsage` exported; `src/lib/signals/params.ts:3` KIND_VALUES,
`signals-filters.tsx:17` KIND_OPTIONS, `signal-row.tsx:9` KIND_LABEL and the
single `shipped_work` evidence branch at ~line 156, `brief-evidence.tsx:5`
SIGNAL_KIND_LABEL — all exactly as the plan quotes; `nav-links.tsx` NAV and
alphabetical lucide import (Radar last, `ScanSearch` slots after it) and
COMPANY_SECTIONS with an `#industry-news` anchor to slot after;
`main-container.tsx:17` `WIDE_ROUTES = ["/board", "/calendar"]`;
`nav-links.test.tsx` HREFS at line 29; scheduler route order and its test file
match G2's quoted mocks/beforeEach/ordering structure; `.env.example` has
`IDEATION_MODEL` (line 75) and the exact "Image generation. OpenAI, called
DIRECTLY" block C7 replaces (77–83); `mapWithConcurrency`, `resolveModel`/
`modelId`, `recordLlmUsage`, `resolvePersonaRefs`, `systemPersonas`,
`getOrCreateCompanyProfile`, `listCompetitors`, `listSignals(tenantId,
filters, db?)` with `filters.kind` all exist as consumed; `SignalRow` props
match I1's test usage; `Card` supports `size="sm"`; `DisabledHint({hint,
children})` exists; `evidence-actions.ts` exports both names I1 mocks;
`chart.tsx` absent (H1 creates it) and all other imported ui primitives
present; deps: `ai@7`, `zod@4`, `date-fns@4` (has `getISOWeek`/`getISOWeekYear`),
`recharts` absent (new, as the contract requires); scripts `db:generate`,
`db:migrate`, `db:migrate:test`, `typecheck`, `lint`, `test` all present;
vitest projects route `tests/components/**` to jsdom and everything else to
node — every plan test file is in the right project.

**Logic spot-checks that passed** — `allocateMix` largest-remainder arithmetic
(30-slot case reproduces the test's {9,6,5,4,3,3}); brand-check 1-sample
planning and its exclusion from `n` (belt-and-braces `branded ||
intent==='brand_check'`); `capExceeded` boundary cases (=cap not exceeded;
19.999+0.036 exceeded-not-reached); month boundaries incl. December rollover;
`runSlice` budget/resume clock arithmetic against the advancing fake clock;
judge chunk index mapping (indices are per-chunk, chunks built per-chunk — no
cross-chunk offset bug); `quoteIsVerbatim` whitespace-collapse/case-preserve;
aggregate delete-then-insert idempotency vs the two partial uniques;
engine-level n=0 rows written on total failure; F1 cap determinism
(weight×1000+evidence, externalId tiebreak); `cellReading`/`engineChipLine`
never printing booleans or 0/0; H7 filter round-trip incl. hostile
intent/status, foreign competitor uuid, deleted persona, repeated params;
H10 `segmentAnswer` (longest-match, URL exclusion, word boundaries, XSS-by-
construction via React children); one-writer sample claim documented as an
invariant rather than pretending to lock.

---

## Coverage map (task → test file → covered?)

| Task | Test file | Covered |
| --- | --- | --- |
| A1 schema | `tests/lib/ai-visibility/schema.test.ts` | yes — defaults, partial uniques, cascades, payload round-trip |
| A2 settings | `tests/lib/ai-visibility/settings.test.ts` | yes — defaults, coercion, per-field rejection, string coercion |
| A3 source/switch | same file (extended) | yes — idempotent source, on/off, lastError semantics |
| B1 prompts CRUD | `tests/lib/ai-visibility/prompts.test.ts` | yes — cap, duplicate, tenancy, ordering |
| B2 approve batch | same file | **partial** — multi-edit half-apply untested (QA-10); stale-resubmit-at-cap untested (QA-14) |
| B3 lifecycle | same file | yes — supersede, no-op edit, delete guard, cross-tenant |
| B4 quality checks | `tests/lib/ai-visibility/generate-prompts.test.ts` | yes |
| B5 generation | same file | yes — fencing, negatives, index dedupe, fail-closed, disabled/cap |
| C1 domains | `tests/lib/ai-visibility/domains.test.ts` | yes (but see QA-1 — tested, unused) |
| C2 aliases | `tests/lib/ai-visibility/aliases.test.ts` | yes — URL/echo stripping, boundaries, possessive |
| C3–C6 engines | `tests/lib/ai-visibility/engines/*.test.ts` | yes — request shape, extraction, error/refusal taxonomy per engine |
| C7 registry | `engines/index.test.ts` | yes — incl. monthly-cost sanity band |
| D1 cost | `tests/lib/ai-visibility/cost.test.ts` | yes — incl. brand-check pricing, both booleans |
| D2 planRun | `tests/lib/ai-visibility/run.test.ts` | yes — all five refusals, grid shape, snapshot |
| D3 runSlice | same file | **partial** — cap-pause test broken (QA-3); budget/resume/error paths yes |
| D4 extract | `tests/lib/ai-visibility/extract.test.ts` | **partial** — no redirect-resolution case (QA-1); rest yes |
| D5 judgeChunk | `tests/lib/ai-visibility/judge.test.ts` | yes — index dedupe, usage op, fail-soft, empty chunk |
| D6 judgeRun | same file | **partial** — budget test never makes progress (QA-21); flags/quotes/D-J yes |
| D7 aggregates | `tests/lib/ai-visibility/aggregate.test.ts` | yes — eligibility cut, per-engine split, idempotency, n=0 rows |
| D8 finalize | `run.test.ts` | yes — order, resume, source health, double-finalize guard |
| E1 windows/metrics | `tests/lib/ai-visibility/metrics.test.ts` | **broken** — delta tests real-clock (QA-4); wilson/window/pooled yes |
| E2 matrix/history/samples | same file | yes — incl. per-engine limit, tenancy, model ids |
| E3 cited domains | `tests/lib/ai-visibility/cited-domains.test.ts` | yes — eligibility parity, shares, ordering, prompt narrowing |
| F1 triggers | `tests/lib/ai-visibility/signals.test.ts` | **partial** — gained_mention spec deviation pinned wrong (QA-11); externalId collision untested (QA-9); rest thorough incl. noise holds, suppression, cap determinism |
| F2 emitSignals | same file + `run.test.ts` wiring | **partial** — model-change suppression vacuous (QA-13); write/dedupe/cap yes |
| G1 sweep | `tests/lib/ai-visibility/sweep.test.ts` | yes — cadence incl. 13-day tolerance, resume-any-day, budget split, refusal recording, ordering |
| G2 scheduler | `tests/app/api/cron/scheduler/route.test.ts` | yes — placement + ordering + 401s |
| H1 charts | `tests/components/ai-visibility/charts.test.tsx` | partial by design (jsdom can't draw); markers/order/empty yes; dot positioning unfixable in test (QA-15) |
| H2 nav/wide | `tests/components/nav-links.test.tsx` | yes (HREFS mechanism) |
| H3 actions | `tests/app/ai-visibility-actions.test.ts` | yes — validation, tenancy, refusal copy, no-double-gate |
| H4 tiles/run-now | `overview-cards.test.tsx` | yes — Collecting-baseline vs 0%, muted delta, destructive failure, estimate copy |
| H5 matrix/domains table | two jsdom files | yes — counts-never-booleans, dash semantics, show-all, propose-brief gating |
| H6 overview page | none (manual checklist) | **no** — 9 states manual-only; acceptable per plan's stated reason (OAuth-walled preview), but QA-17's bugs live exactly here |
| H7 filter params | `tests/app/ai-visibility-prompt-params.test.ts` | yes — full round-trip incl. hostile values |
| H8 editor/suggestions | `prompts-editor.test.tsx` | **broken** — collapsed-default contradiction (QA-5); rest good |
| H9 prompts page | none (manual) | **no** — and QA-8 lives here |
| H10 HighlightedAnswer | `highlighted-answer.test.tsx` | yes — incl. XSS-as-text |
| H11 detail page | `related-pieces.test.ts` only | **partial** — relatedPieces yes (incl. externalId-vs-payload trap); page mapping (QA-6, QA-12) untested |
| I1 signals browser | `signals-ai-visibility-row.test.tsx` | yes — label + branch + non-regression |
| I2 evidence dialog | `evidence-dialog.test.tsx` | yes — lazy load, methodology line, null promptId, read-only (alias bug QA-7 not caught: aliases are mocked) |
| I3 company card | `company-card.test.tsx` | yes — optimistic revert, derivation line, lastError persistence |
| I4 settings form | `settings-form.test.tsx` | yes — estimate recompute, no-engines guard, over-cap warning |
| I5 brief chip | `brief-evidence-chip.test.tsx` | yes — excerpt/domains, payload-less fallback (query change under-specified, QA-20) |

---

*Scope note: correctness, consistency, coverage, and executability only; no
style findings. All line references are into
`docs/superpowers/plans/2026-08-20-ai-visibility.md` unless a repo path is
given.*
