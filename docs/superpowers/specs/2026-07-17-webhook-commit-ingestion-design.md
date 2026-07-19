# Webhook Commit Ingestion — Design

**Date:** 2026-07-17
**Status:** Approved (pending spec review)

## Context

The GitHub webhook is meant to ingest both merged PRs and pushed commits from watched
repos, but pushed commits **never land**: `ingestPush`
([src/lib/change-items/ingest-push.ts:33](../../../src/lib/change-items/ingest-push.ts))
returns early unless the repo's `sourceTypes` includes `"commit"`, and nothing ever writes
`"commit"` there — `addSelectedRepos`
([repo-sync.ts:31](../../../src/lib/workspace/repo-sync.ts)) hardcodes `["pr"]` and there is
no UI to change it. The webhook plumbing (signature verify, event filtering, branch match,
enrichment, dedup) is otherwise correct and test-covered.

The product should capture **both** merged PRs and directly-pushed commits, for every repo,
without configurability. Naively enabling both introduces problems this design solves.

### Problems to solve

1. **Double-counting.** A merged PR fires a `pull_request` event (→ a PR change item) **and**
   a `push` to the base branch containing its commits (→ commit change items) — the same work
   ingested twice.
2. **20-commit cap.** GitHub's push payload includes at most 20 commits; larger pushes
   silently lose the rest.
3. **Webhook timeout.** Enrichment + diff-fetch run inline per commit in the request; a large
   push can exceed GitHub's ~10s delivery timeout, causing GitHub to retry.
4. **Noise commits.** Merge commits and empty-diff commits (no code change) carry no
   changelog value; enriching and generating from them wastes cost and pollutes updates.

## Goal

Ingest merged PRs and pushed commits for every watched repo. Keep a merged PR as a single
rich PR item. Filter out merge commits and empty-diff commits before enrichment, but keep
them **visible and labeled "ignored"** in the tracked list rather than silently dropping
them. Process pushes robustly regardless of size.

## Design

### 1. Always ingest both PR and commit changes

Remove the `sourceTypes` gates: `ingestPush` drops
`if (!repo || !repo.sourceTypes.includes("commit")) return;` and `ingestMergedPullRequest`
([ingest-pull-request.ts:30](../../../src/lib/change-items/ingest-pull-request.ts)) drops the
`"pr"` check — each keeps only the `!repo` / branch guards. The `source_types` column becomes
vestigial and is **left in place** (dropping it is a follow-up migration, out of scope).

### 2. Ack fast, process pushes after the response

The webhook route
([src/app/api/webhooks/github/route.ts](../../../src/app/api/webhooks/github/route.ts))
verifies the signature and, for a `push`, returns `200` immediately and schedules the ingest
work with **Next.js `after()`** (`next/server`) — same function invocation, up to its 300s
limit. This removes the ~10s delivery-timeout risk. PR ingestion (one item, one enrichment
call) stays **inline** — it is bounded.

**Trade-off:** acking `200` opts out of GitHub's automatic retry. Post-response errors are
logged; a missed push is recoverable via the manual "Import commits" dialog. *(The plan first
verifies `after` from `next/server` exists in this repo's Next version; approved fallback is
persist-and-cron.)*

### 3. Full commit enumeration (parents + fix the 20-commit cap)

`listPushCommits(installationId, repoFullName, { before, after, payloadCommits })` returns the
commit list **with each commit's `parents`** (needed to detect merge commits — the push
payload omits parents):
- Enumerate the `before...after` range via the compare API
  (`GET /repos/{o}/{r}/compare/{before}...{after}`), **paginated**, **capped at 250**.
- Beyond the cap: process the first 250 and **log a truncation breadcrumb** (repo, watched
  branch, `before→after`, total, skipped count); the skipped range stays recoverable via
  manual import.
- New-branch pushes (`before` all-zeros, no compare base) fall back to `payloadCommits`
  (treated as having no parent info → not classified as merge commits).

### 4. Per-commit classification

For each enumerated commit, in this **precedence order**:

1. **Belongs to a merged PR** (`getCommitPulls(sha)` reports an associated **merged** PR) →
   **drop** (not stored); the PR is its own rich item. This runs first so a PR's **merge
   commit** is dropped along with the rest of its commits — never shown as ignored.
2. **Merge commit with no associated PR** (`parents.length >= 2`, e.g. a local merge pushed
   directly) → record as **ignored**, reason `merge_commit`. No diff fetch, no enrichment.
3. **Empty diff** — fetch the diff; if it is empty (nothing changed) → record as **ignored**,
   reason `empty_diff`. No enrichment.
4. **Otherwise** → enrich the diff and store as a normal **pending** commit change item
   (the existing sub-project-A enrichment path).

`onConflictDoNothing` on `(repoId, commitSha)` still guards webhook re-delivery for every
stored row (pending and ignored alike).

### 5. Data model

`change_items` gains the ability to represent an ignored commit:
- Extend `change_item_status` enum with `"ignored"` (alongside `pending` / `batched` /
  `excluded`).
- Add `ignored_reason` column: text/enum, nullable, one of `merge_commit` / `empty_diff`
  (null for non-ignored rows).

Ignored rows store the usual commit fields (`commit_sha`, `commit_message`, `commit_url`,
`committed_at`, `diff`) with `status = "ignored"`, `ignored_reason` set, and the enrichment
columns left null (they are never enriched). Migration required.

### 6. Tracked-list UI (Pending page)

The Pending page currently shows `pending` change items (with sub-project A's dimmed
"not user-facing" soft-filter). It is extended to also show **`ignored`** rows, dimmed, with
an **"ignored · merge commit"** / **"ignored · empty diff"** label — sitting alongside the
other non-actionable rows. Ignored rows are **excluded from generation**
(`getBatchableChangeItems` already returns only `status = "pending"`), and are **not**
force-includable (unlike non-user-facing items — a merge/empty commit has no changelog value).
The page's list query returns `status in ('pending','ignored')`; a small display helper maps a
row to its label (extends the existing `change-item-display` helper).

### 7. Refactored `ingestPush` + GitHub client

`ingestPush(input, deps)` where `input = { installationId, repoFullName, ref, before, after, payloadCommits }`
and `deps` injects `{ listPushCommits, getCommitPulls, getCommitDiff, enrich, database }` (all
with real defaults) — matching the codebase's testable-injection pattern. Flow: repo lookup →
branch gate → `listPushCommits` → `mapWithConcurrency(commits, 5, classify-and-store per §4)`.
The route builds `input` from `payload.before` / `payload.after` / `payload.commits` and calls
`ingestPush` inside `after()`.

New client fns in `integrations/github/github.ts`:
- `listPushCommits(...)` — compare-API enumeration with parents, pagination, the 250 cap, and
  new-branch fallback.
- `getCommitPulls(installationId, repoFullName, sha)` — associated PRs (enough to answer
  "belongs to a merged PR").
- `getCommitDiff` — exists, unchanged.

### 8. Testing

- **`ingestPush`** (injected fakes for all deps): a substantive direct commit → enriched
  `pending`; a **non-PR** merge commit → `ignored/merge_commit` (no enrich); an empty-diff
  commit → `ignored/empty_diff` (no enrich); a merged-PR commit **including a PR merge commit**
  → dropped (not stored); a mixed batch; the classification precedence (PR-drop beats merge
  beats empty); `≥20`/compare enumeration; branch mismatch → nothing; re-delivery deduped;
  over-cap truncation logs + processes the cap.
- **GitHub client fns** (mocked octokit): compare pagination + cap + parents; `commits/{sha}/pulls`
  merged-vs-open discrimination.
- **Data model**: round-trip an `ignored` row with `ignored_reason`.
- **Display helper**: maps `ignored` + reason → the right label; pending/non-facing unchanged.
- **`getBatchableChangeItems`**: still excludes `ignored` rows (already `status = pending` only).
- Route stays thin (verify + schedule via `after`); logic lives in the testable `ingestPush`.

## Scope boundaries (explicitly NOT in this work)

- PR ingestion logic unchanged except removing its `sourceTypes` gate; stays inline, one rich
  PR item.
- PR-associated commits are **dropped**, not shown as ignored (per the chosen scope).
- `source_types` column left vestigial (no migration to drop it, no UI).
- No new background/queue infrastructure — `after()` only.
- No change to generation, enrichment internals, or the manual import path.

## Accepted trade-offs

1. **Ack-fast opts out of GitHub retries** — a post-response failure isn't retried by GitHub;
   mitigated by logging + the manual "Import commits" recovery path.
2. **Over-cap pushes (>250 commits) are truncated with a logged breadcrumb** — rare bulk
   events; recoverable via manual import.
3. **One `commits/{sha}/pulls` call per commit** (PR-association is checked first, so it runs
   for every commit; plus a diff fetch for non-PR, non-merge commits) — the cost of accurate,
   strategy-agnostic dedup + empty-diff detection; affordable now that push processing runs
   after the response with capped concurrency.
