import { and, eq, gte, ne, notInArray, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { atomicUpdates, changeEvents, signals } from "@/db/schema";
import { signalWindowStart } from "./window";

export type ShippedWorkDeps = { database?: typeof defaultDb };

/**
 * Reconciles atomic updates into `shipped_work` signals.
 *
 * A reconciler rather than a hook at creation: atomic updates are inserted in
 * three places with no shared helper, so a fourth site added later would
 * silently stop producing signals. Reconciling is idempotent, self-healing, and
 * gets hide/unhide for free — a hidden update's signal is marked `stale` and
 * comes back to `new` when it is unhidden.
 *
 * `externalId` is the atomic update's id, so the unique index on
 * (tenantId, kind, externalId) is what makes the upsert safe. This id is also
 * why the stale-marking step below is allowed to run unscoped across tenants
 * (see the comment there) — see `externalId`'s comment on `signals` in
 * `schema.ts` for the invariant that relies on.
 *
 * Bounded by `SIGNAL_WINDOW_DAYS` (`./window`) on both sides: the candidate
 * select only considers atomic updates created within the window, and the
 * stale-marking below only touches signals created within it. Without that
 * bound, an atomic update older than the window would (a) dump a tenant's
 * entire history into signals on first run, with `createdAt = now`, and
 * (b) — once a purge job exists — be silently re-created by the very next
 * run after the purge deletes it, making `shipped_work` signals permanently
 * un-prunable. See `./window` for the full reasoning; that module is the
 * shared definition, so any future change to the bound belongs there.
 */
export async function syncShippedWorkSignals(deps: ShippedWorkDeps = {}): Promise<void> {
  const database = deps.database ?? defaultDb;
  const now = new Date();
  const windowStart = signalWindowStart(now);

  let visible: Array<{
    id: string;
    tenantId: string;
    title: string;
    summary: string;
    createdAt: Date;
    // MAX(COALESCE(mergedAt, committedAt, completedAt, releasedAt)) across every
    // change event linked to this atomic update — the most recent real-world
    // date among its evidence. Null when the atomic update has no linked
    // change events (a manually-created one) or none of them carry a date yet.
    // Typed loosely because a raw `sql<>` aggregate isn't decoded through
    // drizzle's column mapper the way a plain column select is — the driver
    // can hand back a string here, not a `Date`.
    latestEvidenceAt: Date | string | null;
  }>;
  try {
    visible = await database
      .select({
        id: atomicUpdates.id,
        tenantId: atomicUpdates.tenantId,
        title: atomicUpdates.title,
        summary: atomicUpdates.summary,
        createdAt: atomicUpdates.createdAt,
        latestEvidenceAt: sql<Date | null>`max(coalesce(${changeEvents.mergedAt}, ${changeEvents.committedAt}, ${changeEvents.completedAt}, ${changeEvents.releasedAt}))`,
      })
      .from(atomicUpdates)
      .leftJoin(changeEvents, eq(changeEvents.atomicUpdateId, atomicUpdates.id))
      .where(and(ne(atomicUpdates.status, "hidden"), gte(atomicUpdates.createdAt, windowStart)))
      .groupBy(
        atomicUpdates.id,
        atomicUpdates.tenantId,
        atomicUpdates.title,
        atomicUpdates.summary,
        atomicUpdates.createdAt
      );
  } catch (error) {
    // Nothing to reconcile against without the candidate list. Log and
    // return — next run retries. Matches resolve-sweep's posture.
    console.error("[shipped-work-signals] failed to load candidate atomic updates:", error);
    return;
  }

  // Each update's upsert gets its own try/catch, same as resolve-sweep scopes
  // failure per tenant: one bad row must not abort the loop for every other
  // atomic update across every tenant, nor skip the stale-marking below.
  for (const update of visible) {
    try {
      const occurredAt = update.latestEvidenceAt ? new Date(update.latestEvidenceAt) : update.createdAt;
      await database
        .insert(signals)
        .values({
          tenantId: update.tenantId,
          kind: "shipped_work",
          externalId: update.id,
          title: update.title,
          excerpt: update.summary,
          // When the thing shipped, not when we noticed it: the last piece of
          // real evidence to land, or the atomic update's own createdAt when
          // it has no linked change events to date it. Ranking in spec 5
          // decays on this, so a backfilled/imported old change must not read
          // as fresh just because its atomic update was created today.
          occurredAt,
          atomicUpdateId: update.id,
        })
        .onConflictDoUpdate({
          target: [signals.tenantId, signals.kind, signals.externalId],
          // Refresh only what can change upstream. Never touch relevanceScore,
          // topics or `used` — those belong to whatever scored or cited this
          // signal, and a re-sync must not undo them. `status` is the one
          // exception, and only in one direction: if this signal was
          // previously marked stale (its atomic update was hidden or gone),
          // being upserted here means it's visible again, so flip it back to
          // `new`. Any other status (including `used`, which spec 5 sets) is
          // left exactly as it was.
          set: {
            title: update.title,
            excerpt: update.summary,
            atomicUpdateId: update.id,
            status: sql`CASE WHEN ${signals.status} = 'stale' THEN 'new' ELSE ${signals.status} END`,
          },
        });
    } catch (error) {
      console.error(`[shipped-work-signals] upsert failed for atomic update ${update.id}:`, error);
    }
  }

  // Mark stale any shipped_work signal whose atomic update went away or was
  // hidden — never delete: `atomicUpdateId` on `signals` is ON DELETE SET
  // NULL because the signal is the durable record of what happened (see the
  // schema comment), and spec 5's `brief_signals` will cascade on signal
  // delete with no accepted-brief exemption implemented here. `listSignals`
  // already excludes `stale` by default, so the browser behaves the same as
  // a hard delete while the row (and its relevanceScore/topics/used) survives
  // a later unhide.
  //
  // Scoped to this kind so no other producer's rows are ever touched, and to
  // signals created within the window: a signal outside it is already
  // invisible to every reader (see `listSignals`/`signalWindowCondition`) and
  // must be left alone rather than churned every run. `visibleIds` comes from
  // the select above, not from which upserts succeeded, so a failed upsert
  // cannot cause a wrongful stale-marking here.
  //
  // Deliberately unscoped by tenant: this is safe only because `externalId`
  // for `shipped_work` is the atomic update's UUID, which is globally unique
  // across every tenant — unlike a feed guid or article URL, which the
  // `externalId` comment on `signals` (schema.ts) anticipates being shared
  // across tenants for other kinds. A future producer writing `shipped_work`
  // rows with a non-UUID externalId would silently break this.
  const visibleIds = visible.map((update) => update.id);
  try {
    const staleCondition =
      visibleIds.length > 0
        ? and(eq(signals.kind, "shipped_work"), notInArray(signals.externalId, visibleIds), gte(signals.createdAt, windowStart))
        : and(eq(signals.kind, "shipped_work"), gte(signals.createdAt, windowStart));

    await database.update(signals).set({ status: "stale" }).where(staleCondition);
  } catch (error) {
    console.error("[shipped-work-signals] stale-marking failed:", error);
  }
}
