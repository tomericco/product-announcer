# AI Usage Tab — Design

Date: 2026-08-28
Status: Approved design, pending implementation plan

## Purpose

Give customers a settings view of their AI consumption so they can track it,
and lay the UI/query groundwork for future per-package monthly credit limits.
Usage is reported in **two separate channels** that must never be summed:

1. **Credits** — tokens spent on calls made with *our* provider keys.
   1 credit = 1 token. No limit today; future packages will impose a monthly
   credit limit, and the UI must be ready to render one.
2. **BYOK tracking** — tokens spent by the AI-visibility *engine sweep* calls,
   which run on the customer's own API keys. Shown so the customer can track
   what those sweeps cost them; **never counted as credits** and never subject
   to the credit limit, because the customer already pays their provider
   directly for them.

Everything else about billing stays as it is: core features on our keys,
AI-visibility sweeps BYOK. (A full-BYOK mode was considered and deferred.)

## What already exists (context)

- Every AI SDK call already records tokens per tenant into `llm_usage`
  (`src/db/schema.ts:1308`) via `recordLlmUsage` (`src/lib/ai/llm-usage.ts`),
  keyed by an `operation` string (16 values today). This feature is mostly
  read-side.
- The AI-visibility sweep engines (`src/lib/ai-visibility/engines/{openai,
  gemini,anthropic}.ts`) call provider HTTP APIs with raw `fetch` and
  currently **discard** the `usage` object present in every response. They
  bill flat USD estimates onto `ai_visibility_runs.costUsd` (BYOK dollars);
  that system is unchanged by this feature.
- Settings (`src/app/(dashboard)/settings/page.tsx`) is one scroll of cards,
  no tabs. `Tabs`, `ChartContainer` (recharts), and table components already
  exist under `src/components/ui/`.
- No plan/package/subscription concept exists anywhere in the schema.

## Decisions (settled with the user)

| Question | Decision |
|---|---|
| Unit & naming | Tab named **"AI usage"**; unit is **credits**, 1 credit = 1 token. The existing "show dollars, never credits" comments apply to the BYOK spend UI only and stay untouched. |
| Images | Token-priced like everything else: `generateImage` reports real token usage and `renderImage` already persists it (`src/lib/ai/images.ts:141`). No per-image constant. Image rows whose token columns are null (provider omitted usage, or rows predating usage capture) count 0 credits. |
| BYOK sweep tokens | Included in the tab, tracked in `llm_usage`, displayed in their own clearly-labeled section, **excluded from all credit math**. |
| Settings layout | Convert the settings page to two tabs: **Workspace** (all existing cards, unchanged) and **AI usage**. Deep link via `?tab=usage`; Workspace is the default so existing `#ai-engines` / `#ai-visibility` anchors keep working. |
| Limit prep | Query/UI seam only. `getMonthlyCreditLimit(tenantId)` returns `null` today; no schema, no enforcement. |
| Aggregation | Live `GROUP BY date_trunc` queries, **no rollup tables and no cron work** (the Hobby plan's daily-only cron makes rollups stale by design; the table is small and tenant-scoped). |
| Buckets | UTC. Weeks are ISO (`date_trunc('week')`, Monday start) — the tenant `weekStartsOn` setting is deliberately not used here. |

## Architecture

### 1. Write side: capture sweep-engine tokens

The only new instrumentation. All three engine responses already carry token
usage in their raw JSON (OpenAI Responses `usage`, Gemini `usageMetadata`,
Anthropic `usage`); the clients parse it and return it.

- Extend `EngineAnswer` and `EngineError` (`src/lib/ai-visibility/types.ts`)
  with an optional `usage?: { inputTokens?: number; outputTokens?: number;
  totalTokens?: number }` — optional because a transport failure has no
  response to read, and a malformed response may omit it.
- Each engine client populates `usage` from its raw response, on success and
  on *billed* failures (refusal, truncation — the tokens were spent). Missing
  or malformed usage fields are stored as absent, never guessed.
- The run slice (`src/lib/ai-visibility/run.ts`) records each sample's usage
  via the existing `recordLlmUsage` with:
  - new operation value `ai_visibility_engine` (added to `LlmOperation`),
  - `model` = the engine's reported model id (e.g. `gpt-5.5-2026-04-23`),
    which is how per-engine breakdown works without a new column.
- `recordLlmUsage` already never throws, so accounting cannot fail a run.
- Historical sweeps have no token data; BYOK tracking starts at deploy. The
  UI's BYOK section states this ("tracked since &lt;date&gt;" is not needed —
  an empty-state line suffices).

Nothing about `costUsd`, `monthlyCapUsd`, or the cap-pause flow changes.

While here: correct the stale comment on `LlmOperation` in
`src/lib/ai/llm-usage.ts` claiming `image_generation` "sets `imageCount`
instead of the token columns" — it sets both.

### 2. Migration

One migration (`npm run db:generate`, applied by `db:migrate` and
`db:migrate:test`):

- Index `llm_usage_tenant_created_idx` on `llm_usage (tenant_id, created_at)`
  — prerequisite for every query below.

No new tables, no new columns.

### 3. Query module: `src/lib/usage/`

All functions take `tenantId` and are tenant-scoped SQL over `llm_usage`.
Credits math is one shared SQL expression: `credits = COALESCE(total_tokens,
0)` — uniform across operations, images included (image calls report token
usage too).

Rows with `operation = 'ai_visibility_engine'` are **excluded** from every
credit aggregate and **selected exclusively** by the BYOK functions.

- `creditsByPeriod(tenantId, granularity)` — `granularity: "daily" | "weekly"
  | "monthly"`; fixed windows: daily = last 30 days, weekly = last 12 ISO
  weeks, monthly = last 12 calendar months. Returns
  `{ bucket: string, feature: FeatureKey, credits: number }[]` — grouped by
  bucket × feature so the chart can stack. Buckets with no usage are
  zero-filled in code (not SQL) so charts have a continuous axis.
- `creditsByFeature(tenantId, granularity)` — totals per feature over the same
  window, for the breakdown table.
- `monthToDateCredits(tenantId)` — one number, current UTC calendar month.
- `byokTokensByPeriod(tenantId, granularity)` — same shape as
  `creditsByPeriod` but over `ai_visibility_engine` rows only, measured in
  **tokens**, not credits. Grouped by `model`; since `model` stores the
  provider's dated snapshot id (e.g. `gpt-5.5-2026-04-23`), the UI maps ids
  to engine labels by prefix (`gpt-*` → GPT, `gemini-*` → Gemini,
  `claude-*` → Claude), unknown prefixes shown as-is.
- `byokTokensMonthToDate(tenantId)` — headline for the BYOK section.
- `getMonthlyCreditLimit(tenantId): Promise<number | null>` — **the limit
  seam.** Hard-coded `return null` today with a comment pointing at the
  future package model. The UI branches on it; nothing else knows limits
  exist.

### 4. Feature display map

`operation` is the storage dimension but not 1:1 with product features
(`generation` covers four call sites, etc.). A display map in
`src/lib/usage/features.ts` groups the 16 operations into product-facing
features:

| Feature (label) | Operations |
|---|---|
| Content generation | `generation`, `brief_draft`, `atomic_summary`, `resolution` |
| Review & revision | `review`, `revision` |
| Briefs & ideation | `brief_proposal`, `ideation` |
| Images | `image_generation`, `illustration_plan` |
| Signals | `signal_relevance`, `news_selection`, `enrichment` |
| LinkedIn | `linkedin_copy` |
| Onboarding & brand | `brand_analysis`, `company_context_analysis` |
| AI visibility | `ai_visibility_prompts`, `ai_visibility_judge` |

An operation value not in the map (e.g. added later and forgotten) falls into
an **"Other"** bucket rather than disappearing — the map must never silently
drop usage. `ai_visibility_engine` is intentionally absent from this map; it
belongs to the BYOK channel.

### 5. UI

`src/app/(dashboard)/settings/page.tsx` becomes a two-tab page using the
existing `Tabs` component. The active tab comes from `?tab=` (server-read
search param; the tab bar renders links, not client state, so the page stays
a Server Component and deep links work). All existing cards move under the
**Workspace** tab unchanged.

**AI usage tab** (new components under `src/app/(dashboard)/settings/`):

1. **Month-to-date headline card.** `monthToDateCredits` as "N credits used
   this month". When `getMonthlyCreditLimit` returns a number: a progress bar
   and "N of M credits". When `null`: the plain total, no mention of limits.
2. **Usage chart card.** Granularity toggle (Daily / Weekly / Monthly — a
   client component holding the selection; all three datasets are fetched
   server-side and passed down, since each is ≤ 36 rows × features). Stacked
   bar chart via `ChartContainer` + recharts `BarChart`, one series per
   feature, following the color/contrast conventions in
   `ai-visibility/visibility-trend.tsx`.
3. **Feature breakdown card.** Table of feature → credits for the selected
   granularity's window, sorted descending, with share-of-total.
4. **BYOK section card** — visually separate, titled "Your own API keys
   (AI visibility sweeps)" with the explicit line "Tracked for your cost
   visibility — not counted as credits." Month-to-date token total plus a
   small bar chart by engine, in **tokens**. Empty state explains tracking
   began with this release.

Access: any member can view (read-only page; no owner gating — consistent
with the rest of settings being visible, and there is nothing to edit).

### 6. Error handling

- Query functions are plain reads; a DB failure surfaces as the page's error
  boundary like any other settings query. No swallowing.
- `recordLlmUsage`'s never-throw contract already covers the new engine
  recording path.
- Engines with absent/malformed `usage` record null token columns — the
  existing recorder contract — and those rows contribute 0 to sums via
  `COALESCE`.

## Testing

- `tests/lib/usage/*.test.ts` — real-Postgres tests (per repo convention:
  unique tenant name per file as the cleanup key). Seed `llm_usage` rows
  across operations/dates and assert: bucket math (ISO weeks, UTC months),
  zero-filling, null-token rows counting 0, `ai_visibility_engine` exclusion
  from credits and inclusion in BYOK functions, feature-map fallback to
  "Other".
- Engine tests (`tests/lib/ai-visibility/engines/…`) — mocked `fetch`
  responses assert `usage` is parsed on success and billed failures, and
  absent on transport errors.
- Run-slice test — asserts one `llm_usage` row per engine sample with
  operation `ai_visibility_engine`.
- Component test (jsdom project) — granularity toggle switches datasets;
  limit-present vs limit-null rendering of the headline card.

## Out of scope

- Any plan/package/subscription schema, and any enforcement or blocking of
  LLM calls on a limit.
- Changes to the BYOK USD estimate system (`costUsd`, `monthlyCapUsd`,
  cap-pause flow) or the AI-visibility settings UI.
- Rollup/aggregate tables and cron changes.
- Backfilling token data for historical sweeps (impossible — not captured).
- Cost-in-dollars for credit usage (no price table; credits are tokens).
