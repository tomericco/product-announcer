"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { db } from "@/db";
import { repos, scheduleConfigs, tenants } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { requireRole } from "@/lib/workspace/active-tenant";
import { addSelectedRepos } from "@/lib/workspace/repo-sync";
import { listRepoBranches } from "@/lib/integrations/github/github";
import { createInvite, revokeActiveInvite } from "@/lib/workspace/invites";
import { removeWorkspaceMember } from "@/lib/workspace/members";
import { parseHour } from "@/lib/workspace/parse-hour";
import { normalizeWeekStart, parseHolidayCountries } from "@/lib/workspace/calendar-settings";

export async function saveWorkspaceName(formData: FormData) {
  const session = await requireSession();
  const name = (formData.get("name") as string)?.trim();
  if (!name) return;

  await db.update(tenants).set({ name }).where(eq(tenants.id, session.user.tenantId));
  revalidatePath("/settings");
}

/**
 * The two workspace calendar settings, saved together because they share one
 * card and one Save button. Both values are re-derived from the allow-lists in
 * `calendar-settings.ts` rather than trusted from the form, so a stale or
 * tampered submission can only ever land a value the UI itself offers.
 *
 * `/calendar` is revalidated too: it reads both columns on every render, so a
 * save that only revalidated `/settings` would leave the grid showing the old
 * week start until something else invalidated it.
 */
export async function saveCalendarSettings(formData: FormData) {
  const session = await requireSession();

  const weekStartsOn = normalizeWeekStart(formData.get("weekStartsOn"));
  const holidayCountries = parseHolidayCountries(formData.getAll("holidayCountries"));

  await db
    .update(tenants)
    .set({ weekStartsOn, holidayCountries })
    .where(eq(tenants.id, session.user.tenantId));

  revalidatePath("/settings");
  revalidatePath("/calendar");
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

  revalidatePath("/integrations");
  revalidatePath("/company");
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

  revalidatePath("/integrations");
  revalidatePath("/company");
}

export async function saveWorkspaceSchedule(formData: FormData) {
  const session = await requireSession();
  const hour = parseHour(formData.get("hour"));

  // onConflictDoUpdate (not a plain insert) so a concurrent first-time save can't
  // violate the one-per-tenant unique constraint — matches saveOnboardingSchedule.
  await db
    .insert(scheduleConfigs)
    .values({ tenantId: session.user.tenantId, hour })
    .onConflictDoUpdate({ target: scheduleConfigs.tenantId, set: { hour } });

  revalidatePath("/settings");
  revalidatePath("/company");
}

export async function generateInviteLink(): Promise<{ url: string; expiresAt: string }> {
  const session = await requireSession();
  requireRole(session, "owner");

  const { token, expiresAt } = await createInvite(session.user.tenantId, session.user.id);

  // Build an absolute URL from the request origin (never embeds the tenant id).
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  const origin = process.env.NEXTAUTH_URL ?? (host ? `${proto}://${host}` : "");
  const url = `${origin}/invite/${token}`;

  revalidatePath("/settings");
  return { url, expiresAt: expiresAt.toISOString() };
}

export async function revokeInviteLink(): Promise<void> {
  const session = await requireSession();
  requireRole(session, "owner");
  await revokeActiveInvite(session.user.tenantId);
  revalidatePath("/settings");
}

export async function removeMember(targetUserId: string): Promise<void> {
  const session = await requireSession();
  requireRole(session, "owner");
  // Scoped to the active tenant; self-removal is refused inside the helper so
  // the workspace always keeps at least one owner.
  await removeWorkspaceMember(session.user.tenantId, session.user.id, targetUserId);
  revalidatePath("/settings");
}
