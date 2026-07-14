import { App } from "octokit";

export const githubApp = new App({
  appId: process.env.GITHUB_APP_ID as string,
  privateKey: (process.env.GITHUB_APP_PRIVATE_KEY as string)?.replace(/\\n/g, "\n"),
});

export async function listAccessibleRepos(
  installationId: string
): Promise<Array<{ fullName: string; defaultBranch: string }>> {
  const installationOctokit = await githubApp.getInstallationOctokit(Number(installationId));
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
