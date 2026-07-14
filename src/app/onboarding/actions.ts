"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { repos, scheduleConfigs, tenants } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { advanceNextScheduledAt, type Cadence } from "@/lib/scheduler-decision";
import { addSelectedRepos } from "@/lib/repo-sync";
import { parseRepoSelections } from "@/lib/repo-selection-form";
import { markOnboardingComplete } from "@/lib/onboarding";

export async function addOnboardingRepos(formData: FormData) {
  const session = await requireSession();
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, session.user.tenantId)).limit(1);
  if (!tenant?.githubInstallationId) {
    throw new Error("GitHub is not connected for this tenant yet");
  }

  const selections = parseRepoSelections(formData);
  if (selections.length > 0) {
    await addSelectedRepos(session.user.tenantId, tenant.githubInstallationId, selections);
  }

  redirect("/onboarding");
}

export async function saveOnboardingSchedule(formData: FormData) {
  const session = await requireSession();
  const cadence = formData.get("cadence") as Cadence;
  const thresholdRaw = formData.get("threshold");
  const threshold = thresholdRaw ? Number(thresholdRaw) : null;

  const tenantRepos = await db.select().from(repos).where(eq(repos.tenantId, session.user.tenantId));
  const nextScheduledAt = cadence === "none" ? null : advanceNextScheduledAt(new Date(), cadence);

  for (const repo of tenantRepos) {
    await db.insert(scheduleConfigs).values({
      tenantId: session.user.tenantId,
      repoId: repo.id,
      cadence,
      threshold,
      nextScheduledAt,
    });
  }

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
