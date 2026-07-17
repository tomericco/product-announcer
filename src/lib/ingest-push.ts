import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { repos, changeItems } from "../db/schema";
import { truncateDiff } from "./github";
import { mapWithConcurrency } from "./concurrency";
import { enrichChangeItem, type EnrichChangeItem } from "@/lib/ai/enrich-change-item";

export type PushInput = {
  installationId: string;
  repoFullName: string;
  ref: string;
  commits: Array<{ id: string; message: string; url: string; timestamp: string }>;
};

export type GetCommitDiff = (owner: string, repo: string, sha: string) => Promise<string>;

const ENRICH_CONCURRENCY = 5;

export async function ingestPush(
  input: PushInput,
  getCommitDiff: GetCommitDiff,
  enrich: EnrichChangeItem = enrichChangeItem,
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

  await mapWithConcurrency(input.commits, ENRICH_CONCURRENCY, async (commit) => {
    const diff = truncateDiff(await getCommitDiff(owner, repoName, commit.id));
    const enrichment = await enrich({
      sourceType: "commit",
      repoName: input.repoFullName,
      commitMessage: commit.message,
      diff,
    });

    await database
      .insert(changeItems)
      .values({
        tenantId: repo.tenantId,
        repoId: repo.id,
        sourceType: "commit",
        commitSha: commit.id,
        commitMessage: commit.message,
        commitUrl: commit.url,
        committedAt: new Date(commit.timestamp),
        diff,
        userFacing: enrichment.userFacing,
        impactSummary: enrichment.impactSummary,
        suggestedCategory: enrichment.suggestedCategory,
        enrichmentConfidence: enrichment.confidence,
        enrichedAt: new Date(),
      })
      .onConflictDoNothing();
  });
}
