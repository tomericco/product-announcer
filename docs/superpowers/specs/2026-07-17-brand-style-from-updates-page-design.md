# Brand Style from Updates Page — Design

**Date:** 2026-07-17
**Status:** Approved (pending spec review)

## Context

A tenant's brand profile (`brand_profiles`: `tone`, `reading_level`, `do_list`, `dont_list`,
`example_phrases`, `industry`, personas) is today filled **only** by hand in Settings. Nothing
seeds it, so a new tenant either does the manual work or generates updates with a bare profile.

Most teams that would use Product Announcer already publish a changelog / "what's new" page —
usually public (no auth). That page is a rich, ready-made signal of their voice, structure, and
vocabulary. This feature lets onboarding **scrape that page, analyze it, and auto-fill the brand
profile**, so setup is faster and the writing agent immediately has house-style context.

Onboarding is a 4-step card flow (`src/app/onboarding/page.tsx`): name → connect GitHub →
select repos → schedule. This adds an optional brand-style card.

## Goal

During onboarding, let the tenant paste the URL of their existing updates page; the app scrapes
it (server-side, SSRF-guarded), an LLM derives their brand-style fields plus a new
"update structure/style" summary, and the derived values are saved to the brand profile
(editable later in Settings). The new summary field feeds the generation prompt.

## Design

### 1. Data model (`brand_profiles`)

Two new nullable columns (migration required):

| Column | Type | Meaning |
|---|---|---|
| `updates_page_url` | text (nullable) | the source URL the tenant provided |
| `updates_style_summary` | text (nullable) | derived prose description of how they structure updates (sections, length, voice patterns) — the new generation-context field |

The existing brand columns (`tone`, `reading_level`, `do_list`, `dont_list`,
`example_phrases`, `industry`) are populated by the same analysis; no new columns for them.

### 2. Scraping module — `src/lib/workspace/scrape-updates-page.ts`

`fetchUpdatesPageText(url, deps?): Promise<{ text: string } | { error: "invalid-url" | "blocked" | "fetch-failed" | "insufficient-content" }>`:

- **SSRF guard (non-negotiable):** accept only `http(s)` URLs (https preferred); resolve the host
  and reject private, loopback, link-local, and non-public IP ranges; disable following redirects
  to such hosts (fetch with `redirect: "manual"` and re-validate each hop, or cap to same-origin).
- **Bounds:** request timeout (e.g. 8s via `AbortSignal`), response-size cap (e.g. 2 MB), and a
  non-HTML content-type is rejected.
- **Extraction:** strip `<script>`/`<style>`/`<noscript>`, convert remaining HTML to whitespace-
  collapsed text, truncate to a token budget (e.g. ~12k chars).
- **Insufficient-content signal:** if the extracted text is below a threshold (e.g. < 200 chars —
  typical of a JS-only shell), return `{ error: "insufficient-content" }` so the UI can fall back
  to "set it in Settings".

The network client is injected (default `fetch`) so tests mock it.

### 3. Analysis agent — `src/lib/workspace/analyze-brand-style.ts`

- `DerivedBrandProfile` (Zod): `{ tone: string | null; readingLevel: string | null; doList: string[]; dontList: string[]; examplePhrases: string[]; industry: string | null; updatesStyleSummary: string | null }`.
- `analyzeBrandStyle(pageText): Promise<DerivedBrandProfile>` → one `generateObject` call with
  `process.env.ONBOARDING_ANALYSIS_MODEL ?? "anthropic/claude-sonnet-4-5"`; the prompt instructs
  the model to infer each field from the page and leave a field null/empty when it cannot.
- **Fail-safe:** on model error, return an all-empty derivation (`{ tone: null, …, doList: [], …, updatesStyleSummary: null }`) so the caller saves nothing and the user proceeds manually.

### 4. Onboarding step

A new **optional** card in `src/app/onboarding/page.tsx` — "Import your brand style from your
changelog (optional)": a URL `Input` + submit that calls a server action
`importBrandStyle(formData)`:

1. Validate/scrape via `fetchUpdatesPageText`. On any `error`, redirect back with a friendly
   message ("We couldn't read that page — you can set your brand style in Settings.") and save
   nothing except (optionally) the URL.
2. `analyzeBrandStyle(text)` → derived profile.
3. **Overwrite** the tenant's brand profile with the derived values plus `updates_page_url` and
   `updates_style_summary` (safe: the profile is freshly-defaulted at onboarding).
4. Redirect back with a success confirmation ("Brand style imported — refine it anytime in
   Settings.").

The card is independent of the GitHub steps and skippable (the existing "Skip for now" applies).

### 5. Generation wiring

`buildSystemPrompt` in `src/lib/ai/compose-prompt.ts` gains one line when
`brandProfile.updatesStyleSummary` is non-empty: `Match the house style of their existing
updates: <summary>.` — placed alongside the existing tone / personas / examplePhrases lines.
(`brandProfiles` row already flows into `buildSystemPrompt`, so no signature change.)

### 6. Settings

The Settings brand editor gains an **editable style-summary** textarea (`updates_style_summary`)
and displays the source `updates_page_url` (read-only link). **Manual-edit-only** — Settings does
**not** re-run analysis, so hand-tuned fields are never clobbered. The existing brand-save action
is extended to persist the new field.

### 7. Testing

- **`fetchUpdatesPageText`** (mocked network): rejects non-http(s), private/loopback/link-local
  hosts, and redirects to blocked hosts; enforces the size cap and non-HTML rejection; extracts
  text from HTML (scripts/styles stripped); returns `insufficient-content` below threshold.
- **`analyzeBrandStyle`** (mocked `generateObject`): parses a `DerivedBrandProfile`; returns the
  all-empty derivation on model error.
- **`importBrandStyle` action** (mocked scrape + analysis): a successful run writes the derived
  fields + URL + summary to the brand profile; a scrape `error` writes nothing (beyond possibly
  the URL) and surfaces the fallback message.
- **`buildSystemPrompt`**: includes the house-style line when `updatesStyleSummary` is set, omits
  it when null.
- **Settings save**: persists an edited `updates_style_summary`.

## Scope boundaries (explicitly NOT in this work)

- **No extraction of real past updates as few-shot examples** (the sub-project B "tenant
  examples" — deferred again). Only a prose style summary is captured.
- **No headless browser** — static/SSR pages only; JS-only pages fall back to manual setup.
- **No Settings re-analysis** — analysis runs at onboarding only; Settings is manual-edit-only.
- No change to the seeded example catalog (B) or the review pass (D).

## Accepted trade-offs

1. **JS-rendered changelog pages won't scrape** — accepted; the `insufficient-content` fallback
   routes those tenants to manual Settings entry. A headless renderer can be added later.
2. **Onboarding analysis overwrites the brand profile** — safe because the profile is
   freshly-defaulted during onboarding; there is no re-analysis path from Settings to clobber
   later manual edits.
3. **DNS-rebinding (TOCTOU) residual in the scraper** — the SSRF guard validates the resolved
   host, but Node's `fetch` resolves DNS again independently, so an attacker controlling their
   domain's DNS could pass the check and connect to a private IP. Accepted for now: the guard
   blocks IP literals, encoded IPs, redirect-to-private, and DNS-resolves-to-private; rebinding
   requires a determined attacker racing DNS against a one-shot onboarding scrape. Full closure
   (IP pinning via a custom undici dispatcher) is tracked as a follow-up hardening task.
