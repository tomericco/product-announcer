"use server";

import { requireSession } from "@/lib/workspace/session";
import { proposeBriefForSelection } from "@/lib/briefs/propose-selection";
import { briefExpiryFrom } from "@/lib/briefs/run";
import { createManualBrief } from "@/app/(dashboard)/briefs/new/actions";

/**
 * What the creation modal needs back.
 *
 * Not `CreateManualBriefResult`: the modal reports what the brief was actually
 * built from, and only this layer knows both numbers. `listSignals` silently
 * drops stale signals and anything past its 60-day window
 * (`proposeBriefForSelection`), and the selection is capped at
 * `MAX_PROPOSAL_SIGNALS` on top of that, so a five-signal selection can become
 * a three-signal brief with nothing anywhere saying so.
 */
export type ProposeAndCreateBriefResult =
  | { ok: true; briefId: string; usedSignalCount: number; droppedSignalCount: number }
  | { ok: false; error: string };

/**
 * Proposes a brief from signals a human selected on `/signals`, and creates
 * it — the one action the creation modal drives (spec B,
 * `docs/superpowers/specs/2026-08-14-brief-creation-modal-design.md`).
 *
 * Deliberately thin: `proposeBriefForSelection`
 * (`src/lib/briefs/propose-selection.ts`) does the tenant-scoped resolution
 * and the model call, and `createManualBrief`
 * (`src/app/(dashboard)/briefs/new/actions.ts`) does the write — the only
 * writer of `briefs.body`. This wrapper's entire job is resolving
 * `tenantId` from the session, gluing those two together, and deciding the
 * one thing neither of them can: how long the result lives. It takes no
 * `deps` and no function value ever needs to cross the client/server
 * boundary: unlike a plain `src/lib` function, a `"use server"` export is a
 * reachable POST endpoint, and every other dashboard server action follows
 * the same rule (see `src/lib/briefs/draft.ts`'s `generateDraftForPiece` for
 * where the deps seam actually belongs instead).
 *
 * ### Why this brief expires and a hand-written one does not
 *
 * `createManualBrief` defaults to `expiresAt: null` because a brief someone
 * typed is a decision, and `expireStaleBriefs` must never delete a decision
 * out from under them. Nothing here was typed. The row is inserted before the
 * modal has rendered a single word of it, so it is a candidate awaiting a
 * human — the same thing `runIdeation` writes, and it ages out on the same
 * clock via `briefExpiryFrom`. Without this, clicking Create brief three times
 * while exploring would leave three permanent rows pinned to the top of the
 * inbox.
 */
export async function proposeAndCreateBrief(signalIds: string[]): Promise<ProposeAndCreateBriefResult> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;

  // Deduped here as well as inside `proposeBriefForSelection`, so the
  // "requested" count this compares against is the same set that function
  // resolved — otherwise a duplicated id would report itself as dropped.
  const requestedCount = new Set(signalIds).size;

  const proposal = await proposeBriefForSelection(tenantId, signalIds);
  if (!proposal.ok) {
    return { ok: false, error: proposal.error };
  }

  const created = await createManualBrief({
    ...proposal.input,
    expiresAt: briefExpiryFrom(new Date()),
  });
  if (!created.ok) {
    return { ok: false, error: created.error };
  }

  const usedSignalCount = proposal.input.signalIds.length;
  return {
    ok: true,
    briefId: created.briefId,
    usedSignalCount,
    droppedSignalCount: Math.max(0, requestedCount - usedSignalCount),
  };
}
