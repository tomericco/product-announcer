"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { briefs, briefSignals, signals, type Brief } from "@/db/schema";
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
 * `expiresAt: null` and `status: "new"` are the difference from an
 * agent-proposed brief: a hand-written brief is a decision the sweep must
 * never expire out from under a human, not a candidate awaiting one. An empty
 * `signalIds` is valid — this is the degradation path for when the proposal
 * agent refused to run at all, and the human may not have selected anything
 * to begin with.
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

  const [brief] = await db
    .insert(briefs)
    .values({
      tenantId,
      origin: "manual",
      createdBy: session.user.id ?? null,
      contentType: input.contentType,
      title,
      angle: input.angle.trim(),
      whyNow: input.whyNow.trim(),
      suggestedChannel: input.suggestedChannel.trim(),
      audience: input.audience?.trim() || null,
      keyPoints: input.keyPoints,
      targetLength: input.targetLength ?? null,
      score: input.score,
      scoreRationale: input.scoreRationale?.trim() || null,
      status: "new",
      // Never expires — see the doc comment above.
      expiresAt: null,
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
