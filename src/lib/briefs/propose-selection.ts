import { eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { tenants, companyProfiles, type Signal, type Brief } from "@/db/schema";
import { listSignals } from "@/lib/signals/query";
import type { RelevanceProfile } from "@/lib/signals/relevance";
import { proposeBriefFromSignals, MAX_PROPOSAL_SIGNALS, type ProposalInput, type ProposeDeps } from "./propose";

/**
 * The shape a resolved proposal hands to `createManualBrief`
 * (`src/app/(dashboard)/briefs/new/actions.ts`).
 *
 * Deliberately NOT imported from that module — this file lives in `src/lib`
 * and must not import from `src/app`, so the fields are declared here,
 * structurally identical to `ManualBriefInput`. `src/app` is the layer that
 * depends on `src/lib`, never the reverse; a `src/lib` module reaching back
 * into `src/app` would make that boundary meaningless. TypeScript's
 * structural typing accepts this value directly where `ManualBriefInput` is
 * expected, with no cast and no re-export needed.
 */
export type ProposedManualBriefInput = {
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

export type ProposeBriefForSelectionResult =
  | { ok: true; input: ProposedManualBriefInput }
  | { ok: false; error: string };

/**
 * Same shape as `loadProfile` in `src/lib/briefs/run.ts` and `NewBriefPage`
 * (`src/app/(dashboard)/briefs/new/page.tsx`) — duplicated rather than
 * reached across a module boundary that has no other reason to be public.
 * `name` comes from the tenant row, not `companyProfiles` — see
 * `RelevanceProfile`'s own doc comment.
 */
async function loadProfile(tenantId: string): Promise<RelevanceProfile> {
  const [tenant] = await defaultDb.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
  const [profile] = await defaultDb.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenantId));
  return {
    name: tenant?.name ?? "",
    oneLiner: profile?.oneLiner ?? null,
    positioning: profile?.positioning ?? null,
    topics: profile?.topics ?? [],
  };
}

/**
 * Resolves signals a human selected on `/signals`, tenant-scoped, and
 * proposes one brief from them. Does NOT persist — this is the "resolve +
 * ask the model" half of the brief-creation-modal pipeline (spec B,
 * `docs/superpowers/specs/2026-08-14-brief-creation-modal-design.md`);
 * writing the row is the caller's job, through `createManualBrief`, which is
 * the only writer of `briefs.body`.
 *
 * `signalIds` is entirely user-supplied — client state seeded by a URL — so
 * it is never trusted directly. `listSignals` is what makes "resolved
 * tenant-scoped" true here, exactly as it does for `NewBriefPage` and
 * `runIdeation`: it filters on `eq(signals.tenantId, tenantId)` (plus the
 * 60-day window and non-stale rows) before this function ever sees a row, so
 * an id belonging to another tenant simply never appears in `resolved` and
 * silently drops out. Nothing of another tenant's signal — its title, above
 * all — ever reaches the model prompt this function builds.
 *
 * `deps` is `proposeBriefFromSignals`'s own `ProposeDeps` seam, threaded
 * through unchanged so tests can inject a fake `generate` and never reach
 * the real model.
 */
export async function proposeBriefForSelection(
  tenantId: string,
  signalIds: string[],
  deps: ProposeDeps = {}
): Promise<ProposeBriefForSelectionResult> {
  const requestedIds = [...new Set(signalIds)];
  const allSignals = requestedIds.length > 0 ? await listSignals(tenantId, {}) : [];
  const byId = new Map(allSignals.map((s) => [s.id, s]));
  const resolved: Signal[] = requestedIds.map((id) => byId.get(id)).filter((s): s is Signal => s !== undefined);

  // `/signals` caps selection client-side, but client state can still hand
  // this function more than `MAX_PROPOSAL_SIGNALS` ids — capped here so the
  // signals that reach the model and the signals the caller attaches as
  // evidence always agree, the same reasoning `NewBriefPage` documents for
  // `chosen`.
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

  return {
    ok: true,
    input: {
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
    },
  };
}
