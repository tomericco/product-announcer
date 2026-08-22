# Tactic 1 — AI visibility: UX research on existing tools

**Date:** 2026-08-19 · **Role:** UX research · **Feeds:** the AI-visibility spec (prompt set + weekly run + `ai_visibility` signals).
Companion to `../2026-08-19-ai-mentions-tactics.md` (Tactic 1). Sources are public reviews, docs and pricing pages; vendor UIs were not hands-on tested.

## 1. Landscape

| Tool | For | Prompt setup | Engines | Core views | Cadence | Price |
| --- | --- | --- | --- | --- | --- | --- |
| [Peec AI](https://geoptie.com/blog/peec-ai-review) | SMB/agency marketers | Domain → auto brand profile → suggested prompts, accept/reject; manual add; tags | pick 3 of 7 (ChatGPT, AIO, AI Mode, Perplexity, Gemini, Copilot, Grok); Claude enterprise-only | Visibility %, position, sentiment, sources (URL level), competitor ranking | daily | $95 / 50 prompts; $245 / 150 |
| [Profound](https://generatemore.ai/blog/my-profound-ai-search-visibility-review-for-saas-/-tech) | Enterprise | Auto-generated from topics; upload; pull from "Prompt Volumes" (400M real conversations) | ~10 incl. ChatGPT, Perplexity, AIO | Answer Engine Insights (SOV, sentiment, citations, personas, topics), Conversation Explorer, Agent Analytics (crawler logs) | daily | $99 starter (100 prompts) → $399 → custom |
| [Otterly.ai](https://help.otterly.ai/search-prompt-monitoring) | Small teams | Manual or "AI Prompt Research"; labels; column picker | ChatGPT, AIO, Perplexity, Copilot; Gemini/AI Mode/Claude add-ons | Per-prompt table (coverage %, sentiment, mentions, citations, intent volume); prompt detail → per-response, per-engine | daily | $29 / 15 prompts; $189 / 100 |
| [Semrush AI Visibility Toolkit](https://www.semrush.com/kb/1496-getting-started-with-ai-visibility-toolkit) | SEO teams already on Semrush | Enter domain → score instantly (their 126M-prompt index); then track own prompts (25 on base) | ChatGPT, AI Mode, AIO, Gemini, Perplexity | Visibility Overview (0–100 score), Brand Performance (sentiment, attributes), Competitor Research, Prompt Research (volume/intent), AI site audit | daily tracking; index monthly | $99/mo add-on per domain |
| [Ahrefs Brand Radar](https://ahrefs.com/blog/brand-radar-methodology/) | SEO teams | No user prompts: derived from real search queries (PAA + semantic fan-out), millions/month | ChatGPT, Perplexity, Gemini, Copilot, AIO, AI Mode | Mentions, SOV, sentiment, cited sources, "estimated impressions", 90-day window | monthly refresh (AIO continuous) | in Ahrefs plans |
| [Scrunch](https://www.rankability.com/blog/scrunch-ai-review/) | Mid-market B2B | Generated per **persona × journey stage**; roll up into categories | ChatGPT, Claude, Gemini, Perplexity (+4 higher tier) | Dashboard by persona/region/topic/stage; "why you're missing" gap insights; Knowledge Hub | daily | $300 / 350 prompts / 3 personas |
| [Goodie](https://dageno.ai/blog/goodie-ai-review) | Brands wanting monitor+write | Topics → prompts; Topic Explorer | ChatGPT, Perplexity, Gemini, Claude, DeepSeek | Monitoring, Optimization Hub (recs), AEO Content Writer, crawler analytics | daily | $399/mo; higher tiers demo |
| [AthenaHQ](https://www.airops.com/blog/athenahq-alternatives) | Agencies/mid-market | Prompts + credits per response | 8 engines | Visibility, Action Center (on/off-page recs, "content to snipe") | credit-based runs | credit-based, ~$300+ |
| [Nightwatch](https://echowi.ai/blog/nightwatch-review/) | SEO rank-tracker users | Prompts alongside keywords | ChatGPT, Claude, Gemini, Perplexity + AIO | Prompt tracking next to rankings; ~30 answers/prompt/month | roughly weekly per engine | €79–399 |
| [Rankscale](https://rankscale.ai/pricing) | Solo/pilot | Prompts; credits (0.25/engine/prompt) | 5+ | Visibility Score, avg position by topic/engine, citation analysis | per credit | $20 / 480 responses; $99 / 4,800 |
| [Evertune](https://trakkr.ai/reviews/evertune-review) | Fortune 500 | No user prompts: thousands of category prompts, each sampled 100× | 9 | AI Brand Index (single score: frequency + rank) | continuous | ~$800+/mo, demo-led |

Two camps: **user-defined prompt sets, run daily** (Peec, Otterly, Scrunch, Profound, Goodie) vs **vendor-owned massive prompt panels you search into** (Ahrefs, Evertune, Semrush's index). Versional's fit is the first camp, with the second camp's lesson — a number on day one before any setup.

## 2. Prompt management patterns

- **Generation is table stakes.** Every self-serve tool does domain → brand profile → suggested prompts → accept/reject ([Peec](https://radarkit.ai/blog/peec-ai-review/), Otterly's 4-step AI-assisted setup, Profound "transforms your topics into a normalized series of prompts"). Profound's fully automated flow is criticised for *no* manual control; Semrush the other way — type prompts in, capped at 25, score methodology opaque.
- **Grouping.** Tags/labels (Peec, Otterly), topics/categories (Scrunch, Rankscale, Profound "prompt clusters"), **persona × journey stage** (Scrunch; but reviewers say default prompts weren't actually tagged by persona and there is no persona view — a tagging model that the UI doesn't honour is worse than none). Intent tags (discovery / comparison / alternatives / how-to) are mostly implicit in vendor copy, rarely first-class filters.
- **Volume limits** are the product: 15 / 25 / 50 / 100 / 350 prompts per tier, or credits per response (Rankscale, AthenaHQ — users "burn through credits faster than expected", can't forecast spend). Engine choice is also gated ("pick 3 of 7", Claude enterprise-only). Pausing a prompt frees a slot; nobody does soft "archive with history kept" well.
- **Complaints:** no historical backfill ("tracking begins the day you activate"); crowded tables once prompts × engines × competitors grow (Otterly, Scrunch "cramped, lacks infinite scroll"); prompt ideas untied to what people actually ask (Ahrefs' whole pitch is "real queries, not fabricated prompts"); beginners "take time to get comfortable with prompts".

**Recommendation for Versional (near-zero setup):** no prompt UI in onboarding at all. The company profile already has category, positioning, personas, competitors, topics — generate ~30 prompts from it, show them as a *reviewable list* (intent + persona chips, competitor named where relevant), with paused/active toggles and an "add prompt" inline field. Cap at ~40 active, with the cap stated next to the list and a plain-language cost line. Monthly "refresh suggestions" arrive as proposals (the brief-inbox pattern), never silently. Regenerate when competitors/personas change — show a banner "3 competitor changes since prompts were generated → regenerate?".

## 3. Results display patterns

- **Headline:** one visibility %/score + delta vs previous period + line chart, with competitor lines overlaid ([Peec](https://blog.stateshift.com/peec-ai-review/): visibility %, industry ranking table with domain, avg position, sentiment, 7-day visibility; Semrush: 0–100 score). Reviewers like it when "you can tell what's happening in under a minute"; they distrust single scores with hidden methodology (Semrush, Peec).
- **Per-engine:** usually a filter/tab, sometimes small multiples. Since engines barely overlap (11% of domains), per-engine must be one click, not a drop-down.
- **Prompt table:** the workhorse — prompt, coverage %, position, sentiment, competitors present, engines (icons), trend sparkline; customisable columns (Otterly). Clicking a row → per-engine, per-response list, the raw answer with mentions highlighted, and cited URLs tagged own/competitor/third-party (Peec's URL-level view was "the most useful part" to a reviewer).
- **Sources/citations:** domain leaderboard with type (UGC/editorial/docs/competitor), citation frequency, "you vs them" — this is the view that produces tasks.
- **Sentiment/attributes:** "how the brand is described" — useful for positioning drift, noisy at small samples.
- **Clutter**: Semrush is "broad, layered"; Profound has seven reports; reviewers' real weekly routine is: glance at dashboard (<1 min) → prompts that moved → competitor movement → new sources.

**Recommended v1 hierarchy:** (1) Overview strip: SOV per engine (4 tiles with sparkline + 4-week delta, competitors in a tooltip), sources top-5; (2) Prompt list with intent/persona chips, per-engine dots (present / absent / partial over last N samples), competitors named, sparkline; (3) Prompt detail: per-engine cards, appearance rate over runs, competitor ranks, cited domains; (4) Raw answer view: the actual text of each sample, brand/competitor mentions highlighted, citations listed, "API-observed · model · date" stamp. No score invented by us; show the ratio and what it's over.

## 4. Noise & trust

- Most tools **don't** talk about variance in-product; help docs hedge ("ChatGPT gives different answers to the same question", Otterly). Critics compute it for them: ~30 samples/prompt/month → ±33–44 pt confidence on a single prompt ([EchoWi on Nightwatch](https://echowi.ai/blog/nightwatch-review/)); Evertune sells 100× sampling as the differentiator.
- **API vs UI** is a live fight: Peec markets UI-collected "real data", Profound argues both ways, independent writeups find only ~4% source overlap between ChatGPT API and web UI and ask vendors to disclose per-channel method, model version, run frequency, detection logic, and to let users see raw answers ([metehan.ai](https://metehan.ai/articles/how-ai-visibility-tools-collect-data/), [Superlines](https://www.superlines.io/articles/api-vs-ui-data-ai-visibility-tools)).
- **Freshness/cost:** daily runs are marketed; nobody shows cost to the user except credit balances, which users hate for unpredictability.
- **First run:** Semrush/Ahrefs give an instant number from their index; prompt-set tools show empty charts until the first run completes and "no history before signup" is a recurring complaint.

**For Versional:** label everything "API-observed" with engine/model; show appearance rate "2 of 3 samples" rather than a boolean; default time grain weekly with 4-week moving view and a note "content changes show in 60–90 days"; run the first audit during onboarding review so the company page has numbers within ~10 minutes; show a monthly cost estimate next to the prompt cap, not credits.

## 5. From insight to action

- Monitoring tools stop at analytics (Peec "monitoring, not optimization"; Rankscale "expects you to act through your own processes"; AthenaHQ "stops at analytics rather than fixing the gaps"). Where recommendations exist they are generic ("Expand your business line" — Semrush; Profound Opportunities "No recommendations found"; AthenaHQ outreach "not worth your time"). Goodie/AirOps bolt on a writer/refresh workflow; Scrunch's "why you're missing" insights get the best marks because they explain, not just count.
- Weakness pattern: recommendations are page-level SEO checklists, detached from the team's calendar, evidence and voice; nothing tracks whether the action closed the gap.

**Versional's advantage:** gaps become *signals with evidence* and the brief agent joins them with competitor and shipped-work signals ("B cited for 'best X for startups' 3/3; B shipped Y last week; we shipped Y in March" → comparison page brief). Each brief carries the prompt, engines, raw-answer excerpt and cited domains; once published, the prompt's next runs show the evidence trail on the content piece ("tracked prompts: 3 · visibility since publish"). Placement/outreach gaps ("get on this G2 list") need the task-shaped piece from Tactic 2.

## 6. Integration into Versional

- **Home:** a tab on the company page (`/company/ai-visibility`) — it is derived from competitors/personas/topics, so it belongs next to them; overview strip + prompt list + run status. Not its own nav item in v1 (the board/calendar stay the home). Settings holds only the engine toggles, cost cap, schedule.
- **Runs:** reuse the source-status row (last run, next run, samples, engines, failures) plus "Run now" after positioning/competitor edits or a launch. A visible "prompts generated from: 5 competitors, 3 personas, 12 topics — 2 changed since" link.
- **Prompt ↔ profile:** each prompt shows its competitor/persona chips; editing a competitor prompts regeneration of that competitor's prompts only.
- **Into the loop:** `ai_visibility` signals appear in the signals browser (filter by engine, prompt, competitor); briefs in the inbox carry an "AI visibility" evidence chip and the answer excerpt in the evidence popover; accepted pieces on the board/calendar show which prompts they target, and the prompt detail links back to the piece.
- **Weekly journey (content marketer, Monday):** open inbox → 2 AI-gap briefs among the usual → open evidence: "Perplexity names A, B; cited g2.com, reddit" → accept "Us vs B" brief → board; later glance at the company tab: 4 tiles, one prompt turned green since the post went live; monthly: "12 new prompt suggestions" proposal → accept 6, pause 2 stale ones.

## 7. Open UX questions

1. Is the overview on the company tab enough, or do SOV tiles also belong on the board home once users care?
2. How many samples/engines to show by default before it reads as clutter — 4 engines × 3 samples per prompt row?
3. Should prompt suggestions be accepted one-by-one (Peec) or as a batch with exclusions?
4. Do we show competitor SOV lines by default (motivating) or on demand (noisy with 5+ competitors)?
5. How do we render "this prompt is now covered by piece X" without implying causation?
6. Where does a paused prompt's history live; can it be resurrected?
7. Cost: plain "~$X/month at current settings" vs hiding it entirely for the first tier?
