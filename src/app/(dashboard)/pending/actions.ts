"use server";

import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { changeItems, scheduleConfigs } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { getPendingChangeItems } from "@/lib/change-item-batch";
import { runBatchForWorkspace, applyPostRunScheduleChoice } from "@/lib/run-schedule";

export async function dropChangeItem(formData: FormData) {
  const session = await requireSession();
  const changeItemId = formData.get("changeItemId") as string;

  // Scope the mutation to the change item AND the caller's tenant so a caller
  // can only ever exclude their own rows.
  await db
    .update(changeItems)
    .set({ status: "excluded", excludedAt: new Date(), excludedBy: session.user.id })
    .where(and(eq(changeItems.id, changeItemId), eq(changeItems.tenantId, session.user.tenantId)));

  revalidatePath("/pending");
}

export async function runNow() {
  const session = await requireSession();

  const pending = await getPendingChangeItems(session.user.tenantId);
  if (pending.length === 0) {
    revalidatePath("/pending");
    return;
  }

  await runBatchForWorkspace(session.user.tenantId, pending);
  await db
    .update(scheduleConfigs)
    .set({ lastRunAt: new Date() })
    .where(eq(scheduleConfigs.tenantId, session.user.tenantId));

  redirect("/pending/schedule-choice");
}

export async function chooseSchedule(formData: FormData) {
  const session = await requireSession();
  const choice = formData.get("choice") as "keep" | "skip";

  await applyPostRunScheduleChoice(session.user.tenantId, choice);

  redirect("/pending");
}
