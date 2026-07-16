"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { brandProfiles, scheduleConfigs, tenants } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { getOrCreateBrandProfile } from "@/lib/brand-profile";
import { advanceNextScheduledAt, type Cadence } from "@/lib/scheduler-decision";
import { addSelectedRepos } from "@/lib/repo-sync";
import { parseRepoSelections } from "@/lib/repo-selection-form";
import { listRepoBranches } from "@/lib/github";
import { parsePersonas } from "@/lib/persona-form";

function splitCsv(value: FormDataEntryValue | null): string[] {
  if (!value || typeof value !== "string") return [];
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

export async function saveWorkspaceName(formData: FormData) {
  const session = await requireSession();
  const name = (formData.get("name") as string)?.trim();
  if (!name) return;

  await db.update(tenants).set({ name }).where(eq(tenants.id, session.user.tenantId));
  revalidatePath("/settings");
}

export async function addSettingsRepos(formData: FormData) {
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

  revalidatePath("/settings");
  revalidatePath("/pending");
}

export async function saveBrandProfile(formData: FormData) {
  const session = await requireSession();
  const profile = await getOrCreateBrandProfile(session.user.tenantId);

  await db
    .update(brandProfiles)
    .set({
      tone: (formData.get("tone") as string) || null,
      readingLevel: (formData.get("readingLevel") as string) || null,
      industry: (formData.get("industry") as string) || null,
      userPersonas: parsePersonas(formData),
      doList: splitCsv(formData.get("doList")),
      dontList: splitCsv(formData.get("dontList")),
      updatedAt: new Date(),
    })
    .where(eq(brandProfiles.id, profile.id));

  revalidatePath("/settings");
}

export async function saveWorkspaceSchedule(formData: FormData) {
  const session = await requireSession();
  const cadence = formData.get("cadence") as Cadence;
  const thresholdRaw = formData.get("threshold");
  const threshold = thresholdRaw ? Number(thresholdRaw) : null;

  const [existing] = await db
    .select()
    .from(scheduleConfigs)
    .where(eq(scheduleConfigs.tenantId, session.user.tenantId))
    .limit(1);
  const freshAnchor = cadence === "none" ? null : advanceNextScheduledAt(new Date(), cadence);

  if (existing) {
    await db
      .update(scheduleConfigs)
      .set({
        cadence,
        threshold,
        nextScheduledAt: cadence === existing.cadence ? existing.nextScheduledAt : freshAnchor,
      })
      .where(eq(scheduleConfigs.id, existing.id));
  } else {
    // onConflictDoUpdate (not a plain insert) so a concurrent first-time save
    // can't violate the one-per-tenant unique constraint — matches
    // saveOnboardingSchedule.
    await db
      .insert(scheduleConfigs)
      .values({ tenantId: session.user.tenantId, cadence, threshold, nextScheduledAt: freshAnchor })
      .onConflictDoUpdate({
        target: scheduleConfigs.tenantId,
        set: { cadence, threshold, nextScheduledAt: freshAnchor },
      });
  }

  revalidatePath("/settings");
  revalidatePath("/pending");
}
