"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/workspace/session";
import { createManualSignal } from "@/lib/signals/manual";
import type { ManualSignalInput, ManualSignalResult } from "@/lib/signals/manual";

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
