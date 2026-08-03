"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { companyProfiles, scheduleConfigs, tenants } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { addSelectedRepos } from "@/lib/workspace/repo-sync";
import { parseRepoSelections } from "@/lib/workspace/repo-selection-form";
import { advanceOnboardingStep, isOnboardingComplete, markOnboardingComplete } from "@/lib/workspace/onboarding";
import { listRepoBranches } from "@/lib/integrations/github/github";
import { importBrandStyleForTenant } from "@/lib/workspace/brand-import";
import { bootstrapCompanyContext } from "@/lib/workspace/company-bootstrap";
import { getOrCreateCompanyProfile } from "@/lib/workspace/company-profile";
import { parseTopics } from "@/lib/workspace/parse-topics";
import { parseHour } from "@/lib/workspace/parse-hour";

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
  const hour = parseHour(formData.get("hour"));

  await db
    .insert(scheduleConfigs)
    .values({ tenantId: session.user.tenantId, hour })
    .onConflictDoUpdate({ target: scheduleConfigs.tenantId, set: { hour } });

  await markOnboardingComplete(session.user.tenantId);
  redirect("/atomic-updates");
}

/**
 * Finish onboarding without configuring a schedule at all. Deliberately writes no
 * scheduleConfigs row: the ideation run (spec 5) iterates the rows that exist, so
 * a tenant without one is simply never picked up until they set an hour in Settings.
 */
export async function skipScheduleStep() {
  const session = await requireSession();
  await markOnboardingComplete(session.user.tenantId);
  redirect("/atomic-updates");
}

/**
 * Derives brand voice from a public updates page and stores it. A tertiary
 * action on step 2 (below the profile review that bootstrapOnboardingCompany /
 * saveOnboardingCompany drives) — reads a different page for a different
 * purpose, so it neither replaces nor is replaced by that flow. It deliberately
 * does NOT advance the step: saveOnboardingCompany is the step's only exit,
 * because advancing here would skip past the review and strand any unsaved
 * corrections — and guardOnboardingStep(2) would then bounce a user who
 * navigates back to fix them.
 */
export async function importBrandStyle(formData: FormData) {
  const session = await requireSession();
  // Re-gated after the wizard rewrite dropped it. guardOnboardingStep(2) protects
  // the PAGE, but a server action is a public endpoint that can be replayed
  // directly — and importBrandStyleForTenant fetches a live page and runs an LLM
  // derivation, so an ungated replay burns real money on a tenant who is already
  // done. The write itself is idempotent; the cost is not.
  if (await isOnboardingComplete(session.user.tenantId)) return redirect("/atomic-updates");

  const url = (formData.get("updatesPageUrl") as string)?.trim();
  // An empty URL is a hard validation error, so it gets the same visible
  // treatment as an empty workspace name rather than a silent bounce.
  if (!url) return redirect("/onboarding/brand?error=empty");

  const result = await importBrandStyleForTenant(session.user.tenantId, url);
  // A failed scrape keeps the user on step 2 so they can try another URL; only
  // a success returns there too, now with the imported style in place.
  if (!result.ok) return redirect("/onboarding/brand?brandImport=failed");

  return redirect("/onboarding/brand");
}

export async function bootstrapOnboardingCompany(formData: FormData) {
  const session = await requireSession();
  // Same gate as importBrandStyle, for the same reason: guardOnboardingStep(2)
  // protects the PAGE, but a server action is a public endpoint that can be
  // replayed directly — and bootstrapCompanyContext fetches up to four live
  // pages and runs an LLM derivation, so an ungated replay burns real money on
  // a tenant who is already done. The write is idempotent; the cost is not.
  if (await isOnboardingComplete(session.user.tenantId)) return redirect("/atomic-updates");

  const url = (formData.get("websiteUrl") as string)?.trim();
  if (!url) return redirect("/onboarding/brand?error=empty");

  const result = await bootstrapCompanyContext(session.user.tenantId, url);
  // A failed crawl keeps the user on step 2 so they can try another URL or skip;
  // only a success advances. A company whose site blocks us must never be trapped.
  // The reason travels in the query string (rather than a flat "failed") so the
  // page can tell "we couldn't read your site" (a PageError) apart from "we read
  // it fine but the model derived nothing" (analysis-empty) — those need
  // different advice, and "try another URL" is actively wrong for the latter.
  if (!result.ok) return redirect(`/onboarding/brand?bootstrap=${result.reason ?? "failed"}`);

  // Deliberately does NOT advance the step or leave the page. The profile is
  // the ranking function every later agent scores signals against, so a wrong
  // draft silently degrades every brief the product ever proposes — the human
  // reviews it on THIS page (drafted=1 tells the page to render that review)
  // before saveOnboardingCompany below is the thing that actually advances.
  return redirect("/onboarding/brand?drafted=1");
}

/**
 * Persists the reviewed (and possibly corrected) draft, then leaves step 2 for
 * good. Split from bootstrapOnboardingCompany above on purpose: that action
 * re-runs the crawl every time it's called, so it cannot also be "the save" —
 * calling it a second time to persist edits would re-derive from the site and
 * silently discard whatever the human just corrected.
 */
export async function saveOnboardingCompany(formData: FormData) {
  const session = await requireSession();
  // Same gate as its neighbours: this still writes (and advances), so a
  // replayed POST after onboarding is done must not mutate the profile.
  if (await isOnboardingComplete(session.user.tenantId)) return redirect("/atomic-updates");

  const profile = await getOrCreateCompanyProfile(session.user.tenantId);

  await db
    .update(companyProfiles)
    .set({
      oneLiner: (formData.get("oneLiner") as string)?.trim() || null,
      category: (formData.get("category") as string)?.trim() || null,
      positioning: (formData.get("positioning") as string)?.trim() || null,
      topics: parseTopics((formData.get("topics") as string) ?? ""),
      updatedAt: new Date(),
    })
    .where(eq(companyProfiles.id, profile.id));

  await advanceOnboardingStep(session.user.tenantId, 3);
  return redirect("/onboarding/connect");
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
