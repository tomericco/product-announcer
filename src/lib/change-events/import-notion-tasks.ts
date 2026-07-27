import { eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { changeEvents } from "@/db/schema";
import { enrichChangeItem, type EnrichChangeItem } from "@/lib/ai/enrich-change-item";
import { resolvePendingEvents } from "@/lib/change-events/pipeline";

export type TaskImportSelection = {
  pageId: string;
  title: string;
  url: string;
  completedAt: string | null;
};

/**
 * Imports user-selected (Done) Notion tasks as pending task-sourced change
 * items. Mirrors `importSelectedPullRequests`: tasks aren't repo-scoped, so
 * there's no per-repo grouping/IDOR guard here. Each selection's page body is
 * fetched via the caller-supplied `getBody` (a failure there logs and skips
 * just that selection, mirroring the webhook's per-item fail-safe), then
 * enriched and inserted with `externalId` = the Notion page id.
 *
 * On conflict (same tenant + provider + externalId): a previously-dropped
 * (`excluded`) task is resurrected back to `pending` with fresh
 * content/enrichment; an already-active task is left untouched. Returns how
 * many tasks were newly imported or resurrected.
 *
 * Deliberately skips tier-1 filtering (`filterTask`) — the user explicitly
 * selected these, exactly as `importSelectedPullRequests` does not run
 * `filterPullRequest`.
 */
export async function importSelectedTasks(
  input: { tenantId: string; selections: TaskImportSelection[] },
  getBody: (pageId: string) => Promise<string>,
  deps: {
    enrich?: EnrichChangeItem;
    database?: typeof defaultDb;
    resolvePending?: typeof resolvePendingEvents;
  } = {}
): Promise<{ importedCount: number; eventIds: string[] }> {
  const database = deps.database ?? defaultDb;
  const enrich = deps.enrich ?? enrichChangeItem;
  const resolvePending = deps.resolvePending ?? resolvePendingEvents;
  if (input.selections.length === 0) return { importedCount: 0, eventIds: [] };

  let importedCount = 0;
  const resolvableIds: string[] = [];
  const insertedIds: string[] = [];

  for (const selection of input.selections) {
    let description: string;
    try {
      description = await getBody(selection.pageId);
    } catch (error) {
      console.error(`Failed to fetch body for Notion task ${selection.pageId}:`, error);
      continue;
    }

    const enrichment = await enrich({
      tenantId: input.tenantId,
      type: "task",
      repoName: "",
      taskTitle: selection.title,
      taskDescription: description || null,
    });

    const enrichedFields = {
      taskTitle: selection.title,
      taskDescription: description || null,
      externalUrl: selection.url,
      completedAt: selection.completedAt ? new Date(selection.completedAt) : new Date(),
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
        repoId: null,
        type: "task",
        provider: "notion",
        externalId: selection.pageId,
        ...enrichedFields,
      })
      .onConflictDoUpdate({
        target: [changeEvents.tenantId, changeEvents.provider, changeEvents.externalId],
        set: { status: "pending", excludedAt: null, excludedBy: null, ...enrichedFields },
        setWhere: eq(changeEvents.status, "excluded"),
      })
      .returning({ id: changeEvents.id });

    if (upserted.length > 0 && upserted[0]?.id) {
      importedCount += 1;
      insertedIds.push(upserted[0].id);
      if (enrichment.userFacing !== false) resolvableIds.push(upserted[0].id);
    }
  }

  if (resolvableIds.length > 0) await resolvePending(input.tenantId, resolvableIds);

  return { importedCount, eventIds: insertedIds };
}
