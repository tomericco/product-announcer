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
