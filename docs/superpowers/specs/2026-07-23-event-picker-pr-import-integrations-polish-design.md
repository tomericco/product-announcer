# Unified Event Picker, PR Import, Integrations Move & Polish — Design

**Date:** 2026-07-23
**Branch:** `feat/atomic-updates` (PR #3)
**Status:** Approved

## Summary

Eight changes across the change-events, atomic-updates, integrations, and nav
surfaces:

- **A — Unified event picker.** Extract the rich multi-select list out of the
  change-events Import dialog into a shared `EventMultiSelect`, and reuse it
  for the "add change events to an atomic update" picker. Both gain an
  event-type switcher (Commit / PR / Task — soon). Adding events is now
  multi-select and regenerates the atomic update once on submit.
- **B — Move GitHub to Integrations.** Relocate the GitHub repos management
  card from `/settings` to `/integrations`.
- **C — PR import.** Import merged pull requests as change events, selected
  via the new type switcher in the Import dialog.
- **D — Optional webhook secret.** Make the webhook signing secret optional;
  deliver unsigned when absent.
- **E — Open-drafts nav counter.** Show a count of open drafts on the Drafts
  nav item.
- **F — Draft CTA wording.** Rename the draft detail CTA "Approve & publish"
  → "Publish" to match the drafts row-menu language.
- **G — "History" → "Release history."** Rename the nav item and page
  heading.
- **H — User avatar + logout menu.** Replace the plain email line in the nav
  with an avatar (initials default) + email that opens a dropdown with a
  Log out action.

One spec, one plan. The shared-component extraction (A) is sequenced first so
C builds on it. B, D, E, F, G, H are independent.

## Global Constraints

- No test may reach a live external API (Anthropic, GitHub, Webflow). GitHub
  fetches and enrichment are injected/mocked, per the existing
  `tests/lib/change-events/*` and `import-commits` conventions.
- Client components must not import `@/db` or pg. Server data reaches client
  dialogs only as plain-data props (or via server actions the client calls).
- Server actions derive tenant/user from the session (`requireSession()`),
  never from `formData`; every GitHub/DB read is tenant-scoped (IDOR guard).
- `externalId` namespacing stays: commits use the SHA; PRs use
  `owner/repo#number`. Uniqueness enforced by the existing indexes
  (`change_events_repo_commit_unique`, `change_events_repo_pr_unique`,
  `change_events_tenant_provider_external_unique`).
- Adding/removing evidence on an atomic update always regenerates its
  title/summary, overwriting a prior hand-edit (the existing `forceRegenerate`
  freeze-clear). A hidden/released update is never a valid target.
- Keep typecheck + lint + vitest + build green at the end of every task.

---

## Feature A — Unified event multi-select picker

### Current state
- `change-events/import-dialog.tsx` holds a rich list: repo tabs
  (All / repo…), search, date range, a scroll list with checkboxes,
  **select-all**, and **shift-click range selection**, plus an "N selected" +
  primary-CTA footer. It lists GitHub commits not yet imported and imports the
  selected ones.
- `atomic-updates/add-event-picker.tsx` is a **single-click-to-add** picker of
  existing selectable change events; each click reassigns one event into the
  card's atomic update and regenerates. `NewAtomicUpdateDialog` is a simpler
  multi-select of the same `SelectableEventRow[]` for creating a new update.

### Target
Extract a reusable **`EventMultiSelect`** presentational component
(`src/app/(dashboard)/_components/event-multi-select.tsx` or a shared location
both routes can import) that owns:

- The **event-type switcher** — a segmented control / tab row: `Commit`,
  `PR`, and `Task` (rendered disabled with a "soon" affordance). The active
  type is controlled by the parent.
- The **search** box.
- The **scroll list** with per-row checkbox, **select-all** (header
  checkbox over the currently-visible selectable rows), and **shift-click
  range selection** — the existing anchor/shiftHeldRef logic moves here
  verbatim.
- Loading / empty / error states.
- The **footer**: "N selected" + a primary CTA (label supplied by parent) +
  Cancel.

It is controlled: the parent supplies, per active type, the list `items`
(each carrying an `id`, a `type`, a primary label, a secondary meta line, and
an optional external URL), the loading/error flags, the selection set +
change handlers, the CTA label, and `onSubmit`. Selection state and the
shift-range/select-all mechanics live inside the component; data loading and
the submit action live in each caller.

Divergent, caller-specific chrome stays **out** of the shared core and is
composed around it by the caller:
- Import keeps its **repo tabs** and **date-range** inputs (they parameterize
  the GitHub fetch; meaningless for existing-event selection).
- Add-to-atomic-update has no repo tabs / date filters.

Two callers:

**Import dialog** (`change-events/import-dialog.tsx`)
- Active type drives which GitHub source loads: `Commit` →
  `listImportableCommits`; `PR` → `listImportablePullRequests` (Feature C).
- CTA: "Import N commit(s)" / "Import N PR(s)".
- Keeps repo tabs + date range around the shared list.

**Add-to-atomic-update picker** (replaces `add-event-picker.tsx`)
- Items = existing `SelectableEventRow[]` (unassigned + those in other open
  updates, minus ones already on this update), **filtered by the active
  type** (Commit / PR). No GitHub fetch.
- Multi-select; on submit calls `addEventsToAtomicUpdate` (below).
- CTA: idle "Add N event(s)"; **pending state shows "Regenerating…"** to
  reflect that submit regenerates the update.
- Retains the empty-source **needs-confirmation** flow, now batched across
  possibly-multiple emptied source updates (see below).

### `addEventsToAtomicUpdate` (server action)
Replaces the single-event `addEventToAtomicUpdate`. Signature:

```ts
addEventsToAtomicUpdate(
  atomicUpdateId: string,
  eventIds: string[],
  confirmEmptyDeletion?: boolean
): Promise<
  | { ok: true; deletedAtomicUpdates: { id: string; title: string }[] }
  | { ok: false; needsConfirmation: true; emptiedAtomicUpdates: { id: string; title: string; inDraft: boolean }[] }
  | { ok: false; reason: string }
>
```

- Derives tenant/user from `requireSession()`; validates the target update is
  open + owned. Batch-reassigns every `eventId` into `atomicUpdateId`
  (`forceRegenerate: true`), then regenerates the target's title/summary
  **once** after all reassignments. Mirrors `createAtomicUpdateFromEvents`'s
  batching and its `needsConfirmation` contract (when the batch would empty
  one or more source open updates, return them for confirmation rather than
  silently deleting; a re-post with `confirmEmptyDeletion=true` proceeds).
- `revalidatePath('/atomic-updates')`.

The card (`atomic-update-card.tsx`) swaps its `AddEventPicker` usage for the
new multi-select picker, passing the same `addableEvents` (already filtered to
exclude events on this update).

### Testing
- `addEventsToAtomicUpdate`: batch add of multiple events into one update
  regenerates once (mock/inject the regenerate), events end up on the target;
  a batch emptying ≥2 source updates returns `needsConfirmation` naming all of
  them and makes no destructive change until re-posted with the confirm flag;
  tenant isolation and target-must-be-open guards. No live Anthropic.

---

## Feature C — Import merged pull requests

### GitHub library
Add `listRepoPullRequests(installationId, repoFullName, { since?, until? })`
to `src/lib/integrations/github/github.ts` using
`octokit.rest.pulls.list({ state: "closed", base: watchedBranch?, sort: "updated", direction: "desc" })`
(paginated), then **filter to merged PRs only** (`merged_at != null`) per the
chosen scope. Returns `{ number, title, body, url, mergedAt, authorName }`.
(Open/unmerged PRs are excluded — they are not shipped changes.)

### Actions + import core
- `listImportablePullRequests({ repoIds, since?, until? })` in
  `change-events/import-actions.ts`, mirroring `listImportableCommits`:
  tenant-scoped repo load, per-repo guarded fetch, mark `imported` by checking
  existing non-excluded `change_events` with matching `prNumber` for the repo.
  Returns `ImportablePullRequest[]` (`repoId`, `repoFullName`, `number`,
  `title`, `body`, `url`, `mergedAt`, `authorName`, `imported`).
- `importPullRequests({ selections })` → `importSelectedPullRequests` in a new
  `src/lib/change-events/import-pull-requests.ts`, mirroring
  `importSelectedCommits`:
  - Enrich each PR with `enrichChangeItem({ type: "pull_request", repoName,
    prTitle, prDescription })` — **no diff fetch**; `buildEnrichmentPrompt`
    already renders PRs from title+description.
  - Insert as `type: "pull_request"`, `provider: "github"`, `externalId:
    "owner/repo#number"`, `prNumber`, `prTitle`, `prDescription`, `prUrl`,
    `mergedAt`, plus the enrichment fields.
  - `onConflictDoUpdate` on `[repoId, prNumber]` with the same
    resurrect-if-excluded semantics as commits.
  - Resolve freshly-imported user-facing PRs into atomic updates via the same
    `resolvePendingEvents` path.
  - `revalidatePath('/atomic-updates')` + `revalidatePath('/change-events')`.

### Type switcher wiring
The Import dialog's type switcher selects `Commit` vs `PR`; each tab lazy-loads
its source when activated. `Task` is a disabled "soon" tab. Selection/search
state resets appropriately when switching type (a PR selection and a commit
selection are distinct sets; simplest is to clear selection on type change —
they can't be imported together in one submit).

### Testing
- `importSelectedPullRequests`: inserts a PR change event with the right
  columns + `externalId`; re-import of a merged PR is idempotent (onConflict);
  enrichment injected (no live Anthropic); GitHub fetch injected. Mirror the
  `import-commits` test file structure.
- `listRepoPullRequests` merged-only filter: a stubbed octokit response with a
  mix of merged/unmerged PRs yields only the merged ones.

---

## Feature B — Move GitHub repos to Integrations

- Move the **GitHub repos** card and everything it needs out of
  `settings/page.tsx` into `integrations/page.tsx`, alongside the Webhook and
  Webflow cards:
  - The server-side data: `installUrl` (via
    `getGithubApp().getInstallationUrl({ state: "<tenantId>|integrations" })`),
    `listAccessibleRepos`, the per-repo `listRepoBranches` map, and the
    tenant's repos.
  - The components `add-repo-dialog.tsx`, `repo-branch-select.tsx`,
    `repo-row.tsx`, and the `removeRepo` action move to (or are imported from
    a shared location by) `/integrations`. The `saveWorkspaceName`,
    brand/persona/schedule cards stay in Settings.
- Update the install-redirect: the state token becomes `<tenantId>|integrations`,
  and `api/github/setup/route.ts` maps `returnTo === "integrations"` →
  `/integrations` (keeping `settings` and the onboarding default working, or
  replacing `settings` if nothing else uses it). Post-install returns to
  `/integrations?github_connect=success`.
- Guard against the same GitHub-page-crash concern already handled in
  settings: each per-repo branch fetch stays individually try/caught so one
  transient error degrades to an empty branch list, not a 500.

### Testing
- No new unit tests (a UI relocation). Existing repo-selection / branch tests
  continue to pass; the setup-route `returnTo` mapping is covered by adding
  `integrations` to any existing setup-route test, if present, else verified
  via typecheck/build.

---

## Feature D — Optional webhook secret

- **Schema:** make `webhook_configs.secret_ciphertext`, `secret_iv`,
  `secret_auth_tag` nullable (drop `NOT NULL`). Migration = one
  `ALTER TABLE … ALTER COLUMN … DROP NOT NULL` per column.
- **Form** (`webhook-config-form.tsx`): the Secret field is no longer
  `required` in any case. Placeholder communicates it's optional (e.g.
  "Optional — used to sign deliveries" for a new config; keep the "Saved —
  leave blank to keep" wording when a secret already exists).
- **`saveWebhookConfig`:** remove the "A secret is required to create a webhook
  config" throw on the insert branch; insert with the secret columns null when
  none is provided. The existing "empty secret on an existing config = leave
  it alone" behavior is preserved (so a config that already has a secret keeps
  it unless a new one is typed). *(Note: this means the form can't clear an
  existing secret; that's out of scope — flagged, not built.)*
- **`webhookDestination.deliver`:** when `config.secretCiphertext` is null,
  skip decryption entirely and send the request **without** the
  `x-product-announcer-signature` header. When a secret is present, decrypt and
  sign exactly as today (including the decrypt-failure → permanent/configFault
  path).

### Testing
- `webhookDestination.deliver` with a null-secret config delivers with **no**
  signature header and records success; with a secret, still signs (existing
  test unchanged). `saveWebhookConfig` inserts a secret-less config
  successfully. Reuse `tests/lib/publishing/dispatch.test.ts` conventions
  (real test DB + stubbed fetch); no live API.

---

## Feature E — Open-drafts nav counter

- In `(dashboard)/layout.tsx` (Server Component), add a tenant-scoped
  `count(*)` of `releases` where `status = 'draft'`, and pass it to
  `<NavLinks draftCount={n} />`.
- `nav-links.tsx` renders a small count badge on the **Drafts** item when
  `draftCount > 0` (e.g. a `Badge` aligned right within the button). No live
  polling — the layout re-runs on navigation, and draft create/publish/reject
  already `revalidatePath('/drafts')`.

### Testing
- No unit test (a layout count + presentational badge). Verified via
  typecheck/build. If a lightweight query helper is extracted, it may get a
  trivial count test, but this is optional.

---

## Feature F — Draft CTA wording

- In `publish-dialog.tsx`, the trigger button label changes from
  "Approve & publish" to **"Publish"**, matching the drafts row-menu language
  (`draft-row-menu.tsx` uses "Publish" for the menu item, the "Publish this
  update?" confirm, and the button). The modal title ("Publish release") and
  confirm ("Publish" / "Publishing…") already align. No behavior change.

---

## Feature G — "History" → "Release history"

- `nav-links.tsx`: the `/history` item label becomes "Release history".
- `history/page.tsx:24`: the `<h1>History</h1>` heading becomes "Release
  history". Route stays `/history`.

---

## Feature H — User avatar + logout menu

### Current state
The dashboard sidebar footer renders the email as plain text:
`<div className="mt-auto px-2 pt-3 text-xs text-muted-foreground">{session.user.email}</div>`.
There is no logout affordance in the app, no `SessionProvider`, and no Avatar
UI primitive (only `dropdown-menu`).

### Target
- New client component `(dashboard)/user-menu.tsx`, props
  `{ email: string; name: string | null }`:
  - A `DropdownMenu` (same primitive as the workspace switcher at the top of
    the sidebar) whose trigger is a full-width button showing an **avatar** —
    a small rounded element containing the user's **initials** — next to the
    email (preserving the current `text-xs text-muted-foreground` treatment).
  - Initials are derived from `name` when present (first letters of the first
    two words, uppercased), falling back to the first character(s) of the
    email local-part. No image avatar — initials are the default and only
    rendering (no remote avatar fetch, keeping the CSP/no-external-request
    posture).
  - The dropdown content has a single **Log out** item (with a `LogOut`
    icon) that calls `signOut({ callbackUrl: "/api/auth/signin" })` from
    `next-auth/react`. `signOut` posts to the existing unguarded
    `/api/auth/signout` (no `SessionProvider` needed), then redirects to sign
    in.
- `layout.tsx`: replace the plain email `<div>` with
  `<UserMenu email={session.user.email} name={session.user.name ?? null} />`.
  `session.user.name` is populated from the GitHub profile in the auth
  callback (`auth.ts`), and `email`/`name` flow through NextAuth's default
  session user.

### Testing
- No unit test (a presentational menu + a NextAuth client call). Verified via
  typecheck/build. If an `initials(nameOrEmail)` pure helper is extracted, it
  gets a small unit test (e.g. "Tomer Gabbai" → "TG"; "tomer@x.com" → "T").

---

## Out of scope / non-goals

- No Notion/task ingestion (the "Task" type switcher tab is a disabled "soon"
  placeholder only).
- The webhook form still cannot clear an existing secret back to none (only
  set/replace/leave-alone); noted under D.
- Repo tabs / date filters are not added to the add-to-atomic-update picker
  (import-only), per the agreed shared-component boundary.
- The drafts LIST quick-publish and its "publish to all configured
  destinations" behavior are unchanged.
