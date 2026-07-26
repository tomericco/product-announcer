import { db as defaultDb } from "@/db";
import { changeEvents } from "@/db/schema";
import { enrichChangeItem, type EnrichChangeItem } from "@/lib/ai/enrich-change-item";
import { filterTask } from "@/lib/change-events/filter";
import { resolvePendingEvents } from "@/lib/change-events/pipeline";

export type NotionTaskInput = {
  tenantId: string;
  pageId: string;
  title: string;
  description: string | null;
  url: string;
  completedAt: Date;
};

export type IngestNotionTaskDeps = {
  enrich?: EnrichChangeItem;
  resolvePending?: typeof resolvePendingEvents;
  database?: typeof defaultDb;
};

export async function ingestNotionTask(input: NotionTaskInput, deps: IngestNotionTaskDeps = {}): Promise<void> {
  const enrich = deps.enrich ?? enrichChangeItem;
  const resolvePending = deps.resolvePending ?? resolvePendingEvents;
  const database = deps.database ?? defaultDb;

  const base = {
    tenantId: input.tenantId,
    repoId: null,
    type: "task" as const,
    provider: "notion" as const,
    externalId: input.pageId,
    externalUrl: input.url,
    taskTitle: input.title,
    taskDescription: input.description,
    completedAt: input.completedAt,
  };

  // Tier 1.
  const verdict = filterTask({ title: input.title, description: input.description });
  if (verdict.drop) {
    await database
      .insert(changeEvents)
      .values({ ...base, status: "ignored", filterReason: verdict.reason })
      .onConflictDoNothing();
    return;
  }

  // Tier 2.
  const enrichment = await enrich({
    tenantId: input.tenantId,
    type: "task",
    repoName: "",
    taskTitle: input.title,
    taskDescription: input.description,
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

  // Tier 3. `row` is undefined when the unique (tenantId, provider, externalId)
  // conflict swallowed a duplicate delivery — the task already resolved on the
  // first arrival, so do not resolve again.
  if (row && enrichment.userFacing) {
    await resolvePending(input.tenantId, [row.id]);
  }
}
