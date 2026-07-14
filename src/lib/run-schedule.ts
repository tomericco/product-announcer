import { eq } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { scheduleConfigs } from "../db/schema";
import { getPendingChangeItems, claimBatchAndCreateUpdate } from "./change-item-batch";
import { generateUpdateDraft } from "./generation";
import { getOrCreateBrandProfile } from "./brand-profile";
import { shouldTriggerRun, advanceNextScheduledAt, type Cadence } from "./scheduler-decision";

type ChangeItemRow = Awaited<ReturnType<typeof getPendingChangeItems>>[number];

export async function runBatchForRepo(
  repoId: string,
  tenantId: string,
  pending: ChangeItemRow[],
  database: typeof defaultDb = defaultDb
): Promise<boolean> {
  if (pending.length === 0) return false;

  const brandProfile = await getOrCreateBrandProfile(tenantId, database);

  let draft;
  try {
    draft = await generateUpdateDraft(pending, brandProfile);
  } catch {
    try {
      draft = await generateUpdateDraft(pending, brandProfile);
    } catch {
      // Both attempts failed. Leave the batch's items pending — they roll into
      // the next scheduled/threshold/manual run automatically (see Plan's
      // Global Constraints re: deferred failure surfacing).
      return false;
    }
  }

  const update = await claimBatchAndCreateUpdate(
    { tenantId, repoId, changeItemIds: pending.map((p) => p.id), draft },
    database
  );

  return update !== null;
}

export async function runSchedulerTick(now: Date, database: typeof defaultDb = defaultDb): Promise<void> {
  const configs = await database.select().from(scheduleConfigs);

  for (const config of configs) {
    try {
      const pending = await getPendingChangeItems(config.repoId, database);

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

      const created = await runBatchForRepo(config.repoId, config.tenantId, pending, database);

      const updateFields: Partial<typeof scheduleConfigs.$inferInsert> = { lastRunAt: now };
      // Advance the cadence clock only when an Update was actually produced. A
      // cadence tick that fired but generated nothing (double-failure) must not
      // consume the cadence slot — leaving nextScheduledAt in the past lets the
      // next hourly tick retry instead of waiting a full cadence cycle.
      if (created && reason === "cadence" && config.cadence !== "none" && config.nextScheduledAt) {
        updateFields.nextScheduledAt = advanceNextScheduledAt(
          config.nextScheduledAt,
          config.cadence as Exclude<Cadence, "none">
        );
      }
      await database.update(scheduleConfigs).set(updateFields).where(eq(scheduleConfigs.id, config.id));
    } catch (error) {
      // One repo's unexpected failure must not starve the other tenants'
      // configs in this tick. Log and continue.
      console.error(`Scheduler tick failed for repo ${config.repoId}:`, error);
    }
  }
}

export async function applyPostRunScheduleChoice(
  repoId: string,
  choice: "keep" | "skip",
  database: typeof defaultDb = defaultDb
): Promise<void> {
  if (choice !== "skip") return;

  const [config] = await database.select().from(scheduleConfigs).where(eq(scheduleConfigs.repoId, repoId)).limit(1);
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
