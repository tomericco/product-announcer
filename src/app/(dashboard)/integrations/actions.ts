"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { webhookConfigs, webflowConnections } from "@/db/schema";
import type { WebflowFieldMapping } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { encryptSecret, decryptSecret } from "@/lib/credentials/encryption";
import { listSites, getCollection } from "@/lib/integrations/webflow/client";
import { validateMapping, suggestMapping } from "@/lib/integrations/webflow/mapping";

export async function saveWebhookConfig(formData: FormData) {
  const session = await requireSession();
  const url = formData.get("url") as string;
  const secret = formData.get("secret") as string;
  const active = formData.get("active") === "on";

  const [existing] = await db
    .select()
    .from(webhookConfigs)
    .where(eq(webhookConfigs.tenantId, session.user.tenantId))
    .limit(1);

  // The form is write-only: an empty secret on an existing config means
  // "leave it alone", not "set it to empty".
  const encrypted = secret ? encryptSecret(secret) : null;

  if (existing) {
    await db
      .update(webhookConfigs)
      .set({
        url,
        active,
        ...(encrypted
          ? {
              secretCiphertext: encrypted.ciphertext,
              secretIv: encrypted.iv,
              secretAuthTag: encrypted.authTag,
            }
          : {}),
      })
      .where(eq(webhookConfigs.id, existing.id));
  } else {
    if (!encrypted) throw new Error("A secret is required to create a webhook config");
    await db.insert(webhookConfigs).values({
      tenantId: session.user.tenantId,
      url,
      active,
      secretCiphertext: encrypted.ciphertext,
      secretIv: encrypted.iv,
      secretAuthTag: encrypted.authTag,
    });
  }

  revalidatePath("/integrations");
}

export async function saveWebflowToken(formData: FormData) {
  const session = await requireSession();
  const token = (formData.get("token") as string).trim();

  // Validate before storing. A bad token discovered at publish time is a much
  // worse failure than one caught here.
  await listSites(token);

  const encrypted = encryptSecret(token);
  const values = {
    tokenCiphertext: encrypted.ciphertext,
    tokenIv: encrypted.iv,
    tokenAuthTag: encrypted.authTag,
    authType: "site_token" as const,
    status: "active" as const,
    lastValidatedAt: new Date(),
  };

  const [existing] = await db
    .select()
    .from(webflowConnections)
    .where(eq(webflowConnections.tenantId, session.user.tenantId))
    .limit(1);

  if (existing) {
    await db.update(webflowConnections).set(values).where(eq(webflowConnections.id, existing.id));
  } else {
    await db.insert(webflowConnections).values({ tenantId: session.user.tenantId, ...values });
  }

  revalidatePath("/integrations");
}

export async function saveWebflowSite(formData: FormData) {
  const session = await requireSession();
  await db
    .update(webflowConnections)
    .set({
      siteId: formData.get("siteId") as string,
      siteName: formData.get("siteName") as string,
      // Changing site invalidates the collection and its mapping.
      collectionId: null,
      collectionName: null,
      fieldMapping: {},
    })
    .where(eq(webflowConnections.tenantId, session.user.tenantId));
  revalidatePath("/integrations");
}

export async function saveWebflowCollection(formData: FormData) {
  const session = await requireSession();
  const collectionId = formData.get("collectionId") as string;

  const [connection] = await db
    .select()
    .from(webflowConnections)
    .where(eq(webflowConnections.tenantId, session.user.tenantId))
    .limit(1);
  if (!connection) throw new Error("No Webflow connection");

  const token = decryptSecret({
    ciphertext: connection.tokenCiphertext,
    iv: connection.tokenIv,
    authTag: connection.tokenAuthTag,
  });
  const collection = await getCollection(token, collectionId);

  await db
    .update(webflowConnections)
    .set({
      collectionId,
      collectionName: collection.displayName,
      // Pre-fill the mapping so the common case is one confirmation click.
      fieldMapping: suggestMapping(collection.fields),
    })
    .where(eq(webflowConnections.id, connection.id));

  revalidatePath("/integrations");
}

export async function saveWebflowMapping(formData: FormData) {
  const session = await requireSession();
  const [connection] = await db
    .select()
    .from(webflowConnections)
    .where(eq(webflowConnections.tenantId, session.user.tenantId))
    .limit(1);
  if (!connection?.collectionId) throw new Error("No Webflow collection selected");

  const token = decryptSecret({
    ciphertext: connection.tokenCiphertext,
    iv: connection.tokenIv,
    authTag: connection.tokenAuthTag,
  });
  const collection = await getCollection(token, connection.collectionId);

  const mapping: WebflowFieldMapping = {};
  for (const field of collection.fields) {
    const source = formData.get(`source:${field.slug}`) as string | null;
    if (!source) continue;
    if (source === "static") {
      mapping[field.slug] = { source: "static", value: (formData.get(`static:${field.slug}`) as string) ?? "" };
    } else {
      mapping[field.slug] = { source: source as "title" | "body" | "slug" | "publishedAt" | "empty" };
    }
  }

  // The gate: an unmapped required field would fail at publish time with a
  // Webflow 400 the user cannot act on. Refuse the save instead.
  const problems = validateMapping(mapping, collection.fields);
  if (problems.length > 0) throw new Error(problems.join(" "));

  await db
    .update(webflowConnections)
    .set({
      fieldMapping: mapping,
      publishMode: formData.get("publishMode") === "live" ? "live" : "draft",
      status: "active",
    })
    .where(eq(webflowConnections.id, connection.id));

  revalidatePath("/integrations");
}

export async function disconnectWebflow() {
  const session = await requireSession();
  await db.delete(webflowConnections).where(eq(webflowConnections.tenantId, session.user.tenantId));
  revalidatePath("/integrations");
}
