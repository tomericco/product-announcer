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
   a `push` to the base branch containing the merge/squash/rebased commits (→ commit change
   items) — the same work ingested twice. Only push commits that originated from a PR merge
   overlap; direct pushes correctly produce only commit items.
2. **20-commit cap.** GitHub's push payload includes at most 20 commits; larger pushes
   silently lose the rest.
3. **Webhook timeout.** Enrichment + diff-fetch run inline per commit in the request; a large
   push can exceed GitHub's ~10s delivery timeout, causing GitHub to mark delivery failed and
   retry.

## Goal

Ingest merged PRs and pushed commits for every watched repo, keep a merged PR as a single
rich PR item (dropping its commits from the push to avoid duplication), and process pushes
robustly regardless of size.

## Design

### 1. Always ingest both PR and commit changes

Remove the `sourceTypes` gates: `ingestPush` drops
`if (!repo || !repo.sourceTypes.includes("commit")) return;` and `ingestMergedPullRequest`
([ingest-pull-request.ts:30](../../../src/lib/change-items/ingest-pull-request.ts)) drops
`if (!repo || !repo.sourceTypes.includes("pr")) return;` — each keeps only the `!repo` /
branch guards. Both paths now run for any matched repo. The `source_types` column becomes
vestigial; it is **left in place** (dropping it is a follow-up migration, out of scope).

### 2. Ack fast, process pushes after the response

The webhook route
([src/app/api/webhooks/github/route.ts](../../../src/app/api/webhooks/github/route.ts))
verifies the signature, and for a `push`: returns `200` immediately and schedules the ingest
work with **Next.js `after()`** (`next/server`) so it runs after the response, in the same
function invocation (up to its 300s limit). This removes the ~10s delivery-timeout risk.
PR ingestion (one item, one enrichment call) stays **inline** — it is bounded.

**Trade-off:** acking `200` opts out of GitHub's automatic retry. Post-response errors are
logged; a missed push is recoverable via the existing manual "Import commits" dialog.

*(The plan will first verify `after` from `next/server` exists and behaves as expected in this
repo's Next version; the approved fallback if not is persist-and-cron.)*

### 3. Full commit enumeration (fix the 20-commit cap)

`listPushCommits(installationId, repoFullName, { before, after, payloadCommits })`:
- If `payloadCommits.length < 20`, use them directly (definitely not truncated).
- Otherwise enumerate the real range via the compare API
  (`GET /repos/{o}/{r}/compare/{before}...{after}`), **paginated**, **capped at 250** commits.
- Beyond the cap: process the first 250 and **log a truncation breadcrumb** — repo, watched
  branch, `before→after` range, total commit count, and skipped count — so the drop is
  discoverable in server logs (the skipped range stays recoverable via manual import).
- New-branch pushes (`before` all-zeros) fall back to `payloadCommits`.

### 4. Per-commit PR-merge dedup

`getCommitPulls(installationId, repoFullName, sha)` calls
`GET /repos/{o}/{r}/commits/{sha}/pulls`. A commit is **skipped** when it belongs to a **merged**
PR (that PR is its own rich item); it is **kept** otherwise (a direct commit, or a commit only
in an open/unmerged PR). Accurate across squash / merge / rebase strategies and race-free —
GitHub's association is authoritative regardless of which event we process first.

### 5. Refactored `ingestPush`

`ingestPush(input, deps)` where `input = { installationId, repoFullName, ref, before, after, payloadCommits }`
and `deps` injects `{ listPushCommits, getCommitPulls, getCommitDiff, enrich, database }`
(all with real defaults) — matching the codebase's testable-injection pattern. Flow:

1. Look up the repo (installationId + repoFullName); return if not found.
2. Branch gate: `ref === refs/heads/<watchedBranch>`, else return.
3. `listPushCommits(...)` → the full commit list (§3).
4. `mapWithConcurrency(commits, 5, …)`: for each commit — `getCommitPulls` → skip if
   merged-PR-associated; else `getCommitDiff` → `enrich` → insert with `onConflictDoNothing`
   (unchanged re-delivery guard). Fields as today (§enrichment from sub-project A).

The route builds `input` from the push payload (`payload.before`, `payload.after`,
`payload.commits`) and invokes `ingestPush` inside `after()`.

### 6. GitHub client additions (`integrations/github/github.ts`)

- `listPushCommits(...)` — compare-API enumeration with pagination + the 250 cap + payload
  fast-path.
- `getCommitPulls(installationId, repoFullName, sha)` — associated PRs for a commit (enough to
  answer "belongs to a merged PR").
- `getCommitDiff` — exists, unchanged.

### 7. Testing

- **`ingestPush`** (injected fakes for all deps): direct commits ingested; a merged-PR commit
  skipped; a mixed batch (some PR, some direct); the `≥20` path enumerates via
  `listPushCommits`; branch mismatch → nothing; re-delivery deduped via `onConflictDoNothing`;
  over-cap truncation logs and processes the cap.
- **GitHub client fns** (mocked octokit): compare pagination + cap; `commits/{sha}/pulls`
  merged-vs-open discrimination.
- **Route** stays thin (verify + schedule via `after`); the testable logic lives in
  `ingestPush`, so no brittle route test is needed.

## Scope boundaries (explicitly NOT in this work)

- PR ingestion logic is unchanged except removing the `sourceTypes` gate; it stays inline and
  still creates a single rich PR item.
- `source_types` column is left vestigial (no migration, no UI).
- No new background/queue infrastructure — `after()` only.
- No change to generation, enrichment internals, or the manual import path.

## Accepted trade-offs

1. **Ack-fast opts out of GitHub retries** — a post-response processing failure won't be
   retried by GitHub. Mitigated by internal error logging and the manual "Import commits"
   recovery path.
2. **Over-cap pushes (>250 commits) are truncated with a logged breadcrumb** rather than fully
   processed — rare bulk events; the skipped range is recoverable via manual import.
3. **One `commits/{sha}/pulls` API call per candidate commit** (plus the diff fetch) — the cost
   of accurate, strategy-agnostic dedup; affordable because push processing now runs after the
   response with capped concurrency.
