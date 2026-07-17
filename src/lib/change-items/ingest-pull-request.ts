import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { repos, changeItems } from "@/db/schema";
import { enrichChangeItem, type EnrichChangeItem } from "@/lib/ai/enrich-change-item";

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

  if (!repo || !repo.sourceTypes.includes("pr")) return;
  if (input.baseBranch !== repo.watchedBranch) return;

  const enrichment = await enrich({
    sourceType: "pr",
    repoName: input.repoFullName,
    prTitle: input.prTitle,
    prDescription: input.prDescription,
  });

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
      userFacing: enrichment.userFacing,
      impactSummary: enrichment.impactSummary,
      suggestedCategory: enrichment.suggestedCategory,
      enrichmentConfidence: enrichment.confidence,
      enrichedAt: new Date(),
    })
    .onConflictDoNothing();
}
