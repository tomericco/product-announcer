"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { scheduleConfigs, tenants } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { advanceNextScheduledAt, type Cadence } from "@/lib/scheduling/scheduler-decision";
import { addSelectedRepos } from "@/lib/workspace/repo-sync";
import { parseRepoSelections } from "@/lib/workspace/repo-selection-form";
import { markOnboardingComplete } from "@/lib/workspace/onboarding";
import { listRepoBranches } from "@/lib/integrations/github/github";

export async function addOnboardingRepos(formData: FormData) {
  const session = await requireSession();
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, session.user.tenantId)).limit(1);
  if (!tenant?.githubInstallationId) {
    throw new Error("GitHub is not connected for this tenant yet");
  }

  const selections = parseRepoSelections(formData);
  const validated: typeof selections = [];
  for (const selection of selections) {
    const branches = await listRepoBranches(tenant.githubInstallationId, selection.fullName);
    if (branches.includes(selection.branch)) validated.push(selection);
  }
  if (validated.length > 0) {
    await addSelectedRepos(session.user.tenantId, tenant.githubInstallationId, validated);
  }

  redirect("/onboarding");
}

export async function saveOnboardingSchedule(formData: FormData) {
  const session = await requireSession();
  const cadence = formData.get("cadence") as Cadence;
  const thresholdRaw = formData.get("threshold");
  const threshold = thresholdRaw ? Number(thresholdRaw) : null;
  const nextScheduledAt = cadence === "none" ? null : advanceNextScheduledAt(new Date(), cadence);

  await db
    .insert(scheduleConfigs)
    .values({ tenantId: session.user.tenantId, cadence, threshold, nextScheduledAt })
    .onConflictDoUpdate({
      target: scheduleConfigs.tenantId,
      set: { cadence, threshold, nextScheduledAt },
    });

  await markOnboardingComplete(session.user.tenantId);
  redirect("/pending");
}

export async function skipOnboarding() {
  const session = await requireSession();
  await markOnboardingComplete(session.user.tenantId);
  redirect("/pending");
}

export async function saveWorkspaceName(formData: FormData) {
  const session = await requireSession();
  const name = (formData.get("name") as string)?.trim();
  if (!name) return;

  await db.update(tenants).set({ name }).where(eq(tenants.id, session.user.tenantId));
  redirect("/onboarding");
}
