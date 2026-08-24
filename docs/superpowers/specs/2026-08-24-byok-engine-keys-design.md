# Bring Your Own Keys — Design

**Date:** 2026-08-24
**Status:** Approved (hard gate confirmed — no vendor-key fallback)
**Amends:** `2026-08-19-ai-visibility-design.md` ("Engines", "Cost & cap")

## Summary

AI-visibility engine calls move from our API keys to the tenant's own. Hard
gate: no free tier, no fallback to our keys, no first-run subsidy. A tenant
with no verified key for an engine does not sample that engine; a tenant with
no verified keys at all cannot run.

The keys live in **AI-visibility settings**, in the same card as the engine
they unlock — not on the Integrations page, and not split across two pages.
One row per engine, carrying the key and its enable state together.

## Why now

A run is ~$6.20 and weekly cadence is ~$27/month per tenant, paid by us. That
scales linearly with tenants and is the single largest variable cost in the
product.

## Research basis

Four parallel surveys of published documentation (2026-08-24), covering ~40
products across marketing/GTM SaaS, automation platforms, AI assistants,
LLM-ops tooling, and general B2B SaaS. Findings that decided this design are
cited inline. Where the survey found no convention, that is stated too — those
are the places we are setting the bar rather than following one.

---

## Decision 1 — the keys live in AI-visibility settings

**5 of 5 products that actually ship LLM BYOK attach the credential to the AI
feature. 0 of 5 put it on a general Integrations page.** GitHub Copilot
(*Copilot › Models › Custom models*), Salesforce (*AI Models › Generative*),
Vercel (*AI Gateway › BYOK*), Cloudflare (*AI Gateway › Provider Keys*),
OpenRouter (*Workspace › BYOK*).

This reverses the placement proposed in the first design pass, which argued
for Integrations on the strength of our own `webflow-token-form` precedent.
That precedent is real but it is about *shape*, not *placement*: Webflow
connects an external system many features could draw on, and an LLM key is an
input parameter to one feature's behaviour.

The rule the evidence supports, which we adopt:

> A credential belongs on the general Integrations surface when it connects an
> external **system** that multiple features may draw on. It belongs in feature
> settings when it is an input parameter to **one feature's** behaviour.

Supabase demonstrates it cleanly — SMTP credentials under Auth, S3 credentials
under Storage, extensions under Integrations, and its Integrations page holds
no secrets at all. Zendesk demonstrates the cost of not deciding: two parallel
credential stores, both masking, no stated rule.

**The sharper predictor, found across eight devtool vendors: OAuth connections
go on a central integrations page; pasted secrets end up on the consuming
feature's own settings screen.** PostHog shows it cleanly — GitHub, Linear and
Jira connect by OAuth from the central integrations page, while GitLab, the one
integration needing a pasted `api`-scoped token, lives on the error-tracking
settings screen instead. Vercel shows the same split between Integrations and
Connect. Nobody names this as a rule; all of them follow it. Our engine keys
are pasted secrets, which puts them on the feature screen twice over.

**The honest counter-example: Datadog.** It takes customer OpenAI and Anthropic
API keys on the *integration tile* — and those keys are then consumed by LLM
Observability, a different product surface. It is the closest thing to a BYOK
feature in that survey and it went the other way. Two things make it weak
support for copying: Datadog's tile *is* the feature surface for that
integration, and the cross-surface dependency (key entered under Integrations,
burned by LLM Observability) is one their docs never explain — the same
unnarrated split we are trying to avoid. Recorded rather than dismissed.

### Dissent recorded, and the trigger to revisit

A fourth survey — 15 automation and LLM-ops platforms — counts it differently:
**12 of 15 put credentials in a dedicated top-level area in the main left nav
(Credentials / Connections / Providers), and 0 of 15 put them inside the
feature only.** That is a real count against this decision and it should not be
buried.

Why we are not following it: in every one of those 12, credentials are **shared
infrastructure** — one n8n credential serves any number of nodes across any
number of workflows; one Zapier connection serves many Zaps. A top-level store
is right when the credential outlives and out-scopes its consumer. We have
three keys, one consuming feature, and no reuse. Note also that 3 of those 12
are reached through a generic Settings parent anyway (Langfuse's *Project
Settings › LLM Connections*, AirOps' *Settings › API Providers*), which is the
shape we are adopting.

**The strongest argument against us is Retool's direction of travel.** It moved
*away* from a single `Settings › Retool AI` toggle toward first-class resource
objects, and published the reason: *"finer-grained control: multiple API keys
per provider, granular permissions, environment-specific configurations, and
cleaner auditability."* Portkey moved the same way, from Virtual Keys to a
Model Catalog. Both moved toward more structure, never less.

**Revisit trigger:** the moment a *second* feature needs an LLM provider key —
if the judge, prompt generation, or a future feature moves to customer keys —
this decision inverts and the keys should be promoted to their own surface. The
rule in Decision 1 predicts that: at that point the credential stops being one
feature's input and becomes a shared system connection.

### Naming

The card is titled **"AI engines"**, not "Credentials", "API keys" or "BYOK".
Of the 18 products surveyed with a dedicated credential screen, the
provider-named variants — Dify's "Model Provider", Braintrust's "AI
providers", AirOps' "API Providers" — are the only ones that name something a
marketer recognises. "Credentials" and "BYOK" are engineer vocabulary.

## Decision 2 — the key and its engine toggle are one control

`ai_visibility_settings.engines` currently holds which engines are on, and the
toggles live in `settings/ai-visibility-form.tsx`. Under BYOK, "is ChatGPT part
of my measurement?" and "do we have a working ChatGPT key?" are the same
question. Two controls for one decision is a contradiction waiting to be
rendered.

So the engine switches move into the AI-engines card, one per row, beside the
key they depend on. There is no second place to enable an engine.

Survey support: five products co-locate key and toggle in the same row
(Raycast, Open WebUI, Dify, Cursor, TypingMind). The two that separate anything
— JetBrains, VS Code Copilot — separate *credential* from *model routing*, not
credential from per-engine on/off. **No product in the survey ships the split
we were considering.**

The one structural idea worth taking from VS Code: *the toggle only exists over
engines a verified key already produced*. A keyless row renders no switch at
all, so the contradictory state is unreachable rather than merely discouraged.

### What stays in AI-visibility settings

Cadence, day of week, samples per prompt, monthly budget. These are per-use
parameters, and Langfuse draws exactly this boundary: provider options "are
**not** set up in the LLM Connections page but either when selecting a
connection on the Playground or during evaluator setup." The credential holds
identity and auth; the call site holds parameters.

## Decision 3 — verify before store, and the save button is the verify button

Vercel's wording is the model: *"Click **Test Key** to validate and add your
credentials."* There is no "save without checking" path, because a key that was
never exercised is a key that will fail during a scheduled sweep at 09:00 UTC
with nobody watching.

Two calls per verification:

1. A **free auth probe** (`GET /v1/models`, `GET /v1beta/models`) — catches
   typos and revoked keys instantly, costs nothing.
2. **One real grounded call**, the same shape a run makes — catches the failure
   the probe cannot see: a valid key on an account with no credit.

The second call costs ~$0.25 (OpenAI), ~$0.07 (Gemini), ~$0.09 (Anthropic),
once, on the tenant's own key, quoted in the UI before it happens. That is
acceptable against a $6.20 run, and its alternative is discovering the problem
84 calls into a paid run.

Precedent: Langfuse fires a real completion (`"How are you?"`) before writing
the record, `maxRetries: 1`, surfacing the provider's own error with fallback
copy *"Could not verify the API key."* n8n tests on save — *"When you save a
credential, n8n tests it to confirm it works."* Dify validates before making
the provider available.

**Never re-verified on a timer.** A recurring paid call the user did not ask
for is exactly what BYOK exists to stop. Re-verification happens on an explicit
Re-check, and implicitly on every run.

## Decision 4 — four failure states, never three

The survey found products conflating these, and one that gets it right.
LibreChat ships four distinct strings: no key / invalid / expired-at-timestamp
/ insufficient funds. Dify conflates two in a single remediation line — *"check
that your API key has not expired and has sufficient quota"* — which tells a
marketer to check two things and fix neither.

Our states, with the sentence shape borrowed from Zed (*"Invalid API Key. The
API key for Anthropic is invalid or has expired. Update your key via the Agent
Panel settings to continue."* — names the provider, the cause, the next action,
and the exact screen):

| State | Cause | Copy |
| --- | --- | --- |
| `invalid_key` | 401/403 | "ChatGPT rejected this key. Check you copied the whole thing, and that it's a secret key (starts `sk-`) rather than an organization ID." |
| `quota_exceeded` | 429 `insufficient_quota`, billing not enabled | "That key is valid, but the OpenAI account behind it has no credit. Add a payment method at platform.openai.com/settings/billing and top up about $10, then paste the key again." |
| `rate_limited` | 429 rate/TPM | "OpenAI is rate-limiting this key — the account is on a new-account tier with low throughput. See 'Rate limits' below." |
| `provider_unavailable` | 5xx, timeout, unreachable | "Couldn't reach OpenAI just now. This is usually temporary — try Re-check in a few minutes." |

A fifth state exists and must not be collapsed into `invalid_key`: **we could
not read the stored key** (decryption failure). Zed shipped this bug — its
"invalid or has expired" banner also fires when the OS keychain fails to return
a perfectly good key, and users were told to replace a key that was fine.

## Decision 5 — enable/disable and remove are both kept

Not redundant, and the distinction is irreversibility rather than behaviour.
OpenAI, Google and Anthropic all show a secret exactly once, so Remove is not
undoable by the person who did it, while off is one click. A team pausing
ChatGPT for a month — it is 3.7× Gemini per call — must not have to mint a new
key to come back.

Copy that makes the difference legible: **"Saved, not in use"** for off, versus
a Remove dialog that says plainly that nobody can show you this key again.

Raycast states the consequence in the row: *"Disabled keys won't be used for
any AI request."*

## Decision 6 — a persistent status column, not only a save-time check

The failure that actually happens is not a bad paste. It is a key that dies
three weeks later — rotated, revoked, out of credit, or expired.

Cloudflare is the only surveyed product that shows this properly: configured
keys by provider, **when each was last used**, and **the status of each key
(active, expired, invalid)**. We copy it.

Two hazards specific to our engines make this non-optional:

- **Anthropic keys can be created with an expiry** — presets of 3 hours, 1 day,
  7 days, 30 days, or Never. A customer pastes a 30-day key and the feature
  silently dies a month later. Anthropic emails *the key's creator*, not us.
- **GitHub secret scanning** forwards leaked `sk-ant-` and OpenAI keys to the
  vendors, who revoke them. A customer key can be killed with no warning.

When a run hits an auth failure, the engine is forced off, the row goes to
`Key rejected`, and the reason names the run date. This is Langfuse's
auto-pause pattern — the only product in the survey that closes this loop —
with reason codes `LLM_CONNECTION_AUTH_INVALID`,
`LLM_CONNECTION_BILLING_EXHAUSTED`, `LLM_CONNECTION_MISSING`,
`LLM_CONNECTION_ENDPOINT_UNREACHABLE`, each carrying a human sentence, a deep
link, and a Reactivate button.

## Decision 7 — no fallback to our keys, and the sweep must not fail silently

Hard gate, per the product decision. `effectiveEngines = settings.engines ∩
{engines with a verified key}`, with **no fallback-to-all when empty** —
deliberately unlike `normalizeSettingsRow`, which substitutes all three engines
for an empty list. Empty means empty.

This feeds `planRun`, `capExceeded`, `runNowAction`, the tiles, the trend chart
and the monthly estimate. A tenant with `engines: [openai, gemini, anthropic]`
and one Gemini key runs Gemini, is quoted Gemini's price, and sees one tile.

**The migration state is every existing tenant.** `DEFAULT_AI_VISIBILITY_SETTINGS.engines`
is all three, so on ship day every tenant has three engines on and zero keys.
We do not silently rewrite their rows; `effectiveEngines` resolves it.

Because there is no fallback, the failure mode is a scheduled sweep that stops
producing data. That is what Decision 6's status column exists to catch, and it
is why we deliberately reject Vercel's pattern — Vercel silently falls back to
its own credentials when a BYOK key fails **and bills the customer for it**,
with no documented opt-out.

## Decision 8 — admin-only, workspace-scoped

4 of 5 BYOK products are workspace/org-scoped, and admin-only wherever
documented. Only GitHub ships a personal tier, as a separate mechanism with
different storage and an admin policy to switch it off. We do not build a
personal tier.

The uncomfortable precedent: **AirOps — same audience, same product shape
(content workflows plus an AI-visibility product) — gives its Brand Manager
role, the marketer, zero access to Secrets & API keys.** Admin and Developer
only. It also excludes BYOK from Playbooks, its most packaged surface.

We adopt owner-only for write, masked state visible to all members. This is a
deliberate acceptance that BYOK is an admin feature, not a discovery of one.

## Decision 9 — concurrency must become per-tenant, and 12 is not safe

**This is the finding most likely to cause a bad launch.**

`AI_VISIBILITY_CONCURRENCY` defaults to 12 in both `sweep.ts:45` and
`actions.ts:41`. Our keys sit on a mature tier. A customer's brand-new paid
account does not.

| Provider | New-paid-account reality |
| --- | --- |
| OpenAI Tier 1 ($5 paid) | 500 RPM uniform, but **TPM varies ~17× by model** — `gpt-4o` is **30,000 TPM** |
| Anthropic Start | 1,000 RPM / 2M ITPM — **but new orgs may start in an undisclosed "Evaluation tier" below every published limit**, plus acceleration limits on sharp usage increases, plus a **$500/month spend cap** |
| Gemini Tier 1 | Per-model RPM/TPM **no longer published** (Google removed the table; the figures circulating are user-reported and staff declined to confirm them). A hard **$10 per rolling 10-minute window** spend cap applies regardless of throughput |

RPM is comfortable — 12 concurrent calls at 10–30s each is roughly 24–72 RPM,
well under every published ceiling. **TPM is the binding constraint**, and the
arithmetic is unforgiving: 30,000 TPM ÷ 12 concurrent = **2,500 tokens per
request including output**. An AI-visibility prompt plus its answer exceeds
that. A Tier 1 `gpt-4o` tenant 429s on the first sweep. This is invisible to us
because our own account sits several tiers up.

Required changes:

1. Per-tenant configurable concurrency with a conservative default (start at 3).
2. Do not default BYOK tenants to `gpt-4o` — at Tier 1 it has 16× less headroom
   than `gpt-5-mini` (30,000 vs 500,000 TPM) for the same 12 requests.
3. Honour `retry-after`; ramp rather than burst (Anthropic explicitly warns a
   nominal 60 RPM "might be enforced as 1 request per second").
4. Treat 429 as a first-class UI state that names the tier as the cause — with
   a hard gate and no fallback, the customer's 429 is our outage.
5. State any tier floor in the UI *before* they paste. Clay requires OpenAI
   Tier 2 (≥450,000 TPM) and Anthropic Tier 4 for its AI features and surfaces
   this as a documented prerequisite; a marketer cannot diagnose a usage tier.

### This contradicts the retry classification we shipped on 2026-08-24

`isRetryableStatus` in `engines/shape.ts` treats **all** 429s as retryable, and
`MAX_SAMPLE_ATTEMPTS = 3` with backoff `[30s, 60s]` retries them. That is right
for a throughput 429 and wrong for a **spend-cap 429**, which will never
succeed within the window:

- **Anthropic's spend-cap 429 carries no `retry-after`** and is identified by
  `error.details.error_code === "enforced_spend_limit_reached"`. Retrying it
  burns three attempts and 90 seconds of budget to fail identically.
- **Gemini's `$10 / 10-minute` cap** returns `429 RESOURCE_EXHAUSTED` and needs
  a wait longer than our whole backoff ladder.

So 429 must split into two classifications: `rate_limited` (retryable, honour
`retry-after`) and `quota_exceeded` (terminal for this run, flips the key row
to a status the tenant can act on). Without that split, a tenant who hits their
spend cap sees a run that silently retries itself to death.

## Decision 10 — security bar

### The live bug this must fix first

`ai-visibility/page.tsx:363` interpolates `engineHealth.lastError` into the UI,
and that string is `` `openai ${status}: ${body.slice(0, 300)}` `` from
`openai.ts:160`. The same raw string is stored in `ai_visibility_samples.error`
and `sources.lastError`.

An OpenAI 401 body contains:

```json
{"error": {"message": "Incorrect API key provided: sk-Eyftb****************************99vW. You can find your API key at https://platform.openai.com/account/api-keys.", "type": "invalid_request_error", "code": "invalid_api_key"}}
```

**It echoes the submitted key's prefix and its last 4 characters.** The
organization variant echoes the tenant identifier: `"No such organization: org-XXXXXXXX"`.

Today that is our key in our tenant's browser. Under BYOK it is a customer
secret fragment rendered to whoever opens the page — not necessarily the person
who owns the key — and written unencrypted to two tables.

This shape of bug is CVE-grade: **CVE-2025-0330**, LiteLLM leaking Langfuse API
keys through an error path, **CVSS 7.5 HIGH**. CWE-209 names the case
precisely: externally-generated messages whose contents are "not under direct
control by the programmer."

**Fix regardless of whether BYOK ships.** Map provider errors to a closed set of
codes at the client boundary; store and render only the code plus a request id.
OpenRouter is the precedent — it normalises upstream errors into typed codes
and, on 500, replaces the message with a generic string. LiteLLM relays
provider messages through, and is the one with the CVE.

Also: never log raw provider response headers — `anthropic-organization-id`
lives there.

### Storage

`src/lib/credentials/encryption.ts` already provides AES-256-GCM with a 32-byte
`CREDENTIALS_ENCRYPTION_KEY` and per-record IV + auth tag, and is already used
for `webflowConnections`. Reuse it; do not invent a second scheme.

Checklist, drawn from the strongest published commitments found (Supabase Vault,
Cloudflare Secrets Store, Doppler):

1. AES-256-GCM, named publicly. ✅ already have it.
2. Key material outside the database holding the ciphertext. Supabase's *"the
   encryption key is never stored in the database alongside the encrypted
   data"* is the bar. ✅ env var today; KMS is the upgrade path.
3. **Write-once. No read-back path — not in the UI, not in our API, not in an
   admin tool.** This is the decision that puts us with Cloudflare Secrets
   Store (*"can no longer be decrypted or accessed via API or on the
   dashboard"*) rather than with Vercel's default env vars, which are *"visible
   to any user that has access to the project."*
   Note Helicone ships an eye-toggle that fully decrypts and reveals a stored
   key in the browser. We do not.

   Two implementations worth copying wholesale. **Vercel's Sensitive
   Environment Variables**: values *"non-readable once created"*, stored *"in
   an unreadable format"*, the current value hidden on edit, a "Sensitive" tag
   in the list, and `[REDACTED]` substituted in build logs. **Segment's
   `type: 'password'` field flag**, which drives masking in the UI, redaction
   through the public API, and exclusion from config-as-code sync from one
   declaration — the strongest cross-surface consistency claim found in any
   survey. One flag, three surfaces, no way to forget one.
4. Show only: provider, last 4, status, last verified, last used, who added it,
   when. **No surveyed product displays key-lifecycle metadata** — shipping
   provenance puts us ahead of all of them, and a 3-person team genuinely needs
   to know which colleague pasted the key. Braintrust comes closest with a
   masked `abc...xyz` preview plus last-updated and the user who changed it.
5. **Scrub before logging, not just before rendering.** Redact `sk-*`,
   `sk-ant-*`, `AIza*` and `org-*` patterns on the way into the logger and
   Sentry. The UI is the symptom; the log is the durable copy.
6. Ciphertext must survive into backups and replication as ciphertext.
7. **Audit-log** add / replace / delete / enable / disable with actor and
   timestamp. No surveyed product documents this for an LLM credential.

### Compliance

BYOK shifts data-handling to the customer's own provider agreement. Vercel
publishes the clearest language and it is the template:

> "BYOK keys operate under your own agreements and permissions with providers,
> which can differ from the ZDR agreements Vercel has negotiated."
> "You take responsibility for any BYOK key you mark as ZDR. Vercel has no
> visibility into your agreements with providers."

We state the equivalent in our docs. Caveat from the research: this is
docs-level language, not a contract clause — no SOC 2 report or DPA was found
that scopes BYOK out of a vendor's obligations.

---

## The UI

One card, `id="ai-engines"`, in AI-visibility settings, above the cadence and
budget controls. All three engines always rendered, so the empty state explains
itself.

### Not connected

```
ChatGPT                                    [Badge outline] Not connected
About $0.25 per run at your current prompt set, billed by OpenAI to your key
[ Input type=password  placeholder="sk-proj-…" ]   [Button outline] Connect
▸ How to get an OpenAI key
```

No switch is rendered — there is nothing to enable.

### Connected

```
[Switch]  ChatGPT                                [ConnectedIndicator] Verified
sk-proj-…7f4A · added 24 Aug by Tomer · checked 24 Aug · last used 24 Aug
                                          [Re-check]            [Remove]
```

### Getting-a-key help

An inline `<details>` per provider. The step that matters most is the one
almost nobody documents — Zapier is the only surveyed product that warns about
it:

> 1. Go to platform.openai.com/api-keys and sign in. **This is a different
>    account from ChatGPT.**
> 2. Add a payment method under Billing and top up about $10. **A new key with
>    a $0 balance passes every check and then fails every call** — this step is
>    not optional.
> 3. Click **Create new secret key**, name it "Versional".
> 4. Copy it and paste it above. OpenAI shows it once.
>
> Not your job? [Copy these steps] and send them to whoever owns your OpenAI
> account.

**The delegation affordance is the primary flow, not a nicety.** 0 of 12
marketing products support delegating key entry, and the realistic path for a
3-person marketing team is forwarding instructions to an engineer. HubSpot
comes closest by naming the provider-side role required (*"a user with the role
of **owner** in your OpenAI account"*), which is a delegation prompt in
disguise.

### Wrong-provider paste guard

Client-side, no API call: `sk-ant-` in the ChatGPT field, `AIza` in either →
*"That looks like an Anthropic key. Paste it in the Claude row instead."*
Trim whitespace and newlines — people paste with a trailing newline.

---

## Data

`ai_visibility_engine_keys`, unique on `(tenantId, engine)`:

| Column | Notes |
| --- | --- |
| `tenantId`, `engine` | |
| `keyCiphertext`, `keyIv`, `keyAuthTag` | same shape as `webflowConnections` |
| `last4` | display only |
| `status` | `verified` / `invalid_key` / `quota_exceeded` / `rate_limited` / `provider_unavailable` / `unreadable` |
| `enabled` | off ≠ removed |
| `verifiedAt`, `lastUsedAt`, `lastFailureCode`, `lastFailureAt` | |
| `createdAt`, `createdByUserId` | provenance — the industry blank |

`askOpenAI`/`askGemini`/`askAnthropic` take the key as an argument instead of
reading `process.env`. Env keys remain for local development only.

---

## Cost framing

The cap does not stop being useful; it stops being ours. It changes from "we
stop spending our money" to "we stop spending yours", which makes it *more*
valuable — providers give you no per-project stop-loss.

- Cap label → **"Monthly engine budget"**. Help text: *"We stop running when
  estimated engine spend reaches this. The engines bill your own keys directly
  — these are our estimates, and your provider's invoice is the record."*
- **BYOK does not remove our whole cost, only the engine share.** The judge and
  prompt generation still run on our Anthropic key. Copy must not claim
  otherwise: *"Reading and scoring the answers runs on Versional's own AI and is
  included in your plan. Only the engine calls hit your keys."*
- `CAP_PAUSED_PREFIX` "Paused — monthly cap reached" → "Paused — monthly engine
  budget reached". `isCapPausedError` string-matches this prefix and
  `clearCapPauseIfResolved` depends on it: change the constant, not the call
  sites, and note that stored `sources.lastError` strings on existing rows will
  not match the new prefix until the next run.

---

## Deliberately not doing

- **No free first run.** Product decision; revisit as a promotion.
- **No vendor-key fallback.** The evidence leans against this and the doc
  should say so plainly: **9 of 15 platforms offer a vendor-key path, and all 6
  that hard-gate are developer tools whose users already hold provider
  accounts.** The two products closest to our audience both keep a vendor
  default and make BYOK the opt-in — Zapier ships GPT-4.1 mini and lets you
  upgrade with a key; Retool defaults to "Retool Managed". Glide, the most
  non-technical product surveyed, has no BYOK at all. Decided anyway, on cost.
  If it needs softening later, the shape to copy is OpenRouter's per-provider
  opt-in with the consequence written into the label: *"Always use for this
  provider… may result in rate limit errors if your keys are exhausted, but
  ensures all requests go through your account."*
- **No multiple keys per provider**, no load-balancing pools, no
  prioritized/fallback ordering (Dify, OpenRouter). One key per engine.
- **No base URL, custom model names, adapters or extra headers.** Every field
  added is a field a marketer can get wrong. Cursor's Base URL field sitting
  beside the key is the survey's worst pattern for this audience.
- **No personal-scope keys.**
- **No slugs or aliases** (Portkey's `@openai-prod/gpt-4o`).

## Open questions

1. **Does this defeat the audience?** Three provider consoles, three accounts,
   three payment methods, prepaid credit. AirOps concluded marketers should not
   touch keys at all. The delegation flow is our mitigation; it is unproven.
2. **Gemini's free tier** — a tenant's own Google key may carry grounded-search
   allowance ours does not, making `GEMINI_COST_PER_CALL_USD = 0.069` wrong for
   them, high. Unresolved.
3. **Model choice stays ours** (`AI_VISIBILITY_OPENAI_MODEL`). We pick the
   model, they pay for it, and a snapshot roll silently changes their bill.
   Needs a policy.
4. **Cost constants become their money.** `0.252` / `0.094` / `0.069` are our
   measurements; Gemini's is derived, not measured. Under BYOK a wrong constant
   under-protects their budget with no reconciliation, since we cannot see
   their invoice. Re-measure before shipping.
5. **Gemini Tier 1 limits are unpublished.** Someone must log into AI Studio on
   a Tier 1 project and read them before we set a default concurrency.

## Sequencing

The error-sanitisation work (Decision 10) is a prerequisite and ships first —
it is a live bug today and a customer-secret leak under BYOK.
