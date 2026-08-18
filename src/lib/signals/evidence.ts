import { and, asc, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { atomicUpdates, changeEvents, signals } from "@/db/schema";
import { eventLabel } from "@/lib/change-events/event-label";

type Database = typeof defaultDb;

export type EvidenceEvent = {
  id: string;
  type: (typeof changeEvents.$inferSelect)["type"];
  provider: (typeof changeEvents.$inferSelect)["provider"];
  label: string;
  externalUrl: string | null;
  createdAt: Date;
};

export type SignalEvidence = {
  atomicUpdateId: string;
  title: string;
  summary: string;
  category: (typeof atomicUpdates.$inferSelect)["category"];
  size: (typeof atomicUpdates.$inferSelect)["size"];
  hidden: boolean;
  /**
   * `status = 'open'` — whether the curation mutations behind the drawer will
   * actually apply. This read applies no status filter (unlike
   * `listAtomicUpdates`, which shows open+unclaimed only), because
   * `syncShippedWorkSignals` leaves a signal in place for a released atomic
   * update: the row is still in the feed, so the drawer still opens on it.
   * What must not happen is the drawer offering a Save that the
   * `status='open'` guard on `editAtomicUpdate`/`setAtomicUpdateSize`/
   * `setAtomicUpdateCategory` will silently refuse — so it renders read-only
   * instead, the same treatment `hidden` already gets.
   */
  editable: boolean;
  events: EvidenceEvent[];
};

/**
 * One signal's evidence: the atomic update it mirrors, plus the change events
 * behind that update.
 *
 * Returns null when the signal has no `atomicUpdateId` — every non-shipped_work
 * kind, and a shipped_work signal whose atomic update was deleted (the FK is
 * ON DELETE SET NULL, because the signal is the durable record of what
 * happened). The drawer renders nothing in that case rather than an error.
 *
 * The signal lookup is tenant-scoped, and the atomic-update lookup is scoped
 * again independently: the id comes from a row we just tenant-checked, but the
 * where clause is the security boundary in this codebase and each query carries
 * its own.
 */
export async function readSignalEvidence(
  tenantId: string,
  signalId: string,
  database: Database = defaultDb
): Promise<SignalEvidence | null> {
  const [signal] = await database
    .select({ atomicUpdateId: signals.atomicUpdateId })
    .from(signals)
    .where(and(eq(signals.id, signalId), eq(signals.tenantId, tenantId)))
    .limit(1);

  if (!signal?.atomicUpdateId) return null;

  const [atomic] = await database
    .select({
      id: atomicUpdates.id,
      title: atomicUpdates.title,
      summary: atomicUpdates.summary,
      category: atomicUpdates.category,
      size: atomicUpdates.size,
      status: atomicUpdates.status,
    })
    .from(atomicUpdates)
    .where(and(eq(atomicUpdates.id, signal.atomicUpdateId), eq(atomicUpdates.tenantId, tenantId)))
    .limit(1);

  if (!atomic) return null;

  // Ordered by createdAt then id: events ingested in the same webhook batch
  // share a createdAt, and SQL guarantees no order among equal sort keys — the
  // id tiebreaker keeps the drawer's list stable across opens.
  const events = await database
    .select({
      id: changeEvents.id,
      type: changeEvents.type,
      provider: changeEvents.provider,
      prTitle: changeEvents.prTitle,
      commitMessage: changeEvents.commitMessage,
      taskTitle: changeEvents.taskTitle,
      externalUrl: changeEvents.externalUrl,
      createdAt: changeEvents.createdAt,
    })
    .from(changeEvents)
    .where(and(eq(changeEvents.tenantId, tenantId), eq(changeEvents.atomicUpdateId, atomic.id)))
    .orderBy(asc(changeEvents.createdAt), asc(changeEvents.id));

  return {
    atomicUpdateId: atomic.id,
    title: atomic.title,
    summary: atomic.summary,
    category: atomic.category,
    size: atomic.size,
    hidden: atomic.status === "hidden",
    editable: atomic.status === "open",
    events: events.map((e) => ({
      id: e.id,
      type: e.type,
      provider: e.provider,
      label: eventLabel(e),
      externalUrl: e.externalUrl,
      createdAt: e.createdAt,
    })),
  };
}
