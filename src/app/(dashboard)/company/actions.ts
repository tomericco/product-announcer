"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { companyProfiles } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { getOrCreateCompanyProfile } from "@/lib/workspace/company-profile";
import { importBrandStyleForTenant } from "@/lib/workspace/brand-import";
import { sanitizePersonas } from "@/lib/workspace/persona-form";
import { parseTopics } from "@/lib/workspace/parse-topics";
import { addCompetitor, removeCompetitor } from "@/lib/workspace/competitors";
import { bootstrapCompanyContext } from "@/lib/workspace/company-bootstrap";

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
      oneLiner: (formData.get("oneLiner") as string)?.trim() || null,
      category: (formData.get("category") as string)?.trim() || null,
      positioning: (formData.get("positioning") as string)?.trim() || null,
      topics: parseTopics((formData.get("topics") as string) ?? ""),
      updatedAt: new Date(),
    })
    .where(eq(companyProfiles.id, profile.id));

  revalidatePath("/company");
}

export async function addCompetitorAction(formData: FormData): Promise<{ ok: boolean; reason?: string }> {
  const session = await requireSession();
  const name = (formData.get("name") as string)?.trim();
  if (!name) return { ok: false, reason: "empty-name" };

  await addCompetitor(session.user.tenantId, {
    name,
    websiteUrl: (formData.get("websiteUrl") as string)?.trim() || null,
  });

  revalidatePath("/company");
  return { ok: true };
}

/**
 * Takes `unknown`-shaped client input like `savePersonas` does: a Server Action
 * argument is public input, and the tenant scoping lives inside `removeCompetitor`
 * so an id from another workspace matches nothing.
 */
export async function removeCompetitorAction(id: string): Promise<void> {
  const session = await requireSession();
  await removeCompetitor(session.user.tenantId, id);
  revalidatePath("/company");
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
