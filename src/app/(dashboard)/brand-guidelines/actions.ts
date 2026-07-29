"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { brandProfiles } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { getOrCreateBrandProfile } from "@/lib/workspace/brand-profile";
import { importBrandStyleForTenant } from "@/lib/workspace/brand-import";
import { parsePersonas } from "@/lib/workspace/persona-form";

export async function saveBrandProfile(formData: FormData) {
  const session = await requireSession();
  const profile = await getOrCreateBrandProfile(session.user.tenantId);

  await db
    .update(brandProfiles)
    .set({
      guidelines: (formData.get("guidelines") as string)?.trim() || null,
      industry: (formData.get("industry") as string) || null,
      userPersonas: parsePersonas(formData),
      updatedAt: new Date(),
    })
    .where(eq(brandProfiles.id, profile.id));

  revalidatePath("/brand-guidelines");
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
  if (result.ok) revalidatePath("/brand-guidelines");
  return result;
}
