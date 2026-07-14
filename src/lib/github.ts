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

export function truncateDiff(diff: string, maxLines = 200): string {
  const lines = diff.split("\n");
  if (lines.length <= maxLines) return diff;

  const kept = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;
  return [...kept, `… (truncated, ${remaining} more lines)`].join("\n");
}
