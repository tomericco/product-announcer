import { App } from "octokit";

// Constructed lazily rather than at module load: octokit's `App` throws
// ("appId option is required") the moment it's instantiated without
// GITHUB_APP_ID set. Building it eagerly would mean that merely importing a
// pure helper like `truncateDiff` — or the push-ingestion DB logic, which
// imports it — requires GitHub App credentials to be present, breaking tests
// and any environment that doesn't need GitHub auth. The memoized getter
// defers construction until a caller actually talks to GitHub.
let _githubApp: App | null = null;

export function getGithubApp(): App {
  if (!_githubApp) {
    _githubApp = new App({
      appId: process.env.GITHUB_APP_ID as string,
      privateKey: (process.env.GITHUB_APP_PRIVATE_KEY as string)?.replace(/\\n/g, "\n"),
    });
  }
  return _githubApp;
}

export async function listAccessibleRepos(
  installationId: string
): Promise<Array<{ fullName: string; defaultBranch: string }>> {
  const installationOctokit = await getGithubApp().getInstallationOctokit(Number(installationId));
  const { data } = await installationOctokit.rest.apps.listReposAccessibleToInstallation();
  return data.repositories.map((repo) => ({
    fullName: repo.full_name,
    defaultBranch: repo.default_branch ?? "main",
  }));
}

export async function listRepoBranches(installationId: string, repoFullName: string): Promise<string[]> {
  const [owner, repo] = repoFullName.split("/");
  const installationOctokit = await getGithubApp().getInstallationOctokit(Number(installationId));
  const branches = await installationOctokit.paginate(installationOctokit.rest.repos.listBranches, {
    owner,
    repo,
    per_page: 100,
  });
  return branches.map((b) => b.name);
}

export type RepoCommit = {
  sha: string;
  message: string;
  url: string;
  committedAt: string | null;
  authorName: string | null;
};

export async function listRepoCommits(
  installationId: string,
  repoFullName: string,
  branch: string,
  opts: { since?: string; until?: string } = {}
): Promise<RepoCommit[]> {
  const [owner, repo] = repoFullName.split("/");
  const installationOctokit = await getGithubApp().getInstallationOctokit(Number(installationId));
  const { data } = await installationOctokit.rest.repos.listCommits({
    owner,
    repo,
    sha: branch,
    since: opts.since,
    until: opts.until,
    per_page: 100,
  });
  return data.map((c) => ({
    sha: c.sha,
    message: c.commit.message,
    url: c.html_url,
    committedAt: c.commit.author?.date ?? c.commit.committer?.date ?? null,
    authorName: c.commit.author?.name ?? c.author?.login ?? null,
  }));
}

export type RepoPullRequest = {
  number: number;
  title: string;
  body: string | null;
  url: string;
  mergedAt: string | null;
  authorName: string | null;
};

export async function listRepoPullRequests(
  installationId: string,
  repoFullName: string,
  base: string,
  opts: { since?: string; until?: string } = {}
): Promise<RepoPullRequest[]> {
  const [owner, repo] = repoFullName.split("/");
  const installationOctokit = await getGithubApp().getInstallationOctokit(Number(installationId));
  // Closed PRs targeting the watched branch, newest-updated first. Only MERGED
  // ones are shipped changes, so filter out closed-unmerged (merged_at null).
  const prs = await installationOctokit.paginate(installationOctokit.rest.pulls.list, {
    owner,
    repo,
    state: "closed",
    base,
    sort: "updated",
    direction: "desc",
    per_page: 100,
  });
  // GitHub's pulls.list has no merge-date filter, so bound by merged_at here —
  // this powers the import dialog's After/Before filters on the PR tab.
  const sinceMs = opts.since ? Date.parse(opts.since) : null;
  const untilMs = opts.until ? Date.parse(opts.until) : null;
  return prs
    .filter((pr) => pr.merged_at != null)
    .filter((pr) => {
      const t = Date.parse(pr.merged_at as string);
      if (sinceMs !== null && t < sinceMs) return false;
      if (untilMs !== null && t > untilMs) return false;
      return true;
    })
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      body: pr.body ?? null,
      url: pr.html_url,
      mergedAt: pr.merged_at ?? null,
      authorName: pr.user?.login ?? null,
    }));
}

export async function getCommitDiff(
  installationId: string,
  repoFullName: string,
  sha: string
): Promise<string> {
  const [owner, repo] = repoFullName.split("/");
  const installationOctokit = await getGithubApp().getInstallationOctokit(Number(installationId));
  const { data: commit } = await installationOctokit.rest.repos.getCommit({ owner, repo, ref: sha });
  return (commit.files ?? []).map((f) => f.patch ?? "").join("\n");
}

export function truncateDiff(diff: string, maxLines = 200): string {
  const lines = diff.split("\n");
  if (lines.length <= maxLines) return diff;

  const kept = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;
  return [...kept, `… (truncated, ${remaining} more lines)`].join("\n");
}

const ZERO_SHA_RE = /^0+$/;
const MAX_PUSH_COMMITS = 250;

export type PushCommit = {
  sha: string;
  message: string;
  url: string;
  committedAt: string | null;
  parents: string[];
};

// Caps the per-push commit list, logging a breadcrumb when it truncates so the
// dropped range is discoverable (recoverable via manual import).
export function capPushCommits<T>(
  commits: T[],
  cap: number,
  ctx: { repoFullName: string; before: string; after: string }
): T[] {
  if (commits.length <= cap) return commits;
  console.warn(
    `[ingest-push] truncated push for ${ctx.repoFullName} ${ctx.before}...${ctx.after}: ` +
      `${commits.length} commits, processing first ${cap}, skipping ${commits.length - cap}`
  );
  return commits.slice(0, cap);
}

export async function listPushCommits(
  installationId: string,
  repoFullName: string,
  range: {
    before: string;
    after: string;
    payloadCommits: Array<{ id: string; message: string; url: string; timestamp: string }>;
  }
): Promise<PushCommit[]> {
  // New-branch push: no base commit to compare against — fall back to the payload
  // commits (which carry no parent info, so none are classified as merge commits).
  // GitHub caps the webhook payload's `commits` array at 20; a push that hits that
  // cap on a brand-new branch may have dropped earlier commits with no compare base
  // available to enumerate them, so leave a breadcrumb.
  if (!range.before || ZERO_SHA_RE.test(range.before)) {
    if (range.payloadCommits.length >= 20) {
      console.warn(
        `[ingest-push] new-branch push for ${repoFullName} (...${range.after}): ` +
          `${range.payloadCommits.length} payload commits — GitHub's payload cap may have truncated earlier commits, no compare base to enumerate`
      );
    }
    return range.payloadCommits.map((c) => ({
      sha: c.id,
      message: c.message,
      url: c.url,
      committedAt: c.timestamp,
      parents: [],
    }));
  }

  const [owner, repo] = repoFullName.split("/");
  const installationOctokit = await getGithubApp().getInstallationOctokit(Number(installationId));

  type RawCommit = {
    sha: string;
    html_url: string;
    commit: {
      message: string;
      author?: { date?: string } | null;
      committer?: { date?: string } | null;
    };
    parents: Array<{ sha: string }>;
  };

  // Use `paginate.iterator` (rather than `paginate()`) so we can read `total_commits`
  // off each raw page envelope: it's the API's TRUE count of commits in the range,
  // separate from — and not reducible from — the `commits` array itself, which
  // `paginate()`'s mapFn form (see extraction below) discards along with the rest of
  // the envelope. `total_commits` is constant across pages (it describes the whole
  // comparison), so the last page's value wins.
  //
  // The compare-commits response has a top-level `url` field, so a bare accumulation
  // of `response.data` would NOT be individual commits — must still extract
  // `.data.commits` per page, same precaution as the old mapFn form, to avoid
  // silently collecting whole compare envelopes instead of commits.
  let totalCommits = 0;
  const rawCommits: RawCommit[] = [];
  const iterator = installationOctokit.paginate.iterator(
    installationOctokit.rest.repos.compareCommitsWithBasehead,
    {
      owner,
      repo,
      basehead: `${range.before}...${range.after}`,
      per_page: 100,
    }
  );
  for await (const response of iterator) {
    const data = (response as unknown as { data: { total_commits: number; commits: RawCommit[] } }).data;
    totalCommits = data.total_commits;
    rawCommits.push(...data.commits);
  }

  const mapped: PushCommit[] = rawCommits.map((c) => ({
    sha: c.sha,
    message: c.commit.message,
    url: c.html_url,
    committedAt: c.commit.author?.date ?? c.commit.committer?.date ?? null,
    parents: (c.parents ?? []).map((p) => p.sha),
  }));

  const result = capPushCommits(mapped, MAX_PUSH_COMMITS, { repoFullName, before: range.before, after: range.after });

  // Real truncation detection: GitHub's compare API itself caps the `commits` array
  // (regardless of pagination) well below `total_commits` for large ranges, so
  // `capPushCommits`'s own over-cap check rarely fires in practice. Compare against
  // the authoritative `total_commits` instead.
  if (totalCommits > result.length) {
    console.warn(
      `[ingest-push] truncated push for ${repoFullName} ${range.before}...${range.after}: ` +
        `total_commits=${totalCommits}, processed=${result.length}, skipped=${totalCommits - result.length}`
    );
  }

  return result;
}

export async function getCommitPulls(
  installationId: string,
  repoFullName: string,
  sha: string
): Promise<Array<{ number: number; merged: boolean; baseRef: string }>> {
  const [owner, repo] = repoFullName.split("/");
  const installationOctokit = await getGithubApp().getInstallationOctokit(Number(installationId));
  const { data } = await installationOctokit.rest.repos.listPullRequestsAssociatedWithCommit({
    owner,
    repo,
    commit_sha: sha,
  });
  return data.map((pr) => ({ number: pr.number, merged: pr.merged_at != null, baseRef: pr.base.ref }));
}
