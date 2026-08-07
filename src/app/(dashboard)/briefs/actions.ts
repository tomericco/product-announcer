"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { db } from "@/db";
import { briefs, contentPieces, type Brief } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { scaffoldBody } from "@/lib/briefs/scaffold";
import { generateDraftForPiece } from "@/lib/briefs/draft";

export type DismissReason = NonNullable<Brief["dismissReason"]>;
export type AcceptResult = { ok: true; contentPieceId: string } | { ok: false; error: string };
export type DismissResult = { ok: true } | { ok: false; error: string };

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
          // "brief" = approved, draft not yet generated (schema.ts's own
          // definition). Generation moves it to "draft"; until then the body is
          // the scaffold. Do NOT set "draft" here — that would present an
          // ungenerated scaffold as a finished draft.
          status: "brief",
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
  // The new content piece shows up in the drafts sidebar count too — without
  // this the count can lag behind an accept until something else revalidates
  // /drafts.
  revalidatePath("/drafts");

  // Runs once the response is finished, so accept stays instant and a
  // generation failure can never cost the human their decision.
  //
  // Request APIs (cookies, headers) ARE available inside `after` when it's
  // called from a Server Function like this one — the restriction in
  // node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md
  // applies to Server Components (pages/layouts), not Server Functions.
  // tenantId and contentPieceId are still read above and closed over here
  // deliberately: acceptBrief already has both in scope, and closing over
  // them keeps this callback's inputs explicit rather than re-deriving them
  // from the request inside the callback.
  after(async () => {
    await generateDraftForPiece(contentPieceId, tenantId);
    // The revalidatePath calls above ran before this callback was even
    // scheduled, so they only ever refreshed the page for the "brief"
    // placeholder. Without revalidating again here, the page the user is
    // sitting on never learns the draft actually finished generating until
    // something unrelated triggers a revalidation. revalidatePath is legal
    // here: its own docs (revalidatePath.md) say it "can be called in Server
    // Functions and Route Handlers" with no carve-out for `after` callbacks,
    // and unlike cookies()/headers() it isn't on next/server's list of
    // request-time APIs restricted from Server Component `after` callbacks —
    // the restriction that page even describes is specific to those APIs.
    // `npm run build` is the backstop: it already caught one illegal-export
    // rule this suite's 1216 tests missed, and would fail here too if this
    // usage were actually invalid.
    revalidatePath("/drafts");
    revalidatePath(`/drafts/${contentPieceId}`);
  });

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

/**
 * The Generate/retry button's action. `contentPieceId` is user-supplied (it
 * arrives from a URL), so tenant scoping is not optional here — it's enforced
 * inside `generateDraftForPiece`, which re-reads the piece scoped to the
 * caller's own tenant rather than trusting the id alone.
 */
export async function generateDraft(contentPieceId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireSession();
  const result = await generateDraftForPiece(contentPieceId, session.user.tenantId);
  revalidatePath("/drafts");
  revalidatePath(`/drafts/${contentPieceId}`);
  return result;
}
