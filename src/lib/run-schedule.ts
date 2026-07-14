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
): Promise<void> {
  if (pending.length === 0) return;

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
      return;
    }
  }

  await claimBatchAndCreateUpdate(
    { tenantId, repoId, changeItemIds: pending.map((p) => p.id), draft },
    database
  );
}

export async function runSchedulerTick(now: Date, database: typeof defaultDb = defaultDb): Promise<void> {
  const configs = await database.select().from(scheduleConfigs);

  for (const config of configs) {
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

    await runBatchForRepo(config.repoId, config.tenantId, pending, database);

    const updateFields: Partial<typeof scheduleConfigs.$inferInsert> = { lastRunAt: now };
    if (reason === "cadence" && config.cadence !== "none" && config.nextScheduledAt) {
      updateFields.nextScheduledAt = advanceNextScheduledAt(
        config.nextScheduledAt,
        config.cadence as Exclude<Cadence, "none">
      );
    }
    await database.update(scheduleConfigs).set(updateFields).where(eq(scheduleConfigs.id, config.id));
  }
}
