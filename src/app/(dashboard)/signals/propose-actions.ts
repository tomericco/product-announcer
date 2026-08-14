"use server";

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { tenants, companyProfiles, type Signal } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { listSignals } from "@/lib/signals/query";
import { proposeBriefFromSignals, MAX_PROPOSAL_SIGNALS, type ProposalInput, type ProposeDeps } from "@/lib/briefs/propose";
import type { RelevanceProfile } from "@/lib/signals/relevance";
import { createManualBrief, type CreateManualBriefResult } from "@/app/(dashboard)/briefs/new/actions";

/**
 * Same shape as `loadProfile` in `src/lib/briefs/run.ts` and `NewBriefPage`
 * (`src/app/(dashboard)/briefs/new/page.tsx`) — duplicated a third time
 * rather than reached across a module boundary that has no other reason to
 * be public. `name` comes from the tenant row, not `companyProfiles` — see
 * `RelevanceProfile`'s own doc comment.
 */
async function loadProfile(tenantId: string): Promise<RelevanceProfile> {
  const [tenant] = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
  const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenantId));
  return {
    name: tenant?.name ?? "",
    oneLiner: profile?.oneLiner ?? null,
    positioning: profile?.positioning ?? null,
    topics: profile?.topics ?? [],
  };
}

/**
 * Proposes a brief from signals a human selected on `/signals`, and creates
 * it — the one action the creation modal drives (spec B,
 * `docs/superpowers/specs/2026-08-14-brief-creation-modal-design.md`).
 *
 * `signalIds` arrives from client state seeded by a URL and is entirely
 * user-supplied, so it is never trusted directly. `listSignals` is what
 * makes "resolved tenant-scoped" true here, exactly as it does for
 * `NewBriefPage`: it filters on `eq(signals.tenantId, tenantId)` (plus the
 * 60-day window and non-stale rows) before this function ever sees a row, so
 * an id belonging to another tenant simply never appears in `resolved` and
 * silently drops out — nothing of another tenant's signal (its title,
 * above all) ever reaches the model prompt or the saved brief.
 *
 * Persistence goes through `createManualBrief`, which re-applies its own
 * tenant-ownership check on the ids it is handed and is the only writer of
 * `briefs.body` this module calls — seeing a fourth writer of that column
 * here would repeat a bug this branch already fixed twice. `createManualBrief`
 * re-reading the ids is not redundant with the resolution below: the two
 * checks close different gaps (this one decides which signals reach the
 * model at all; that one decides what is actually allowed to save), and the
 * design doc is explicit that this action must reuse that guard rather than
 * add a second one of its own.
 *
 * `deps` is `proposeBriefFromSignals`'s own `ProposeDeps` seam, threaded
 * through unchanged so tests can inject a fake `generate` and never reach
 * the real model. Real callers (the modal) never pass a second argument, so
 * no function value ever needs to cross the client/server boundary.
 */
export async function proposeAndCreateBrief(
  signalIds: string[],
  deps: ProposeDeps = {}
): Promise<CreateManualBriefResult> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;

  const requestedIds = [...new Set(signalIds)];
  const allSignals = requestedIds.length > 0 ? await listSignals(tenantId, {}) : [];
  const byId = new Map(allSignals.map((s) => [s.id, s]));
  const resolved: Signal[] = requestedIds.map((id) => byId.get(id)).filter((s): s is Signal => s !== undefined);

  // `/signals` caps selection client-side, but client state can still hand
  // this action more than `MAX_PROPOSAL_SIGNALS` ids — capped here so the
  // signals that reach the model and the signals attached as evidence always
  // agree, the same reasoning `NewBriefPage` documents for `chosen`.
  const chosen = resolved.slice(0, MAX_PROPOSAL_SIGNALS);

  const proposal = await proposeBriefFromSignals(
    {
      signals: chosen.map(
        (s): ProposalInput => ({
          id: s.id,
          kind: s.kind,
          title: s.title,
          excerpt: s.excerpt,
          occurredAt: s.occurredAt,
        })
      ),
      profile: await loadProfile(tenantId),
      tenantId,
    },
    deps
  );

  if (!proposal.ok) {
    return { ok: false, error: proposal.error };
  }

  return createManualBrief({
    contentType: proposal.brief.contentType,
    title: proposal.brief.title,
    angle: proposal.brief.angle,
    whyNow: proposal.brief.whyNow,
    keyPoints: proposal.brief.keyPoints,
    suggestedChannel: proposal.brief.suggestedChannel,
    targetLength: proposal.brief.targetLength,
    audience: proposal.brief.audience,
    score: proposal.brief.score,
    scoreRationale: proposal.brief.scoreRationale,
    signalIds: chosen.map((s) => s.id),
  });
}
