import { and, eq, ne, notInArray } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { atomicUpdates, signals } from "@/db/schema";

export type ShippedWorkDeps = { database?: typeof defaultDb };

/**
 * Reconciles atomic updates into `shipped_work` signals.
 *
 * A reconciler rather than a hook at creation: atomic updates are inserted in
 * three places with no shared helper, so a fourth site added later would
 * silently stop producing signals. Reconciling is idempotent, self-healing, and
 * gets hide/unhide for free — a hidden update's signal disappears and comes back
 * when it is unhidden.
 *
 * `externalId` is the atomic update's id, so the unique index on
 * (tenantId, kind, externalId) is what makes the upsert safe.
 */
export async function syncShippedWorkSignals(deps: ShippedWorkDeps = {}): Promise<void> {
  const database = deps.database ?? defaultDb;

  let visible: Array<{
    id: string;
    tenantId: string;
    title: string;
    summary: string;
    createdAt: Date;
  }>;
  try {
    visible = await database
      .select({
        id: atomicUpdates.id,
        tenantId: atomicUpdates.tenantId,
        title: atomicUpdates.title,
        summary: atomicUpdates.summary,
        createdAt: atomicUpdates.createdAt,
      })
      .from(atomicUpdates)
      .where(ne(atomicUpdates.status, "hidden"));
  } catch (error) {
    // Nothing to reconcile against without the candidate list. Log and
    // return — next run retries. Matches resolve-sweep's posture.
    console.error("[shipped-work-signals] failed to load candidate atomic updates:", error);
    return;
  }

  // Each update's upsert gets its own try/catch, same as resolve-sweep scopes
  // failure per tenant: one bad row must not abort the loop for every other
  // atomic update across every tenant, nor skip the withdrawal delete below.
  for (const update of visible) {
    try {
      await database
        .insert(signals)
        .values({
          tenantId: update.tenantId,
          kind: "shipped_work",
          externalId: update.id,
          title: update.title,
          excerpt: update.summary,
          occurredAt: update.createdAt,
          atomicUpdateId: update.id,
        })
        .onConflictDoUpdate({
          target: [signals.tenantId, signals.kind, signals.externalId],
          // Refresh only what can change upstream. Never touch relevanceScore,
          // topics or status — those belong to whatever scored or cited this
          // signal, and a re-sync must not undo them.
          set: { title: update.title, excerpt: update.summary, atomicUpdateId: update.id },
        });
    } catch (error) {
      console.error(`[shipped-work-signals] upsert failed for atomic update ${update.id}:`, error);
    }
  }

  // Withdraw signals whose atomic update went away or was hidden. Scoped to
  // this kind so no other producer's rows are ever touched. `visibleIds`
  // comes from the select above, not from which upserts succeeded, so a
  // failed upsert cannot cause a wrongful withdrawal here.
  const visibleIds = visible.map((update) => update.id);
  try {
    await database.delete(signals).where(
      visibleIds.length > 0
        ? and(eq(signals.kind, "shipped_work"), notInArray(signals.externalId, visibleIds))
        : eq(signals.kind, "shipped_work")
    );
  } catch (error) {
    console.error("[shipped-work-signals] withdrawal delete failed:", error);
  }
}
