"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { brandProfiles, repos, scheduleConfigs, tenants } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { getOrCreateBrandProfile } from "@/lib/workspace/brand-profile";
import { computeNextScheduledAt, type Cadence } from "@/lib/scheduling/scheduler-decision";
import { addSelectedRepos } from "@/lib/workspace/repo-sync";
import { listRepoBranches } from "@/lib/integrations/github/github";
import { parsePersonas } from "@/lib/workspace/persona-form";

function splitList(value: FormDataEntryValue | null): string[] {
  if (!value || typeof value !== "string") return [];
  // Accept both newline- and comma-separated entries so the do/don't textareas
  // work whether the user puts one item per line or keeps them comma-separated.
  return value
    .split(/[\n,]/)
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

export async function saveAutoPublish(formData: FormData) {
  const session = await requireSession();
  const autoPublish = formData.get("autoPublish") === "on";
  await db.update(tenants).set({ autoPublish }).where(eq(tenants.id, session.user.tenantId));
  revalidatePath("/settings");
}

export async function addRepo(formData: FormData) {
  const session = await requireSession();
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, session.user.tenantId)).limit(1);
  if (!tenant?.githubInstallationId) {
    throw new Error("GitHub is not connected for this tenant yet");
  }

  const fullName = (formData.get("fullName") as string)?.trim();
  const branch = (formData.get("branch") as string)?.trim();
  if (!fullName || !branch) return;

  // Validate that the branch actually exists on the repo the installation can
  // see before persisting — this also re-checks (server-side) that the repo is
  // reachable by this tenant's installation, so a forged fullName can't be added.
  const branches = await listRepoBranches(tenant.githubInstallationId, fullName);
  if (!branches.includes(branch)) return;

  await addSelectedRepos(session.user.tenantId, tenant.githubInstallationId, [{ fullName, branch }]);

  revalidatePath("/settings");
  revalidatePath("/pending");
}

export async function updateRepoBranch(formData: FormData) {
  const session = await requireSession();
  const repoId = (formData.get("repoId") as string)?.trim();
  const branch = (formData.get("branch") as string)?.trim();
  if (!repoId || !branch) return;

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, session.user.tenantId)).limit(1);
  if (!tenant?.githubInstallationId) return;

  // Load the repo tenant-scoped (IDOR guard) so we can resolve its full name and
  // validate the requested branch against what the installation can actually see.
  const [repo] = await db
    .select()
    .from(repos)
    .where(and(eq(repos.id, repoId), eq(repos.tenantId, session.user.tenantId)))
    .limit(1);
  if (!repo) return;

  const branches = await listRepoBranches(tenant.githubInstallationId, repo.githubRepoFullName);
  if (!branches.includes(branch)) return;

  await db
    .update(repos)
    .set({ watchedBranch: branch })
    .where(and(eq(repos.id, repoId), eq(repos.tenantId, session.user.tenantId)));

  revalidatePath("/settings");
  revalidatePath("/pending");
}

export async function removeRepo(formData: FormData) {
  const session = await requireSession();
  const repoId = (formData.get("repoId") as string)?.trim();
  if (!repoId) return;

  // Tenant-scoped delete so one tenant can't remove another's repo (IDOR guard).
  // change_items reference repos with onDelete cascade, so their rows are cleaned up.
  await db.delete(repos).where(and(eq(repos.id, repoId), eq(repos.tenantId, session.user.tenantId)));

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
      industry: (formData.get("industry") as string) || null,
      userPersonas: parsePersonas(formData),
      doList: splitList(formData.get("doList")),
      dontList: splitList(formData.get("dontList")),
      updatedAt: new Date(),
    })
    .where(eq(brandProfiles.id, profile.id));

  revalidatePath("/settings");
}

function parseIntOrNull(value: FormDataEntryValue | null): number | null {
  if (value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export async function saveWorkspaceSchedule(formData: FormData) {
  const session = await requireSession();
  const cadence = formData.get("cadence") as Cadence;
  const thresholdRaw = formData.get("threshold");
  const threshold = thresholdRaw ? Number(thresholdRaw) : null;

  const hour = Math.min(23, Math.max(0, parseIntOrNull(formData.get("hour")) ?? 9));
  // Day-of-week is meaningful for the weekly and biweekly cadences, day-of-month
  // for the monthly cadence — store null for the others so the data stays honest.
  const dayOfWeek =
    cadence === "weekly" || cadence === "biweekly" ? parseIntOrNull(formData.get("dayOfWeek")) : null;
  const dayOfMonth = cadence === "monthly" ? parseIntOrNull(formData.get("dayOfMonth")) : null;

  // Recompute the next run from now on every save so a changed hour/day/cadence
  // takes effect immediately. Subsequent runs advance from this anchor.
  const nextScheduledAt =
    cadence === "none"
      ? null
      : computeNextScheduledAt(new Date(), cadence, { hour, dayOfWeek, dayOfMonth });

  const values = { cadence, threshold, hour, dayOfWeek, dayOfMonth, nextScheduledAt };

  // onConflictDoUpdate (not a plain insert) so a concurrent first-time save can't
  // violate the one-per-tenant unique constraint — matches saveOnboardingSchedule.
  await db
    .insert(scheduleConfigs)
    .values({ tenantId: session.user.tenantId, ...values })
    .onConflictDoUpdate({ target: scheduleConfigs.tenantId, set: values });

  revalidatePath("/settings");
  revalidatePath("/pending");
}
