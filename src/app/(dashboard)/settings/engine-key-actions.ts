"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/workspace/session";
import { requireRole } from "@/lib/workspace/active-tenant";
import {
  listEngineKeys,
  loadEngineKeySecret,
  removeEngineKey,
  setEngineKeyEnabled,
  setEngineKeyStatus,
  storeEngineKey,
  type EngineKeyStatus,
  type EngineKeyView,
} from "@/lib/ai-visibility/engine-keys";
import { verifyEngineKey } from "@/lib/ai-visibility/engines/verify";
import { scrubError } from "@/lib/ai-visibility/scrub";
import { ENGINE_IDS, type EngineId } from "@/lib/ai-visibility/types";
import { engineKeyMessage } from "./engine-key-copy";

/**
 * The four writes the AI-engines card makes: save, re-check, switch, remove.
 *
 * ### Two rules this file exists to hold
 *
 * **Verify before store.** Nothing here writes a key that has not just
 * answered a real grounded call on the tenant's own account. There is no
 * "save anyway", no force flag, and no path that stores first and checks
 * later — a key that was never exercised is a key that fails at 09:00 UTC on a
 * Monday with nobody watching.
 *
 * **No read-back.** Every function here returns a status or an
 * `EngineKeyView`, and `EngineKeyView` has no field that can hold a key. The
 * one function in the codebase that decrypts, `loadEngineKeySecret`, is called
 * exactly once below — by Re-check, which hands the string to the provider and
 * keeps nothing.
 *
 * ### Shape
 *
 * Discriminated unions, never throws, matching `/ai-visibility/actions.ts`. A
 * thrown Server Action error has its message stripped in production builds,
 * which would silence precisely the four sentences a tenant needs in order to
 * fix their key.
 *
 * Owner-only for every WRITE (Decision 8: admin-only, workspace-scoped; masked
 * state visible to all members). `requireRole` throws, which is right here —
 * a member reaching these actions is a forged request or a stale tab after a
 * role change, not a state to render copy for.
 */

export type EngineKeyResult =
  | { ok: true; keys: EngineKeyView[] }
  | { ok: false; error: string; status?: EngineKeyStatus };

function isEngineId(value: unknown): value is EngineId {
  return typeof value === "string" && (ENGINE_IDS as readonly string[]).includes(value);
}

/**
 * Client-side paste guards, restated server-side.
 *
 * The card runs the same three checks before it submits, with no API call, so a
 * misdirected paste is caught instantly and for free. This copy exists because
 * a stale tab is a client that can still post the wrong thing — and because the
 * alternative to catching it here is spending the tenant's money proving that
 * an Anthropic key is not an OpenAI key.
 */
function wrongProviderHint(engine: EngineId, key: string): string | null {
  if (engine !== "anthropic" && key.startsWith("sk-ant-")) {
    return "That looks like an Anthropic key. Paste it in the Claude row instead.";
  }
  if (engine !== "gemini" && key.startsWith("AIza")) {
    return "That looks like a Google AI key. Paste it in the Gemini row instead.";
  }
  if (engine === "gemini" && key.startsWith("sk-")) {
    return "That looks like an OpenAI or Anthropic key. Gemini keys start `AIza`.";
  }
  if (key.startsWith("org-") || key.startsWith("proj_")) {
    return "That's an organization or project ID, not a secret key. The secret is the one shown once, when you create it.";
  }
  return null;
}

/**
 * Save — which is also Verify. There is no other way in.
 *
 * The free probe runs first and the paid grounded call second, so a typo costs
 * nothing to discover and the great majority of bad pastes are typos. Only a
 * key that passed BOTH is ever written; a failure returns its status and the
 * row is untouched, so a working key is never replaced by a broken one.
 */
export async function saveEngineKeyAction(formData: FormData): Promise<EngineKeyResult> {
  const session = await requireSession();
  requireRole(session, "owner");
  const tenantId = session.user.tenantId;

  const engine = formData.get("engine");
  if (!isEngineId(engine)) return { ok: false, error: "Unknown engine." };

  // Trimmed, because people paste with a trailing newline and a provider will
  // reject the key over it with a message that blames the key.
  const raw = formData.get("key");
  const key = typeof raw === "string" ? raw.trim() : "";
  if (key.length === 0) return { ok: false, error: "Paste the key first." };

  const misdirected = wrongProviderHint(engine, key);
  if (misdirected) return { ok: false, error: misdirected };

  let verified: Awaited<ReturnType<typeof verifyEngineKey>>;
  try {
    verified = await verifyEngineKey(engine, key);
  } catch (error) {
    // `verifyEngineKey` is not supposed to throw — every client promises not to
    // — so this is our bug rather than the tenant's. It must still not write:
    // "we could not confirm it" is the only honest outcome, and storing on a
    // crash would be storing without verifying.
    // Scrubbed, and as a string: `verifyEngineKey` is not supposed to throw at
    // all, so whatever reaches here is unplanned — most likely a `fetch`
    // rejection carrying the request that failed, and that request has the
    // tenant's key in a header.
    console.error(`[ai-visibility] ${engine} key verification threw: ${scrubError(error)}`);
    return {
      ok: false,
      error: engineKeyMessage(engine, "provider_unavailable"),
      status: "provider_unavailable",
    };
  }

  if (!verified.ok) {
    return { ok: false, error: engineKeyMessage(engine, verified.status), status: verified.status };
  }

  await storeEngineKey({ tenantId, engine, key, actorUserId: session.user.id });
  await revalidateEngineSurfaces();
  return { ok: true, keys: await listEngineKeys(tenantId) };
}

/**
 * Re-check — the ONLY re-verification there is.
 *
 * Never on a timer. A recurring paid call the tenant did not ask for is exactly
 * what BYOK exists to stop, so re-verification is either this button or a run.
 *
 * The one place outside `runSlice` that decrypts a stored key. It is not a
 * read-back path: the plaintext is handed to the provider it belongs to and
 * nothing is returned but a status.
 *
 * Deliberately does not require the key to be usable — re-checking a rejected
 * or out-of-credit key after fixing the account is the entire point of the
 * button, and demanding `verified` first would make it useless exactly when it
 * is needed.
 */
export async function recheckEngineKeyAction(engineInput: unknown): Promise<EngineKeyResult> {
  const session = await requireSession();
  requireRole(session, "owner");
  const tenantId = session.user.tenantId;

  if (!isEngineId(engineInput)) return { ok: false, error: "Unknown engine." };
  const engine = engineInput;

  const loaded = await loadEngineKeySecret(tenantId, engine);
  if (!loaded.ok) {
    if (loaded.reason === "unreadable") {
      // Recorded as the fifth state, so the row says "we couldn't read it"
      // rather than "your key is invalid". Nobody should be sent to a provider
      // console over a fault in our own key material.
      await setEngineKeyStatus(
        { tenantId, engine, status: "unreadable", actorUserId: session.user.id },
        new Date()
      );
      await revalidateEngineSurfaces();
      return {
        ok: false,
        error: engineKeyMessage(engine, "unreadable"),
        status: "unreadable",
      };
    }
    return { ok: false, error: "No key is saved for this engine." };
  }

  let verified: Awaited<ReturnType<typeof verifyEngineKey>>;
  try {
    verified = await verifyEngineKey(engine, loaded.key);
  } catch (error) {
    console.error(`[ai-visibility] ${engine} key re-check threw: ${scrubError(error)}`);
    return {
      ok: false,
      error: engineKeyMessage(engine, "provider_unavailable"),
      status: "provider_unavailable",
    };
  }

  const status: EngineKeyStatus = verified.ok ? "verified" : verified.status;
  await setEngineKeyStatus({ tenantId, engine, status, actorUserId: session.user.id }, new Date());
  await revalidateEngineSurfaces();

  if (!verified.ok) return { ok: false, error: engineKeyMessage(engine, status), status };
  return { ok: true, keys: await listEngineKeys(tenantId) };
}

/**
 * The row's switch — "Saved, not in use" versus in use.
 *
 * Turning ON is refused unless the key is `verified`, server-side. The card
 * renders no switch at all on a keyless row, which makes the contradictory
 * state unreachable rather than merely discouraged; this is that same rule
 * where a stale tab cannot get past it.
 */
export async function toggleEngineKeyAction(
  engineInput: unknown,
  enabled: unknown
): Promise<EngineKeyResult> {
  const session = await requireSession();
  requireRole(session, "owner");
  const tenantId = session.user.tenantId;

  if (!isEngineId(engineInput)) return { ok: false, error: "Unknown engine." };
  if (typeof enabled !== "boolean") return { ok: false, error: "Unknown state." };

  const result = await setEngineKeyEnabled({
    tenantId,
    engine: engineInput,
    enabled,
    actorUserId: session.user.id,
  });
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.reason === "missing"
          ? "No key is saved for this engine."
          : "This key needs to pass a check before it can be switched on — try Re-check.",
    };
  }

  await revalidateEngineSurfaces();
  return { ok: true, keys: await listEngineKeys(tenantId) };
}

/**
 * Remove — the irreversible one, and the whole reason the switch exists beside
 * it.
 *
 * OpenAI, Google and Anthropic each show a secret exactly once, so nobody
 * (including us) can put this back. The dialog says so in those words. Turning
 * the engine off in the same transaction is not a courtesy: a removed key
 * beside a settings row still naming that engine is a workspace whose card
 * claims to be measuring something it cannot measure.
 */
export async function removeEngineKeyAction(engineInput: unknown): Promise<EngineKeyResult> {
  const session = await requireSession();
  requireRole(session, "owner");
  const tenantId = session.user.tenantId;

  if (!isEngineId(engineInput)) return { ok: false, error: "Unknown engine." };

  const removed = await removeEngineKey({
    tenantId,
    engine: engineInput,
    actorUserId: session.user.id,
  });
  if (!removed.ok) return { ok: false, error: "No key is saved for this engine." };

  await revalidateEngineSurfaces();
  return { ok: true, keys: await listEngineKeys(tenantId) };
}

/**
 * The three surfaces a key change is visible on.
 *
 * `/ai-visibility` is not optional: `effectiveEngines` decides its tiles, its
 * trend series, its run estimate and whether Run now is offered at all, so a
 * key saved on /settings changes that page's whole shape. `/company` carries
 * the feature's health badge.
 */
async function revalidateEngineSurfaces(): Promise<void> {
  revalidatePath("/settings");
  revalidatePath("/ai-visibility");
  revalidatePath("/company");
}
