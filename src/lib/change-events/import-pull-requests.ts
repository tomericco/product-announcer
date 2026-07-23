import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { changeEvents, repos } from "@/db/schema";
import { enrichChangeItem, type EnrichChangeItem } from "@/lib/ai/enrich-change-item";
import { resolvePendingEvents } from "@/lib/change-events/pipeline";
import { mapWithConcurrency } from "@/lib/concurrency";

export type PullRequestSelection = {
  repoId: string;
  number: number;
  title: string;
  body: string | null;
  url: string;
  mergedAt: string | null;
};

const ENRICH_CONCURRENCY = 4;

/**
 * Imports user-selected merged pull requests as pending PR-sourced change
 * items. Mirrors `importSelectedCommits`: each repo is loaded tenant-scoped
 * (IDOR guard), the PR is enriched from title+description (no diff — PRs
 * carry no diff fetch), and inserted with `externalId` = `owner/repo#number`.
 * On conflict (same repo + PR number): a previously-dropped (`excluded`) PR
 * is resurrected back to `pending` with fresh content/enrichment; an
 * already-active PR is left untouched. Returns how many PRs were newly
 * imported or resurrected.
 */
export async function importSelectedPullRequests(
  input: { tenantId: string; selections: PullRequestSelection[] },
  deps: {
    enrich?: EnrichChangeItem;
    database?: typeof defaultDb;
    resolvePending?: typeof resolvePendingEvents;
  } = {}
): Promise<{ importedCount: number }> {
  const database = deps.database ?? defaultDb;
  const enrich = deps.enrich ?? enrichChangeItem;
  const resolvePending = deps.resolvePending ?? resolvePendingEvents;
  if (input.selections.length === 0) return { importedCount: 0 };

  const byRepo = new Map<string, PullRequestSelection[]>();
  for (const s of input.selections) {
    const list = byRepo.get(s.repoId) ?? [];
    list.push(s);
    byRepo.set(s.repoId, list);
  }

  let importedCount = 0;
  const resolvableIds: string[] = [];

  for (const [repoId, selections] of byRepo) {
    const [repo] = await database
      .select()
      .from(repos)
      .where(and(eq(repos.id, repoId), eq(repos.tenantId, input.tenantId)))
      .limit(1);
    if (!repo) continue;

    const inserted = await mapWithConcurrency(selections, ENRICH_CONCURRENCY, async (selection) => {
      const enrichment = await enrich({
        tenantId: input.tenantId,
        type: "pull_request",
        repoName: repo.githubRepoFullName,
        prTitle: selection.title,
        prDescription: selection.body,
      });

      const enrichedFields = {
        prTitle: selection.title,
        prDescription: selection.body,
        prUrl: selection.url,
        mergedAt: selection.mergedAt ? new Date(selection.mergedAt) : null,
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
          type: "pull_request",
          provider: "github",
          externalId: `${repo.githubRepoFullName}#${selection.number}`,
          prNumber: selection.number,
          ...enrichedFields,
        })
        .onConflictDoUpdate({
          target: [changeEvents.repoId, changeEvents.prNumber],
          set: { status: "pending", excludedAt: null, excludedBy: null, ...enrichedFields },
          setWhere: eq(changeEvents.status, "excluded"),
        })
        .returning({ id: changeEvents.id });

      return { count: upserted.length, id: upserted[0]?.id, userFacing: enrichment.userFacing };
    });

    importedCount += inserted.reduce((a, b) => a + b.count, 0);
    for (const r of inserted) {
      if (r.count > 0 && r.id && r.userFacing !== false) resolvableIds.push(r.id);
    }
  }

  // `resolvePendingEvents(tenantId, eventIds, deps?)` — positional, matching
  // how `importSelectedCommits` calls it (it does not thread the test db into
  // resolvePending; tests inject a `resolvePending` mock instead).
  if (resolvableIds.length > 0) await resolvePending(input.tenantId, resolvableIds);

  return { importedCount };
}
