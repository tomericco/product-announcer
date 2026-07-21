import { and, eq, inArray, isNull } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { changeEvents, repos } from "@/db/schema";
import {
  resolveAtomicUpdates,
  RESOLVER_BATCH_SIZE,
  type ResolverEvent,
} from "@/lib/ai/resolve-atomic-updates";
import { refreshAtomicUpdates } from "@/lib/ai/regenerate-atomic-summary";
import { applyResolutionInTx, loadOpenAtomicUpdates, withTenantLock } from "./apply-resolution";

export type PipelineDeps = {
  resolve?: typeof resolveAtomicUpdates;
  refresh?: typeof refreshAtomicUpdates;
  database?: typeof defaultDb;
};

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Tier 3. Takes the ids of freshly ingested, user-facing change events and
 * resolves them into atomic updates as one batch per chunk.
 *
 * Chunks are resolved sequentially, each reloading the open set, so an event in
 * chunk 2 can attach to an atomic update chunk 1 just created.
 */
export async function resolvePendingEvents(
  tenantId: string,
  eventIds: string[],
  deps: PipelineDeps = {}
): Promise<void> {
  const database = deps.database ?? defaultDb;
  const resolve = deps.resolve ?? resolveAtomicUpdates;
  const refresh = deps.refresh ?? refreshAtomicUpdates;
  if (eventIds.length === 0) return;

  const rows = await database
    .select({
      id: changeEvents.id,
      type: changeEvents.type,
      prTitle: changeEvents.prTitle,
      commitMessage: changeEvents.commitMessage,
      impactSummary: changeEvents.impactSummary,
      repoName: repos.githubRepoFullName,
    })
    .from(changeEvents)
    .leftJoin(repos, eq(changeEvents.repoId, repos.id))
    .where(
      and(
        inArray(changeEvents.id, eventIds),
        eq(changeEvents.tenantId, tenantId),
        eq(changeEvents.userFacing, true),
        isNull(changeEvents.atomicUpdateId)
      )
    );
  if (rows.length === 0) return;

  const events: ResolverEvent[] = rows.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.prTitle ?? r.commitMessage ?? "",
    summary: r.impactSummary,
    repoName: r.repoName,
  }));

  const touched = new Set<string>();

  for (const batch of chunk(events, RESOLVER_BATCH_SIZE)) {
    // The lock spans loading the candidate set and applying the plan, so a
    // concurrent push cannot create a duplicate atomic update in between.
    const actions = await withTenantLock(database, tenantId, async (tx) => {
      const open = await loadOpenAtomicUpdates(tx, tenantId);
      const plan = await resolve({ tenantId, events: batch, open });
      // Applied under the SAME lock and transaction that loaded `open`. Applying
      // in a separate transaction would release the lock between deciding and
      // writing — the exact window in which a concurrent push reads a stale
      // candidate set and creates a duplicate.
      await applyResolutionInTx(tx, tenantId, plan);
      return plan;
    });

    for (const action of actions) {
      if (action.action === "assign") touched.add(action.atomicUpdateId);
    }
  }

  // Only assignments change an existing atomic update's meaning. A freshly
  // created one was written from its evidence a moment ago.
  if (touched.size > 0) await refresh(database, tenantId, [...touched]);
}
