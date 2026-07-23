"use server";

import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { atomicUpdates, changeEvents } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";

export type AtomicUpdateEvent = {
  id: string;
  type: "commit" | "pull_request" | "task";
  // A PR's title, a commit's first message line, or (until a dedicated task
  // pipeline exists) the same prTitle field — mirrors the fallback already
  // used in regenerate-atomic-summary.ts.
  label: string;
  externalUrl: string | null;
};

export type AtomicUpdateRow = {
  id: string;
  title: string;
  summary: string;
  category: "new" | "improved" | "fixed" | null;
  events: AtomicUpdateEvent[];
  summaryEditedAt: Date | null;
  updatedAt: Date;
};

export async function listAtomicUpdates(): Promise<AtomicUpdateRow[]> {
  const session = await requireSession();

  const atomics = await db
    .select({
      id: atomicUpdates.id,
      title: atomicUpdates.title,
      summary: atomicUpdates.summary,
      category: atomicUpdates.category,
      summaryEditedAt: atomicUpdates.summaryEditedAt,
      updatedAt: atomicUpdates.updatedAt,
    })
    .from(atomicUpdates)
    .where(
      and(
        eq(atomicUpdates.tenantId, session.user.tenantId),
        eq(atomicUpdates.status, "open"),
        // Compose candidate set: an atomic update already linked to a draft
        // release is spoken for and shows up on that draft instead — see
        // getOpenAtomicUpdates in release-claim.ts for the same rule.
        isNull(atomicUpdates.releaseId)
      )
    )
    .orderBy(desc(atomicUpdates.updatedAt));

  if (atomics.length === 0) return [];

  const atomicIds = atomics.map((a) => a.id);

  // Single query for every event behind every listed atomic update, instead of
  // one query per card (the N+1 shape). Tenant-scoped independently of the
  // atomicIds filter above — the where clause is the security boundary, so
  // this join must not rely solely on ids already having been tenant-checked.
  // Ordered by createdAt then id: createdAt is always non-null (unlike
  // committedAt/mergedAt), but events ingested in the same webhook batch can
  // share a createdAt, and SQL does not guarantee a deterministic order among
  // rows with equal sort keys — id as a tiebreaker keeps a card's evidence
  // list stable across loads.
  const events = await db
    .select({
      id: changeEvents.id,
      atomicUpdateId: changeEvents.atomicUpdateId,
      type: changeEvents.type,
      prTitle: changeEvents.prTitle,
      commitMessage: changeEvents.commitMessage,
      externalUrl: changeEvents.externalUrl,
    })
    .from(changeEvents)
    .where(
      and(eq(changeEvents.tenantId, session.user.tenantId), inArray(changeEvents.atomicUpdateId, atomicIds))
    )
    .orderBy(asc(changeEvents.createdAt), asc(changeEvents.id));

  const eventsByAtomicId = new Map<string, AtomicUpdateEvent[]>();
  for (const event of events) {
    // TS-nullability guard, not a reachable branch: inArray(atomicUpdateId, atomicIds)
    // can never match a null atomicUpdateId.
    if (!event.atomicUpdateId) continue;
    const label = event.type === "commit" ? (event.commitMessage ?? "").split("\n")[0] : (event.prTitle ?? "");
    const list = eventsByAtomicId.get(event.atomicUpdateId) ?? [];
    list.push({ id: event.id, type: event.type, label, externalUrl: event.externalUrl });
    eventsByAtomicId.set(event.atomicUpdateId, list);
  }

  return atomics.map((atomic) => ({
    ...atomic,
    events: eventsByAtomicId.get(atomic.id) ?? [],
  }));
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
