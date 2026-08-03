"use server";

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { contentPieces, deliveryAttempts, users } from "@/db/schema";
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

export async function getReleaseDetail(contentPieceId: string): Promise<ReleaseDetail | null> {
  const session = await requireSession();

  const [row] = await db
    .select({
      id: contentPieces.id,
      title: contentPieces.title,
      body: contentPieces.body,
      linkedinBody: contentPieces.linkedinBody,
      publishedAt: contentPieces.publishedAt,
      publisherName: users.name,
      publisherEmail: users.email,
    })
    .from(contentPieces)
    .leftJoin(users, eq(contentPieces.publishedBy, users.id))
    // Tenant-scoped: a content piece the caller doesn't own returns no row → null.
    .where(and(eq(contentPieces.id, contentPieceId), eq(contentPieces.tenantId, session.user.tenantId)))
    .limit(1);
  if (!row) return null;

  // The content piece is confirmed the caller's above, so its delivery
  // attempts (FK'd to it) are safe to read by contentPieceId alone.
  const attempts = await db
    .select({
      destination: deliveryAttempts.destination,
      status: deliveryAttempts.status,
      error: deliveryAttempts.lastError,
    })
    .from(deliveryAttempts)
    .where(eq(deliveryAttempts.contentPieceId, contentPieceId))
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
