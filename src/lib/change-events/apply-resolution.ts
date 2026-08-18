import { and, eq, exists, isNull, ne, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { atomicUpdates, changeEvents } from "@/db/schema";
import type { OpenAtomicUpdate, ResolutionAction } from "@/lib/ai/resolve-atomic-updates";

type Database = typeof defaultDb;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Runs `fn` inside a transaction holding a per-tenant advisory lock, so two
 * concurrent pushes for the same tenant cannot both decide "no matching atomic
 * update exists" and create duplicates. The lock releases on commit or rollback.
 */
export async function withTenantLock<T>(
  database: Database,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenantId})::bigint)`);
    return fn(tx);
  });
}

/**
 * The resolver's candidate set: atomic updates not yet shipped. An atomic update
 * sitting in an unpublished draft release is still open — nothing has been
 * communicated to users yet, so new evidence still belongs to it.
 *
 * Deliberately DOES NOT filter on `contentPieceId IS NULL` the way the compose-side
 * candidate sets do (`getOpenAtomicUpdates` in release-claim.ts, `listAtomicUpdates`
 * in atomic-updates/actions.ts). Those two hide an atomic update once it's
 * claimed into a draft, so it isn't offered for a second release. This query
 * is different on purpose: it's what lets a new commit/PR attach to an
 * atomic update that's already sitting in an in-progress draft (the
 * "evidence delta" a later commit can still contribute before the draft
 * ships) instead of spinning up a duplicate atomic update. Do NOT add a
 * contentPieceId filter here to "match" the others — that would break re-resolution
 * against open drafts.
 */
export async function loadOpenAtomicUpdates(
  database: Database | Tx,
  tenantId: string
): Promise<OpenAtomicUpdate[]> {
  const rows = await database
    .select({ id: atomicUpdates.id, title: atomicUpdates.title, summary: atomicUpdates.summary })
    .from(atomicUpdates)
    .where(and(eq(atomicUpdates.tenantId, tenantId), eq(atomicUpdates.status, "open")));
  return rows;
}

/**
 * Applies a resolver plan using a caller-supplied transaction.
 *
 * The pipeline calls this INSIDE `withTenantLock`, so that loading the candidate
 * set, resolving, and writing the result all happen under one lock. Splitting
 * apply into its own transaction would release the lock between the decision and
 * the write, which is precisely the window two concurrent pushes need to both
 * conclude "no matching atomic update exists" and create duplicates.
 */
export async function applyResolutionInTx(
  tx: Tx,
  tenantId: string,
  actions: ResolutionAction[]
): Promise<void> {
  if (actions.length === 0) return;

  // Two events describing the same new change both arrive as `create` actions
  // with an identical title. Creating a row per action would split one change
  // across two atomic updates, so the first create wins and the rest reuse it.
  const createdByTitle = new Map<string, string>();

  for (const action of actions) {
    let atomicUpdateId: string;

    if (action.action === "create") {
      const key = action.title.trim().toLowerCase();
      const existing = createdByTitle.get(key);

      if (existing) {
        atomicUpdateId = existing;
      } else {
        const [created] = await tx
          .insert(atomicUpdates)
          .values({
            tenantId,
            title: action.title,
            summary: action.summary,
            category: action.category,
            size: action.size,
          })
          .returning({ id: atomicUpdates.id });
        atomicUpdateId = created.id;
        createdByTitle.set(key, atomicUpdateId);
      }
    } else {
      atomicUpdateId = action.atomicUpdateId;
    }

    // Tenant-scoped and unassigned-only: the resolver's plan is model output,
    // so it must not be able to reach another tenant's rows or clobber an
    // assignment made while it was thinking. `ne(status, "excluded")` is
    // defense-in-depth: a detached event is `status='excluded'` with
    // `atomicUpdateId` null, which already satisfies `isNull` above — no
    // current caller feeds an excluded event's id into a resolver plan, but
    // this guarantees a future caller can never have it auto-reassigned.
    const conditions = [
      eq(changeEvents.id, action.eventId),
      eq(changeEvents.tenantId, tenantId),
      isNull(changeEvents.atomicUpdateId),
      ne(changeEvents.status, "excluded"),
    ];

    if (action.action === "assign") {
      // `assign` names an atomic update the resolver picked from its `open`
      // set, which is supposed to already be tenant-scoped (loadOpenAtomicUpdates)
      // — but that guarantee lives two modules away and this function has no
      // way to see it. Re-verify ownership locally via EXISTS, folded into the
      // same UPDATE, so a differently-sourced `open` list can never link one
      // tenant's change event to another tenant's atomic update. If the target
      // isn't this tenant's, the WHERE simply matches nothing and the event
      // stays unassigned rather than throwing.
      // Also re-check `status = 'open'`: a draft link (`linkAtomicUpdatesToPiece`)
      // does not take the tenant lock this resolver runs under, so the target
      // atomic update can flip to `released` while the resolver's LLM call is
      // in flight. If that happened, the EXISTS fails, the event stays
      // unassigned, and the next hourly sweep re-resolves it into an open AU
      // — rather than binding it to an atomic update that already shipped.
      conditions.push(
        exists(
          tx
            .select({ one: sql`1` })
            .from(atomicUpdates)
            .where(
              and(
                eq(atomicUpdates.id, atomicUpdateId),
                eq(atomicUpdates.tenantId, tenantId),
                eq(atomicUpdates.status, "open")
              )
            )
        )
      );
    }

    await tx
      .update(changeEvents)
      .set({ atomicUpdateId })
      .where(and(...conditions));
  }
}

/**
 * Standalone wrapper: applies a plan in its own transaction. Used by tests and
 * any caller that is not already holding the tenant lock.
 */
export async function applyResolution(
  database: Database,
  tenantId: string,
  actions: ResolutionAction[]
): Promise<void> {
  if (actions.length === 0) return;
  await database.transaction((tx) => applyResolutionInTx(tx, tenantId, actions));
}
