"use server";

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { releases, deliveryAttempts, users } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { destinationLabel } from "@/lib/publishing/dispatch";
import { renderMarkdown } from "@/lib/markdown/render";

export type ReleaseDestinationStatus = {
  destination: "webhook" | "webflow" | "linkedin";
  label: string;
  status: "pending" | "success" | "failed";
  error: string | null;
};

export type ReleaseDetail = {
  id: string;
  title: string;
  bodyHtml: string;
  linkedinBody: string | null;
  publishedAt: string | null;
  publisherName: string | null;
  destinations: ReleaseDestinationStatus[];
};

export async function getReleaseDetail(releaseId: string): Promise<ReleaseDetail | null> {
  const session = await requireSession();

  const [row] = await db
    .select({
      id: releases.id,
      title: releases.title,
      body: releases.body,
      linkedinBody: releases.linkedinBody,
      publishedAt: releases.publishedAt,
      publisherName: users.name,
      publisherEmail: users.email,
    })
    .from(releases)
    .leftJoin(users, eq(releases.publishedBy, users.id))
    // Tenant-scoped: a release the caller doesn't own returns no row → null.
    .where(and(eq(releases.id, releaseId), eq(releases.tenantId, session.user.tenantId)))
    .limit(1);
  if (!row) return null;

  // The release is confirmed the caller's above, so its delivery attempts
  // (FK'd to it) are safe to read by releaseId alone.
  const attempts = await db
    .select({
      destination: deliveryAttempts.destination,
      status: deliveryAttempts.status,
      error: deliveryAttempts.lastError,
    })
    .from(deliveryAttempts)
    .where(eq(deliveryAttempts.releaseId, releaseId))
    .orderBy(deliveryAttempts.destination);

  return {
    id: row.id,
    title: row.title,
    bodyHtml: renderMarkdown(row.body),
    linkedinBody: row.linkedinBody,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    publisherName: row.publisherName ?? row.publisherEmail ?? null,
    destinations: attempts.map((a) => ({
      destination: a.destination,
      label: destinationLabel(a.destination),
      status: a.status,
      error: a.error,
    })),
  };
}
