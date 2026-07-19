import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { repos, scheduleConfigs, tenants, webhookConfigs, updates, systemPersonas, systemUpdateExamples } from "@/db/schema";
import { getPendingChangeItems, getBatchableChangeItems, claimBatchAndCreateUpdate, batchCategories } from "@/lib/change-items/change-item-batch";
import { generateUpdateDraft } from "@/lib/ai/generation";
import { getOrCreateBrandProfile } from "@/lib/workspace/brand-profile";
import { resolvePersonaRefs, systemPersonaKeys } from "@/lib/workspace/personas";
import { selectExamples } from "@/lib/ai/select-examples";
import { shouldTriggerRun, advanceNextScheduledAt, type Cadence } from "./scheduler-decision";
import { dispatchWebhookForUpdate } from "@/lib/publishing/webhook-delivery";
import { reviewAndReconcile } from "@/lib/ai/review-draft";

type ChangeItemRow = Awaited<ReturnType<typeof getPendingChangeItems>>[number];

async function reposByIdForTenant(
  tenantId: string,
  database: typeof defaultDb
): Promise<Map<string, string>> {
  const rows = await database.select().from(repos).where(eq(repos.tenantId, tenantId));
  return new Map(rows.map((r) => [r.id, r.githubRepoFullName]));
}

export async function runBatchForWorkspace(
  tenantId: string,
  pending: ChangeItemRow[],
  database: typeof defaultDb = defaultDb
): Promise<boolean> {
  if (pending.length === 0) return false;

  const brandProfile = await getOrCreateBrandProfile(tenantId, database);
  const reposById = await reposByIdForTenant(tenantId, database);
  const catalog = await database.select().from(systemPersonas);
  const personas = resolvePersonaRefs(brandProfile.userPersonas, catalog);

  const allExamples = await database.select().from(systemUpdateExamples);
  const examples = selectExamples(allExamples, {
    industry: brandProfile.industry,
    personaKeys: systemPersonaKeys(brandProfile.userPersonas),
    categories: batchCategories(pending),
  });

  let draft;
  try {
    draft = await generateUpdateDraft(pending, brandProfile, reposById, personas, examples);
  } catch {
    try {
      draft = await generateUpdateDraft(pending, brandProfile, reposById, personas, examples);
    } catch {
      // Both attempts failed. Leave the batch's items pending — they roll into
      // the next scheduled/threshold/manual run automatically.
      return false;
    }
  }

  const review = await reviewAndReconcile(draft, brandProfile);

  const update = await claimBatchAndCreateUpdate(
    {
      tenantId,
      changeItemIds: pending.map((p) => p.id),
      draft: review.finalDraft,
      review: { status: review.status, issues: review.issues },
    },
    database
  );
  if (!update) return false;

  // Auto-publish: only when the workspace opted in, an active webhook
  // exists, AND the review passed/revised — otherwise the update stays a
  // draft for review (a publish with no delivery would go nowhere, and a
  // failed/errored review must never ship unattended).
  const [tenant] = await database.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const [activeWebhook] = await database
    .select()
    .from(webhookConfigs)
    .where(and(eq(webhookConfigs.tenantId, tenantId), eq(webhookConfigs.active, true)))
    .limit(1);

  const reviewPassed = review.status === "passed" || review.status === "revised";
  if (tenant?.autoPublish && activeWebhook && reviewPassed) {
    await database
      .update(updates)
      .set({ status: "published", publishedAt: new Date() })
      .where(eq(updates.id, update.id));
    await dispatchWebhookForUpdate(update.id, database);
  }

  return true;
}

export async function runSchedulerTick(now: Date, database: typeof defaultDb = defaultDb): Promise<void> {
  const configs = await database.select().from(scheduleConfigs);

  for (const config of configs) {
    try {
      const pending = await getBatchableChangeItems(config.tenantId, database);

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

export async function applyPostRunScheduleChoice(
  tenantId: string,
  choice: "keep" | "skip",
  database: typeof defaultDb = defaultDb
): Promise<void> {
  if (choice !== "skip") return;

  const [config] = await database.select().from(scheduleConfigs).where(eq(scheduleConfigs.tenantId, tenantId)).limit(1);
  if (config && config.cadence !== "none" && config.nextScheduledAt) {
    await database
      .update(scheduleConfigs)
      .set({
        nextScheduledAt: advanceNextScheduledAt(
          config.nextScheduledAt,
          config.cadence as Exclude<Cadence, "none">
        ),
      })
      .where(eq(scheduleConfigs.id, config.id));
  }
}
