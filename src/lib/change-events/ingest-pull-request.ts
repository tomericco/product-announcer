import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { repos, changeEvents } from "@/db/schema";
import { enrichChangeItem, type EnrichChangeItem } from "@/lib/ai/enrich-change-item";
import { filterPullRequest } from "@/lib/change-events/filter";
import { resolvePendingEvents } from "@/lib/change-events/pipeline";

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

export type IngestPullRequestDeps = {
  enrich?: EnrichChangeItem;
  resolvePending?: typeof resolvePendingEvents;
  database?: typeof defaultDb;
};

export async function ingestMergedPullRequest(
  input: MergedPullRequestInput,
  deps: IngestPullRequestDeps = {}
): Promise<void> {
  const enrich = deps.enrich ?? enrichChangeItem;
  const resolvePending = deps.resolvePending ?? resolvePendingEvents;
  const database = deps.database ?? defaultDb;

  const [repo] = await database
    .select()
    .from(repos)
    .where(
      and(eq(repos.githubInstallationId, input.installationId), eq(repos.githubRepoFullName, input.repoFullName))
    )
    .limit(1);

  if (!repo) return;
  if (input.baseBranch !== repo.watchedBranch) return;

  // PR numbers collide across repos, so the id is namespaced by repo full name.
  // This format must match the Task 1 migration backfill exactly.
  const externalId = `${input.repoFullName}#${input.prNumber}`;

  const base = {
    tenantId: repo.tenantId,
    repoId: repo.id,
    type: "pull_request" as const,
    provider: "github" as const,
    externalId,
    externalUrl: input.prUrl,
    prNumber: input.prNumber,
    prTitle: input.prTitle,
    prDescription: input.prDescription,
    prUrl: input.prUrl,
    mergedAt: input.mergedAt,
  };

  // Tier 1.
  const verdict = filterPullRequest({ title: input.prTitle });
  if (verdict.drop) {
    await database
      .insert(changeEvents)
      .values({ ...base, status: "ignored", filterReason: verdict.reason })
      .onConflictDoNothing();
    return;
  }

  // Tier 2.
  const enrichment = await enrich({
    tenantId: repo.tenantId,
    type: "pull_request",
    repoName: input.repoFullName,
    prTitle: input.prTitle,
    prDescription: input.prDescription,
  });

  const [row] = await database
    .insert(changeEvents)
    .values({
      ...base,
      userFacing: enrichment.userFacing,
      impactSummary: enrichment.impactSummary,
      suggestedCategory: enrichment.suggestedCategory,
      enrichmentConfidence: enrichment.confidence,
      enrichedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: changeEvents.id });

  // Tier 3. `row` is undefined when the conflict clause swallowed a duplicate
  // delivery, in which case the PR was already resolved on the first attempt.
  if (row && enrichment.userFacing) {
    await resolvePending(repo.tenantId, [row.id]);
  }
}
