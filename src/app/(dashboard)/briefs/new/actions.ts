"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { briefs, briefSignals, signals, type Brief } from "@/db/schema";
import { EMPTY_BRIEF_BODY_ERROR, isBlankBriefBody, renderBriefBody } from "@/lib/briefs/body";
import { requireSession } from "@/lib/workspace/session";

/**
 * The manual brief form's shape. Mirrors `ProposedBrief` (minus
 * `evidenceSignalIds`, which is the separate `signalIds` field here) so a
 * proposal can pre-fill this form's state without any translation layer, but
 * every field is filled in by a human either way — including on the
 * degradation path, where the proposal failed and the form starts empty.
 */
export type ManualBriefInput = {
  contentType: Brief["contentType"];
  title: string;
  angle: string;
  whyNow: string;
  keyPoints: string[];
  suggestedChannel: string;
  targetLength: number | null;
  audience: string | null;
  score: number;
  scoreRationale: string | null;
  signalIds: string[];
  /**
   * When the sweep may expire this brief, or `null` for never.
   *
   * Optional, and omitted by every hand-written caller — `BriefForm` builds a
   * `ManualBriefInput` and never sets this — so the "a human wrote it, it
   * never expires" rule holds by construction rather than by remembering to
   * pass `null`. Only `proposeAndCreateBrief` sets it, because what it saves
   * is a model's proposal nobody has read yet. See the doc comment below.
   */
  expiresAt?: Date | null;
};

export type CreateManualBriefResult = { ok: true; briefId: string } | { ok: false; error: string };

/**
 * Saves a brief a human wrote (or edited from a proposal) directly, with no
 * model call of its own.
 *
 * The signal ids arrive from client state seeded by a URL and are
 * user-supplied, so they are re-read scoped to the caller's own tenant rather
 * than trusted: attaching another tenant's signal would leak its title into
 * this tenant's brief and into every draft later generated from it. Any id
 * that does not resolve under this tenant fails the whole save — nothing is
 * written on that path, per `loadOwnBrief`'s membership-check convention in
 * `src/app/(dashboard)/briefs/actions.ts`.
 *
 * Expiry is the caller's call, and the default is "never". A brief written by
 * hand is a decision the sweep must not expire out from under a human, so
 * `BriefForm` omits `expiresAt` and gets `null` — the same invariant this
 * comment has always stated, now stated for the hand-written path only.
 *
 * It is NOT true of every caller anymore. `proposeAndCreateBrief`
 * (`src/app/(dashboard)/signals/propose-actions.ts`) also lands here, and what
 * it saves is a model's proposal that no human has seen yet — the brief exists
 * before the modal has even offered Close. Left never-expiring, three
 * exploratory clicks would leave three permanent `status = "new"` rows at the
 * top of an inbox forever, which is precisely the debt `expireStaleBriefs`
 * exists to prevent. So it passes the agent TTL and its briefs age out like
 * agent-proposed ones. `status: "new"` is unconditional either way.
 *
 * An empty `signalIds` is valid — this is the degradation path for when the
 * proposal agent refused to run at all, and the human may not have selected
 * anything to begin with.
 */
export async function createManualBrief(input: ManualBriefInput): Promise<CreateManualBriefResult> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;

  const title = input.title.trim();
  if (!title) {
    return { ok: false, error: "Title is required." };
  }

  // Deduped before the ownership check below: a duplicate id in the input
  // would otherwise make `owned.length` fall short of `signalIds.length` for
  // an id that is, in fact, entirely valid.
  const signalIds = [...new Set(input.signalIds)];

  if (signalIds.length > 0) {
    const owned = await db
      .select({ id: signals.id })
      .from(signals)
      .where(and(inArray(signals.id, signalIds), eq(signals.tenantId, tenantId)));
    if (owned.length !== signalIds.length) {
      return { ok: false, error: "One or more selected signals could not be found." };
    }
  }

  const angle = input.angle.trim();
  const whyNow = input.whyNow.trim();
  const audience = input.audience?.trim() || null;
  const keyPoints = input.keyPoints;
  const body = renderBriefBody({ angle, whyNow, keyPoints, audience });

  // The same guard `saveBriefBody` applies, from the same module — this action
  // is the OTHER writer of `briefs.body` and was unguarded. Only `title` is
  // validated above, and the form gates its submit button on the title alone,
  // so angle/why-now/key-points/audience can all arrive blank; `renderBriefBody`
  // then returns "" and stored "" — not null — which is the one value
  // `briefBody`'s fallback cannot rescue (see the module).
  //
  // Refused rather than stored as null. Null would only re-run the very
  // renderer that just produced "" from these same fields, so the fallback
  // renders "" too — the brief would still reach the model as no prose at all,
  // just one indirection later. There is no value to store that makes a brief
  // with nothing in it into a usable commission, so the human is told now,
  // while they are still looking at the form.
  if (isBlankBriefBody(body)) {
    return { ok: false, error: EMPTY_BRIEF_BODY_ERROR };
  }

  const [brief] = await db
    .insert(briefs)
    .values({
      tenantId,
      origin: "manual",
      createdBy: session.user.id ?? null,
      contentType: input.contentType,
      title,
      angle,
      whyNow,
      suggestedChannel: input.suggestedChannel.trim(),
      audience,
      keyPoints,
      body,
      targetLength: input.targetLength ?? null,
      score: input.score,
      scoreRationale: input.scoreRationale?.trim() || null,
      status: "new",
      // `?? null` rather than a default parameter: an omitted field and an
      // explicit `null` must mean the same thing, since the field crosses a
      // Server Action boundary where `undefined` is not reliably preserved.
      expiresAt: input.expiresAt ?? null,
      lastEvidenceAt: new Date(),
    })
    .returning({ id: briefs.id });

  if (signalIds.length > 0) {
    await db.insert(briefSignals).values(
      signalIds.map((signalId) => ({
        briefId: brief.id,
        signalId,
        addedBy: session.user.id ?? null,
      }))
    );
  }

  revalidatePath("/briefs");
  return { ok: true, briefId: brief.id };
}
