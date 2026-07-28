"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { scheduleConfigs, tenants } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { advanceNextScheduledAt, type Cadence } from "@/lib/scheduling/scheduler-decision";
import { addSelectedRepos } from "@/lib/workspace/repo-sync";
import { parseRepoSelections } from "@/lib/workspace/repo-selection-form";
import { advanceOnboardingStep, isOnboardingComplete, markOnboardingComplete } from "@/lib/workspace/onboarding";
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

  redirect("/onboarding/connect");
}

/**
 * Leaves step 3, whether the user connected something or skipped. Both cases do
 * the same thing — the step's only stored outcome is the connection itself, and
 * that is written by the OAuth callbacks, not here.
 */
export async function finishConnectStep() {
  const session = await requireSession();
  await advanceOnboardingStep(session.user.tenantId, 4);
  redirect("/onboarding/schedule");
}

export async function saveOnboardingSchedule(formData: FormData) {
  const session = await requireSession();
  const cadence = formData.get("cadence") as Cadence;
  const thresholdRaw = formData.get("threshold");
  const threshold = thresholdRaw ? Number(thresholdRaw) : null;
  const nextScheduledAt = cadence === "none" ? null : advanceNextScheduledAt(new Date(), cadence);
  // "No fixed cadence" leaves nextScheduledAt null, so the threshold is the only
  // thing left that can trigger a draft — enable it, or picking that option would
  // silently mean "never draft anything". With a real cadence the cadence drives
  // it and the threshold stays off, as before.
  const thresholdEnabled = cadence === "none";

  await db
    .insert(scheduleConfigs)
    .values({ tenantId: session.user.tenantId, cadence, threshold, thresholdEnabled, nextScheduledAt })
    .onConflictDoUpdate({
      target: scheduleConfigs.tenantId,
      set: { cadence, threshold, thresholdEnabled, nextScheduledAt },
    });

  await markOnboardingComplete(session.user.tenantId);
  redirect("/atomic-updates");
}

/**
 * Finish onboarding without configuring a schedule at all. Deliberately writes no
 * scheduleConfigs row: runSchedulerTick iterates the rows that exist, so a tenant
 * without one is simply never picked up until they set a schedule in Settings.
 */
export async function skipScheduleStep() {
  const session = await requireSession();
  await markOnboardingComplete(session.user.tenantId);
  redirect("/atomic-updates");
}

export async function importBrandStyle(formData: FormData) {
  const session = await requireSession();
  // Re-gated after the wizard rewrite dropped it. guardOnboardingStep(2) protects
  // the PAGE, but a server action is a public endpoint that can be replayed
  // directly — and importBrandStyleForTenant fetches a live page and runs an LLM
  // derivation, so an ungated replay burns real money on a tenant who is already
  // done. The write itself is idempotent; the cost is not.
  if (await isOnboardingComplete(session.user.tenantId)) redirect("/atomic-updates");

  const url = (formData.get("updatesPageUrl") as string)?.trim();
  // An empty URL is a hard validation error, so it gets the same visible
  // treatment as an empty workspace name rather than a silent bounce.
  if (!url) redirect("/onboarding/brand?error=empty");

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
