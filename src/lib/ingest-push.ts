import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { repos, changeItems } from "../db/schema";
import { truncateDiff } from "./github";

export type PushInput = {
  installationId: string;
  repoFullName: string;
  ref: string;
  commits: Array<{ id: string; message: string; url: string; timestamp: string }>;
};

export type GetCommitDiff = (owner: string, repo: string, sha: string) => Promise<string>;

export async function ingestPush(
  input: PushInput,
  getCommitDiff: GetCommitDiff,
  database: typeof defaultDb = defaultDb
): Promise<void> {
  const [repo] = await database
    .select()
    .from(repos)
    .where(
      and(eq(repos.githubInstallationId, input.installationId), eq(repos.githubRepoFullName, input.repoFullName))
    )
    .limit(1);

  if (!repo || !repo.sourceTypes.includes("commit")) return;
  if (input.ref !== `refs/heads/${repo.watchedBranch}`) return;

  const [owner, repoName] = input.repoFullName.split("/");

  for (const commit of input.commits) {
    const rawDiff = await getCommitDiff(owner, repoName, commit.id);

    await database.insert(changeItems).values({
      tenantId: repo.tenantId,
      repoId: repo.id,
      sourceType: "commit",
      commitSha: commit.id,
      commitMessage: commit.message,
      commitUrl: commit.url,
      committedAt: new Date(commit.timestamp),
      diff: truncateDiff(rawDiff),
    });
  }
}
