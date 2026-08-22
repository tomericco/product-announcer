# Getting mentioned by AI assistants (AEO/GEO) — tactics research

**Date:** 2026-08-19
**Status:** Research. Not a spec. Feeds a future "AI visibility" spec for Versional.

## Summary

Five tactics recur across the research papers, vendor studies and case studies
on how B2B companies get named by ChatGPT, Claude, Perplexity and Google AI
Mode. One of them (the audit) is the foundation the other four consume; one of
them (owned content) is what Versional already does and only needs a new
signal source and a few content types; two (third-party mentions, community
replies) produce *tasks and pasted text* rather than published pieces and need
a new content-piece shape; the last (entity/technical foundation) is mostly a
one-time audit plus a reusable "entity kit".

| # | Tactic | What moves | Refresh | Fit with Versional |
| --- | --- | --- | --- | --- |
| 1 | AI visibility audit / prompt-set tracking | Nothing directly — it is the measurement and the source of "where to get placed" | run weekly, regenerate prompts monthly | new source agent (`ai_visibility` signals) + dashboard |
| 2 | Earned third-party mentions (listicles, G2/Capterra, PR) | Recommendation rate — most citations are off-domain | targets monthly, re-run weekly, reviews quarterly | new "placement" brief kind → outreach task + drafted asset |
| 3 | LLM-optimized owned content (comparison, FAQ, stats, glossary, refresh) | Citation of the company's own pages; entity facts | prompts monthly, pages every 90–180 days | closest to today's loop: new signal source + content types + GEO drafting rules |
| 4 | Community / UGC (Reddit, LinkedIn, YouTube) | Perplexity/AI Overviews citations; ChatGPT via LinkedIn | discovery daily, platform weights monthly | new "community" source agent + "community reply" piece (human posts) |
| 5 | Entity & technical foundation (grounding page, schema, crawlers, consistency) | Hygiene; unblocks the rest | one-time + weekly light check + quarterly | "AI readiness" panel on the company page; entity kit reused by all drafting |

**Cross-cutting findings that shape the design**

- Engines are different ecosystems: only ~11% of domains are cited by both
  ChatGPT and Perplexity; ChatGPT leans on parametric knowledge and Wikipedia,
  Perplexity on live web, Reddit and G2. Per-engine tracking and per-engine
  weights belong in data, not code.
- 66% of brand recommendations happen without citing the brand's own site —
  owned content alone does not move recommendation rate; it needs tactics 2 and 4.
- Answers are non-deterministic (~73% consistency on repeats) and cited sources
  churn ~80% daily on ChatGPT. Everything must be measured as appearance rate
  over many runs, not snapshots, and shown as 60–90-day trends.
- The Princeton GEO paper: statistics, quotations and citations lift visibility
  30–40%; keyword stuffing does nothing; optimisation is passage-level.
- Widely-quoted schema multipliers (2.8×/2.5×) could not be sourced; the one
  controlled study shows ≈0 lift. llms.txt is not consumed by major engines.
  Treat both as hygiene.

**Case studies used**

- Gumlet (Derivate X): 0 → 20% of inbound revenue from ChatGPT in ~8 months —
  entity pages, listicle placement on pages ChatGPT already cited, full prompt
  re-test every 30 days. https://derivatex.agency/case-studies/gumlet/
- Simaia 7-step playbook with client numbers (50-prompt audit, grounding page,
  question-headed posts, platform-specific distribution, press pickup). Some
  figures unverified. https://simaia.co/resources/7-steps-to-getting-your-b2b-company-into-chatgpt-and-perplexity-answers-(with-real-client-examples)
- Discovered Labs: $25M ARR SaaS 8% → 24% citation rate in 90 days (agency claim).
- Studies: Princeton GEO paper (arXiv 2311.09735); Profound 680M citations;
  Peec/Wix 1.06M citations by content type; Ahrefs freshness (17M citations),
  schema (controlled), llms.txt, brand-mention correlations; Octolens 522M
  Reddit mentions; GetMentions citation volatility; Quoleady LLMO research;
  Vercel/MERJ AI-crawler rendering; Cloudflare crawler traffic.

**Suggested build order** (dependency-driven): 5 (cheap, unblocks) → 1
(everything else consumes its output) → 3 (reuses existing drafting) → 2 and 4
(need the new task-shaped content piece).

---

## Tactic 1 — AI visibility audit & prompt-set tracking ("share of AI voice")

### Inputs / sources needed

**Already in Versional (company context):**
- Identity/category + positioning → the "X" in "best X for…" prompts and the claims to check sentiment against.
- Personas/ICPs → the "for Y-size team / Y role" modifiers.
- Competitors (with URLs) → "X vs Z", "alternatives to Z" prompts and the mention/citation matching list (domains + brand names).
- Topics → informational prompts ("how to do T").

**New inputs (optional):** GSC top queries / seed keywords; the tenant's own domain(s) for cited-source matching.

**LLM access — the run surface (all API, not consumer UI):**
- OpenAI Responses API with `web_search` tool: token cost + $10–50 per 1,000 searches depending on context size ([OpenAI pricing](https://platform.openai.com/docs/pricing/), [ModelCostWatch](https://www.modelcostwatch.com/openai/tool-costs/web-search)). API answers ≠ ChatGPT consumer answers (no memory, different system prompt, search-mode differs); treat as a proxy.
- Perplexity Sonar API: $1/M tokens (Sonar) + $5–12 per 1,000 requests search fee ([Perplexity pricing](https://docs.perplexity.ai/docs/getting-started/pricing)). Closest to consumer Perplexity since both retrieve live web.
- Gemini API with Google Search grounding: 5,000 grounded prompts/month free on Gemini 3.x, then $14/1,000 ([Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)). AI Overviews/AI Mode have no API — proxy only or via a SERP vendor.
- Claude with web search tool (Versional already calls Anthropic directly) — cheap 4th engine plus the classifier/prompt-generator.

**Third-party alternative:** Peec AI ~$95–100/mo starter, Profound Lite ~$399–499/mo, Otterly ~$29/mo ([Acromatico comparison](https://acromatico.com/ai-visibility-tool-pricing-compared), [Surmado](https://www.surmado.com/blog/best-ai-visibility-tools-2026)). None have public per-tenant APIs suited to embedding, so DIY is the fit.

**Cost order of magnitude (DIY):** 40 prompts × 4 engines × 3 samples × 4 runs/month ≈ 1,900 calls/month → roughly $20–60/tenant/month at the above rates; a weekly single-sample run is ~$5–15.

### Refresh interval

- **Re-run results: weekly** (LLM Pulse computes SOV weekly; vendors argue daily minimum, but for a 2–5 person team weekly is the actionable cadence) ([LLM Pulse](https://llmpulse.ai/blog/share-of-voice-ai-search/), [Nightwatch](https://nightwatch.io/blog/ai-share-of-voice/)). Perplexity's recency-weighted reranking shifts fastest; ChatGPT (parametric-heavy) shifts slowest, so weekly captures Perplexity/Gemini movement and monthly-averaged views smooth ChatGPT.
- **Sample each prompt 3× per engine** and report frequency, not binary presence: identical prompts were consistent only ~73% of the time across 10 runs ([WSU study](https://scitechdaily.com/chatgpt-was-asked-the-same-question-10-times-the-answers-kept-changing/)).
- **Regenerate/expand the prompt set: every 30 days** — Gumlet re-tested the full set every 30 days and expanded clusters from what worked ([Derivate X](https://derivatex.agency/case-studies/gumlet/)); also re-generate whenever competitors/personas/positioning change in settings.
- Expect content changes to show in results over 60–90 days ([Nightwatch](https://nightwatch.io/blog/ai-share-of-voice/)) — the dashboard should show trend lines, not week-over-week alarms.

### Processing

1. **Prompt generation (LLM, Claude):** from category, positioning, personas, competitors, topics → 20–50 prompts across intents: category discovery ("best X for Y"), comparison ("A vs B"), alternatives ("alternatives to A"), problem/how-to. Human edits/approves; stored per tenant with intent tag and persona.
2. **Run (deterministic fan-out):** each prompt × engine × N samples, via APIs with search enabled; store raw answer + citation list (URLs, positions).
3. **Extract & classify (LLM, one batched call per run):** for each answer — brands mentioned (self, each competitor, others), rank/order, sentiment/how described (one-line "framing"), cited domains, and whether the tenant's domain was cited. Deterministic post-pass: URL normalisation, domain matching against competitor URLs.
4. **Aggregate:** share of voice = tenant mentions / all tracked-brand mentions, per engine and per intent; citation share; top cited third-party domains (G2, Reddit, review sites, "best X" listicles) — the "where to get placed" list; per-prompt matrix (prompt × engine → who's mentioned).
5. **Gap analysis (LLM):** compare with previous run: prompts where competitors are named and we're absent; prompts we lost; misdescriptions of positioning; new domains cited for competitor-only prompts.
6. **Outputs:** SOV dashboard + trend; prompt × engine table; cited-domain leaderboard; and **signals** (kind `ai_visibility`) into the brief agent — one per material gap/change, with the answer excerpt as evidence.

### Integration into Versional

- **Where it lives:** an "AI visibility" tab under `/company` (next to competitors/personas — it derives from them) for the prompt set (auto-generated, editable, approve/pause per prompt, choose engines) and a status row in source-status like Notion/Webflow. Results dashboard sits with the Signals browser or as its own view; drill from any cell to the raw answer.
- **Trigger:** cron alongside the daily agents but on a weekly schedule; "Run now" button after a competitor/positioning edit or a launch; monthly "refresh prompt set" proposal the human accepts (new prompts appear as suggestions, not silently added). Cost cap per tenant in settings.
- **Feeding the loop:** it is a fourth source agent producing signals such as "For 'best X for startups', ChatGPT names A and B; we're absent 3/3 runs — cited: g2.com, reddit.com/r/…" or "Perplexity describes us as 'legacy'; positioning says 'modern'". The brief agent correlates with existing signals ("competitor B shipped feature; B now cited for prompt P; we shipped the same") and proposes briefs: comparison page "Us vs B", "alternatives to A" page, listicle-placement/outreach task, refresh of an existing post, or a persona-specific landing page. Positioning fit already ranks briefs, so AI-gap signals rank high when the missing prompt matches owned messages.
- **What the user sees:** headline SOV per engine with trend, the prompt matrix, cited-domain list, and briefs in the inbox tagged with the AI-visibility evidence.

### Evidence & case studies

- Gumlet/Derivate X: 17 targeted pages, 30-day full re-test loop, ~20% inbound revenue traced to ChatGPT discovery ([case study](https://derivatex.agency/case-studies/gumlet/)).
- Only ~11% of domains are cited by both ChatGPT and Perplexity (680M-citation dataset; Wikipedia ~48% of ChatGPT top-10 vs Reddit ~47% for Perplexity) — per-engine tracking is mandatory ([HN thread](https://news.ycombinator.com/item?id=47223235), [Leads Now summary](https://leadsnow.ai/chatgpt-vs-perplexity-citation-overlap-per-engine-aeo/)).
- Derivate X benchmark: 44% of B2B SaaS companies invisible to AI-assisted buyers ([press release](https://norfolkdailynews.com/online_features/press_releases/derivatex-44-of-b2b-saas-companies-are-invisible-to-ai-assisted-buyers-benchmark-study-finds/article_d7a96dfb-bba6-5b6a-b67b-0c601d68c95e.html)).
- SOV methodology and cadence: [LLM Pulse](https://llmpulse.ai/blog/share-of-voice-ai-search/), [Alex Birkett](https://alexbirkett.com/ai-share-of-voice/), [HubSpot glossary](https://www.hubspot.com/glossary/ai-share-of-voice).

### Risks / caveats

- **Non-determinism:** ~73% answer consistency on repeats; single-sample runs produce noisy SOV — sample ≥3× and show trends, not deltas.
- **API ≠ consumer UI:** ChatGPT-with-search via API, and Gemini API vs AI Overviews, are proxies; scraping the consumer UIs violates OpenAI's ToS ([OpenAI ToS](https://openai.com/policies/row-terms-of-use/)). Label results as "API-observed".
- **Cost creep:** search tool fees scale with prompts × engines × samples × cadence — enforce a per-tenant cap and prompt limit (~40).
- **Attribution lag:** content changes take 60–90 days to move results; without trend framing users will judge the feature as broken in week two.

---

## Tactic 2 — Earned third-party mentions (listicles, review sites, digital PR)

### Inputs / sources needed

- **Cited-page inventory per category prompt** — the URLs each engine actually cites for the company's "best X / X alternatives / X vs Y" prompts (output of tactic 1). Perplexity's Search/Sonar API returns citations; ChatGPT/AI Mode need a visibility tool or API-with-search runs.
- **Competitor list with URLs** (already in company context) — seed for "alternatives to <competitor>" prompts and for spotting listicles that include competitors but not us.
- **Review-site profiles** — G2, Capterra, TrustRadius, Software Advice, Gartner Peer Insights URLs + last-review dates. G2 has a partner API for reviews; Capterra/Gartner Digital Markets have vendor portals; TrustRadius has an API for customers. Otherwise scrape profile metadata.
- **Brand facts sheet** — one-paragraph description, category, pricing, integrations, founding facts, logos, boilerplate; positioning and voice from settings. Everything a listicle editor or journalist needs to include us without asking. (Same artefact as tactic 5's entity kit.)
- **Outreach targets** — publisher editorial contacts, "submit your tool" forms, HARO/Qwoted/Featured/Connectively-style expert-quote services, PR wire (optional).
- **Owned "trust" pages** — Wikipedia (78.8% of ChatGPT-recommended tools have one, [Quoleady](https://www.quoleady.com/llmo-research/)), Crunchbase, LinkedIn — presence checks only.

### Refresh interval

- **Cited-page list churns fast**: daily source churn 79% ChatGPT, 76% AI Mode, 88% Gemini, 44% Perplexity; only 0.4–11% of sources persist across 7 days; 84% of sources are cited by a single engine ([GetMentions, 530k citations](https://www.getmentions.ai/blog/ai-citation-volatility-study)). Profound's 680M-citation study shows only 11% domain overlap between ChatGPT and Perplexity ([Profound via 5W](https://www.5wpr.com/research/state-of-ai-citations-2026/)). So: re-run prompts **weekly** and rank pages by *appearance rate over many runs*, not single snapshots; refresh the target list monthly.
- **Listicle recency**: 92% of cited listicles carry the current year in the title; recency is "the single biggest lever" ([AIVO](https://www.tryaivo.com/resources/research/chatgpt-listicle-silver-bullet-june-2026)) — so pages that just got refreshed/republished are the priority targets, and placements need re-checking each January.
- **Reviews**: steady flow beats one-time batch; request quarterly and update profile after launches/pricing changes ([AirOps](https://www.airops.com/blog/review-sites-ai-citations)).
- **PR**: monthly cadence of a quotable story (launch, data, POV) is enough; expert-quote services are daily opportunistic.

### Processing

1. **Discover** — run the prompt set on each engine (weekly), collect cited URLs, classify each: listicle / comparison / review site / press-news / forum / competitor-owned.
2. **Score** — appearance rate × engines covered × domain authority × *gap* (competitors on the page, we are not) × reachability (has "submit"/"contact editor", sponsored option, we know the author). Drop competitor-owned pages.
3. **Draft assets (LLM)** — per target: pitch email to the editor with a ready-to-paste blurb in the page's own list format; "why we belong" facts; for review sites: customer review-request email + updated profile copy; for PR: press release / contributed quote answering an open expert request; for owned side: an honest "X alternatives" comparison page (own domain).
4. **Task list** — one task per target with owner, asset, channel, due date; status pitched → accepted → live → verified.
5. **Track** — weekly recheck: is the page live with us on it, does it now surface in citations, did our mention rate on the prompt set move. Feed wins/losses back into scoring; log review counts and last-review date per site.

### Integration into Versional

- **Settings/company profile**: add review-site profile URLs and outreach contacts alongside competitors; the brand facts sheet is a derived, editable view of identity + positioning.
- **Source agent**: the tactic-1 agent emits **signals** — "ChatGPT cited page P for prompt Q; competitors on it, we are not", "G2 profile: no reviews in 90 days", "expert request matching topic T" — as a new kind (`placement_gap`).
- **Briefs**: the daily brief agent clusters those signals into **placement briefs** — a new brief kind whose accept action creates an **outreach task + drafted asset**, not a publish-to-Webflow piece. Simplest fit: a new content type "third-party placement" on the board with statuses pitched → accepted → live → verified instead of draft → scheduled → published; publish target is "external" (copy/email), no channel connector.
- **Owned-content bridge**: some clusters still yield normal pieces (an "alternatives" comparison post, a data story for PR) — those flow through the existing content-piece path, so both branches keep evidence attached.
- **Calendar**: placements and review-request pushes appear as dated items for coverage.

### Evidence & case studies

- Gumlet/Derivate X: 20% of inbound revenue from AI discovery in 8 months, 550+ users reporting ChatGPT as first touch (Aug–Sep 2025), via entity pages + PR/guest placements on AI/SaaS publishers — [derivatex.agency](https://derivatex.agency/results/gumlet-ai-seo-inbound-revenue/)
- 100% of ChatGPT-recommended tools for "alternatives" prompts had Capterra reviews, 99% G2 — but review count correlation with rank is ~0 (−0.16 to −0.21); DR is the strongest signal — [Quoleady](https://www.quoleady.com/llmo-research/)
- G2 22.4% of review-platform citations for software queries; five review sites = 88% of review-platform citations in AI Overviews; 45% of buyers say review-site citations are the most confidence-inspiring — [AirOps](https://www.airops.com/blog/review-sites-ai-citations), [G2/PRNewswire](https://www.prnewswire.com/news-releases/new-g2-research-half-of-b2b-software-buyers-now-start-their-research-with-ai-chatbots-302742807.html)
- ChatGPT cites a listicle 100% of the time on commercial-investigation prompts — [AIVO](https://www.tryaivo.com/resources/research/chatgpt-listicle-silver-bullet-june-2026)
- Branded web mentions correlate 0.66–0.71 with AI visibility across 75k brands; backlinks weak — [Ahrefs](https://ahrefs.com/blog/ai-brand-visibility-correlations/). Simaia/USA Today figures not independently verified.

### Risks / caveats

- **Pay-to-play listicles**: $200–500+ per placement markets exist; openly sold "AI-cited" placements are being clustered for penalty ([Link Building Journal](https://linkbuildingjournal.co.uk/listicle-placements-ai-citation-tactic/)). Prefer earned; flag sponsored as such.
- **Review gating/incentives**: G2/Capterra prohibit selective solicitation and undisclosed incentives; Versional should draft neutral asks, never filter by sentiment.
- **Volatility**: with ~80% daily churn, one placement rarely moves the needle; measure appearance rates over weeks, not snapshots.
- **Spam/outreach fatigue**: LLM-drafted mass pitches burn editor goodwill; cap volume and personalize from the page's own content.

---

## Tactic 3 — LLM-optimized owned content

### Inputs / sources needed

- **Company context (already in Versional):** identity + product names (entity naming), positioning/differentiators (the "why us" claims a comparison page must make), ICPs/personas (drives "best tools for <job>" and FAQ phrasing), competitors with URLs (comparison / alternatives targets), topics (glossary + question universe), voice guidelines.
- **Buyer-intent prompt set:** 50–200 questions a buyer would ask an assistant, seeded three ways: LLM-generated from ICP × topics × competitors ("X vs Y", "alternatives to X", "best <category> for <job>", "what is <term>", "how do I <task>"); GSC queries with question modifiers; optionally Semrush/Ahrefs question keywords. Store per prompt: intent (commercial/informational), target ICP, target competitor. (Shared with tactic 1.)
- **Owned-site inventory:** sitemap + blog crawl → per URL: title, H1/H2s, first-paragraph answer, `dateModified`, word count, which prompts it plausibly answers. This is what makes gap analysis and stale-page detection possible.
- **Product facts & proof points:** feature list, pricing tier facts, integrations, customer counts, benchmarks, named customers/quotes — the GEO paper's lift came from *statistics, quotations and citations*, so these are the raw material, not decoration ([arXiv 2311.09735](https://arxiv.org/abs/2311.09735)).
- **Original data:** anything the company can publish as a stat (usage numbers, survey, benchmark). Optional but the strongest citation magnet.

### Refresh interval

- **Prompt set:** regenerate monthly (competitor list or positioning change triggers immediate regen); it is cheap and the question universe drifts with news.
- **Existing pages:** review at 90 days, refresh anything older than 6 months in the category. Evidence: Ahrefs' 17M-citation study found AI-cited URLs 25.7% fresher than Google organic (ChatGPT 33% fresher) ([ahrefs.com](https://ahrefs.com/blog/do-ai-assistants-prefer-to-cite-fresh-content)); AirOps' 4,000-page tracking: 35.2% of cited pages updated in last 3 months, 53.4% within 6 ([writesonic summary](https://writesonic.com/blog/how-content-freshness-affects-ai-citations)); Position Digital's B2B SaaS study: median cited page 3.9 months old, 69.7% published within 12 months ([position.digital](https://www.position.digital/blog/chatgpt-ranking-factors/)); the "~3x for <30-day pages" figure is GrowByData-via-vendor blogs, weaker sourcing ([apiserpent](https://apiserpent.com/blog/freshness-wins-chatgpt-citation-study)). Refresh means real content change + `dateModified`, not a date bump.
- **Own-site re-crawl:** weekly (or on publish webhook) — cheap, keeps the inventory current.

### Processing

1. **Inventory** — crawl site, extract per-page answer/heading/date; embed pages.
2. **Gap analysis** — for each prompt: (a) does an owned page answer it (embedding + LLM judge)? (b) does a tracked competitor have a page for it (competitor watch already fetches their sites)? (c) optionally, who does ChatGPT/Perplexity actually cite for it (tactic 1's output). Emit gap signals: *no owned page*, *owned page stale (>180 d)*, *competitor has it, we don't*, *owned page exists but not answer-first*.
3. **Page-type selection** — rule table on intent: commercial + competitor named → comparison/alternatives; commercial + category → "best tools for <ICP job>" listicle (must name 5–10 tools incl. competitors — pages naming 6+ brands averaged 2.13 citations vs 1.21 for none, position.digital above); informational "what is" → glossary/definition; informational "how" → how-to; cluster of related questions → FAQ page; any proof point/original data → stats post.
4. **LLM drafting with GEO rules** (system prompt built from company context): direct answer in first 2 sentences; question-form H2s, each section self-contained (optimization is passage-level per the GEO paper); ≥3 concrete numbers with linked sources; one quotation; entity-consistent naming (exact product name, category phrase from positioning); FAQ block at end (with FAQPage schema); visible "Updated <date>"; no keyword stuffing.
5. **Refresh-stale-page job** — for pages older than threshold or whose prompts changed: fetch current page, propose delta (new stats, updated competitor facts from competitor signals, new shipped-work signals), produce a redline draft.
6. **Output** — briefs (kind: `ai-search-gap`), drafts with GEO structure, and refresh recommendations ranked by prompt intent × gap severity.

### Integration into Versional

- **New source agent, "AI-search demand"** — same fetch → extract → tier-1 → tier-2 → signal contract. Fetch = own-site crawl + prompt set; signals like "Prompt 'X vs Y': competitor page exists, no owned page" or "Page /glossary/foo last updated 14 months ago; 3 prompts depend on it." Reuses competitor-watch fetches for competitor page detection.
- **Brief agent** — new brief kinds / content types: comparison page, alternatives page, FAQ page, glossary entry, "best tools" listicle, stats post, page refresh. Evidence = the gap signal + related shipped-work/competitor signals.
- **Settings** — site URL for inventory (can default from onboarding URL); prompt set (auto-generated, editable, "regenerate" button); refresh threshold (default 180 days); GEO drafting rules toggles (answer-first, question H2s, FAQ block, cite-sources-required, freshness stamp); proof-points/stats library (company profile section).
- **Drafting** — the content-type template injects the GEO rules automatically, so the user just sees a well-structured draft; a "GEO checklist" panel shows which rules the draft meets.
- **What the user sees** — a "Coverage" view: prompts × (owned page / competitor page / stale) grid; briefs in the normal daily brief flow; refresh cards on existing pieces.

### Evidence & case studies

- Princeton/Georgia Tech GEO paper (KDD 2024): stats, quotes, citations lift visibility up to ~40%; keyword stuffing does not — [arxiv.org/abs/2311.09735](https://arxiv.org/abs/2311.09735).
- Wix/Peec, 75k answers, 1.06M citations: listicles are the #1 cited type on ChatGPT (22.6%), AI Mode (21.9%), Perplexity (21.9%); Perplexity elevates discussions to 17.4% — [wix.com AI Search Lab](https://www.wix.com/studio/ai-search-lab/research/content-types-most-cited-by-llms).
- Position Digital B2B SaaS, 278 answers/3,508 citations: listicles 18.8%, product pages 18.6%, docs 12.5%; 66% of brand recommendations occur without citing the brand's own site — [position.digital](https://www.position.digital/blog/chatgpt-ranking-factors/).
- Ahrefs 17M citations: AI-cited content 25.7% fresher than Google organic — [ahrefs.com](https://ahrefs.com/blog/do-ai-assistants-prefer-to-cite-fresh-content).
- Agency claims (weaker): $25M ARR SaaS 8% → 24% citation rate in 90 days ([discoveredlabs](https://discoveredlabs.com/blog/case-study-how-a-b2b-saas-used-a-geo-agency-to-3x-citation-rates-in-90-days)); Simaia client 24x YoY AI-bot visits ([press release](https://www.barchart.com/story/news/1210800/simaia-launches-ai-search-on-autopilot-to-help-apac-b2b-companies-and-startups-capture-llm-traffic-and-convert-leads)). The "90 question-headed posts → 3.5x" figure could not be verified.

### Risks / caveats

- **Comparison/alternatives pages are cited <3% of the time** across verticals in the Wix data — they matter for the *recommendation* (brand co-occurrence, entity facts) more than for direct citation. Listicles naming competitors carry more weight.
- **Thin programmatic pages** (100 "X vs Y" stubs) risk Google helpful-content/scaled-content-abuse actions and dilute crawl budget; cap volume, require proof points per page.
- **Cannibalization** with existing SEO pages — gap analysis must map prompts to existing URLs first and prefer refresh over new page.
- **Being cited ≠ being recommended** — 66% of recommendations don't cite the brand site; this tactic must pair with tactics 2 and 4.

---

## Tactic 4 — Community / UGC / social presence (Reddit, LinkedIn, YouTube)

### Inputs / sources needed

- **Category prompt set + citation audit output** (tactic 1): the URLs each engine actually cites for the tenant's category prompts, tagged by domain (reddit.com, quora.com, youtube.com, linkedin.com, niche forums). This is the seed list of "threads AI already trusts."
- **Reddit access.** Free Data API tier is 100 QPM OAuth, but since Nov 2025 it needs pre-approval under the Responsible Builder Policy; commercial pricing is negotiated (~$0.24/1K calls, ~$12K/mo floor reported) — [Prowlo](https://prowlo.com/blog/reddit-api-pricing), [Octolens](https://octolens.com/blog/reddit-api-pricing). Practical v1: web search restricted to `site:reddit.com` / `site:quora.com` plus fetching public `.json` thread pages, not the paid API.
- **Subreddit / community list** derived from ICP + topics + competitors (agent proposes, human confirms — same pattern as competitors). Octolens found 67% of B2B tool recommendations happen in dedicated subreddits ([study](https://octolens.com/reddit-b2b-saas-study)).
- **Company context** already in Versional: identity, positioning, personas, competitor names (for "alternative to X" threads — up 230% YoY, avg 47 comments, same study), voice.
- **Poster identity**: which team member's Reddit/LinkedIn account answers, and their disclosure line.
- **LinkedIn publishing** (exists). **YouTube channel** (optional; transcripts are what gets cited).
- **Owned content library** (published blog posts / product updates) as raw material for repurposing.

### Refresh interval

- **Thread discovery: at least daily, ideally every few hours** for high-value subreddits — 73% of engagement happens in the first 6 hours and replies within 2 hours get 4.7x engagement, yet threads stay active 18+ months ([Octolens](https://octolens.com/reddit-b2b-saas-study)). So: fast pass for new threads, slow pass (weekly) for evergreen threads AI already cites.
- **Platform weighting: re-check monthly, it moves fast.** Reddit's cross-LLM share halved Oct 2025→Jan 2026 (2.02%→1.01%, [Conductor](https://www.conductor.com/academy/reddit-ai-citation-decline/)); YouTube's share of social citations went 18.9%→39.2% while Reddit fell 44.2%→20.3% ([Digital Applied / Adweek](https://www.digitalapplied.com/blog/youtube-overtakes-reddit-ai-citations-study)); LinkedIn's rank on ChatGPT moved ~11th→~5th in four months ([MediaPost/Profound](https://www.mediapost.com/publications/article/415662/ai-finding-its-citation-hierarchy-across-applicati.html)); and a reported ChatGPT-search Reddit drop of ~86% around 14 Aug 2026 ([explainx](https://explainx.ai/blog/reddit-citations-chatgpt-search-drop-august-2026) — single source, unverified). Yet Perplexity still drew 24% of citations from Reddit in Jan 2026 ([ZipTie](https://ziptie.dev/blog/why-reddit-dominates-chatgpt-perplexity-and-google-ai-overviews/)). Per-engine weights belong in data, not code.
- **LinkedIn cadence**: 2–3 long-form posts/week from a named person; **Reddit**: 9:1 non-branded to branded, 4–6 weeks of authority-building before any brand mention, 6–12 weeks to see citation signals ([Simaia](https://simaia.co/resources/5-best-reddit-content-tactics-that-help-b2b-brands-get-cited-in-google-ai-overviews-in-2026)).

### Processing

1. **Discover** threads three ways: (a) URLs from the citation audit; (b) search on prompt-set phrasing / topics ("what do you use for X", "best X for Y", "X vs Y"); (c) competitor-name and "alternative to <competitor>" queries.
2. **Tier-1 filter** (deterministic): allowed communities, thread age/lock status, comment count, not already answered by the team, no duplicate.
3. **Tier-2 relevance** (one batched LLM call): score against personas/positioning; classify intent (buying / comparison / how-to); flag "AI already cites this" vs "ranks / likely to be cited".
4. **Draft** an answer in the chosen persona's voice: direct opening → concrete use case → honest trade-offs, disclosure line, brand mention only when it answers the question (or none — 9:1). Helpful replies average 89 upvotes vs 11 for promotional; disclosed affiliation gets 2.4x more upvotes ([Octolens](https://octolens.com/reddit-b2b-saas-study)).
5. **Human posts** — copy/paste; the agent never touches Reddit/Quora. Human marks "posted" with the comment URL.
6. **Track**: on subsequent audit runs, check whether that thread/comment appears in citations or the brand mention rate for the prompt moved.
7. **Repurpose** (LinkedIn/YouTube): take a published blog/product update → LinkedIn long-form in the persona's voice (published via existing integration); optionally a YouTube script/description with a transcript-friendly structure.
- **Output**: a *reply opportunities* queue (thread, why it matters, intent, cited-by, draft, deadline) plus repurposed social pieces.

### Integration into Versional

- **New source agent — "Community"**: emits `community thread` signals (URL, platform, community, intent, cited-by-engines, freshness). Same five-step contract; the citation-audit list is one of its inputs.
- **Brief kind — "Reply opportunity"** clustering signals for the same question; accepting yields a **community reply** content piece (new type; publish = mark as posted + paste comment URL, no destination). Repurposing briefs yield the existing **social post** type (LinkedIn destination).
- **User configures** in Company: communities to watch (agent-proposed), poster persona per platform, disclosure text, banned claims/competitor-bashing rules, brand-mention ratio. In Settings: LinkedIn (exists), optional Reddit account label.
- **Board/calendar**: reply opportunities appear with a short TTL (hours, not weeks) and a "cited by ChatGPT/Perplexity" badge; expire automatically; posted replies show on the calendar as done, and later citation hits annotate them.

### Evidence & case studies

- Octolens 522M-mention study: 23% of B2B threads show buying intent; Reddit threads 4.7x likelier than blog posts to appear in AI answers; "Reddit" in 34% of ChatGPT B2B tool answers — https://octolens.com/reddit-b2b-saas-study
- Perplexity: 24% of citations from Reddit (Jan 2026); AI Overviews include Reddit in ~49% of cases — https://ziptie.dev/blog/why-reddit-dominates-chatgpt-perplexity-and-google-ai-overviews/
- Reddit share across LLMs halved Oct 2025→Jan 2026 (238K prompts) — https://www.conductor.com/academy/reddit-ai-citation-decline/
- YouTube overtook Reddit as top social citation source (39.2% vs 20.3%) — https://www.digitalapplied.com/blog/youtube-overtakes-reddit-ai-citations-study
- LinkedIn treated by ChatGPT as a credible reference; rank ~11th→~5th in four months (Profound) — https://www.mediapost.com/publications/article/415662/ai-finding-its-citation-hierarchy-across-applicati.html
- Simaia's Reddit workflow (9:1 rule, 4–6 week warm-up, 6–12 weeks to signal) — https://simaia.co/resources/5-best-reddit-content-tactics-that-help-b2b-brands-get-cited-in-google-ai-overviews-in-2026

### Risks / caveats

- **Bans / anti-spam**: undisclosed or repetitive brand replies get accounts and domains banned subreddit-wide; hence human-only posting, named accounts, 9:1 ratio, disclosure by default.
- **Astroturfing / FTC**: undisclosed employee endorsements are a legal and brand risk; make disclosure non-optional in the draft template.
- **Reddit ToS / API**: scraping at scale or automated posting violates terms; commercial API is expensive and needs approval — design v1 around search + human posting.
- **Volatility**: citation weights swing 50–100% within months; don't hard-code "Reddit first" — surface per-engine weights from the audit and let the brief agent rank by them.

---

## Tactic 5 — Entity & technical foundation

### Inputs / sources needed

- **Already in Versional:** website URL, identity (one-liner, product names, category), positioning, personas, competitors, voice. These are the *canonical* against which everything else is checked.
- **New inputs:** list of external profile URLs (LinkedIn company page, G2, Capterra, Crunchbase, GitHub org, Product Hunt, Wikidata QID / Wikipedia if any). Onboarding agent can propose these by searching `"<company name>" site:linkedin.com/company` etc.; human confirms.
- **Site access (read-only, unauthenticated):** fetch `robots.txt`, `llms.txt`, `sitemap.xml`; fetch homepage/about/product/blog with a non-JS client and compare text to a headless-rendered version (SSR check); parse JSON-LD blocks for `Organization`, `Product/SoftwareApplication`, `FAQPage`, `Article`, `Person`/`sameAs`.
- **Webflow:** already integrated for publishing. Webflow Data API supports pages, custom code (site/page-level scripts) and CMS items, so JSON-LD injection into a page's `<head>` and creating a grounding page / FAQ page as CMS items is feasible. Serving `/llms.txt` needs a redirect or a static page at that path — Webflow can't serve arbitrary root files natively. Flag as "guided task", not one-click.

### Refresh interval

- **One-time setup** (kit generation, schema, robots) plus **weekly lightweight audit** (robots.txt still allows the AI crawlers, JSON-LD still present on key pages, external descriptions unchanged) and **quarterly full re-audit**.
- Justification for re-audits: the crawler list churns — Cloudflare's 2025 review shows PerplexityBot +157,490% requests, GPTBot share 2.2%→7.7%, user-triggered bots +15x in a year, and new agents/bots appear monthly — https://blog.cloudflare.com/radar-2025-year-in-review/ , https://www.searchenginejournal.com/ai-crawler-user-agents-list/558130/ .
- Description drift is human-caused (someone edits the LinkedIn tagline), so a monthly diff of external profiles against the canonical one-liner is enough.

### Processing

1. **Own-site audit (deterministic, no LLM):** robots.txt rules per UA (GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-SearchBot, PerplexityBot, Perplexity-User, Google-Extended, Applebot-Extended, Bytespider); SSR check = text length/main-copy diff between raw HTML and rendered DOM on 5 key pages; JSON-LD inventory per page; existence of `/llms.txt`, an about/"what is X" page containing a one-sentence definition; author bios with `Person` + `sameAs`.
2. **External profile audit (LLM):** fetch each profile, extract name/tagline/description/category, score semantic and literal consistency against the canonical identity; flag category mismatches (the case-study failure mode below).
3. **Generate the entity kit (LLM, from company context):** boilerplate in 25/50/100 words; grounding-page copy (definition → problems solved → proof points → who it's for → FAQ); FAQ (8–12 Q&As drawn from positioning + personas); JSON-LD for `Organization` (with `sameAs` array of confirmed profiles), `SoftwareApplication`, `FAQPage`; `llms.txt` listing key pages with one-line summaries.
4. **Output:** checklist with pass/warn/fail + score; generated assets; a task list ("update G2 description to: …", "add Organization JSON-LD to homepage", "allow PerplexityBot in robots.txt") ranked by evidence weight (crawler access & SSR > entity consistency > schema > llms.txt).

### Integration into Versional

- **"AI readiness" panel** on the company page: score + checklist, re-run button, last-audit date. Lives beside the identity fields because it audits them.
- **Entity kit stored in company context** — boilerplate/name variants become the source of truth every drafting agent uses, so product names and the one-liner never drift across LinkedIn posts, blog posts and Webflow pages. (Also the "brand facts sheet" tactic 2 needs.)
- **Grounding page, FAQ page and llms.txt as content pieces** — created from the kit, edited like any draft, published via Webflow; JSON-LD attached to the piece as metadata.
- **Regression signals** — the weekly audit writes a signal ("robots.txt now blocks ClaudeBot", "Crunchbase category changed", "homepage lost Organization schema") that flows into the daily brief like any other signal, so it lands in the existing human gate rather than a separate inbox.

### Evidence & case studies

- Vercel/MERJ: none of the major AI crawlers execute JS; 500M+ GPTBot fetches, zero evidence of rendering; ClaudeBot downloads JS in ~24% of requests but never runs it — https://vercel.com/blog/the-rise-of-the-ai-crawler
- Cloudflare: training crawling ~80% of AI-bot traffic; crawl-to-refer ratios Anthropic ~50,000:1, OpenAI 887:1, Perplexity 118:1 — https://blog.cloudflare.com/ai-crawler-traffic-by-purpose-and-industry/
- Ahrefs controlled study, 1,885 pages adding JSON-LD vs 4,000 controls: AI Overviews −4.6%, AI Mode +2.4%, ChatGPT +2.2% (≈ zero) — https://ahrefs.com/blog/schema-ai-citations/ . Correlational studies (Trakkr: FAQPage the only type independently correlated) — https://trakkr.ai/trakkr-research/anatomy-of-an-ai-citation
- Ahrefs llms.txt: 28% of 137K domains publish one; 97% got zero fetches in May 2026; AI retrieval bots = 1.1% of AI-bot requests — https://ahrefs.com/blog/llmstxt-study/ ; Mueller: no AI system uses it — https://www.seroundtable.com/google-ai-llms-txt-39607.html
- Entity-consistency case: B2B company with good content invisible in ChatGPT category queries because Wikidata had no entry, no Organization schema, and Crunchbase listed a different category than the homepage — https://www.data-mania.com/blog/ai-business-context-strategic-visibility-llms/ ; Wikipedia ≈ 7.8% of all ChatGPT citations — https://upgrowth.in/entity-authority-ai-citation-2026/

### Risks / caveats

- **Schema multipliers are overstated.** The "2.8x / 2.5x / 2.4x" figures could not be traced to a source; the one controlled study shows ~no lift. Google states no special structured data is needed for AI features — https://developers.google.com/search/docs/appearance/ai-features . Position schema as hygiene, not a growth lever.
- **llms.txt is not consumed by major engines.** Cheap to ship, but the score should weight it low and the UI should say so.
- **Crawler allowance is a business decision.** Allowing GPTBot/ClaudeBot for training yields ~zero referrals; allowing the *search/user* bots (OAI-SearchBot, ChatGPT-User, Perplexity-User) is what earns citations. Google-Extended only affects Gemini training/grounding, not Search or AI Overviews. Recommend allowing search/user agents, let the user decide on training bots.
- **Webflow can't natively serve `/llms.txt`**; treat as guided task with a redirect workaround.

---

## Open decisions for a spec

1. **Build vs buy the audit engine (tactic 1).** DIY via OpenAI/Perplexity/Gemini/Claude APIs at ~$20–60/tenant/month, or a vendor (Peec/Profound) with no embeddable per-tenant API. Research favours DIY.
2. **A task-shaped content piece.** Tactics 2 and 4 end in "human pastes/emails this" rather than "publish to Webflow/LinkedIn". Either a new content type with a pitched → live → verified lifecycle, or a separate tasks surface on the board.
3. **Where the prompt set lives.** Tactics 1, 3 and 4 all consume the same buyer-intent prompt set; it should be one object under `/company`, generated from positioning × personas × competitors × topics, human-edited, regenerated monthly.
4. **Which engines to run against.** ChatGPT-via-API is a proxy for consumer ChatGPT; AI Overviews has no API at all. Decide whether "API-observed" is good enough for v1.
