"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { brandProfiles, repos, scheduleConfigs, tenants } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { getOrCreateBrandProfile } from "@/lib/brand-profile";
import { advanceNextScheduledAt, type Cadence } from "@/lib/scheduler-decision";
import { addSelectedRepos } from "@/lib/repo-sync";
import { parseRepoSelections } from "@/lib/repo-selection-form";

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
  if (selections.length > 0) {
    await addSelectedRepos(session.user.tenantId, tenant.githubInstallationId, selections);
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
      userPersonas: splitCsv(formData.get("userPersonas")),
      doList: splitCsv(formData.get("doList")),
      dontList: splitCsv(formData.get("dontList")),
      updatedAt: new Date(),
    })
    .where(eq(brandProfiles.id, profile.id));

  revalidatePath("/settings");
}

export async function saveRepoSchedule(formData: FormData) {
  const session = await requireSession();
  const repoId = formData.get("repoId") as string;

  const [repo] = await db.select().from(repos).where(eq(repos.id, repoId)).limit(1);
  if (!repo || repo.tenantId !== session.user.tenantId) {
    throw new Error("Repo not found for this tenant");
  }

  const cadence = formData.get("cadence") as Cadence;
  const thresholdRaw = formData.get("threshold");
  const threshold = thresholdRaw ? Number(thresholdRaw) : null;

  const [existing] = await db.select().from(scheduleConfigs).where(eq(scheduleConfigs.repoId, repoId)).limit(1);
  const nextScheduledAt = cadence === "none" ? null : advanceNextScheduledAt(new Date(), cadence);

  if (existing) {
    await db
      .update(scheduleConfigs)
      .set({
        cadence,
        threshold,
        // Only reset the anchor if the cadence itself changed — editing just the
        // threshold shouldn't perturb an already-scheduled cadence run.
        nextScheduledAt: cadence === existing.cadence ? existing.nextScheduledAt : nextScheduledAt,
      })
      .where(eq(scheduleConfigs.id, existing.id));
  } else {
    await db.insert(scheduleConfigs).values({ tenantId: session.user.tenantId, repoId, cadence, threshold, nextScheduledAt });
  }

  revalidatePath("/settings");
  revalidatePath("/pending");
}
