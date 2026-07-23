"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { repos, webhookConfigs, webflowConnections } from "@/db/schema";
import type { WebflowFieldMapping } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { encryptSecret, decryptSecret } from "@/lib/credentials/encryption";
import {
  listSites,
  listCollections,
  getCollection,
  type WebflowSite,
  type WebflowCollection,
} from "@/lib/integrations/webflow/client";
import { validateMapping, suggestMapping } from "@/lib/integrations/webflow/mapping";

// Next's Flight runtime replaces a thrown server-action error's message with
// a generic "omitted in production" string once built for production — only
// the message set in a `redirect()`/`notFound()` digest and messages
// returned as plain data survive. Throwing was fine for a message no one
// needed to read, but two things this feature promises depend on the exact
// text reaching the user: catching a bad Webflow token at save time, and
// blocking an incomplete field mapping with an actionable reason. Returning
// a typed result instead means the real message always reaches the client
// component that renders it, in every build mode.
export type ActionResult = { ok: true } | { ok: false; error: string };

// Server actions are public POST endpoints — the browser's `required`
// attribute doesn't protect them. A missing field must fail with a message
// the caller can act on instead of a raw TypeError or a DB constraint error.
// (Not exported: "use server" only turns exported functions into RPC
// endpoints, so a plain sync helper here is fine — see resolveBody in
// drafts/actions.ts for the same pattern.) It still throws: every exported
// action below calls it from inside its own try/catch, which turns that
// throw into an `ActionResult` before it ever crosses the server/client
// boundary.
function requiredField(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`"${name}" is required.`);
  }
  return value.trim();
}

function failure(error: unknown, fallback: string): ActionResult {
  return { ok: false, error: error instanceof Error ? error.message : fallback };
}

export async function removeRepo(formData: FormData) {
  const session = await requireSession();
  const repoId = (formData.get("repoId") as string)?.trim();
  if (!repoId) return;

  // Tenant-scoped delete so one tenant can't remove another's repo (IDOR guard).
  // change_events reference repos with onDelete cascade, so their rows are cleaned up.
  await db.delete(repos).where(and(eq(repos.id, repoId), eq(repos.tenantId, session.user.tenantId)));

  revalidatePath("/integrations");
  revalidatePath("/atomic-updates");
}

export async function saveWebhookConfig(formData: FormData): Promise<ActionResult> {
  // requireSession() calls Next's redirect() when there's no valid session,
  // which works by throwing a special digest-marked error that must
  // propagate untouched — it must stay outside the try/catch below, or the
  // generic `failure()` handling would swallow it into a normal error result.
  const session = await requireSession();
  try {
    const url = requiredField(formData, "url");
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
      await db.insert(webhookConfigs).values({
        tenantId: session.user.tenantId,
        url,
        active,
        // A secret is optional: with none provided, the columns stay null and
        // deliveries go out unsigned.
        ...(encrypted
          ? { secretCiphertext: encrypted.ciphertext, secretIv: encrypted.iv, secretAuthTag: encrypted.authTag }
          : {}),
      });
    }

    revalidatePath("/integrations");
    return { ok: true };
  } catch (error) {
    return failure(error, "Could not save the webhook configuration");
  }
}

export async function saveWebflowToken(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  try {
    const token = requiredField(formData, "token");

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
    return { ok: true };
  } catch (error) {
    return failure(error, "Could not connect to Webflow");
  }
}

export async function saveWebflowSite(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  try {
    const siteId = requiredField(formData, "siteId");
    const siteName = requiredField(formData, "siteName");

    const [connection] = await db
      .select()
      .from(webflowConnections)
      .where(eq(webflowConnections.tenantId, session.user.tenantId))
      .limit(1);
    if (!connection) throw new Error("No Webflow connection");

    // Re-selecting the SAME site (e.g. opening "Change site" just to check
    // what's wired up, then confirming without changing anything) must be a
    // no-op. Without this guard the write below runs unconditionally and its
    // cascade — nulling collectionId/collectionName and wiping fieldMapping —
    // fires even though nothing actually changed, destroying a hand-tuned
    // mapping for no reason.
    if (connection.siteId === siteId) {
      revalidatePath("/integrations");
      return { ok: true };
    }

    await db
      .update(webflowConnections)
      .set({
        siteId,
        siteName,
        // Changing site invalidates the collection and its mapping.
        collectionId: null,
        collectionName: null,
        fieldMapping: {},
      })
      .where(eq(webflowConnections.id, connection.id));
    revalidatePath("/integrations");
    return { ok: true };
  } catch (error) {
    return failure(error, "Could not save the selected site");
  }
}

// Read-only lookups backing the "Change site" / "Change collection"
// affordances in the connected wizard. They exist so the picker forms
// (WebflowSiteForm / WebflowCollectionForm) can be re-shown on demand from a
// Client Component instead of eagerly fetched on every render. The actual
// mutation — and the collection/mapping-clearing cascade — stays in
// saveWebflowSite below; this only fetches the list to choose from.
export async function fetchWebflowSites(): Promise<WebflowSite[]> {
  const session = await requireSession();
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
  return listSites(token);
}

export async function fetchWebflowCollections(): Promise<WebflowCollection[]> {
  const session = await requireSession();
  const [connection] = await db
    .select()
    .from(webflowConnections)
    .where(eq(webflowConnections.tenantId, session.user.tenantId))
    .limit(1);
  if (!connection?.siteId) throw new Error("No Webflow site selected");

  const token = decryptSecret({
    ciphertext: connection.tokenCiphertext,
    iv: connection.tokenIv,
    authTag: connection.tokenAuthTag,
  });
  return listCollections(token, connection.siteId);
}

export async function saveWebflowCollection(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  try {
    const collectionId = requiredField(formData, "collectionId");

    const [connection] = await db
      .select()
      .from(webflowConnections)
      .where(eq(webflowConnections.tenantId, session.user.tenantId))
      .limit(1);
    if (!connection) throw new Error("No Webflow connection");

    // Re-selecting the SAME collection must be a no-op, for the identical
    // reason as saveWebflowSite above: without this guard, confirming the
    // picker on an unchanged value would still re-suggest and overwrite the
    // user's hand-tuned fieldMapping with a fresh suggestMapping() result.
    if (connection.collectionId === collectionId) {
      revalidatePath("/integrations");
      return { ok: true };
    }

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
    return { ok: true };
  } catch (error) {
    return failure(error, "Could not save the selected collection");
  }
}

export async function saveWebflowMapping(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  try {
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
    return { ok: true };
  } catch (error) {
    return failure(error, "Could not save the field mapping");
  }
}

export async function disconnectWebflow() {
  const session = await requireSession();
  await db.delete(webflowConnections).where(eq(webflowConnections.tenantId, session.user.tenantId));
  revalidatePath("/integrations");
}
