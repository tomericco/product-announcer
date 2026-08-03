import { and, eq, inArray, isNull } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { atomicUpdates, contentPieces, systemPersonas, systemContentExamples } from "@/db/schema";
import type { AtomicUpdateForPrompt } from "@/lib/ai/compose-prompt";
import { generateReleaseDraft, mergeReleaseDraft } from "@/lib/ai/generation";
import { validateDraftLinks } from "@/lib/ai/validate-links";
import { getOrCreateCompanyProfile } from "@/lib/workspace/company-profile";
import { resolvePersonaRefs, systemPersonaKeys } from "@/lib/workspace/personas";
import { selectExamples } from "@/lib/ai/select-examples";
import { computeReleaseDelta } from "./release-deltas";

type Database = typeof defaultDb;
type Executor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];
type Release = typeof contentPieces.$inferSelect;
type AtomicUpdateRow = typeof atomicUpdates.$inferSelect;

export type CatchUpDeps = {
  mergeDraft?: typeof mergeReleaseDraft;
};

export type StartOverDeps = {
  generateDraft?: typeof generateReleaseDraft;
};

function toPromptItem(row: AtomicUpdateRow): AtomicUpdateForPrompt {
  return { id: row.id, title: row.title, summary: row.summary, category: row.category, size: row.size };
}

/** Distinct non-null categories among a set of atomic updates, used to bias
 * example selection toward examples about the same kinds of changes — mirrors
 * `atomicUpdateCategories` in `src/lib/drafting/compose-draft.ts`. */
function distinctCategories(items: { category: string | null }[]): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    if (item.category !== null) seen.add(item.category);
  }
  return [...seen];
}

async function loadPromptContext(tenantId: string) {
  const brandProfile = await getOrCreateCompanyProfile(tenantId, defaultDb);
  const catalog = await defaultDb.select().from(systemPersonas);
  const personas = resolvePersonaRefs(brandProfile.userPersonas, catalog);
  const allExamples = await defaultDb.select().from(systemContentExamples);
  return { brandProfile, personas, allExamples };
}

/**
 * Links the still-eligible membership-delta atomic updates into `release`.
 * Re-guards exclusivity: the ids came from `computeReleaseDelta`, read a
 * moment earlier, so between that read and this call another draft could have
 * claimed one, or it could have been published. Only rows still tenant-owned,
 * `status = 'open'`, and `contentPieceId IS NULL` are linked (same guard as
 * `claimReleaseFromAtomicUpdates`) — a row that no longer matches is dropped
 * from this catch-up, not force-stolen. Stays `status = 'open'`; publish still
 * owns the `released` transition.
 */
async function linkNewAtomicUpdates(tx: Executor, release: Release, newIds: string[]): Promise<void> {
  if (newIds.length === 0) return;
  await tx
    .update(atomicUpdates)
    .set({ contentPieceId: release.id, updatedAt: new Date() })
    .where(
      and(
        inArray(atomicUpdates.id, newIds),
        eq(atomicUpdates.tenantId, release.tenantId),
        eq(atomicUpdates.status, "open"),
        isNull(atomicUpdates.contentPieceId)
      )
    );
}

/**
 * Merge-regenerates a stale draft release: folds the membership-delta (new)
 * and evidence-delta (changed) atomic updates into the existing body via
 * `mergeReleaseDraft`, which preserves the current wording and structure
 * rather than writing fresh (contrast `startOverRelease`).
 *
 * `computeReleaseDelta` runs against the default pooled db, outside any
 * transaction (it fires two sub-queries concurrently via `Promise.all`, which
 * a single-connection transaction executor can't service). The merge call
 * itself also runs outside a transaction — this codebase never holds a DB
 * connection open across a network/LLM call (see `dispatchAllDestinations` in
 * `drafts/actions.ts`). Only the link + body/composedAt update are
 * transactional.
 *
 * Returns null if the release doesn't exist, or if there is nothing to catch
 * up on (`computeReleaseDelta` returns `count === 0`) — no mutation either way.
 */
export async function catchUpRelease(contentPieceId: string, deps: CatchUpDeps = {}): Promise<Release | null> {
  const mergeDraft = deps.mergeDraft ?? mergeReleaseDraft;

  const [release] = await defaultDb.select().from(contentPieces).where(eq(contentPieces.id, contentPieceId));
  if (!release) return null;

  const delta = await computeReleaseDelta(contentPieceId);
  if (delta.count === 0) return null;

  const { brandProfile, personas, allExamples } = await loadPromptContext(release.tenantId);
  const newItems = delta.newAtomicUpdates.map(toPromptItem);
  const changedItems = delta.changedAtomicUpdates.map(toPromptItem);
  const examples = selectExamples(allExamples, {
    industry: brandProfile.industry,
    personaKeys: systemPersonaKeys(brandProfile.userPersonas),
    contentType: "product_update",
    categories: distinctCategories([...newItems, ...changedItems]),
  });

  const draft = await mergeDraft({
    currentBody: release.body,
    newItems,
    changedItems,
    brandProfile,
    personas,
    examples,
  });

  // Replace any unresolvable link with an [add link] placeholder before the
  // regenerated body is persisted (see `validateDraftLinks`).
  const { body: validatedBody } = await validateDraftLinks(draft.body);

  const newIds = delta.newAtomicUpdates.map((a) => a.id);

  return defaultDb.transaction(async (tx) => {
    await linkNewAtomicUpdates(tx, release, newIds);

    const [updated] = await tx
      .update(contentPieces)
      .set({ body: validatedBody, composedAt: new Date() })
      .where(and(eq(contentPieces.id, release.id), eq(contentPieces.tenantId, release.tenantId)))
      .returning();

    return updated ?? null;
  });
}

/**
 * Regenerates a stale draft release FROM SCRATCH: links the membership-delta
 * atomic updates in, then re-derives the title and body via
 * `generateReleaseDraft` over the release's FULL atomic-update set (the ones
 * already linked plus the newly linked ones) — contrast `catchUpRelease`,
 * which preserves existing wording (and title). Since the body is entirely
 * machine-generated, `bodyEditedAt` is cleared — any prior hand-edit flag no
 * longer applies to the new body.
 *
 * Same `computeReleaseDelta`-outside-any-transaction constraint as
 * `catchUpRelease`. The link happens in its own short transaction (so the
 * exclusivity re-guard is atomic), which also reads back the release's full
 * atomic-update set so the from-scratch regeneration sees everything
 * (existing + newly linked). The generation call and the final
 * body/composedAt update happen afterward, outside a transaction — this
 * codebase never holds a DB connection open across a network/LLM call.
 *
 * Returns null if the release doesn't exist, or if there is nothing to catch
 * up on (`computeReleaseDelta` returns `count === 0`) — no mutation either way.
 */
export async function startOverRelease(contentPieceId: string, deps: StartOverDeps = {}): Promise<Release | null> {
  const generateDraft = deps.generateDraft ?? generateReleaseDraft;

  const [release] = await defaultDb.select().from(contentPieces).where(eq(contentPieces.id, contentPieceId));
  if (!release) return null;

  const delta = await computeReleaseDelta(contentPieceId);
  if (delta.count === 0) return null;

  const { brandProfile, personas, allExamples } = await loadPromptContext(release.tenantId);
  const newIds = delta.newAtomicUpdates.map((a) => a.id);

  const fullItems = await defaultDb.transaction(async (tx) => {
    await linkNewAtomicUpdates(tx, release, newIds);
    const rows = await tx.select().from(atomicUpdates).where(eq(atomicUpdates.contentPieceId, release.id));
    return rows.map(toPromptItem);
  });

  const examples = selectExamples(allExamples, {
    industry: brandProfile.industry,
    personaKeys: systemPersonaKeys(brandProfile.userPersonas),
    contentType: "product_update",
    categories: distinctCategories(fullItems),
  });

  const draft = await generateDraft(fullItems, brandProfile, personas, examples);

  const { body: validatedBody } = await validateDraftLinks(draft.body);

  const [updated] = await defaultDb
    .update(contentPieces)
    .set({ title: draft.title, body: validatedBody, composedAt: new Date(), bodyEditedAt: null })
    .where(and(eq(contentPieces.id, release.id), eq(contentPieces.tenantId, release.tenantId)))
    .returning();

  return updated ?? null;
}
