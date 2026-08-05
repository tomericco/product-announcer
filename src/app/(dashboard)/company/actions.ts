"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { companyProfiles, competitors, sources } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { getOrCreateCompanyProfile } from "@/lib/workspace/company-profile";
import { importBrandStyleForTenant } from "@/lib/workspace/brand-import";
import { sanitizePersonas } from "@/lib/workspace/persona-form";
import { parseTopics } from "@/lib/workspace/parse-topics";
import { addCompetitor, listCompetitors, removeCompetitor } from "@/lib/workspace/competitors";
import { bootstrapCompanyContext } from "@/lib/workspace/company-bootstrap";
import { discoverCompetitorSources } from "@/lib/signals/discover-sources";

/**
 * Persists the guidelines document. Scoped to that one column on purpose: every
 * card on the page saves itself now, so industry and personas are no longer
 * submitted with this form. Widening this back out to `industry`/`userPersonas`
 * would read them as absent and null both columns on every guidelines save.
 */
export async function saveGuidelines(formData: FormData) {
  const session = await requireSession();
  const profile = await getOrCreateCompanyProfile(session.user.tenantId);

  await db
    .update(companyProfiles)
    .set({
      guidelines: (formData.get("guidelines") as string)?.trim() || null,
      updatedAt: new Date(),
    })
    .where(eq(companyProfiles.id, profile.id));

  revalidatePath("/company");
}

/**
 * Persists the industry on its own, as soon as one is picked. Writes only its
 * own column, so it can't disturb an in-progress guidelines edit.
 */
export async function saveIndustry(industry: string): Promise<void> {
  const session = await requireSession();
  const profile = await getOrCreateCompanyProfile(session.user.tenantId);

  await db
    .update(companyProfiles)
    .set({ industry: industry.trim() || null, updatedAt: new Date() })
    .where(eq(companyProfiles.id, profile.id));

  revalidatePath("/company");
}

/**
 * Persists the whole persona list. Called when a persona is added or removed
 * (those save on click), and by the Save button inside a custom persona once
 * its Name and Brief have been edited — the list lives in one JSON column, so
 * either trigger writes all of it.
 *
 * Takes `unknown` deliberately: a Server Action argument is client input, so it
 * goes through the same validation as the form path.
 */
export async function savePersonas(personas: unknown): Promise<void> {
  const session = await requireSession();
  const profile = await getOrCreateCompanyProfile(session.user.tenantId);

  await db
    .update(companyProfiles)
    .set({ userPersonas: sanitizePersonas(personas), updatedAt: new Date() })
    .where(eq(companyProfiles.id, profile.id));

  revalidatePath("/company");
}

/**
 * Re-derives the brand guidelines from a public updates page (the same
 * extraction used in onboarding) and overwrites them. Called from the import
 * panel, which confirms first since this replaces hand-written guidelines.
 * Returns the outcome so the client can show inline feedback.
 */
export async function importBrandStyleFromUrl(url: string): Promise<{ ok: boolean; reason?: string }> {
  const session = await requireSession();
  const trimmed = url.trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  const result = await importBrandStyleForTenant(session.user.tenantId, trimmed);
  if (result.ok) revalidatePath("/company");
  return result;
}

/**
 * Persists the company-context card. Scoped to its own columns for the same
 * reason `saveGuidelines` is: every card on this page saves itself, so widening
 * this would read absent fields as empty and null another card's column.
 */
export async function saveCompanyContext(formData: FormData) {
  const session = await requireSession();
  const profile = await getOrCreateCompanyProfile(session.user.tenantId);

  await db
    .update(companyProfiles)
    .set({
      websiteUrl: (formData.get("websiteUrl") as string)?.trim() || null,
      oneLiner: (formData.get("oneLiner") as string)?.trim() || null,
      category: (formData.get("category") as string)?.trim() || null,
      positioning: (formData.get("positioning") as string)?.trim() || null,
      topics: parseTopics((formData.get("topics") as string) ?? ""),
      updatedAt: new Date(),
    })
    .where(eq(companyProfiles.id, profile.id));

  revalidatePath("/company");
}

/**
 * Adds a competitor. Reports `reason: "exists"` on success when the name
 * (case-insensitively) was already on the list, so the client can tell the
 * user rather than silently clearing the inputs and appearing to do nothing --
 * `addCompetitor` itself is idempotent and returns the existing row in that
 * case, which is indistinguishable from a fresh insert unless checked here.
 */
export async function addCompetitorAction(formData: FormData): Promise<{ ok: boolean; reason?: string }> {
  const session = await requireSession();
  const name = (formData.get("name") as string)?.trim();
  if (!name) return { ok: false, reason: "empty-name" };

  const existing = await listCompetitors(session.user.tenantId);
  const alreadyExists = existing.some((c) => c.name.toLowerCase() === name.toLowerCase());

  await addCompetitor(session.user.tenantId, {
    name,
    websiteUrl: (formData.get("websiteUrl") as string)?.trim() || null,
  });

  revalidatePath("/company");
  return alreadyExists ? { ok: true, reason: "exists" } : { ok: true };
}

/**
 * Removes a competitor. Takes `unknown`, like `savePersonas` does: a Server
 * Action argument is client input, so it's checked here rather than trusted as
 * the `string` TypeScript would otherwise imply. Tenant scoping lives inside
 * `removeCompetitor`, so a well-formed id from another workspace still
 * matches nothing.
 */
export async function removeCompetitorAction(id: unknown): Promise<void> {
  const session = await requireSession();
  if (typeof id !== "string" || !id) return;
  await removeCompetitor(session.user.tenantId, id);
  revalidatePath("/company");
}

/**
 * Finds the changelog/blog/release-notes pages worth watching on a
 * competitor's site and resolves each one's agent-facing variant. Takes
 * `unknown`, like `removeCompetitorAction`: a Server Action argument is
 * client input. The competitor lookup is scoped to `session.user.tenantId`,
 * the same guard `removeCompetitorAction` uses, so an id from another
 * workspace matches nothing rather than leaking that workspace's competitor.
 */
export async function discoverSourcesAction(
  competitorId: unknown
): Promise<{ ok: boolean; reason?: string; count?: number }> {
  const session = await requireSession();
  if (typeof competitorId !== "string" || !competitorId) return { ok: false, reason: "invalid-id" };

  const [competitor] = await db
    .select()
    .from(competitors)
    .where(and(eq(competitors.tenantId, session.user.tenantId), eq(competitors.id, competitorId)))
    .limit(1);
  if (!competitor) return { ok: false, reason: "not-found" };
  if (!competitor.websiteUrl) return { ok: false, reason: "no-website" };

  const created = await discoverCompetitorSources(session.user.tenantId, competitor.id, competitor.websiteUrl);
  revalidatePath("/company");
  return { ok: true, count: created.length };
}

/**
 * Re-drafts the company profile from their website. Returns the outcome so the
 * client can show inline feedback, matching `importBrandStyleFromUrl`.
 */
export async function bootstrapFromWebsite(url: string): Promise<{ ok: boolean; reason?: string }> {
  const session = await requireSession();
  const trimmed = url.trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  const result = await bootstrapCompanyContext(session.user.tenantId, trimmed);
  if (result.ok) revalidatePath("/company");
  return result;
}

/**
 * Opts a tenant in or out of daily news watching. News costs a Tavily credit
 * per topic per run, so unlike competitor sources (created by discovery) this
 * one is only ever created by a human flipping this toggle on.
 *
 * Upserts against the null-url identity index from spec 4
 * (`sources_tenant_type_null_url_unique`) rather than insert-then-update, so
 * enabling twice tops up the same row instead of racing a duplicate, and
 * disabling flips `status` rather than deleting -- `lastRunAt`, `lastSuccessAt`,
 * and `lastError` survive for the health display to keep reading after the
 * tenant turns it back on.
 */
export async function setNewsWatching(enabled: boolean) {
  const session = await requireSession();

  await db
    .insert(sources)
    .values({
      tenantId: session.user.tenantId,
      type: "news",
      url: null,
      label: "Industry news",
      status: enabled ? "active" : "disabled",
    })
    .onConflictDoUpdate({
      // The null-url identity index from task 2. Enabling twice must top up,
      // not duplicate; disabling must not delete, so lastError and lastRunAt
      // survive for the operator to read.
      target: [sources.tenantId, sources.type],
      targetWhere: sql`${sources.url} IS NULL`,
      set: {
        status: enabled ? "active" : "disabled",
        // Enabling clears the stale error. The common path here is a tenant
        // reading "Company profile has no topics to search on.", adding
        // topics, and re-toggling -- without this they keep reading the
        // complaint they just fixed until the next nightly run overwrites it.
        // Disabling leaves it alone: that is exactly when the operator needs
        // the last failure still on screen.
        ...(enabled ? { lastError: null } : {}),
      },
    });

  revalidatePath("/company");
}
