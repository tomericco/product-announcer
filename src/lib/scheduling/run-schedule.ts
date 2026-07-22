import { eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { scheduleConfigs, systemPersonas, systemUpdateExamples } from "@/db/schema";
import { generateReleaseDraft } from "@/lib/ai/generation";
import type { AtomicUpdateForPrompt } from "@/lib/ai/compose-prompt";
import { getOpenAtomicUpdates, claimReleaseFromAtomicUpdates } from "@/lib/change-events/release-claim";
import { getOrCreateBrandProfile } from "@/lib/workspace/brand-profile";
import { resolvePersonaRefs, systemPersonaKeys } from "@/lib/workspace/personas";
import { selectExamples } from "@/lib/ai/select-examples";
import { shouldTriggerRun, advanceNextScheduledAt, type Cadence } from "./scheduler-decision";
import { reviewAndReconcile } from "@/lib/ai/review-draft";
import type { OnDraftProgress } from "./draft-progress";

/** Distinct non-null categories among the atomic updates being composed, used to
 * bias example selection toward examples about the same kinds of changes. */
function atomicUpdateCategories(items: { category: string | null }[]): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    if (item.category !== null) seen.add(item.category);
  }
  return [...seen];
}

export async function runBatchForWorkspace(
  tenantId: string,
  items: AtomicUpdateForPrompt[],
  database: typeof defaultDb = defaultDb,
  onProgress?: OnDraftProgress
): Promise<boolean> {
  if (items.length === 0) return false;

  onProgress?.({ type: "step", key: "preparing", status: "start" });
  const brandProfile = await getOrCreateBrandProfile(tenantId, database);
  const catalog = await database.select().from(systemPersonas);
  const personas = resolvePersonaRefs(brandProfile.userPersonas, catalog);
  const allExamples = await database.select().from(systemUpdateExamples);
  const examples = selectExamples(allExamples, {
    industry: brandProfile.industry,
    personaKeys: systemPersonaKeys(brandProfile.userPersonas),
    categories: atomicUpdateCategories(items),
  });
  onProgress?.({ type: "step", key: "preparing", status: "done" });

  onProgress?.({ type: "step", key: "generating", status: "start" });
  let draft;
  try {
    draft = await generateReleaseDraft(items, brandProfile, personas, examples);
  } catch {
    try {
      draft = await generateReleaseDraft(items, brandProfile, personas, examples);
    } catch (err) {
      // Both attempts failed. Leave the atomic updates open — they roll into
      // the next scheduled/threshold/manual run automatically.
      onProgress?.({ type: "error", message: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }
  onProgress?.({ type: "step", key: "generating", status: "done" });

  onProgress?.({ type: "step", key: "reviewing", status: "start" });
  const review = await reviewAndReconcile(draft, brandProfile, onProgress);
  onProgress?.({ type: "step", key: "reviewing", status: "done" });

  onProgress?.({ type: "step", key: "saving", status: "start" });
  const release = await claimReleaseFromAtomicUpdates(
    {
      tenantId,
      atomicUpdateIds: items.map((i) => i.id),
      draft: review.finalDraft,
      review: { status: review.status, issues: review.issues },
    },
    database
  );
  if (!release) {
    onProgress?.({ type: "error", message: "No changes were available to draft." });
    return false;
  }
  onProgress?.({ type: "step", key: "saving", status: "done" });

  onProgress?.({ type: "done", updateId: release.id });
  return true;
}

export async function runSchedulerTick(now: Date, database: typeof defaultDb = defaultDb): Promise<void> {
  const configs = await database.select().from(scheduleConfigs);

  for (const config of configs) {
    try {
      const pending = await getOpenAtomicUpdates(config.tenantId, database);

      const reason = shouldTriggerRun(
        {
          cadence: config.cadence,
          nextScheduledAt: config.nextScheduledAt,
          threshold: config.threshold,
          thresholdEnabled: config.thresholdEnabled,
          pendingCount: pending.length,
        },
        now
      );

      if (!reason) continue;

      const created = await runBatchForWorkspace(config.tenantId, pending, database);

      const updateFields: Partial<typeof scheduleConfigs.$inferInsert> = { lastRunAt: now };
      if (created && reason === "cadence" && config.cadence !== "none" && config.nextScheduledAt) {
        updateFields.nextScheduledAt = advanceNextScheduledAt(
          config.nextScheduledAt,
          config.cadence as Exclude<Cadence, "none">
        );
      }
      await database.update(scheduleConfigs).set(updateFields).where(eq(scheduleConfigs.id, config.id));
    } catch (error) {
      // One tenant's failure must not starve the others in this tick.
      console.error(`Scheduler tick failed for tenant ${config.tenantId}:`, error);
    }
  }
}
