# Manual Brief Creation — Design

**Date:** 2026-08-06
**Status:** approved, not implemented
**Spec:** 6 in the content-hub pivot decomposition. Depends on 3 (signals) and 5 (briefs, inbox, drafting), both complete.

## Context

The pipeline runs end to end: agents collect signals, the brief agent proposes,
a human accepts, generation writes a draft. Two live runs exposed where it
breaks down, and it is not the judgement — it is the input.

The brief agent twice refused to propose anything, correctly: its signal pool
was nine portfolio pages and dev-tool links against one substantive article. To
test drafting at all, a brief had to be written directly into the database by
hand. That is the gap this spec closes — a way to point the agent's judgement at
signals a human already knows matter, and a way to enter a signal the agents
never found.

The design doc scopes this as *"select signals to create a brief by hand, or add
a signal manually (a competitor post the agent missed, a webinar, a conference
talk)"*.

## Non-goals

- **Editing an existing brief.** `briefs.editedAt` exists and stays unused.
- **Fetching a pasted URL to auto-fill title and excerpt.** Genuinely useful and
  `fetchPageText` already exists with SSRF guards — but it is a new failure path
  and the form works without it. Recorded as a follow-up.
- Bulk signal entry, or importing from a file.

## Part 1 — The proposal call

**`proposeBriefFromSignals` is a new call, NOT a reuse of `ideate`.** This is the
central decision and the reason the two cannot share an entry point.

`ideate`'s prompt reads *"decide what — if anything — this company should
publish"* and imposes a bar: *"Propose a brief only if you would defend it in an
editorial meeting to a skeptical head of marketing."* Its job includes deciding
whether to write at all — and it has already exercised that judgement twice by
refusing. Pointing it at signals a human deliberately selected would let it
refuse them again, which is precisely the failure this feature exists to route
around.

The new call inverts the instruction: **the human has already decided these
signals matter and that something should be written; produce the brief, do not
judge whether one is warranted.** It returns exactly one proposal.

It reuses, deliberately and without change:

- the `ProposedBrief` shape and its zod schema, so the form and the agent path
  produce identical rows;
- the company-profile framing (name, one-liner, positioning, topics);
- the 3–5 key-point cap — the spike measured 6.5 points averaging 27 words when
  uncapped, and a brief is a commission, not a first draft;
- an explicit `maxOutputTokens`, because 6 uncapped briefs overflowed a 4096
  default.

`evidenceSignalIds` is **not** taken from the model. The human chose the signals;
the selection is authoritative and the model does not get to drop or add to it.

### Failure degrades to the blank form

If the call fails, the form opens empty with the error shown, rather than
blocking. This matters more here than anywhere else in the product: this is the
path that exists for when the agent is not being helpful, so it must not require
the agent to work.

## Part 2 — Manual signals

A form writing a `signals` row with `kind: "manual"` — the enum already contains
it, added in spec 3 in anticipation.

| Field | Source |
|---|---|
| `kind` | `"manual"` |
| `title` | required, from the form |
| `url` | optional |
| `excerpt` | optional |
| `occurredAt` | from the form, defaulting to today |
| `externalId` | the normalised URL when one is given; otherwise a generated UUID |

`externalId` is NOT NULL and participates in
`signals_tenant_kind_external_unique`, so it must always have a value. Using the
URL means entering the same link twice is caught as a duplicate rather than
silently creating two signals; a UUID for the no-URL case means two signals that
merely share a title do not collide.

**`kind: "manual"` keeps these out of the `shipped_work` cross-tenant path.**
`signals.externalId`'s own comment warns that `syncShippedWorkSignals` withdraws
rows with an unscoped, cross-tenant query, safe only because shipped-work
external ids are globally unique UUIDs. Manual signals are a different kind and
that sweep never sees them — but a future author who reuses this form for
another kind must read that comment first.

## Part 3 — Selection in the signals browser

Checkboxes on signal rows, and a bar showing the count with a **Create brief**
action. Capped at **10** selected, so the proposal prompt stays bounded — the
same reason `MAX_IDEATION_SIGNALS` exists on the agent path.

`signals-list.tsx` already carries a comment saying selection is spec 6 and
deliberately absent; this is that.

Stale signals must not be selectable. A stale `shipped_work` signal is work that
was withdrawn, and commissioning a brief about something that no longer ships is
the failure `listSignals` already filters for elsewhere.

## Part 4 — The brief form

Opens pre-filled from the proposal, every field editable, and saves a `briefs`
row with `origin: "manual"`, `status: "new"`, `createdBy` set, and the selected
signals attached through `brief_signals`. It then lands in the inbox and behaves
exactly like an agent brief — accept generates a draft, dismiss records a reason.

`score` comes from the proposal and is kept, but means less here: the inbox
orders by score then recency, and for a human-initiated brief the conviction
came from the human. It is not surfaced as a judgement of their idea.

### Manual briefs do not expire

`expireStaleBriefs` ages `new` briefs out at `BRIEF_TTL_DAYS` (14) because the
agent generates continuously and undecided proposals accumulate. A brief someone
wrote by hand is a deliberate act; deleting it on a timer is rude.

`briefs.expiresAt` is currently NOT NULL, so a never-expiring brief would need a
fake far-future date — a value the data claims and the system never honours.
**Make the column nullable instead**, with NULL meaning "no expiry". Existing
rows all have values, so the migration is widening only.

The sweep gains an explicit `isNotNull(briefs.expiresAt)` predicate. SQL's
three-valued logic would already exclude NULL from `expiresAt <= now`, but
relying on that is exactly the kind of subtlety that breaks when someone later
rewrites the query. State it.

## Testing

- The proposal call returns one brief and **preserves the caller's signal ids**
  even if the model returns different ones.
- Its prompt does NOT contain `ideate`'s "if anything" or editorial-bar language
   — the regression that would silently restore the refusal behaviour.
- A failed proposal returns an error the form can render, and does not throw.
- Creating a manual signal: URL present → normalised URL as `externalId`; URL
  absent → a UUID; the same URL twice → rejected as a duplicate, not duplicated.
- A manual brief saves with `origin: "manual"`, `createdBy` set, `expiresAt` null,
  and its selected signals joined.
- `expireStaleBriefs` expires an agent brief whose date has passed and leaves a
  manual brief with a null `expiresAt` alone.
- Selection is capped at 10 and refuses stale signals.
- Every query and mutation is tenant-scoped; a signal id from another tenant
  cannot be attached to a brief.
- Per the standing rule, each guard is deleted and its test re-run to confirm it
  fails.

**`npm run build` is a mandatory gate** — it caught a `"use server"` export rule
that the whole suite missed. **No test may reach the real Anthropic API.** The UI
cannot be visually verified; the dev preview sits behind an OAuth wall.

## Files

- Modify: `src/db/schema.ts` — `briefs.expiresAt` nullable
- Create: `src/db/migrations/<n>_*.sql`
- Modify: `src/lib/briefs/sweep.ts` — the `isNotNull` predicate
- Create: `src/lib/briefs/propose.ts` — `proposeBriefFromSignals`
- Create: `src/lib/signals/manual.ts` — `createManualSignal`
- Modify: `src/app/(dashboard)/signals/*` — selection, the create-brief bar, the add-signal form
- Create: `src/app/(dashboard)/briefs/new/*` — the brief form and its actions
- Tests alongside each

## Open items for whatever follows

- Auto-filling a manual signal from a pasted URL via `fetchPageText`.
- The signal pool itself is still the binding constraint on the agent path. This
  spec routes around it; it does not fix it. Topic tuning and the news agent's
  acquisition quality remain the higher-value work for the automated path.
- `score` on a manual brief is close to meaningless. If manual briefs come to
  dominate the inbox, ordering needs revisiting.
