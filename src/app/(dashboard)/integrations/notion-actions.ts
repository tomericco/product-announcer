"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { notionConnections, type NotionConnection } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { listDatabases, getDatabaseProperties } from "@/lib/integrations/notion/client";
import { withFreshToken } from "@/lib/integrations/notion/connection";

export type ActionResult = { ok: true } | { ok: false; error: string };

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

async function loadConnection(tenantId: string): Promise<NotionConnection> {
  const [connection] = await db
    .select()
    .from(notionConnections)
    .where(eq(notionConnections.tenantId, tenantId))
    .limit(1);
  if (!connection) throw new Error("No Notion connection");
  return connection;
}

export async function fetchNotionDatabases(): Promise<{ id: string; title: string }[]> {
  const session = await requireSession();
  const connection = await loadConnection(session.user.tenantId);
  return withFreshToken(db, connection, (token) => listDatabases(token));
}

export async function saveNotionDatabase(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  try {
    const databaseId = requiredField(formData, "databaseId");
    const databaseName = requiredField(formData, "databaseName");
    const connection = await loadConnection(session.user.tenantId);

    // Changing the database invalidates the completion mapping; reset it and
    // return to misconfigured until the tenant re-maps completion.
    await db
      .update(notionConnections)
      .set({
        databaseId,
        databaseName,
        statusPropertyId: null,
        statusPropertyName: null,
        doneValues: [],
        status: "misconfigured",
      })
      .where(eq(notionConnections.id, connection.id));

    revalidatePath("/integrations");
    return { ok: true };
  } catch (error) {
    return failure(error, "Could not save the selected database");
  }
}

export async function fetchNotionStatusProperties(): Promise<
  { id: string; name: string; options: { id: string; name: string }[] }[]
> {
  const session = await requireSession();
  const connection = await loadConnection(session.user.tenantId);
  if (!connection.databaseId) return [];
  return withFreshToken(db, connection, (token) => getDatabaseProperties(token, connection.databaseId!));
}

export async function saveNotionCompletion(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  try {
    const statusPropertyId = requiredField(formData, "statusPropertyId");
    const statusPropertyName = requiredField(formData, "statusPropertyName");
    const doneValues = formData.getAll("doneValues").filter((v): v is string => typeof v === "string" && v.trim() !== "");
    if (doneValues.length === 0) throw new Error("Pick at least one value that means the task is done.");

    const connection = await loadConnection(session.user.tenantId);
    if (!connection.databaseId) throw new Error("Select a database first.");

    await db
      .update(notionConnections)
      .set({ statusPropertyId, statusPropertyName, doneValues, status: "active" })
      .where(eq(notionConnections.id, connection.id));

    revalidatePath("/integrations");
    return { ok: true };
  } catch (error) {
    return failure(error, "Could not save the completion mapping");
  }
}

export async function disconnectNotion(): Promise<void> {
  const session = await requireSession();
  await db.delete(notionConnections).where(eq(notionConnections.tenantId, session.user.tenantId));
  revalidatePath("/integrations");
}
