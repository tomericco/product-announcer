import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { repos, scheduleConfigs, tenants, webhookConfigs, updates } from "../db/schema";
import { getPendingChangeItems, claimBatchAndCreateUpdate } from "./change-item-batch";
import { generateUpdateDraft } from "./generation";
import { getOrCreateBrandProfile } from "./brand-profile";
import { shouldTriggerRun, advanceNextScheduledAt, type Cadence } from "./scheduler-decision";
import { dispatchWebhookForUpdate } from "./webhook-delivery";

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

  let draft;
  try {
    draft = await generateUpdateDraft(pending, brandProfile, reposById);
  } catch {
    try {
      draft = await generateUpdateDraft(pending, brandProfile, reposById);
    } catch {
      // Both attempts failed. Leave the batch's items pending — they roll into
      // the next scheduled/threshold/manual run automatically.
      return false;
    }
  }

  const update = await claimBatchAndCreateUpdate(
    { tenantId, changeItemIds: pending.map((p) => p.id), draft },
    database
  );
  if (!update) return false;

  // Auto-publish: only when the workspace opted in AND an active webhook
  // exists — otherwise the update stays a draft for review (a publish with no
  // delivery would go nowhere).
  const [tenant] = await database.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const [activeWebhook] = await database
    .select()
    .from(webhookConfigs)
    .where(and(eq(webhookConfigs.tenantId, tenantId), eq(webhookConfigs.active, true)))
    .limit(1);

  if (tenant?.autoPublish && activeWebhook) {
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
      const pending = await getPendingChangeItems(config.tenantId, database);

      const reason = shouldTriggerRun(
        {
          cadence: config.cadence,
          nextScheduledAt: config.nextScheduledAt,
          threshold: config.threshold,
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
