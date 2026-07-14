"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { changeItems, repos, scheduleConfigs } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { getPendingChangeItems } from "@/lib/change-item-batch";
import { runBatchForRepo, applyPostRunScheduleChoice } from "@/lib/run-schedule";

async function assertOwnsRepo(tenantId: string, repoId: string) {
  const [repo] = await db.select().from(repos).where(eq(repos.id, repoId)).limit(1);
  if (!repo || repo.tenantId !== tenantId) {
    throw new Error("Repo not found for this tenant");
  }
  return repo;
}

export async function dropChangeItem(formData: FormData) {
  const session = await requireSession();
  const changeItemId = formData.get("changeItemId") as string;
  const repoId = formData.get("repoId") as string;
  await assertOwnsRepo(session.user.tenantId, repoId);

  await db
    .update(changeItems)
    .set({ status: "excluded", excludedAt: new Date(), excludedBy: session.user.id })
    .where(eq(changeItems.id, changeItemId));

  revalidatePath("/pending");
}

export async function runNow(formData: FormData) {
  const session = await requireSession();
  const repoId = formData.get("repoId") as string;
  const repo = await assertOwnsRepo(session.user.tenantId, repoId);

  const pending = await getPendingChangeItems(repoId);
  if (pending.length === 0) {
    revalidatePath("/pending");
    return;
  }

  await runBatchForRepo(repoId, repo.tenantId, pending);
  await db.update(scheduleConfigs).set({ lastRunAt: new Date() }).where(eq(scheduleConfigs.repoId, repoId));

  redirect(`/pending/schedule-choice?repoId=${repoId}`);
}

export async function chooseSchedule(formData: FormData) {
  const session = await requireSession();
  const repoId = formData.get("repoId") as string;
  const choice = formData.get("choice") as "keep" | "skip";
  await assertOwnsRepo(session.user.tenantId, repoId);

  await applyPostRunScheduleChoice(repoId, choice);

  redirect(`/pending?repoId=${repoId}`);
}
