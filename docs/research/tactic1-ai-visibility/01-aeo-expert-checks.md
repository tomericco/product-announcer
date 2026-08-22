# AEO expert view — checks, metrics, prompts, engines, signals

**Date:** 2026-08-19 · **Status:** input to the Tactic 1 spec · Parent: `docs/research/2026-08-19-ai-mentions-tactics.md`.

No industry-standard formula exists — Semrush, HubSpot and Profound each compute differently ([TurboAudit](https://turboaudit.ai/ai-share-of-voice)); define ours precisely and show definitions in the UI.

## 1. What to measure per answer

One row per `(prompt, engine, sample)`. **D** = deterministic code; **J** = one batched Claude judge call per run (answer + brand/competitor/positioning context → strict JSON, every label with an evidence quote).

| Check | Definition | How | Good for |
| --- | --- | --- | --- |
| Brand mentioned | Tenant named in answer text (not only inside a URL) | D alias regex; J confirms generic-name hits | Mention rate, SOV |
| Position / rank | Ordinal of tenant among all brands named, by first appearance | J ordered brand list → D rank ([Peec](https://docs.peec.ai/metrics-overview), [Semrush](https://www.semrush.com/kb/1594-ai-seo-metrics)) | Avg position, visibility score |
| Mention count | Distinct mentions of tenant | D | Prominence |
| Competitors mentioned | Same for tracked competitors + untracked brands the judge finds | D tracked, J others | SOV denominator, competitor signals, new-competitor suggestions |
| Recommended vs mentioned | `mentioned` → `described` (given attributes) → `recommended` (explicit pick / "best for…" / top of list). Recommendation rate = recommended ÷ n ([Visiblie](https://www.visiblie.com/blog/ai-visibility-metrics)) | J + quote | Separates "present" from "chosen" |
| Sentiment / framing | pos / neu / neg / mixed + one-line framing ("hedged", "legacy") | J + quote | Misdescription, tone trend |
| Attributes associated | Closed taxonomy (price, ease, enterprise, integrations, security, support, persona fit…) | J multi-label | Why competitors win; which claims land |
| Positioning claims | Each owned message: present / contradicted / absent | J vs positioning doc | Misdescription signals, brief ranking |
| Hallucinations | Claims about tenant conflicting with company facts (pricing, features, status) | J, quote + fact | Correction content |
| Own domain cited | Cited URL eTLD+1 ∈ tenant domains (resolve Gemini redirect URIs first) | D | Citation rate |
| Cited URLs/domains | Ordered list + class (own / competitor / review / community / publisher / docs / wiki) | D + lookup table | Cited-domain leaderboard |
| Named-not-cited / cited-not-named | Cross of the two above; they diverge ([LLM Pulse](https://llmpulse.ai/blog/share-of-voice-ai-search/)) | D | Entity problem vs content problem |
| Answer type | list / comparison / single-pick / how-to / explainer / refusal-or-no-search | J | Cuts; bad-prompt detection |
| Search used + queries | Engine searched (`web_search_call`, `server_tool_use`, grounding queries) and what it queried | D | Parametric vs retrieved; free prompt candidates |

## 2. Aggregate metrics

Per engine, over the last run or a rolling 4-run window; `n` = answers in the cut.

- **Mention rate** = answers naming tenant ÷ n (Peec "Visibility", Otterly "Brand Coverage", Ahrefs "Mentions" — [Ahrefs](https://www.customerimpact.be/en/blog/ahrefs-brand-radar/)).
- **Share of voice** = tenant mentions ÷ mentions of all tracked brands × 100, one mention per brand per answer ([LLM Pulse](https://llmpulse.ai/blog/share-of-voice-ai-search/), [Peec](https://docs.peec.ai/metrics-overview)). Variants: answer-level (answers naming tenant ÷ answers naming any tracked brand); position-weighted and topic-volume-weighted (Semrush, [blog](https://www.semrush.com/blog/how-to-measure-ai-share-of-voice/)); impression-weighted by Google volume (Ahrefs). v1: plain; state that adding a competitor lowers everyone.
- **Recommendation rate** = recommended ÷ n.
- **Citation rate** = answers citing own domain ÷ n. **Citation share** = own citations ÷ all citations ([AuthorityTech](https://authoritytech.io/glossary/share-of-citation)).
- **Average position** = mean rank when mentioned, shown with "of N brands".
- **Visibility score** = LLM Pulse `Σ(100/position) / n` ([LLM Pulse](https://llmpulse.ai/blog/share-of-voice-ai-search/)); Semrush's 0–100 benchmarks vs selected competitors. Reciprocal-rank only; no invented composite.
- **Sentiment** = pos/neu/neg split among mentions (Semrush style; Peec uses 0–100 — the split keeps the quotes visible).
- **Cited-domain leaderboard** = domains by answers citing them, with class and prompts.
- **Cuts**: engine always; intent, persona, competitor, locale; competitor benchmark = every metric for every tracked brand.

**v1** (4 numbers + 2 tables): mention rate, SOV, citation rate, recommendation rate — per engine, 4-run trend, `n`; prompt × engine matrix (who is named, framing); cited-domain leaderboard. These have unambiguous §6 triggers and map to content actions.
**v2**: average position / RR score, sentiment split, attribute heatmap, positioning coverage, citation share, intent/persona cuts, benchmark table, answer-type mix.

## 3. Prompt-set design

Intents (one per prompt): **discovery** "best {category} for {persona}"; **comparison** "{us} vs {comp}" and "{compA} vs {compB}" (we are absent — do we get added?); **alternatives** "alternatives to {comp} for {persona}"; **how-to** from topics; **brand check** "what is {us}", "{us} pricing" (hallucination/positioning only, excluded from SOV); **pricing/buying** "cheapest {category} for startups".

Templates fill from category (+synonyms), personas (role + size), competitors, topics, positioning; Claude generates, human approves. **30–40 prompts** for a 2–5 person team (vendors say 30–100, agencies 50–100 — [LLM Pulse](https://llmpulse.ai/blog/share-of-voice-ai-search/), [LLM Reach](https://www.llmreach.ai/blog/enterprise-ai-visibility-tracking)); split ≈ 12 discovery / 8 comparison / 6 alternatives / 6 how-to / 4 brand / 4 pricing.

Tags: `intent`, `persona`, `competitor`, `locale`, `branded`, `source (generated|user|gsc)`, `status (active|paused|proposed)`, `cluster` (template).

Bad prompt (flag on creation): refusal/no-search or zero brands on every engine; tenant name in an unbranded prompt; keyword-ese instead of a question ([Backlinko](https://backlinko.com/llm-prompt-tracking)); identical brand lists to another prompt on 3 runs; >25 words or multi-question.

Cluster expansion (monthly, all as `proposed`): vary persona/modifier/locale on templates where competitors are named and we are not; engine-issued search queries; titles of top cited listicles. Never auto-activate (Gumlet 30-day loop, parent research).

## 4. Engines and run mechanics

| Engine | Call | Returns | Determinism / locale | Cost | Label |
| --- | --- | --- | --- | --- | --- |
| ChatGPT | Responses API `tools:[{type:"web_search"}]`, gpt-5.x, `search_context_size`, `filters.allowed_domains` ([docs](https://developers.openai.com/api/docs/guides/tools-web-search)) | `web_search_call` (queries) + `url_citation {start_index,end_index,url,title}` + `sources` superset | `temperature` on non-reasoning models, no seed guarantee; `user_location {country,city,region,timezone}` | $10/1k searches + tokens ([pricing](https://developers.openai.com/api/docs/pricing)) | "GPT-5.x API + web search", not consumer ChatGPT (no memory, different system prompt/search stack) |
| Perplexity | Sonar/Sonar Pro chat completions; `search_context_size`, `search_domain_filter`, `search_recency_filter` ([ref](https://docs.perplexity.ai/api-reference/chat-completions-post)) | `search_results[] {url,title,date,snippet}`; inline `[n]` | `temperature` 0–2, live retrieval; `web_search_options.user_location {country,region,city}` | $1/M tok + $5–14/1k requests ([pricing](https://docs.perplexity.ai/docs/getting-started/pricing)) | Closest to consumer (same retrieval); still "Sonar API" |
| Gemini | `google_search` grounding, Gemini 3.x ([docs](https://ai.google.dev/gemini-api/docs/google-search)) | search queries, grounding chunks (redirect URIs — resolve), segment supports; suggestion HTML has display rules | `temperature`; no documented geo param — set language in prompt, note gap | 5k free/mo then $14/1k queries, billed per executed query ([CloudZero](https://www.cloudzero.com/blog/gemini-pricing/)) | "Gemini API grounded" — not AI Overviews |
| Claude | `web_search_20250305` tool with `max_uses`, domain filters, `user_location` ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)) | `server_tool_use` query, `web_search_result {url,title,page_age}`, `citations {url,title,cited_text}` | `temperature`; `user_location {type:"approximate",city,region,country,timezone}`; Batches API ok | $10/1k searches + tokens | "Claude API + web search" |
| Google AIO / AI Mode | No API. SERP vendor: DataForSEO `load_async_ai_overview` (+$0.0006/kw), AI Mode ≈$1.20/1k ([DataForSEO](https://dataforseo.com/apis/serp-api/pricing)); SerpApi from $25/1k. Or skip in v1 and say so. Never scrape. | AIO text blocks + references (url,title,position) | Presence varies by query/location; vendor `location_code` | per request | "AI Overview via vendor, location X" |

Run mechanics: neutral fixed system prompt, default temperature (we want the natural distribution), `search_context_size: medium`, `user_location` = tenant HQ or locale tag, store raw JSON + model id + tool version. **3 samples per prompt × engine × run** — nearly every repeat changes the brand list ([AuthorityTech](https://authoritytech.io/blog/ai-visibility-score-accuracy-measurement-reality-2026)); 3 is the floor at which 0/3 ↔ 3/3 means anything, and 40 × 4 × 3 ≈ 480 calls/run fits the budget. **Weekly**, displayed on a rolling 4-run window (≈12 samples); content effects take 60–90 days. Brand-check prompts 1×.

## 5. Quality controls

- Show `n` everywhere; hide per-prompt metrics below n≥3 and aggregates below n≥30. Citation distributions are power-law with large run-to-run variance; many vendor deltas are inside the noise ([Sielinski, arXiv 2603.08924](https://arxiv.org/abs/2603.08924)).
- Wilson interval on every rate (band on trends, "±x pp" on headlines); bootstrap SOV over answers when n<100.
- Rolling 4-run window default; single-run view behind a "noisy" toggle.
- Change → signal only if: prompt×engine mention moves between bands {0/3, ≥2/3} and holds **two consecutive runs**; engine SOV moves ≥10 pp window-over-window; competitor enters top-3 on ≥3 prompts it was absent from; own-domain citations 0 for two runs. Smaller = trend.
- Record model/tool version per answer; on model change, annotate trends and suppress change-signals for that run.
- Brand matching: alias table (product/old names, abbreviations, domain), word boundaries, J confirmation for generic-word brands ("Front", "Loom"), substring traps ("Hub"/"HubSpot"), eTLD+1 after resolving redirectors (Vertex, Bing), never count mentions inside URLs or the echoed prompt.
- Judge QA: D and J must agree on "mentioned" or row is flagged; monthly 20-row human spot check.
- Errors / no-search answers stored but excluded from rates, shown as coverage gaps.

## 6. Signals for the brief agent (kind `ai_visibility`, with excerpt + URLs + prompt/engine/window)

| Type | Trigger | Content action |
| --- | --- | --- |
| `gap_vs_competitor` | Non-brand prompt: competitor ≥2/3, tenant 0/3, 2 runs | Comparison / "best X for persona" page; placement on cited domains |
| `lost_mention` | ≥2/3 → 0/3, 2 runs | Refresh previously cited page; crawl check; re-pitch listicle |
| `gained_mention` | Reverse | Identify moved URL, replicate across cluster |
| `competitor_gained` | Competitor <1/3 → ≥2/3 on ≥3 prompts | Correlate with competitor change events; counter-positioning piece |
| `new_cited_domain` | Enters top-10 or cited on ≥3 prompts where we are absent | Placement/outreach task |
| `own_page_cited` | First own-URL citation on a prompt | Reinforce: links, refresh, add stats/FAQ |
| `misdescription` | Claim contradicted or fact hallucinated, ≥2 samples | Grounding page / FAQ / schema fix quoting the wrong claim |
| `negative_framing` | Negative sentiment ≥2 samples | Address the attribute (pricing page, case study) |
| `attribute_gap` | Competitor owns an attribute in our positioning on ≥3 prompts | Attribute-led piece |
| `recommended_not_cited` | Recommended ≥2/3, own domain never cited | Publish the page the engine wants (comparison/pricing/FAQ) |
| `prompt_candidate` | New engine query / listicle title | Propose prompt |

## 7. Anti-patterns for v1

- One composite 0–100 score without inputs; week-over-week deltas as headline; single-sample runs; rates with n<3.
- Scraping consumer UIs (ToS, irreproducible) — APIs only, labelled honestly.
- Daily runs, >40 prompts, >6 competitors per tenant.
- Sentiment as a dial; judge labels without quotes; LLM-only "mentioned" without deterministic cross-check.
- Prompt/topic volume estimates (unsourceable for us); AI-referral traffic attribution (separate feature).
- Auto-activating generated prompts or auto-publishing from signals — everything is a proposal.
