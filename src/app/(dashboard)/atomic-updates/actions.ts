"use server";

import { and, desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { atomicUpdates, changeEvents } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";

export type AtomicUpdateRow = {
  id: string;
  title: string;
  summary: string;
  category: "new" | "improved" | "fixed" | null;
  eventCount: number;
  summaryEditedAt: Date | null;
  updatedAt: Date;
};

export async function listAtomicUpdates(): Promise<AtomicUpdateRow[]> {
  const session = await requireSession();

  return db
    .select({
      id: atomicUpdates.id,
      title: atomicUpdates.title,
      summary: atomicUpdates.summary,
      category: atomicUpdates.category,
      eventCount: sql<number>`count(${changeEvents.id})::int`,
      summaryEditedAt: atomicUpdates.summaryEditedAt,
      updatedAt: atomicUpdates.updatedAt,
    })
    .from(atomicUpdates)
    .leftJoin(changeEvents, eq(changeEvents.atomicUpdateId, atomicUpdates.id))
    .where(and(eq(atomicUpdates.tenantId, session.user.tenantId), eq(atomicUpdates.status, "open")))
    .groupBy(atomicUpdates.id)
    .orderBy(desc(atomicUpdates.updatedAt));
}

export async function editAtomicUpdate(
  id: string,
  patch: { title: string; summary: string }
): Promise<void> {
  const session = await requireSession();

  // Tenant scoping is enforced per-query in this codebase, not by RLS — the
  // where clause is the security boundary.
  await db
    .update(atomicUpdates)
    .set({
      title: patch.title,
      summary: patch.summary,
      // Freezes automatic regeneration: from here on, only the user rewrites this.
      summaryEditedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(atomicUpdates.id, id), eq(atomicUpdates.tenantId, session.user.tenantId)));

  revalidatePath("/atomic-updates");
}
