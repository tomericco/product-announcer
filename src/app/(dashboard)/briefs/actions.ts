"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { briefs, contentPieces, type Brief } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";

export type DismissReason = NonNullable<Brief["dismissReason"]>;
export type AcceptResult = { ok: true; contentPieceId: string } | { ok: false; error: string };
export type DismissResult = { ok: true } | { ok: false; error: string };

/**
 * The starting body for an accepted brief.
 *
 * Deterministic and model-free on purpose: real drafting is spec 5c, and
 * `contentPieces.body` is NOT NULL so something has to be written. Key points
 * become headings because they ARE the outline — the schema deliberately has no
 * separate `outline` column.
 */
export function scaffoldBody(brief: { angle: string; whyNow: string; keyPoints: string[] }): string {
  return [brief.angle, "", `Why now: ${brief.whyNow}`, "", ...brief.keyPoints.map((p) => `## ${p}`)]
    .join("\n")
    .trim();
}

/**
 * Re-reads a brief scoped to the caller's tenant.
 *
 * The id arrives from a URL and is user-supplied, and briefs carry the
 * company's unpublished content strategy — so this is a membership check, not a
 * convenience. Returning null for "not yours" and "does not exist" alike also
 * avoids confirming that another tenant's brief exists.
 */
async function loadOwnBrief(briefId: string, tenantId: string): Promise<Brief | null> {
  const [brief] = await db
    .select()
    .from(briefs)
    .where(and(eq(briefs.id, briefId), eq(briefs.tenantId, tenantId)));
  return brief ?? null;
}

export async function acceptBrief(briefId: string): Promise<AcceptResult> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;

  const brief = await loadOwnBrief(briefId, tenantId);
  if (!brief) return { ok: false, error: "Brief not found." };
  if (brief.status !== "new") return { ok: false, error: `This brief was already ${brief.status}.` };

  let contentPieceId: string;
  try {
    contentPieceId = await db.transaction(async (tx) => {
      const [piece] = await tx
        .insert(contentPieces)
        .values({
          tenantId,
          type: brief.contentType,
          title: brief.title,
          body: scaffoldBody(brief),
          status: "draft",
        })
        .returning({ id: contentPieces.id });

      // `status = "new"` is repeated here deliberately. The check above ran in a
      // separate statement, so two clicks can both pass it; this makes the
      // transition itself the race winner, and a loser rolls back rather than
      // leaving an orphan content piece behind.
      const updated = await tx
        .update(briefs)
        .set({
          status: "accepted",
          acceptedBy: session.user.id ?? null,
          acceptedAt: new Date(),
          contentPieceId: piece.id,
        })
        .where(and(eq(briefs.id, briefId), eq(briefs.status, "new")))
        .returning({ id: briefs.id });

      if (updated.length === 0) tx.rollback();
      return piece.id;
    });
  } catch (e) {
    // Not necessarily a double-accept — this catch also sees connection
    // failures and constraint violations from the transaction above. The
    // user-facing message stays generic (retrying tells a real failure from a
    // lost race anyway), but the real cause must not vanish, so it's logged
    // the same way `runIdeation` logs its swallowed error in
    // `src/lib/briefs/run.ts`.
    console.error(`[briefs] acceptBrief transaction failed for brief ${briefId}:`, e);
    return { ok: false, error: "This brief was already accepted." };
  }

  revalidatePath("/briefs");
  return { ok: true, contentPieceId };
}

export async function dismissBrief(
  briefId: string,
  reason: DismissReason,
  note?: string
): Promise<DismissResult> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;

  const brief = await loadOwnBrief(briefId, tenantId);
  if (!brief) return { ok: false, error: "Brief not found." };
  if (brief.status !== "new") return { ok: false, error: `This brief was already ${brief.status}.` };

  // These columns are not just an audit trail: `run.ts:163-200` reads dismissed
  // briefs back into the next run's prompt as `rejected`, so writing them is
  // what makes a dismissal train the agent.
  const updated = await db
    .update(briefs)
    .set({
      status: "dismissed",
      dismissReason: reason,
      dismissNote: note?.trim() ? note.trim() : null,
      dismissedBy: session.user.id ?? null,
      dismissedAt: new Date(),
    })
    .where(and(eq(briefs.id, briefId), eq(briefs.status, "new")))
    .returning({ id: briefs.id });

  if (updated.length === 0) return { ok: false, error: "This brief was already decided." };

  revalidatePath("/briefs");
  return { ok: true };
}
