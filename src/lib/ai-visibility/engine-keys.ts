import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import {
  aiVisibilityEngineKeyEvents,
  aiVisibilityEngineKeys,
  aiVisibilitySettings,
  users,
} from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/credentials/encryption";
import { ENGINE_IDS, type EngineId } from "@/lib/ai-visibility/types";

/**
 * Tenant-supplied provider keys — the storage half of BYOK.
 *
 * ### The one rule this module exists to enforce
 *
 * **There is no read-back path.** Exactly one function returns a plaintext key
 * — `loadEngineKeySecret` — and it is for the RUN and the RE-CHECK, both of
 * which hand the string straight to the provider it belongs to and keep no
 * copy. Nothing else in the codebase may call it, nothing returns it to a
 * client, and `EngineKeyView` — the shape every UI, action and page reads —
 * has no field that could carry one. `last4` is the only fragment that ever
 * leaves the server.
 *
 * That is Cloudflare Secrets Store's bar ("can no longer be decrypted or
 * accessed via API or on the dashboard") rather than Helicone's, which ships
 * an eye-toggle that decrypts a stored key into the browser.
 *
 * ### Statuses, and why there are six
 *
 * Four failure states are the design's minimum (LibreChat ships four
 * distinctly; Dify conflates two and tells a marketer to check two things and
 * fix neither). The fifth is `unreadable`: we hold a key and could not DECRYPT
 * it. Zed shipped that as "invalid or has expired" and sent users to replace
 * perfectly good keys. It is a fault in OUR key material, not in theirs, and
 * the copy has to say so.
 */

export const ENGINE_KEY_STATUSES = [
  "verified",
  "invalid_key",
  "quota_exceeded",
  "rate_limited",
  "provider_unavailable",
  "unreadable",
] as const;

export type EngineKeyStatus = (typeof ENGINE_KEY_STATUSES)[number];

export const ENGINE_KEY_ACTIONS = [
  "added",
  "replaced",
  "removed",
  "enabled",
  "disabled",
  "rechecked",
  "auto_failed",
] as const;

export type EngineKeyAction = (typeof ENGINE_KEY_ACTIONS)[number];

/**
 * Everything a surface may know about a stored key.
 *
 * Deliberately has no ciphertext, no IV, no auth tag and no plaintext field.
 * The type IS the guarantee: a component that wanted to render a key could not
 * find one to render, and a future action that tried to return one would have
 * to invent a new type to do it — which is a reviewable diff rather than a
 * one-word slip.
 */
export type EngineKeyView = {
  engine: EngineId;
  last4: string;
  status: EngineKeyStatus;
  enabled: boolean;
  verifiedAt: Date | null;
  lastUsedAt: Date | null;
  lastFailureCode: string | null;
  lastFailureAt: Date | null;
  createdAt: Date;
  /** Who pasted it. Null when that user has since left the workspace. */
  createdByName: string | null;
};

function isEngineId(value: string): value is EngineId {
  return (ENGINE_IDS as readonly string[]).includes(value);
}

function toStatus(value: string): EngineKeyStatus {
  // A status the column holds but this code no longer recognises reads as
  // `unreadable` rather than as `verified`: the failure direction that stops a
  // run is recoverable, and the one that spends a customer's money on a
  // credential we cannot vouch for is not.
  return (ENGINE_KEY_STATUSES as readonly string[]).includes(value)
    ? (value as EngineKeyStatus)
    : "unreadable";
}

/**
 * The last four characters of a key, for display.
 *
 * Four, not more: enough for the person who pasted it to recognise their own
 * key, not enough to confirm a stolen one. Short keys (which never verify
 * anyway) fall back to whatever they have rather than throwing.
 */
export function last4Of(key: string): string {
  return key.slice(-4);
}

/**
 * Every key row this tenant has, in `ENGINE_IDS` order.
 *
 * Joined to `users` for provenance, which no surveyed product shows. Rows for
 * engines this build no longer knows about are dropped rather than surfaced —
 * there is no card to render them in.
 */
export async function listEngineKeys(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<EngineKeyView[]> {
  const rows = await database
    .select({
      engine: aiVisibilityEngineKeys.engine,
      last4: aiVisibilityEngineKeys.last4,
      status: aiVisibilityEngineKeys.status,
      enabled: aiVisibilityEngineKeys.enabled,
      verifiedAt: aiVisibilityEngineKeys.verifiedAt,
      lastUsedAt: aiVisibilityEngineKeys.lastUsedAt,
      lastFailureCode: aiVisibilityEngineKeys.lastFailureCode,
      lastFailureAt: aiVisibilityEngineKeys.lastFailureAt,
      createdAt: aiVisibilityEngineKeys.createdAt,
      createdByName: users.name,
      createdByEmail: users.email,
    })
    .from(aiVisibilityEngineKeys)
    // LEFT, not inner: `createdByUserId` is nullable and SET NULL on member
    // removal, and a key whose adder has left is still a key that runs.
    .leftJoin(users, eq(users.id, aiVisibilityEngineKeys.createdByUserId))
    .where(eq(aiVisibilityEngineKeys.tenantId, tenantId));

  const order = new Map(ENGINE_IDS.map((engine, index) => [engine as string, index]));
  return rows
    .filter((row) => isEngineId(row.engine))
    .sort((a, b) => (order.get(a.engine) ?? 0) - (order.get(b.engine) ?? 0))
    .map((row) => ({
      engine: row.engine as EngineId,
      last4: row.last4,
      status: toStatus(row.status),
      enabled: row.enabled,
      verifiedAt: row.verifiedAt,
      lastUsedAt: row.lastUsedAt,
      lastFailureCode: row.lastFailureCode,
      lastFailureAt: row.lastFailureAt,
      createdAt: row.createdAt,
      // The email is the fallback identity, not a second field: a user row can
      // exist with a null name (an invite accepted before a profile was set).
      createdByName: row.createdByName ?? row.createdByEmail ?? null,
    }));
}

/**
 * The engines this tenant may actually be charged for right now.
 *
 * `settings.engines ∩ {engines with an enabled, verified key}` — design
 * Decision 7 — **with no fallback-to-all when empty**. That absence is the
 * whole point and it is deliberately unlike `normalizeSettingsRow`, which
 * substitutes all three engines for an empty list because an enabled feature
 * measuring nothing behind a green badge is worse than measuring everything.
 *
 * Under a hard gate the reasoning inverts: falling back would spend OUR money
 * on a tenant who has connected nothing, which is exactly what BYOK exists to
 * stop. **Empty means empty.** Every caller that plans, prices or renders a run
 * must read this rather than `settings.engines`.
 *
 * THE MIGRATION STATE IS EVERY EXISTING TENANT. `DEFAULT_AI_VISIBILITY_SETTINGS.engines`
 * is all three, so on ship day every tenant has three engines on and zero keys.
 * Nothing rewrites their rows; this function returns `[]` for them and the UI
 * says why.
 */
export async function effectiveEngines(
  tenantId: string,
  engines: readonly string[],
  database: typeof defaultDb = defaultDb
): Promise<EngineId[]> {
  const wanted = engines.filter(isEngineId);
  if (wanted.length === 0) return [];

  const rows = await database
    .select({ engine: aiVisibilityEngineKeys.engine })
    .from(aiVisibilityEngineKeys)
    .where(
      and(
        eq(aiVisibilityEngineKeys.tenantId, tenantId),
        eq(aiVisibilityEngineKeys.enabled, true),
        eq(aiVisibilityEngineKeys.status, "verified")
      )
    );

  const usable = new Set(rows.map((row) => row.engine));
  // Deduped: `settings.engines` is a text[] a hand-edited row can double up,
  // and a doubled engine would make `planRun` plan its calls twice.
  return [...new Set(wanted)].filter((engine) => usable.has(engine));
}

/**
 * There is deliberately NO batch `effectiveEnginesForTenants` beside this, and
 * the sweep is why.
 *
 * The obvious optimisation is to resolve every candidate tenant's engines in
 * one round trip and drop the keyless ones before dividing the tick's budget.
 * That would be wrong: a tenant filtered out there gets no refusal recorded on
 * its source row, so it sits green and silent — which, under a hard gate with
 * no vendor-key fallback, is indistinguishable from working. The sweep is
 * supposed to be the thing that catches a run that stopped producing data.
 *
 * So every candidate goes through `planRun`, refuses with `no_engines`, and the
 * sweep writes the sentence. One extra query per keyless tenant, on a path that
 * is already one query per tenant, in exchange for the failure being visible.
 */

export type LoadedEngineKey =
  | { ok: true; key: string }
  | { ok: false; reason: "missing" | "disabled" | "unusable" | "unreadable" };

/**
 * THE ONLY FUNCTION IN THIS CODEBASE THAT RETURNS A PLAINTEXT KEY.
 *
 * Two callers, both of which pass the string straight to the provider it
 * belongs to and keep no copy: `runSlice`, and the re-check action. Do not add
 * a third without deciding, in writing, that the caller is not a read-back path
 * in disguise — an "admin debug endpoint" is exactly the shape this rule
 * refuses.
 *
 * `unreadable` is a real, separate outcome, not an error to swallow: a
 * decryption failure means OUR key material is wrong (a rotated
 * `CREDENTIALS_ENCRYPTION_KEY`, a restored backup), and telling the tenant
 * their perfectly good key is invalid is the Zed bug this design names.
 * `decryptSecret` throws on a bad auth tag by design, so the catch is what
 * turns that into a status rather than a 500.
 */
export async function loadEngineKeySecret(
  tenantId: string,
  engine: EngineId,
  opts: { requireUsable?: boolean } = {},
  database: typeof defaultDb = defaultDb
): Promise<LoadedEngineKey> {
  const [row] = await database
    .select()
    .from(aiVisibilityEngineKeys)
    .where(
      and(eq(aiVisibilityEngineKeys.tenantId, tenantId), eq(aiVisibilityEngineKeys.engine, engine))
    )
    .limit(1);
  if (!row) return { ok: false, reason: "missing" };

  // The run demands a key that is both switched on and verified; a re-check
  // deliberately does not, because re-checking a rejected key is the whole
  // point of the button.
  if (opts.requireUsable) {
    if (!row.enabled) return { ok: false, reason: "disabled" };
    if (toStatus(row.status) !== "verified") return { ok: false, reason: "unusable" };
  }

  try {
    return {
      ok: true,
      key: decryptSecret({
        ciphertext: row.keyCiphertext,
        iv: row.keyIv,
        authTag: row.keyAuthTag,
      }),
    };
  } catch (error) {
    // The error itself, never the key. `decryptSecret`'s throw carries no
    // plaintext (GCM fails before producing any), but the caller's log is the
    // durable copy and this is the last place that is true.
    console.error(`[ai-visibility] could not decrypt ${engine} key for tenant ${tenantId}:`, error);
    return { ok: false, reason: "unreadable" };
  }
}

/**
 * Appends one line to the audit trail.
 *
 * Never throws into its caller: an audit write that fails must not undo a
 * successful key change, and a change that happened without a trail line is a
 * smaller problem than a change that was rolled back because the trail was
 * full. Logged loudly instead.
 */
export async function recordEngineKeyEvent(
  entry: {
    tenantId: string;
    engine: EngineId;
    action: EngineKeyAction;
    last4?: string | null;
    status?: EngineKeyStatus | null;
    actorUserId?: string | null;
  },
  database: typeof defaultDb = defaultDb
): Promise<void> {
  try {
    await database.insert(aiVisibilityEngineKeyEvents).values({
      tenantId: entry.tenantId,
      engine: entry.engine,
      action: entry.action,
      last4: entry.last4 ?? null,
      status: entry.status ?? null,
      actorUserId: entry.actorUserId ?? null,
    });
  } catch (error) {
    console.error("[ai-visibility] failed to record engine-key event:", error);
  }
}

/**
 * Stores a VERIFIED key, replacing whatever was there.
 *
 * Callers must have verified first — this function does not, and cannot: it
 * has no network seam and the verification costs real money on the tenant's
 * own account, which is a decision for the action, not for the store. The
 * design's rule is that the save button IS the verify button, and it is
 * enforced at the one place a human can press it.
 *
 * Storing always sets `enabled: true` and `status: "verified"`: the only way
 * here is a key that just answered a real grounded call, and a tenant who
 * pastes a replacement for a rejected key means to use it.
 *
 * And it puts the engine back on `ai_visibility_settings.engines`, in the same
 * transaction — the mirror of what `removeEngineKey` and `setEngineKeyEnabled`
 * already do, and it was the missing third. `effectiveEngines` is the
 * INTERSECTION of that list with the usable keys, so without this write the
 * sequence "remove ChatGPT, change your mind, paste a new ChatGPT key" left the
 * card rendering a green Verified badge over a switch that was on, quoting a
 * per-run price, for an engine that was never sampled again. Nothing on any
 * screen could explain it, because the settings list is not a control the card
 * shows. Same hole for any tenant whose `engines` was a strict subset for any
 * other reason — an old settings form, a hand-edited row.
 */
export async function storeEngineKey(
  entry: {
    tenantId: string;
    engine: EngineId;
    key: string;
    actorUserId: string | null;
  },
  now: Date = new Date(),
  database: typeof defaultDb = defaultDb
): Promise<EngineKeyView> {
  const encrypted = encryptSecret(entry.key);
  const last4 = last4Of(entry.key);

  const [existing] = await database
    .select({ id: aiVisibilityEngineKeys.id })
    .from(aiVisibilityEngineKeys)
    .where(
      and(
        eq(aiVisibilityEngineKeys.tenantId, entry.tenantId),
        eq(aiVisibilityEngineKeys.engine, entry.engine)
      )
    )
    .limit(1);

  const values = {
    keyCiphertext: encrypted.ciphertext,
    keyIv: encrypted.iv,
    keyAuthTag: encrypted.authTag,
    last4,
    status: "verified" as const,
    enabled: true,
    verifiedAt: now,
    // Cleared, not kept: the failure belonged to the key this one replaces, and
    // a stale "Key rejected 3 days ago" under a key that just verified is the
    // status column reporting a problem that no longer exists.
    lastFailureCode: null,
    lastFailureAt: null,
    // And so is "last used", for exactly the same reason. It is provenance
    // about a SECRET, not about the row: the card renders "…7f4A · added 12 Aug
    // by Dana · last used 20 Aug", and after a replacement every fragment on
    // that line except the date belongs to the key that is there now. A key
    // pasted a minute ago has never been used, and the honest reading is the
    // one the card already has a sentence for — "never used yet".
    //
    // `verifiedAt` above is the counter-example that shows the rule: a
    // replacement DID just verify, so that timestamp is true of the new key.
    lastUsedAt: null,
  };

  await database.transaction(async (tx) => {
    await tx
      .insert(aiVisibilityEngineKeys)
      .values({
        tenantId: entry.tenantId,
        engine: entry.engine,
        createdByUserId: entry.actorUserId,
        ...values,
      })
      .onConflictDoUpdate({
        target: [aiVisibilityEngineKeys.tenantId, aiVisibilityEngineKeys.engine],
        // `createdByUserId` and `createdAt` are NOT overwritten: they are the
        // provenance of the row, and a replacement is a new key on the same row
        // rather than a new relationship with the provider. The audit trail
        // carries who replaced it and when.
        set: values,
      });
    // Both halves or neither, exactly as removal is. A stored key beside a
    // settings row that does not name its engine is the same contradiction as a
    // removed key beside one that does — it just fails silently instead of
    // loudly.
    await syncSettingsEngine(tx, entry.tenantId, entry.engine, true);
  });

  await recordEngineKeyEvent(
    {
      tenantId: entry.tenantId,
      engine: entry.engine,
      action: existing ? "replaced" : "added",
      last4,
      status: "verified",
      actorUserId: entry.actorUserId,
    },
    database
  );

  const [view] = (await listEngineKeys(entry.tenantId, database)).filter(
    (row) => row.engine === entry.engine
  );
  return view;
}

/**
 * Records the outcome of a verification against an EXISTING row — the Re-check
 * button, and a run that hit a credential failure.
 *
 * A non-verified status is what takes the engine out of `effectiveEngines`, so
 * this is the whole auto-pause mechanism: no separate "paused" flag, and no way
 * for a rejected key to keep being charged. `enabled` is untouched on purpose —
 * see `flipEngineKeyOnFailure` for why a provider's verdict does not throw the
 * tenant's switch.
 */
export async function setEngineKeyStatus(
  entry: {
    tenantId: string;
    engine: EngineId;
    status: EngineKeyStatus;
    failureCode?: string | null;
    actorUserId?: string | null;
    action?: EngineKeyAction;
  },
  now: Date = new Date(),
  database: typeof defaultDb = defaultDb
): Promise<void> {
  const verified = entry.status === "verified";
  await database
    .update(aiVisibilityEngineKeys)
    .set({
      status: entry.status,
      ...(verified
        ? { verifiedAt: now, lastFailureCode: null, lastFailureAt: null }
        : { lastFailureCode: entry.failureCode ?? entry.status, lastFailureAt: now }),
    })
    .where(
      and(
        eq(aiVisibilityEngineKeys.tenantId, entry.tenantId),
        eq(aiVisibilityEngineKeys.engine, entry.engine)
      )
    );

  await recordEngineKeyEvent(
    {
      tenantId: entry.tenantId,
      engine: entry.engine,
      action: entry.action ?? "rechecked",
      status: entry.status,
      actorUserId: entry.actorUserId ?? null,
    },
    database
  );
}

/**
 * Which engine-call failures are the KEY's fault, and therefore worth flipping
 * a stored row over.
 *
 * `invalid_key` and `quota_exceeded` only. Both are terminal for the
 * credential: a revoked key stays revoked, and an account with no credit stays
 * empty until somebody pays. Flipping the status is what removes the engine
 * from `effectiveEngines`, so the next run does not spend three more attempts
 * discovering the same thing.
 *
 * `rate_limited` and `provider_unavailable` are deliberately NOT here. They are
 * about the moment, not the credential — a throughput 429 on a Tier 1 account
 * is the tenant's account working exactly as sold — and flipping a key over one
 * would take a paid, working engine off the board until somebody noticed a
 * badge. They are recorded on `lastFailureCode` and change nothing else.
 *
 * `bad_response` and `refused` are ours and the model's respectively; neither
 * says anything about the key.
 */
export function isCredentialFailure(code: string): boolean {
  return code === "invalid_key" || code === "quota_exceeded";
}

/**
 * A run's verdict on a key, written back.
 *
 * Deliberately does NOT set `enabled: false`, which is the judgement call this
 * design left open. Reasons, in order of weight:
 *
 *  1. A non-verified status ALREADY stops the engine — `effectiveEngines`
 *     requires `verified`, so the run-stopping half is done without touching
 *     the tenant's switch.
 *  2. `enabled` is the tenant's own control ("Saved, not in use"). A provider
 *     verdict that silently throws a switch a human set leaves them looking at
 *     a control that says something they did not do.
 *  3. The remedy differs. A rejected key needs a new paste; an out-of-credit
 *     account needs a payment and then a Re-check, and the row must still be
 *     there, switched on, for that Re-check to mean "resume" rather than
 *     "reconnect".
 *
 * Removal is the one operation that does flip `enabled` — see
 * `removeEngineKey`, and the design's rule that removing a key turns its engine
 * off in the same transaction.
 */
export async function flipEngineKeyOnFailure(
  entry: { tenantId: string; engine: EngineId; code: string },
  now: Date = new Date(),
  database: typeof defaultDb = defaultDb
): Promise<void> {
  if (!isCredentialFailure(entry.code)) {
    // Recorded, not escalated: the badge should be able to say "rate-limited on
    // the 24 Aug run" without the engine having been taken off the board.
    await database
      .update(aiVisibilityEngineKeys)
      .set({ lastFailureCode: entry.code, lastFailureAt: now })
      .where(
        and(
          eq(aiVisibilityEngineKeys.tenantId, entry.tenantId),
          eq(aiVisibilityEngineKeys.engine, entry.engine)
        )
      );
    return;
  }

  await setEngineKeyStatus(
    {
      tenantId: entry.tenantId,
      engine: entry.engine,
      status: entry.code === "quota_exceeded" ? "quota_exceeded" : "invalid_key",
      failureCode: entry.code,
      action: "auto_failed",
      actorUserId: null,
    },
    now,
    database
  );
}

/** Stamps a key as used. Fire-and-forget from the run; a failed stamp is not a failed run. */
export async function markEngineKeyUsed(
  tenantId: string,
  engine: EngineId,
  now: Date = new Date(),
  database: typeof defaultDb = defaultDb
): Promise<void> {
  try {
    await database
      .update(aiVisibilityEngineKeys)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(aiVisibilityEngineKeys.tenantId, tenantId),
          eq(aiVisibilityEngineKeys.engine, engine)
        )
      );
  } catch (error) {
    console.error(`[ai-visibility] failed to stamp ${engine} key usage:`, error);
  }
}

export type ToggleEngineKeyResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "not_verified" };

/**
 * The row's switch — "Saved, not in use" versus in use.
 *
 * Turning ON is refused unless the key is `verified`. That is VS Code's
 * structural idea, applied to state rather than to markup: the contradictory
 * combination (an engine switched on with nothing that can answer for it) is
 * unreachable rather than merely discouraged. The card renders no switch at all
 * on a keyless row for the same reason; this is the server's copy of that rule,
 * because a stale tab is a client that can still post the wrong thing.
 *
 * Keeps `settings.engines` in step, both ways. Without that a tenant who
 * switched an engine off in the OLD form before this shipped could paste a key,
 * switch it on, and watch it never run — the intersection would exclude it and
 * nothing on screen would explain why, because the old switch no longer exists
 * to be found and corrected. Writing both is not "silently rewriting their
 * rows": it is the explicit click doing what it says.
 */
export async function setEngineKeyEnabled(
  entry: {
    tenantId: string;
    engine: EngineId;
    enabled: boolean;
    actorUserId: string | null;
  },
  database: typeof defaultDb = defaultDb
): Promise<ToggleEngineKeyResult> {
  const [row] = await database
    .select({ status: aiVisibilityEngineKeys.status, last4: aiVisibilityEngineKeys.last4 })
    .from(aiVisibilityEngineKeys)
    .where(
      and(
        eq(aiVisibilityEngineKeys.tenantId, entry.tenantId),
        eq(aiVisibilityEngineKeys.engine, entry.engine)
      )
    )
    .limit(1);
  if (!row) return { ok: false, reason: "missing" };
  if (entry.enabled && toStatus(row.status) !== "verified") {
    return { ok: false, reason: "not_verified" };
  }

  await database.transaction(async (tx) => {
    await tx
      .update(aiVisibilityEngineKeys)
      .set({ enabled: entry.enabled })
      .where(
        and(
          eq(aiVisibilityEngineKeys.tenantId, entry.tenantId),
          eq(aiVisibilityEngineKeys.engine, entry.engine)
        )
      );
    await syncSettingsEngine(tx, entry.tenantId, entry.engine, entry.enabled);
  });

  await recordEngineKeyEvent(
    {
      tenantId: entry.tenantId,
      engine: entry.engine,
      action: entry.enabled ? "enabled" : "disabled",
      last4: row.last4,
      status: toStatus(row.status),
      actorUserId: entry.actorUserId,
    },
    database
  );
  return { ok: true };
}

/**
 * Removes the key and switches its engine off, in ONE transaction.
 *
 * Both halves or neither. A deleted key beside `settings.engines` still naming
 * that engine is a tenant who removed ChatGPT and whose settings card still
 * says ChatGPT is part of their measurement — the exact contradiction Decision
 * 2 exists to make unrenderable.
 *
 * Deleting is the irreversible one, and that is the whole difference from the
 * switch: OpenAI, Google and Anthropic each show a secret exactly once, so
 * nobody — including us — can put this back.
 */
export async function removeEngineKey(
  entry: { tenantId: string; engine: EngineId; actorUserId: string | null },
  database: typeof defaultDb = defaultDb
): Promise<{ ok: true; last4: string } | { ok: false; reason: "missing" }> {
  const [row] = await database
    .select({ last4: aiVisibilityEngineKeys.last4 })
    .from(aiVisibilityEngineKeys)
    .where(
      and(
        eq(aiVisibilityEngineKeys.tenantId, entry.tenantId),
        eq(aiVisibilityEngineKeys.engine, entry.engine)
      )
    )
    .limit(1);
  if (!row) return { ok: false, reason: "missing" };

  await database.transaction(async (tx) => {
    await tx
      .delete(aiVisibilityEngineKeys)
      .where(
        and(
          eq(aiVisibilityEngineKeys.tenantId, entry.tenantId),
          eq(aiVisibilityEngineKeys.engine, entry.engine)
        )
      );
    await syncSettingsEngine(tx, entry.tenantId, entry.engine, false);
  });

  await recordEngineKeyEvent(
    {
      tenantId: entry.tenantId,
      engine: entry.engine,
      action: "removed",
      last4: row.last4,
      actorUserId: entry.actorUserId,
    },
    database
  );
  return { ok: true, last4: row.last4 };
}

/**
 * Adds or drops one engine on `ai_visibility_settings.engines`.
 *
 * Written directly rather than through `saveAiVisibilitySettings`, which
 * refuses an empty engines list — a rule that is right for the settings FORM
 * (an enabled feature with no engines used to plan zero calls behind a green
 * badge) and wrong here, because under BYOK "no engines" is a real, expected,
 * fully-explained state that the /ai-visibility page has its own empty state
 * for. Removing your last key must not be refused as invalid input.
 *
 * Takes the transaction as an argument so every caller gets atomicity with the
 * key write beside it. There are three — store, switch, remove — and that is
 * the whole set of writes that can change whether an engine is measurable.
 */
async function syncSettingsEngine(
  tx: Parameters<Parameters<typeof defaultDb.transaction>[0]>[0],
  tenantId: string,
  engine: EngineId,
  present: boolean
): Promise<void> {
  const [row] = await tx
    .select({ engines: aiVisibilitySettings.engines })
    .from(aiVisibilitySettings)
    .where(eq(aiVisibilitySettings.tenantId, tenantId))
    .limit(1);

  // No row means the tenant is on the defaults, which already name all three
  // engines. Turning one ON needs no write; turning one OFF has to
  // materialise the row, or the default would keep claiming it.
  if (!row) {
    if (present) return;
    await tx.insert(aiVisibilitySettings).values({
      tenantId,
      engines: ENGINE_IDS.filter((id) => id !== engine),
    });
    return;
  }

  const current = new Set(row.engines.filter(isEngineId));
  if (present === current.has(engine)) return;
  if (present) current.add(engine);
  else current.delete(engine);

  await tx
    .update(aiVisibilitySettings)
    .set({ engines: [...current], updatedAt: new Date() })
    .where(eq(aiVisibilitySettings.tenantId, tenantId));
}
