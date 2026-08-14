"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { db } from "@/db";
import { briefs, contentPieces, type Brief } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { briefBody } from "@/lib/briefs/body";
import { generateDraftForPiece, queueGeneration, GENERATION_QUEUED_STEP } from "@/lib/briefs/draft";

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
          // The brief's OWN document, through the accessor — never re-rendered
          // from `angle`/`whyNow`/`keyPoints`. Those fields are creation-time
          // provenance and are never updated after a human edits the brief, so
          // rendering from them here seeded the piece with the pre-edit outline:
          // the author was redirected to /drafts/[id] and shown, as "the outline
          // below", content they had just replaced. Worse, a generation failure
          // deliberately leaves the piece at "brief" with this body intact, so
          // the stale outline became the permanent thing they went on editing.
          //
          // Applied to product_update briefs too, deliberately and with no
          // fork. `generateDraftForPiece`'s release branch ignores the
          // commission when it composes from atomic updates — but that is about
          // what the MODEL reads. This is what the HUMAN sees and may keep, and
          // on a release brief they are the more likely to keep it: the release
          // branch is the one that throws on a lost atomic-update claim and
          // leaves the piece sitting at "brief" with exactly this body.
          body: briefBody(brief),
          // "brief" = approved, draft not yet generated (schema.ts's own
          // definition). Generation moves it to "draft"; until then the body is
          // the brief's. Do NOT set "draft" here — that would present an
          // ungenerated commission as a finished draft.
          status: "brief",
          // Born already marked as generating, in the same INSERT — the
          // `after()` callback below is unconditional, so this piece IS
          // generating from the moment it exists. Writing it here rather than
          // as a follow-up `queueGeneration` call leaves no window at all:
          // this action redirects the client straight to /drafts/[id], and
          // that render used to race the callback's first step write roughly
          // fifty-fifty. Losing the race showed "Awaiting generation" next to
          // a live Generate button for the whole run — one click from a second
          // overlapping generation, since nothing on that page re-renders on
          // its own (revalidatePath invalidates cache, it does not push).
          generationStep: GENERATION_QUEUED_STEP,
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
 *
 * FIRE-AND-FORGET, exactly like `acceptBrief` above: it schedules the
 * generation in `after()` and returns as soon as the work is queued. `{ ok:
 * true }` means "generation started", NOT "draft ready" — both callers render
 * the shared `GenerationChecklist` for the run itself.
 *
 * It used to `await generateDraftForPiece` inline. That held the server action
 * open for the entire generate + review round trip, so nothing re-rendered
 * mid-flight and the persisted-progress checklist — the whole point of
 * `generationStep` — could never mount on this path. The user got a spinner on
 * a button and no idea which step was running.
 *
 * The claim is what makes this safe to fire and forget. `queueGeneration`
 * re-checks eligibility under the caller's own tenant and marks the piece in
 * one statement, so:
 *
 *   - the step is already non-null when this returns, and the caller's refresh
 *     always renders the checklist rather than racing the first step write;
 *   - a refusal is known synchronously and can still be reported to the user,
 *     rather than disappearing into a background log the way it briefly did.
 */
export async function generateDraft(
  contentPieceId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;

  // Deliberately BEFORE `after()`: this is the write that makes the server
  // state true the moment this action returns. A piece that is not this
  // tenant's, not at "brief", or hand-edited matches nothing and is never
  // marked — so no ineligible piece is left displaying a step, and there is
  // nothing to schedule either.
  const queued = await queueGeneration(contentPieceId, tenantId);
  if (!queued) {
    return { ok: false, error: "This piece is not awaiting generation." };
  }

  // Same shape as acceptBrief's: revalidate again from inside the callback,
  // because the pages the user is sitting on were rendered before generation
  // even started and nothing else tells them the run landed.
  after(async () => {
    const result = await generateDraftForPiece(contentPieceId, tenantId);
    if (!result.ok) {
      console.error(`[briefs] generateDraft failed for piece ${contentPieceId}: ${result.error}`);
    }
    revalidatePath("/drafts");
    revalidatePath(`/drafts/${contentPieceId}`);
  });

  return { ok: true };
}
