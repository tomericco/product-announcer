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
  if (!range.before || ZERO_SHA_RE.test(range.before)) {
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

  // Must use the map-callback form: the compare-commits response has a top-level `url`
  // field, so `@octokit/plugin-paginate-rest`'s normalizer does NOT reduce each page to
  // its `commits` array automatically (unlike e.g. listBranches). Without an explicit
  // mapFn, `paginate` would return the whole compare objects (one per page) instead of
  // individual commits, breaking the `.map` below. The response `data` has two
  // array-valued keys (`commits` and `files`), which defeats inference on the mapFn
  // parameter — annotate it explicitly rather than dropping it.
  const commits = await installationOctokit.paginate(
    installationOctokit.rest.repos.compareCommitsWithBasehead,
    {
      owner,
      repo,
      basehead: `${range.before}...${range.after}`,
      per_page: 100,
    },
    (response) =>
      (
        response as unknown as {
          data: {
            commits: Array<{
              sha: string;
              html_url: string;
              commit: {
                message: string;
                author?: { date?: string } | null;
                committer?: { date?: string } | null;
              };
              parents: Array<{ sha: string }>;
            }>;
          };
        }
      ).data.commits
  );

  const mapped: PushCommit[] = commits.map((c) => ({
    sha: c.sha,
    message: c.commit.message,
    url: c.html_url,
    committedAt: c.commit.author?.date ?? c.commit.committer?.date ?? null,
    parents: (c.parents ?? []).map((p) => p.sha),
  }));

  return capPushCommits(mapped, MAX_PUSH_COMMITS, { repoFullName, before: range.before, after: range.after });
}

export async function getCommitPulls(
  installationId: string,
  repoFullName: string,
  sha: string
): Promise<Array<{ number: number; merged: boolean }>> {
  const [owner, repo] = repoFullName.split("/");
  const installationOctokit = await getGithubApp().getInstallationOctokit(Number(installationId));
  const { data } = await installationOctokit.rest.repos.listPullRequestsAssociatedWithCommit({
    owner,
    repo,
    commit_sha: sha,
  });
  return data.map((pr) => ({ number: pr.number, merged: pr.merged_at != null }));
}
