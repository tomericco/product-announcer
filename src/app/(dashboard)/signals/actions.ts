"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/workspace/session";
import { createManualSignal } from "@/lib/signals/manual";
import type { ManualSignalInput, ManualSignalResult } from "@/lib/signals/manual";
import { deleteSignals as deleteSignalRows } from "@/lib/signals/delete";
import type { DeleteSignalsResult } from "@/lib/signals/delete";

/**
 * The add-signal form's server action: records a signal a human found —
 * something the agents missed — under the caller's own tenant.
 *
 * All validation, deduping (the `url`-based unique constraint), and error
 * shaping live in `createManualSignal`; this wrapper only supplies the
 * session's tenantId and revalidates `/signals` so the new row shows up
 * without a manual refresh. This file carries `"use server"`, which permits
 * only async function exports — a single one, `addSignal`, is exported here.
 */
export async function addSignal(input: ManualSignalInput): Promise<ManualSignalResult> {
  const session = await requireSession();
  const result = await createManualSignal(session.user.tenantId, input);
  if (result.ok) revalidatePath("/signals");
  return result;
}

/**
 * The signals browser's bulk-delete action, backing the floating selection
 * bar's "Delete selected" button. `ids` arrives from the browser (the
 * client's `selected` Set), so `deleteSignalRows` re-scopes to the session's
 * tenant itself rather than trusting the caller.
 */
export async function deleteSignals(ids: string[]): Promise<DeleteSignalsResult> {
  const session = await requireSession();
  const result = await deleteSignalRows(session.user.tenantId, ids);
  if (result.ok) revalidatePath("/signals");
  return result;
}
