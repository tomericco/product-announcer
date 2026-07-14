import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { repos, changeItems } from "../db/schema";

export type MergedPullRequestInput = {
  installationId: string;
  repoFullName: string;
  baseBranch: string;
  prNumber: number;
  prTitle: string;
  prDescription: string;
  prUrl: string;
  mergedAt: Date;
};

export async function ingestMergedPullRequest(
  input: MergedPullRequestInput,
  database: typeof defaultDb = defaultDb
): Promise<void> {
  const [repo] = await database
    .select()
    .from(repos)
    .where(
      and(eq(repos.githubInstallationId, input.installationId), eq(repos.githubRepoFullName, input.repoFullName))
    )
    .limit(1);

  if (!repo || !repo.sourceTypes.includes("pr")) return;
  if (input.baseBranch !== repo.watchedBranch) return;

  await database
    .insert(changeItems)
    .values({
      tenantId: repo.tenantId,
      repoId: repo.id,
      sourceType: "pr",
      prNumber: input.prNumber,
      prTitle: input.prTitle,
      prDescription: input.prDescription,
      prUrl: input.prUrl,
      mergedAt: input.mergedAt,
    })
    .onConflictDoNothing();
}
