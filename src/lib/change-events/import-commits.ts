import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { repos, changeEvents } from "@/db/schema";
import { truncateDiff } from "@/lib/integrations/github/github";
import { mapWithConcurrency } from "@/lib/concurrency";
import { enrichChangeItem, type EnrichChangeItem } from "@/lib/ai/enrich-change-item";

export type CommitSelection = {
  repoId: string;
  sha: string;
  message: string;
  url: string;
  committedAt: string | null;
};

export type GetCommitDiff = (
  installationId: string,
  repoFullName: string,
  sha: string
) => Promise<string>;

const ENRICH_CONCURRENCY = 5;

/**
 * Imports user-selected commits as pending commit-sourced change items.
 *
 * Unlike push ingestion, this ignores the repo's configured `sourceTypes` — the
 * user is explicitly choosing these commits. Each repo is loaded tenant-scoped
 * (IDOR guard), the diff is fetched and the commit enriched per item (capped
 * concurrency). On conflict: a previously-dropped (`excluded`) commit is
 * resurrected back to `pending` with fresh content/enrichment; an already-active
 * (pending/batched/…) commit is left untouched. Returns how many commits were
 * newly imported or resurrected.
 */
export async function importSelectedCommits(
  input: { tenantId: string; selections: CommitSelection[] },
  getCommitDiff: GetCommitDiff,
  enrich: EnrichChangeItem = enrichChangeItem,
  database: typeof defaultDb = defaultDb
): Promise<{ importedCount: number }> {
  if (input.selections.length === 0) return { importedCount: 0 };

  const byRepo = new Map<string, CommitSelection[]>();
  for (const selection of input.selections) {
    const list = byRepo.get(selection.repoId) ?? [];
    list.push(selection);
    byRepo.set(selection.repoId, list);
  }

  let importedCount = 0;

  for (const [repoId, selections] of byRepo) {
    const [repo] = await database
      .select()
      .from(repos)
      .where(and(eq(repos.id, repoId), eq(repos.tenantId, input.tenantId)))
      .limit(1);
    if (!repo) continue;

    const insertedCounts = await mapWithConcurrency(selections, ENRICH_CONCURRENCY, async (selection) => {
      const diff = truncateDiff(await getCommitDiff(repo.githubInstallationId, repo.githubRepoFullName, selection.sha));
      const enrichment = await enrich({
        tenantId: input.tenantId,
        type: "commit",
        repoName: repo.githubRepoFullName,
        commitMessage: selection.message,
        diff,
      });

      const committedAt = selection.committedAt ? new Date(selection.committedAt) : null;
      // Deliberately omits `releasedAt`. The list-commits API carries no
      // branch-landing time, so an import can only ever leave it null — and
      // including it here would wipe the real push time off a row that first
      // arrived via the webhook. New import-only rows keep the column null.
      const enrichedFields = {
        commitMessage: selection.message,
        commitUrl: selection.url,
        committedAt,
        diff,
        userFacing: enrichment.userFacing,
        impactSummary: enrichment.impactSummary,
        suggestedCategory: enrichment.suggestedCategory,
        enrichmentConfidence: enrichment.confidence,
        enrichedAt: new Date(),
      };

      const upserted = await database
        .insert(changeEvents)
        .values({
          tenantId: input.tenantId,
          repoId: repo.id,
          type: "commit",
          provider: "github",
          externalId: selection.sha,
          commitSha: selection.sha,
          ...enrichedFields,
        })
        // Re-importing a dropped commit resurrects it to pending (clearing the
        // exclusion) with fresh content; a still-active row is not touched, so the
        // returned-rows count only reflects genuine (re)imports.
        .onConflictDoUpdate({
          target: [changeEvents.repoId, changeEvents.commitSha],
          set: { status: "pending", excludedAt: null, excludedBy: null, ...enrichedFields },
          setWhere: eq(changeEvents.status, "excluded"),
        })
        .returning({ id: changeEvents.id });

      return upserted.length;
    });

    importedCount += insertedCounts.reduce((a, b) => a + b, 0);
  }

  // Deliberately does not call resolvePendingEvents here. In phase 1 the
  // resolver only runs over freshly ingested webhook events; manually
  // imported (and other pre-existing) rows are not auto-resolved into
  // atomic updates, so imported commits stay as standalone pending items.
  return { importedCount };
}
