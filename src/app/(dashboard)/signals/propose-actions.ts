"use server";

import { requireSession } from "@/lib/workspace/session";
import { proposeBriefForSelection } from "@/lib/briefs/propose-selection";
import { createManualBrief, type CreateManualBriefResult } from "@/app/(dashboard)/briefs/new/actions";

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
 * `tenantId` from the session and gluing those two together, so it takes no
 * `deps` and no function value ever needs to cross the client/server
 * boundary: unlike a plain `src/lib` function, a `"use server"` export is a
 * reachable POST endpoint, and every other dashboard server action follows
 * the same rule (see `src/lib/briefs/draft.ts`'s `generateDraftForPiece` for
 * where the deps seam actually belongs instead).
 */
export async function proposeAndCreateBrief(signalIds: string[]): Promise<CreateManualBriefResult> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;

  const proposal = await proposeBriefForSelection(tenantId, signalIds);
  if (!proposal.ok) {
    return { ok: false, error: proposal.error };
  }

  return createManualBrief(proposal.input);
}
