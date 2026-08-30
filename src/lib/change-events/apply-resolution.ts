import { and, desc, eq, exists, isNotNull, isNull, ne, sql } from "drizzle-orm";
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
 * Cap on the resolver's candidate set. Unbounded, the prompt grows with the
 * backlog and assign precision drops.
 *
 * A candidate excluded by the cap means a late commit creates a duplicate
 * instead of assigning — which is why the ordering is recency and why every
 * atomic update already linked to a content piece is included regardless. Those
 * are the in-flight-draft rows this query's missing `contentPieceId` filter
 * exists to serve; dropping one reintroduces exactly the duplicate that filter's
 * absence was written to prevent.
 */
export const MAX_OPEN_CANDIDATES = 100;

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
 *
 * Bounded by MAX_OPEN_CANDIDATES via two queries unioned in code rather than one
 * windowed query: every open row already linked to a content piece (no cap —
 * see MAX_OPEN_CANDIDATES), plus the most recently updated open rows up to the
 * cap. De-duplicated by id. This runs once per chunk, so two round trips is a
 * fine price for the clarity.
 */
export async function loadOpenAtomicUpdates(
  database: Database | Tx,
  tenantId: string
): Promise<OpenAtomicUpdate[]> {
  const columns = { id: atomicUpdates.id, title: atomicUpdates.title, summary: atomicUpdates.summary };

  const draftLinked = await database
    .select(columns)
    .from(atomicUpdates)
    .where(
      and(
        eq(atomicUpdates.tenantId, tenantId),
        eq(atomicUpdates.status, "open"),
        isNotNull(atomicUpdates.contentPieceId)
      )
    );

  const mostRecent = await database
    .select(columns)
    .from(atomicUpdates)
    .where(and(eq(atomicUpdates.tenantId, tenantId), eq(atomicUpdates.status, "open")))
    .orderBy(desc(atomicUpdates.updatedAt))
    .limit(MAX_OPEN_CANDIDATES);

  const byId = new Map<string, OpenAtomicUpdate>();
  for (const row of draftLinked) byId.set(row.id, row);
  for (const row of mostRecent) byId.set(row.id, row);
  return [...byId.values()];
}

/**
 * A near-miss title may add or drop at most this many tokens (after
 * normalization) and still be treated as the same change.
 */
const MAX_TITLE_TOKEN_DIFFERENCE = 1;

/**
 * Below this many tokens in the SHORTER title, a one-token difference is not
 * a near-miss — it's a different, shorter title being subsumed by a longer
 * one that happens to contain it (e.g. "Search" vs. "Faster search").
 */
const MIN_TITLE_TOKENS = 2;

function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
  );
}

/**
 * Whether two `create` actions in the SAME batch describe one change.
 *
 * `RESOLVER_SYSTEM` explicitly instructs the model to give co-describing events
 * the SAME title, so this is a tolerance band on an intended exact match, not
 * open-ended clustering — which is what makes widening the old exact-string
 * comparison safe. Merging two genuinely different updates is worse than
 * splitting one, so the band is deliberately narrow, it applies only within
 * one batch's creates, and it never touches `assign`.
 *
 * This used to be scored by token-set Jaccard similarity (shared / union) at
 * a 0.8 threshold, but that metric is length-dependent: a one-word difference
 * on a short title — the common case, since TITLE_SUMMARY_STYLE asks for a
 * 2-3 token noun phrase — scores well below 0.8 and never merges, while the
 * identical one-word difference on a long (~9+ token) title clears 0.8 and
 * does merge. Whether a near-duplicate merged ended up depending more on
 * title length than on how similar the titles actually were.
 *
 * Replaced with a bounded symmetric difference, which is length-independent:
 * merge when the two token sets differ by at most MAX_TITLE_TOKEN_DIFFERENCE
 * token, provided the smaller set has at least MIN_TITLE_TOKENS tokens. A
 * 2-token pair and a 9-token pair are held to exactly the same standard. The
 * minimum-size guard exists so a single-token title isn't merged into any
 * longer title that contains it as a subset.
 */
export function titlesMatch(a: string, b: string): boolean {
  const left = titleTokens(a);
  const right = titleTokens(b);
  if (Math.min(left.size, right.size) < MIN_TITLE_TOKENS) return false;

  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  const symmetricDifference = left.size + right.size - 2 * shared;
  return symmetricDifference <= MAX_TITLE_TOKEN_DIFFERENCE;
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
  // with a near-identical title (RESOLVER_SYSTEM asks the model for an exact
  // match, titlesMatch adds a tolerance band on top). Creating a row per action
  // would split one change across two atomic updates, so the first create wins
  // and the rest reuse it — scanned with titlesMatch rather than an exact-key
  // map, so a stray extra word no longer defeats the merge.
  const createdTitles: { title: string; id: string }[] = [];

  for (const action of actions) {
    let atomicUpdateId: string;

    if (action.action === "create") {
      const existing = createdTitles.find((c) => titlesMatch(c.title, action.title));

      if (existing) {
        atomicUpdateId = existing.id;
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
        createdTitles.push({ title: action.title, id: atomicUpdateId });
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
