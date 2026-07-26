"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { linkedinConnections } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { listAdminOrganizations } from "@/lib/integrations/linkedin/client";
import { getValidAccessToken } from "@/lib/integrations/linkedin/token";
import { normalizeBaseUrl, isOrganizationUrn } from "./linkedin-helpers";

async function loadConnectionOrThrow(tenantId: string) {
  const [connection] = await db
    .select()
    .from(linkedinConnections)
    .where(eq(linkedinConnections.tenantId, tenantId))
    .limit(1);
  if (!connection) throw new Error("LinkedIn is not connected.");
  return connection;
}

export async function listLinkedinOrganizations(): Promise<{ urn: string; name: string }[]> {
  const session = await requireSession();
  const connection = await loadConnectionOrThrow(session.user.tenantId);
  const accessToken = await getValidAccessToken(connection, db);
  return listAdminOrganizations(accessToken);
}

export async function saveLinkedinOrganization(formData: FormData): Promise<void> {
  const session = await requireSession();
  const urn = String(formData.get("urn") ?? "");
  const name = String(formData.get("name") ?? "");
  if (!urn) throw new Error("Select an organization.");
  // Company-only backstop: the ACL list only returns org URNs, but never trust
  // the submitted form value — reject anything that is not an organization page.
  if (!isOrganizationUrn(urn)) throw new Error("Only company pages can be selected.");
  await db
    .update(linkedinConnections)
    .set({ organizationUrn: urn, organizationName: name })
    .where(eq(linkedinConnections.tenantId, session.user.tenantId));
  revalidatePath("/integrations");
}

export async function saveLinkedinBaseUrl(formData: FormData): Promise<void> {
  const session = await requireSession();
  const baseUrl = normalizeBaseUrl(String(formData.get("baseUrl") ?? ""));
  await db
    .update(linkedinConnections)
    .set({ baseUrl })
    .where(eq(linkedinConnections.tenantId, session.user.tenantId));
  revalidatePath("/integrations");
}

export async function disconnectLinkedin(): Promise<void> {
  const session = await requireSession();
  await db.delete(linkedinConnections).where(eq(linkedinConnections.tenantId, session.user.tenantId));
  revalidatePath("/integrations");
}
