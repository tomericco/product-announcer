# Atomic Updates — Phase 2b (Catch-up) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A draft release that has gone stale — because new commits attached to its atomic updates, or new atomic updates appeared — surfaces a "N new updates since this draft — catch up" affordance. Clicking it merge-regenerates the body, preserving hand edits. First, correct the atomic-update lifecycle to open-until-publish, which the catch-up design requires.

**Architecture:** An atomic update stays `status='open'` while sitting in a draft release (linked by `releaseId`); only PUBLISHING a release closes its atomic updates (`released`). Because in-draft atomic updates stay open, the resolver keeps attaching new evidence to them (the *evidence delta*), and new unlinked atomic updates keep appearing (the *membership delta*). Both deltas are measured against `releases.composedAt` and surfaced as one count on the release editor. Catch-up feeds the composer the current body plus the new material and merges.

**Tech Stack:** Next.js 16 (App Router), Drizzle ORM + Postgres, Vercel AI SDK v7 (`generateObject`) with `@ai-sdk/anthropic`, Vitest.

## Why Task 1 exists (a correction, not a feature)

Phase 2a's `claimReleaseFromAtomicUpdates` flips atomic updates to `status='released'` at **draft (claim) time**. The design spec says the opposite — *"Only publishing closes it — sitting in an unpublished draft does not"* — and the two-delta catch-up depends on it: the **evidence delta** (new commits attaching to an atomic update already in the draft) is only possible if that atomic update stays `open` so the resolver can still attach to it. Task 1 moves the `released` transition from claim-time to publish-time. Every later task in this plan assumes that correction is in place.

## Two distinct notions of "open" after this phase — do not conflate

| Query | Filter | Purpose |
| --- | --- | --- |
| `loadOpenAtomicUpdates` (`apply-resolution.ts`) — the **resolver** candidate set | `status='open'` (ALL open, incl. in-draft) | So new evidence attaches to in-draft atomic updates → the evidence delta. **Do NOT add a `releaseId` filter here.** |
| `getOpenAtomicUpdates` (`release-claim.ts`) + `listAtomicUpdates` (`atomic-updates/actions.ts`) — the **compose** candidate set | `status='open' AND releaseId IS NULL` | Only atomic updates not already committed to a release are composable. |

The whole phase hinges on keeping these two separate. A `releaseId IS NULL` filter leaking into the resolver's set would stop evidence attaching to in-draft features; its absence from the compose set would let one atomic update be double-claimed into two releases.

## Global Constraints

- **The database has no production data.** Ordinary migrations continue from 0025; `NOT NULL` where required; no backfill. `drizzle-kit generate` may prompt on a column add with a `NOT NULL`-no-default — if it prompts, the agent has no TTY: STOP and report NEEDS_CONTEXT so the controller drives it under a pseudo-terminal.
- **This version of Next.js differs from training data.** Per `AGENTS.md`, read the relevant guide under `node_modules/next/dist/docs/` before any Server Component / Server Action / route-handler / `revalidatePath` code.
- **Model resolution goes through `src/lib/ai/model.ts`**; every LLM call records usage via `recordLlmUsage`. Reuse `GENERATION_MODEL` for the merge composer.
- **No test may reach the live Anthropic API** (a live key is present) — mock `generateObject` / the generation module as existing tests do.
- **Tenant scoping is per-query** — every `where` on a tenant-scoped table is a security boundary. Every catch-up action must load the release via the existing `loadOwnedDraft` pattern (tenant-checked) before acting.
- The release editor and `/atomic-updates` sit behind GitHub OAuth with no dev bypass — do NOT build a bypass; verify via build/route-table/tests and state what's unverified.
- Keep `npm run typecheck && npm run lint && npx vitest run && npm run build` green at the end of every task.

## Decisions baked into this plan

| Decision | Choice | Why |
| --- | --- | --- |
| AU lifecycle | Open until publish; `released` set on publish, not claim | Spec + the two-delta catch-up require in-draft AUs to stay open. |
| Exclusivity | `releaseId IS NULL` guards the claim; an AU is in ≤1 release | Was enforced by `status='open'` before; now `status` no longer moves at claim. |
| Membership delta | Open, unlinked AUs with `createdAt > composedAt` | AUs that didn't exist when you composed. A pre-composedAt exclusion was deliberate, not stale. |
| Evidence delta | AUs in this release with `updatedAt > composedAt` | Their evidence attached / summary regenerated after compose. |
| Regeneration default | Merge (composer gets current body + new material, preserves wording) | Survives the "edit intro → 3 AUs land → catch up" sequence without destroying edits or leaving a seam. |
| Regeneration escape hatch | "Start over" = regenerate from scratch over all the release's AUs | Available, not the default. |
| Catch-up UX | A banner on the release editor; server actions, not streaming | One LLM call; a pending state is enough. Simpler than the compose dialog's NDJSON. |

---

### Task 1: Correct the lifecycle to open-until-publish

**Files:**
- Modify: `src/lib/change-events/release-claim.ts` (`claimReleaseFromAtomicUpdates`, `getOpenAtomicUpdates`; add `markReleaseAtomicUpdatesReleased`)
- Modify: `src/app/(dashboard)/drafts/actions.ts` (`approveDraft`, `publishDraft` — release AUs on publish)
- Modify: `src/app/(dashboard)/atomic-updates/actions.ts` (`listAtomicUpdates` — add `releaseId IS NULL`)
- Test: `tests/lib/change-events/release-claim.test.ts` (extend), `tests/app/atomic-updates-actions.test.ts` (extend), a publish-lifecycle test

**Interfaces:**
- Produces: `markReleaseAtomicUpdatesReleased(releaseId, database?): Promise<number>` (sets a release's AUs `status='released'`)
- Changes: `claimReleaseFromAtomicUpdates` sets `releaseId` only (keeps `status='open'`), exclusivity guard becomes `status='open' AND releaseId IS NULL`; `getOpenAtomicUpdates` and `listAtomicUpdates` add `releaseId IS NULL`; **`loadOpenAtomicUpdates` is unchanged**

**Context:** The foundational correction. Read `release-claim.ts`, `drafts/actions.ts` (publish paths, already read into this plan), and `atomic-updates/actions.ts` first. `revertReleaseAtomicUpdates` already sets `status='open', releaseId=null` — it stays correct for reject/delete (at draft time the AU is now already open, so the status write is a harmless no-op; the `releaseId=null` is the operative part).

- [ ] **Step 1: Write failing tests**

Extend `release-claim.test.ts`:
- claim leaves AUs `status='open'` with `releaseId` set (change the existing assertion from `'released'` to `'open'`).
- a second claim naming an already-linked (open, `releaseId` set) AU does NOT re-claim it (exclusivity now via `releaseId`, not status).
- `getOpenAtomicUpdates` excludes an open AU that has a `releaseId` (in a draft).
- `markReleaseAtomicUpdatesReleased(releaseId)` flips that release's AUs to `released`.

Add a publish-lifecycle test (in a drafts-actions test file): after `approveDraft`/`publishDraft`, the release's AUs are `status='released'`.

Extend `atomic-updates-actions.test.ts`: `listAtomicUpdates` excludes an open AU with a `releaseId` set.

- [ ] **Step 2: Run — confirm they fail** for the stated reasons.

- [ ] **Step 3: Change `claimReleaseFromAtomicUpdates`**

In the claim `UPDATE atomicUpdates`: change `.set({ status: "released", releaseId: release.id, updatedAt })` → `.set({ releaseId: release.id, updatedAt })` (drop the status write — the AU stays open). Change the WHERE from `eq(status,'open')` to `and(eq(status,'open'), isNull(releaseId))` (open AND not already in a release). The empty-claim rollback is unchanged.

- [ ] **Step 4: Add `markReleaseAtomicUpdatesReleased` + call it on publish**

Add to `release-claim.ts`:

```ts
/** On publish: closes a release's atomic updates. The inverse of leaving them
 * open while the release is a draft. */
export async function markReleaseAtomicUpdatesReleased(
  releaseId: string,
  database: Executor = defaultDb
): Promise<number> {
  const released = await database
    .update(atomicUpdates)
    .set({ status: "released", updatedAt: new Date() })
    .where(eq(atomicUpdates.releaseId, releaseId))
    .returning({ id: atomicUpdates.id });
  return released.length;
}
```

In `drafts/actions.ts`, in BOTH `approveDraft` and `publishDraft`: when the publish UPDATE returns a `changed` row (the row was actually published, not a double-submit no-op), call `await markReleaseAtomicUpdatesReleased(releaseId, ...)`. Do it in the same place the dispatch happens (inside `if (changed)`), so a double-submit doesn't re-run it. Consider wrapping the publish UPDATE + this call in a transaction so a crash between them can't leave a published release with still-open AUs; match the existing transaction style.

- [ ] **Step 5: Add `releaseId IS NULL` to the compose sets ONLY**

- `getOpenAtomicUpdates` (`release-claim.ts`): WHERE becomes `and(eq(tenantId,…), eq(status,'open'), isNull(releaseId))`.
- `listAtomicUpdates` (`atomic-updates/actions.ts`): add `isNull(atomicUpdates.releaseId)` to its WHERE.
- **Do NOT touch `loadOpenAtomicUpdates` in `apply-resolution.ts`** — the resolver must still see in-draft (open, linked) AUs so evidence attaches to them. Add a code comment there stating this is deliberate, so a later reader doesn't "fix" it to match the others.

- [ ] **Step 6: Verify**

`npm run typecheck && npm run lint && npx vitest run && npm run build`. Confirm the phase-2a assign-guard regression test (`apply-resolution.test.ts`, "never assigns an event to an atomic update already released mid-resolution") STILL passes — it now also protects the published-AU case, and an in-draft (open) AU is correctly assignable.

- [ ] **Step 7: Commit** — `git commit -m "fix: keep atomic updates open until their release publishes"`.

---

### Task 2: Schema — `composedAt` and `bodyEditedAt`

**Files:**
- Modify: `src/db/schema.ts` (add `releases.composedAt`, `releases.bodyEditedAt`), migration `0026_*.sql`
- Modify: `src/lib/change-events/release-claim.ts` (set `composedAt` at claim)
- Modify: `src/app/(dashboard)/drafts/actions.ts` (`saveDraft` sets `bodyEditedAt` when the body changes)
- Test: schema test; extend `release-claim.test.ts` and a saveDraft test

**Interfaces:**
- Produces: `releases.composedAt` (timestamptz, the baseline catch-up deltas measure against; set at claim, advanced on catch-up), `releases.bodyEditedAt` (timestamptz nullable; non-null ⇒ the body was hand-edited)

**Context:** `composedAt` is distinct from `createdAt` because catch-up advances it after a merge. `bodyEditedAt` is the body's analogue of the atomic update's `summaryEditedAt` freeze flag — it lets the UI/merge know the body carries hand edits worth preserving.

- [ ] **Step 1: Failing schema test** — insert a release, assert `composedAt` is set (default now) and `bodyEditedAt` defaults null.
- [ ] **Step 2: Run — fail** (columns absent).
- [ ] **Step 3: Add columns** to `releases` in `schema.ts`: `composedAt` timestamptz `NOT NULL DEFAULT now()`; `bodyEditedAt` timestamptz nullable. `npm run db:generate` (HUMAN-RUN if it prompts) → `0026_*.sql` → migrate both DBs.
- [ ] **Step 4: Set `composedAt` at claim** — in `claimReleaseFromAtomicUpdates`, set `composedAt: new Date()` on the release insert (or rely on the default — but set it explicitly so the semantics are clear and testable).
- [ ] **Step 5: Set `bodyEditedAt` in `saveDraft`** — when the resolved body differs from the existing body, set `bodyEditedAt: new Date()`. (A save that doesn't change the body must not stamp it.) Test both.
- [ ] **Step 6: Verify + commit** — `git commit -m "feat: add composedAt and bodyEditedAt to releases"`.

---

### Task 3: Compute the catch-up deltas

**Files:**
- Create: `src/lib/change-events/release-deltas.ts`
- Test: `tests/lib/change-events/release-deltas.test.ts`

**Interfaces:**
- Produces:
  - `type ReleaseDelta = { newAtomicUpdates: AtomicUpdateRow[]; changedAtomicUpdates: AtomicUpdateRow[]; count: number }`
  - `computeReleaseDelta(releaseId: string, database?): Promise<ReleaseDelta>`

**Context:** Pure DB reads. `newAtomicUpdates` = the **membership delta**: `status='open'`, `releaseId IS NULL`, `tenantId` = the release's tenant, `createdAt > release.composedAt`. `changedAtomicUpdates` = the **evidence delta**: AUs with `releaseId = <this release>` and `updatedAt > release.composedAt`. `count = newAtomicUpdates.length + changedAtomicUpdates.length`. This function is read-only; it does not mutate or claim anything.

- [ ] **Step 1: Failing test** — seed a release with `composedAt` at a fixed past time (pass timestamps in; do NOT call `new Date()` — seed rows with explicit `createdAt`/`updatedAt`/`composedAt` values). Assert:
  - an open unlinked AU created after `composedAt` appears in `newAtomicUpdates`;
  - an open unlinked AU created BEFORE `composedAt` does NOT (deliberate prior exclusion);
  - an AU linked to this release whose `updatedAt > composedAt` appears in `changedAtomicUpdates`;
  - an AU linked to this release whose `updatedAt <= composedAt` does NOT;
  - `count` is their sum;
  - another tenant's new AU does NOT leak in.
- [ ] **Step 2: Run — fail** (module absent).
- [ ] **Step 3: Implement `computeReleaseDelta`** — load the release (for `tenantId` + `composedAt`), then the two queries above. Tenant-scope both.
- [ ] **Step 4: Verify + commit** — `git commit -m "feat: compute catch-up deltas for a draft release"`.

---

### Task 4: Merge-regeneration composer + start-over

**Files:**
- Modify: `src/lib/ai/generation.ts` (add `mergeReleaseDraft`)
- Modify: `src/lib/ai/compose-prompt.ts` (add `composeMergePrompt`)
- Create: `src/lib/change-events/catch-up.ts` (the orchestrators that mutate)
- Test: `tests/lib/ai/compose-prompt.test.ts` (extend), `tests/lib/change-events/catch-up.test.ts`

**Interfaces:**
- Produces:
  - `composeMergePrompt(args: { currentBody: string; newItems: AtomicUpdateForPrompt[]; changedItems: AtomicUpdateForPrompt[]; brandProfile; personas; examples }): { system; prompt }`
  - `mergeReleaseDraft(args): Promise<UpdateDraft>` (mirrors `generateReleaseDraft`'s model/usage/retry shape)
  - `catchUpRelease(releaseId, deps?): Promise<Release | null>` — merges: claims the new AUs into the release, merge-regenerates the body, advances `composedAt`
  - `startOverRelease(releaseId, deps?): Promise<Release | null>` — claims the new AUs, regenerates from scratch over ALL the release's AUs, advances `composedAt`

**Context:** `composeMergePrompt` instructs the model to integrate the new/changed atomic updates into the existing body while preserving its wording and structure — contrast with `composeReleasePrompt`, which writes fresh. Both orchestrators (a) link the membership-delta AUs into the release, (b) regenerate the body (merge vs scratch), (c) `UPDATE releases SET body=…, composedAt=now()`. Advancing `composedAt` is what makes the catch-up count return to zero. Run each orchestrator's mutations in a transaction. No live API in tests — mock the generation call.

**Linking must re-guard exclusivity.** The AUs to link come from `computeReleaseDelta`'s `newAtomicUpdates`, read a moment earlier; between that read and the link another draft could claim one, or it could be published. So the link `UPDATE ... SET releaseId=<this release>` must carry `WHERE status='open' AND releaseId IS NULL` (same guard as the original claim) and only link the rows that still match — a lost row is dropped from this catch-up, not force-stolen. Keep the AUs `open` (do not set `released`) — publish still owns that transition.

- [ ] **Step 1: Failing prompt test** — `composeMergePrompt` includes the current body AND the new items, and its system prompt tells the model to preserve existing wording. Run — fail.
- [ ] **Step 2: Implement `composeMergePrompt` + `mergeReleaseDraft`** (additive; reuse `buildSystemPrompt`, `serializeAtomicUpdates`, `DEFAULT_MAX_PROMPT_CHARS`). Verify.
- [ ] **Step 3: Failing orchestrator tests** (`catch-up.test.ts`, DB-backed, mocked generation):
  - `catchUpRelease`: the membership-delta AUs end up `releaseId = this release` (still open); the release `body` is the merged output; `composedAt` advanced so a subsequent `computeReleaseDelta` returns `count = 0`; another tenant's AUs never pulled in.
  - `startOverRelease`: same linking + composedAt advance, but the body is the from-scratch regeneration.
  - both are tenant-scoped and return `null` (or throw a handled sentinel) for a foreign/nonexistent release.
- [ ] **Step 4: Implement `catch-up.ts`** — `computeReleaseDelta` (Task 3) to get the deltas, claim/link the new AUs, regenerate, update body + `composedAt`, all in one transaction. `startOverRelease` regenerates over the release's full AU set (existing + newly linked).
- [ ] **Step 5: Verify + commit** — `git commit -m "feat: merge-regenerate and start-over for stale draft releases"`.

---

### Task 5: Catch-up UI on the release editor

**Files:**
- Modify: `src/app/(dashboard)/drafts/[releaseId]/page.tsx` (compute + render the delta banner)
- Create: `src/app/(dashboard)/drafts/[releaseId]/catch-up-banner.tsx` (client component)
- Modify: `src/app/(dashboard)/drafts/[releaseId]/` actions (add `catchUp` / `startOver` server actions)
- Test: an actions test asserting each calls its orchestrator and revalidates; tenant-scoping

**Interfaces:**
- Consumes: `computeReleaseDelta` (Task 3), `catchUpRelease` / `startOverRelease` (Task 4)
- Produces: `catchUp(formData)` / `startOver(formData)` server actions; a banner rendered only when `count > 0`

**Context:** Read `node_modules/next/dist/docs/` for Server Components / Server Actions / `revalidatePath` first. The page is an async Server Component; compute the delta server-side and pass `count` to the client banner. The banner shows *"{count} new update{s} since this draft"* with a "Catch up" button (calls `catchUp`) and a subtler "Start over" (calls `startOver`, ideally behind a confirm since it discards the current body). Both actions load the release via the tenant-checked `loadOwnedDraft` pattern, call the orchestrator, `revalidatePath(\`/drafts/${releaseId}\`)`. Use a pending state (`useTransition`/form status) — no streaming.

- [ ] **Step 1: Failing actions test** — `catchUp` calls `catchUpRelease` for the owned release and revalidates; refuses a foreign release; `startOver` calls `startOverRelease`. Mock the orchestrators; no live API.
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Implement the actions** (colocated, tenant-checked). Verify the test.
- [ ] **Step 4: Build the banner + wire the page** — compute `computeReleaseDelta` in `page.tsx`, render `<CatchUpBanner count=… />` only when `count > 0`; the client component posts to the actions with a pending state. Match existing dashboard styling / `src/components/ui`. Read `drafts/[releaseId]/page.tsx` first and place the banner above the editor.
- [ ] **Step 5: Verify** — `npm run typecheck && npm run lint && npx vitest run && npm run build`; confirm the editor route still builds. State that interactive rendering is unverified (OAuth-gated).
- [ ] **Step 6: Commit** — `git commit -m "feat: catch-up banner on the release editor"`.

---

## Verification

- [ ] `npm run typecheck && npm run lint && npx vitest run && npm run build` all clean.
- [ ] Drafting a release keeps its atomic updates `status='open'` (linked by `releaseId`); publishing flips them to `released`; rejecting/deleting reopens (unlinks) them.
- [ ] An in-draft feature that receives a new commit: the resolver attaches it to the same (open) atomic update → that release's catch-up count increments (evidence delta).
- [ ] A brand-new atomic update after compose increments the count (membership delta). It also still appears on `/atomic-updates`'s compose list (it is unlinked) — the delta is per-draft: one unlinked AU can simultaneously be composable into a new release AND count toward an existing draft's catch-up. Both are correct.
- [ ] Catch-up merges: new AUs get linked to the release, the body integrates them preserving prior wording, `composedAt` advances, the count returns to zero.
- [ ] Start-over regenerates from scratch over the full AU set.
- [ ] One atomic update is never in two releases (exclusivity via `releaseId`).

## Out of scope

- Change-events list + manual reassignment UI, and rescuing classifier false-negatives (`userFacing=false`) — phase 3.
- Notion / task sources (separate spec).
- Auto-catch-up (the scheduler regenerating stale drafts unattended) — catch-up is user-initiated only.
