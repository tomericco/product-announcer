"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { scheduleConfigs, tenants } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { advanceNextScheduledAt, type Cadence } from "@/lib/scheduling/scheduler-decision";
import { addSelectedRepos } from "@/lib/workspace/repo-sync";
import { parseRepoSelections } from "@/lib/workspace/repo-selection-form";
import { advanceOnboardingStep, markOnboardingComplete } from "@/lib/workspace/onboarding";
import { listRepoBranches } from "@/lib/integrations/github/github";
import { importBrandStyleForTenant } from "@/lib/workspace/brand-import";

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
    .values({ tenantId: session.user.tenantId, cadence, threshold, thresholdEnabled: false, nextScheduledAt })
    .onConflictDoUpdate({
      target: scheduleConfigs.tenantId,
      set: { cadence, threshold, nextScheduledAt },
    });

  await markOnboardingComplete(session.user.tenantId);
  redirect("/atomic-updates");
}

export async function skipOnboarding() {
  const session = await requireSession();
  await markOnboardingComplete(session.user.tenantId);
  redirect("/atomic-updates");
}

export async function importBrandStyle(formData: FormData) {
  const session = await requireSession();
  const url = (formData.get("updatesPageUrl") as string)?.trim();
  if (!url) redirect("/onboarding/brand");

  const result = await importBrandStyleForTenant(session.user.tenantId, url);
  // A failed scrape keeps the user on step 2 so they can try another URL or skip;
  // only a success advances.
  if (!result.ok) redirect("/onboarding/brand?brandImport=failed");

  await advanceOnboardingStep(session.user.tenantId, 3);
  redirect("/onboarding/connect");
}

export async function skipBrandStep() {
  const session = await requireSession();
  await advanceOnboardingStep(session.user.tenantId, 3);
  redirect("/onboarding/connect");
}

export async function saveWorkspaceName(formData: FormData) {
  const session = await requireSession();
  const name = (formData.get("name") as string)?.trim();
  // Previously this returned silently on an empty name, leaving the user staring
  // at an unchanged form with no feedback.
  if (!name) redirect("/onboarding/workspace?error=empty");

  await db.update(tenants).set({ name }).where(eq(tenants.id, session.user.tenantId));
  await advanceOnboardingStep(session.user.tenantId, 2);
  redirect("/onboarding/brand");
}
