import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/db";
import {
  aiVisibilityEngineKeyEvents,
  aiVisibilityEngineKeys,
  aiVisibilitySettings,
  users,
} from "../../src/db/schema";
import { decryptSecret } from "../../src/lib/credentials/encryption";
import { effectiveEngines, listEngineKeys } from "../../src/lib/ai-visibility/engine-keys";
import { seedTenant, dropTenant, seedEngineKey } from "../helpers/fixtures";

/**
 * The four writes the AI-engines card makes, and the four rules they hold.
 *
 * 1. **Verify before store.** A key that fails verification is never written —
 *    not as `invalid_key`, not as anything. The row is untouched, so a bad
 *    paste cannot take a working engine down.
 * 2. **Write-once.** No path here returns a plaintext key. The assertions are
 *    about an ABSENCE, because asserting the right thing came back would pass
 *    against an implementation that also returned the secret.
 * 3. **Owner-only for writes.** Decision 8. Masked state stays visible to
 *    members; nothing they do can change it.
 * 4. **Remove turns the engine off in the same breath.** A deleted key beside
 *    a settings row still naming that engine is a workspace whose card claims
 *    to measure something it cannot.
 *
 * `verifyEngineKey` is the network seam and is mocked in every case — no test
 * here reaches a provider, and none of them needs to: what is under test is
 * what the action does with each verdict.
 */

const TENANT = "AI Visibility Engine Key Actions Test Tenant";
const USER_EMAIL = "engine-key-actions@example.com";
let currentTenantId = "";
let currentUserId = "";
let currentRole: "owner" | "member" = "owner";

vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({
    user: { tenantId: currentTenantId, id: currentUserId, role: currentRole },
  })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { verifyEngineKey } = vi.hoisted(() => ({
  verifyEngineKey: vi.fn<
    (
      engine: string,
      key: string
    ) => Promise<{ ok: true; costUsd: number } | { ok: false; status: string }>
  >(async () => ({ ok: true, costUsd: 0.25 })),
}));
vi.mock("../../src/lib/ai-visibility/engines/verify", () => ({ verifyEngineKey }));

import {
  recheckEngineKeyAction,
  removeEngineKeyAction,
  saveEngineKeyAction,
  toggleEngineKeyAction,
} from "../../src/app/(dashboard)/settings/engine-key-actions";

const GOOD_KEY = "sk-proj-a-perfectly-good-key-7f4A";
const ALL_ENGINES = ["openai", "gemini", "anthropic"];

/** The engine list a run would read — the stored one, not a literal. */
async function settingsEngines(): Promise<string[]> {
  const [row] = await db
    .select({ engines: aiVisibilitySettings.engines })
    .from(aiVisibilitySettings)
    .where(eq(aiVisibilitySettings.tenantId, currentTenantId));
  return row?.engines ?? ALL_ENGINES;
}

function saveForm(engine: string, key: string): FormData {
  const data = new FormData();
  data.set("engine", engine);
  data.set("key", key);
  return data;
}

async function keyRow(engine: string) {
  const [row] = await db
    .select()
    .from(aiVisibilityEngineKeys)
    .where(
      and(
        eq(aiVisibilityEngineKeys.tenantId, currentTenantId),
        eq(aiVisibilityEngineKeys.engine, engine)
      )
    );
  return row;
}

async function events() {
  return db
    .select()
    .from(aiVisibilityEngineKeyEvents)
    .where(eq(aiVisibilityEngineKeyEvents.tenantId, currentTenantId));
}

beforeEach(async () => {
  vi.clearAllMocks();
  verifyEngineKey.mockResolvedValue({ ok: true, costUsd: 0.25 });
  currentRole = "owner";
  const tenant = await seedTenant(TENANT);
  currentTenantId = tenant.id;
  const [user] = await db
    .insert(users)
    .values({ email: USER_EMAIL, name: "Tomer" })
    .onConflictDoUpdate({ target: users.email, set: { name: "Tomer" } })
    .returning();
  currentUserId = user.id;
});

afterEach(async () => {
  await dropTenant(TENANT);
  await db.delete(users).where(eq(users.email, USER_EMAIL));
});

describe("saveEngineKeyAction — verify before store", () => {
  it("stores a key that passed verification, encrypted, with only last4 in the clear", async () => {
    const result = await saveEngineKeyAction(saveForm("openai", GOOD_KEY));

    expect(result.ok).toBe(true);
    const row = await keyRow("openai");
    expect(row.status).toBe("verified");
    expect(row.enabled).toBe(true);
    expect(row.last4).toBe("7f4A");
    // The plaintext is nowhere in the row but the ciphertext, and the
    // ciphertext really is the key — decrypting proves the run will get
    // something usable rather than a mangled string.
    expect(row.keyCiphertext).not.toContain(GOOD_KEY);
    expect(
      decryptSecret({
        ciphertext: row.keyCiphertext,
        iv: row.keyIv,
        authTag: row.keyAuthTag,
      })
    ).toBe(GOOD_KEY);
  });

  it("does NOT write a key that failed verification", async () => {
    // The whole of Decision 3 in one assertion. A stored-but-broken key is a
    // key that fails during a scheduled sweep at 09:00 UTC with nobody
    // watching, which is the failure this rule exists to make impossible.
    verifyEngineKey.mockResolvedValue({ ok: false, status: "quota_exceeded" });

    const result = await saveEngineKeyAction(saveForm("openai", GOOD_KEY));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe("quota_exceeded");
    // Four states, never three: this one names the account's credit and points
    // at billing, not at the key.
    expect(result.error).toContain("no credit");
    expect(result.error).toContain("platform.openai.com/settings/billing");
    expect(await keyRow("openai")).toBeUndefined();
    expect(await events()).toEqual([]);
  });

  it("leaves a WORKING key in place when its replacement fails verification", async () => {
    // The dangerous version of the same rule. Replacing must not be able to
    // take a paid, working engine down over a typo.
    const { key: original } = await seedEngineKey(currentTenantId, "openai");
    verifyEngineKey.mockResolvedValue({ ok: false, status: "invalid_key" });

    expect((await saveEngineKeyAction(saveForm("openai", "sk-typo"))).ok).toBe(false);

    const row = await keyRow("openai");
    expect(row.status).toBe("verified");
    expect(
      decryptSecret({ ciphertext: row.keyCiphertext, iv: row.keyIv, authTag: row.keyAuthTag })
    ).toBe(original);
  });

  it("does not write when verification THROWS either", async () => {
    // `verifyEngineKey` promises not to throw, so this is our bug rather than
    // the tenant's — and storing on a crash would be storing without verifying,
    // which is the one thing this action may never do.
    vi.spyOn(console, "error").mockImplementation(() => {});
    verifyEngineKey.mockRejectedValue(new Error("boom"));

    const result = await saveEngineKeyAction(saveForm("openai", GOOD_KEY));

    expect(result.ok).toBe(false);
    expect(await keyRow("openai")).toBeUndefined();
    vi.restoreAllMocks();
  });

  it("catches a misdirected paste without spending anything to prove it", async () => {
    const result = await saveEngineKeyAction(saveForm("openai", "sk-ant-api03-something"));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("Paste it in the Claude row");
    // Not one call. The alternative is spending the tenant's money proving
    // that an Anthropic key is not an OpenAI key.
    expect(verifyEngineKey).not.toHaveBeenCalled();
  });

  it("trims the key before verifying it — people paste with a trailing newline", async () => {
    await saveEngineKeyAction(saveForm("openai", `  ${GOOD_KEY}\n`));

    expect(verifyEngineKey).toHaveBeenCalledWith("openai", GOOD_KEY);
    expect((await keyRow("openai")).last4).toBe("7f4A");
  });

  it("records who added it, and says `replaced` the second time", async () => {
    await saveEngineKeyAction(saveForm("openai", GOOD_KEY));
    await saveEngineKeyAction(saveForm("openai", `${GOOD_KEY}-two`));

    const trail = (await events()).sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
    );
    expect(trail.map((row) => row.action)).toEqual(["added", "replaced"]);
    expect(trail.every((row) => row.actorUserId === currentUserId)).toBe(true);
    // Provenance is the industry blank — no surveyed product shows who pasted
    // a key, and a three-person team needs to know which colleague did.
    const [view] = await listEngineKeys(currentTenantId);
    expect(view.createdByName).toBe("Tomer");
  });
});

describe("write-once — nothing hands a key back", () => {
  it("no action's result carries the plaintext, or anything to rebuild it from", async () => {
    await saveEngineKeyAction(saveForm("openai", GOOD_KEY));

    const results = [
      await saveEngineKeyAction(saveForm("gemini", "AIza-a-good-google-key-9ZZ2")),
      await recheckEngineKeyAction("openai"),
      await toggleEngineKeyAction("openai", false),
      await toggleEngineKeyAction("openai", true),
      await removeEngineKeyAction("openai"),
    ];

    for (const result of results) {
      const serialised = JSON.stringify(result);
      expect(serialised).not.toContain(GOOD_KEY);
      expect(serialised).not.toContain("AIza-a-good-google-key-9ZZ2");
      // Not the ciphertext either: it is not readable without our key material,
      // but shipping it to a browser is still shipping the secret.
      expect(serialised).not.toContain("Ciphertext");
      expect(serialised).not.toContain("AuthTag");
    }
  });

  it("the list a page renders carries last4 and nothing longer", async () => {
    await saveEngineKeyAction(saveForm("openai", GOOD_KEY));

    const [view] = await listEngineKeys(currentTenantId);
    expect(view.last4).toBe("7f4A");
    expect(JSON.stringify(view)).not.toContain(GOOD_KEY);
    // The type has no field to put one in, which is the real guarantee — this
    // asserts the shape actually matches the type.
    expect(Object.keys(view).sort()).toEqual([
      "createdAt",
      "createdByName",
      "enabled",
      "engine",
      "last4",
      "lastFailureAt",
      "lastFailureCode",
      "lastUsedAt",
      "status",
      "verifiedAt",
    ]);
  });
});

describe("recheckEngineKeyAction", () => {
  it("clears a rejected status when the provider now accepts the key", async () => {
    // The whole point of the button: a tenant tops up their account and comes
    // back. Re-check must work on a NON-verified row, or it is useless exactly
    // when it is needed.
    await seedEngineKey(currentTenantId, "openai", { status: "quota_exceeded" });

    const result = await recheckEngineKeyAction("openai");

    expect(result.ok).toBe(true);
    const row = await keyRow("openai");
    expect(row.status).toBe("verified");
    expect(row.lastFailureCode).toBeNull();
  });

  it("records the new failure state when it still fails", async () => {
    await seedEngineKey(currentTenantId, "openai");
    verifyEngineKey.mockResolvedValue({ ok: false, status: "invalid_key" });

    const result = await recheckEngineKeyAction("openai");

    expect(result.ok).toBe(false);
    expect((await keyRow("openai")).status).toBe("invalid_key");
  });

  it("says UNREADABLE, not invalid, when our own key material cannot decrypt it", async () => {
    // Zed's bug. A keychain failure surfaced inside an "invalid or has expired"
    // banner and users replaced keys that were fine. Five states, never four.
    vi.spyOn(console, "error").mockImplementation(() => {});
    await seedEngineKey(currentTenantId, "openai");
    await db
      .update(aiVisibilityEngineKeys)
      .set({ keyAuthTag: "00000000000000000000000000000000" })
      .where(eq(aiVisibilityEngineKeys.tenantId, currentTenantId));

    const result = await recheckEngineKeyAction("openai");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe("unreadable");
    expect(result.error).toContain("fault on our side");
    expect((await keyRow("openai")).status).toBe("unreadable");
    // And no provider was troubled about it — the key never reached one.
    expect(verifyEngineKey).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("toggleEngineKeyAction", () => {
  it("cannot switch an unverified key ON", async () => {
    // The contradictory state — an engine switched on with nothing that can
    // answer for it — is unreachable rather than discouraged. The card renders
    // the rule; this is the copy a stale tab cannot get past.
    await seedEngineKey(currentTenantId, "openai", { status: "invalid_key", enabled: false });

    const result = await toggleEngineKeyAction("openai", true);

    expect(result.ok).toBe(false);
    expect((await keyRow("openai")).enabled).toBe(false);
  });

  it("switching off keeps the key and takes the engine out of the run", async () => {
    // "Saved, not in use". A team pausing ChatGPT for a month — it is 3.7x
    // Gemini per call — must not have to mint a new key to come back.
    await seedEngineKey(currentTenantId, "openai");
    await db
      .insert(aiVisibilitySettings)
      .values({ tenantId: currentTenantId, engines: ["openai", "gemini"] });

    expect((await toggleEngineKeyAction("openai", false)).ok).toBe(true);

    expect(await keyRow("openai")).toBeDefined();
    expect((await keyRow("openai")).enabled).toBe(false);
    expect(await effectiveEngines(currentTenantId, ["openai", "gemini"])).toEqual([]);
  });

  it("switching on puts the engine back into settings.engines", async () => {
    // Without this a tenant who switched an engine off in the OLD form before
    // BYOK shipped could paste a key, switch it on, and watch it never run —
    // the intersection would exclude it and the control that could fix it no
    // longer exists.
    await seedEngineKey(currentTenantId, "openai", { enabled: false });
    await db.insert(aiVisibilitySettings).values({ tenantId: currentTenantId, engines: ["gemini"] });

    expect((await toggleEngineKeyAction("openai", true)).ok).toBe(true);

    expect(await effectiveEngines(currentTenantId, ["openai", "gemini"])).toEqual(["openai"]);
  });
});

describe("a replacement is a new secret, not an edit of the old one", () => {
  it("clears `lastUsedAt`, so the provenance line stops describing a key that is gone", async () => {
    // The card renders "…7f4A · added 12 Aug by Dana · last used 20 Aug". After
    // a replacement every fragment on that line is about the key that is there
    // NOW, so a `lastUsedAt` carried over from the key it replaced makes the
    // row report a spend that never happened on this credential. `verifiedAt`
    // is the counter-example: a replacement did just verify.
    const usedAt = new Date("2026-08-20T09:00:00Z");
    await seedEngineKey(currentTenantId, "openai", { lastUsedAt: usedAt });

    expect((await saveEngineKeyAction(saveForm("openai", GOOD_KEY))).ok).toBe(true);

    const row = await keyRow("openai");
    expect(row.lastUsedAt).toBeNull();
    expect(row.verifiedAt).not.toBeNull();
    // And the view the card reads says the same, since that is the surface the
    // sentence is composed from.
    const [view] = (await listEngineKeys(currentTenantId)).filter((key) => key.engine === "openai");
    expect(view.lastUsedAt).toBeNull();
  });
});

describe("saving a key puts its engine back on the settings row", () => {
  it("re-adding a removed key measures again, rather than silently never running", async () => {
    // THE REGRESSION, in the order a person does it: remove ChatGPT, change
    // your mind, paste a new ChatGPT key.
    //
    // `removeEngineKey` drops the engine from `settings.engines`, and
    // `effectiveEngines` is the INTERSECTION of that list with the usable keys.
    // `storeEngineKey` used to write only the key, so the second paste rendered
    // a green Verified badge over a switch that was on, quoted a per-run price,
    // and was never sampled. Nothing on any screen said why — the settings list
    // is not a control the card shows.
    await seedEngineKey(currentTenantId, "openai");
    await db.insert(aiVisibilitySettings).values({
      tenantId: currentTenantId,
      engines: ["openai", "gemini", "anthropic"],
    });
    await seedEngineKey(currentTenantId, "gemini");

    expect((await removeEngineKeyAction("openai")).ok).toBe(true);
    expect(await settingsEngines()).toEqual(["gemini", "anthropic"]);

    expect((await saveEngineKeyAction(saveForm("openai", GOOD_KEY))).ok).toBe(true);

    // The settings row names it again…
    expect(await settingsEngines()).toEqual(expect.arrayContaining(["openai", "gemini"]));
    // …which is what makes the intersection a run actually plans include it.
    // Read through the stored list, exactly as `planRun` and the overview page
    // read it — passing a literal here would test nothing.
    // Sorted: `effectiveEngines` preserves the settings row's own order, and a
    // re-added engine lands at the end of it. The pages sort by
    // `ENGINE_ORDER`, so the ORDER here is not a fact worth pinning.
    expect((await effectiveEngines(currentTenantId, await settingsEngines())).sort()).toEqual([
      "gemini",
      "openai",
    ]);
  });

  it("adds the engine for any tenant whose settings row is a strict subset", async () => {
    // Not only the remove-then-re-add path. A tenant who switched ChatGPT off
    // in the settings form that shipped before BYOK has the same row, and the
    // control that could put it back no longer exists.
    await db.insert(aiVisibilitySettings).values({ tenantId: currentTenantId, engines: ["gemini"] });

    expect((await saveEngineKeyAction(saveForm("openai", GOOD_KEY))).ok).toBe(true);

    expect(await settingsEngines()).toEqual(expect.arrayContaining(["openai", "gemini"]));
    expect(await effectiveEngines(currentTenantId, await settingsEngines())).toEqual(["openai"]);
  });

  it("leaves a tenant on the defaults alone — they already name all three", async () => {
    // No settings row means the defaults apply, and those name every engine.
    // Materialising a row here would be a write with nothing to say.
    expect((await saveEngineKeyAction(saveForm("openai", GOOD_KEY))).ok).toBe(true);

    expect(
      await db
        .select()
        .from(aiVisibilitySettings)
        .where(eq(aiVisibilitySettings.tenantId, currentTenantId))
    ).toEqual([]);
    expect(await effectiveEngines(currentTenantId, ALL_ENGINES)).toEqual(["openai"]);
  });
});

describe("removeEngineKeyAction", () => {
  it("deletes the key and switches the engine off in one go", async () => {
    await seedEngineKey(currentTenantId, "openai");
    await db
      .insert(aiVisibilitySettings)
      .values({ tenantId: currentTenantId, engines: ["openai", "gemini"] });

    expect((await removeEngineKeyAction("openai")).ok).toBe(true);

    expect(await keyRow("openai")).toBeUndefined();
    const [settings] = await db
      .select()
      .from(aiVisibilitySettings)
      .where(eq(aiVisibilitySettings.tenantId, currentTenantId));
    // Both halves or neither: a removed key beside a settings row still naming
    // that engine is a card claiming to measure something it cannot.
    expect(settings.engines).toEqual(["gemini"]);
    expect((await events()).map((row) => row.action)).toEqual(["removed"]);
  });

  it("removing the LAST key empties the engine list rather than being refused", async () => {
    // `saveAiVisibilitySettings` refuses an empty engines array, which is right
    // for the settings FORM and wrong here: under BYOK "no engines" is a real,
    // explained state with its own empty state on /ai-visibility, and removing
    // your last key must not fail as invalid input.
    await seedEngineKey(currentTenantId, "openai");
    await db.insert(aiVisibilitySettings).values({ tenantId: currentTenantId, engines: ["openai"] });

    expect((await removeEngineKeyAction("openai")).ok).toBe(true);

    const [settings] = await db
      .select()
      .from(aiVisibilitySettings)
      .where(eq(aiVisibilitySettings.tenantId, currentTenantId));
    expect(settings.engines).toEqual([]);
    expect(await effectiveEngines(currentTenantId, ["openai", "gemini", "anthropic"])).toEqual([]);
  });
});

describe("the audit trail — Decision 10's checklist item nobody else ships", () => {
  it("records every write with its actor, and names them apart", async () => {
    // "Audit-log add / replace / delete / enable / disable with actor and
    // timestamp. No surveyed product documents this for an LLM credential."
    // Asserted as an ORDERED list, because a trail that logs five writes as
    // five identical "changed" lines is not a trail.
    await saveEngineKeyAction(saveForm("openai", GOOD_KEY));
    await saveEngineKeyAction(saveForm("openai", `${GOOD_KEY}-two`));
    await toggleEngineKeyAction("openai", false);
    await toggleEngineKeyAction("openai", true);
    await recheckEngineKeyAction("openai");
    await removeEngineKeyAction("openai");

    const trail = (await events()).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    expect(trail.map((entry) => entry.action)).toEqual([
      "added",
      "replaced",
      "disabled",
      "enabled",
      "rechecked",
      "removed",
    ]);
    // Every line names who did it. A trail that cannot answer "who" is a log.
    expect(trail.every((entry) => entry.actorUserId === currentUserId)).toBe(true);
    expect(trail.every((entry) => entry.createdAt instanceof Date)).toBe(true);
    // …and no line carries anything longer than the last four.
    const serialised = JSON.stringify(trail);
    expect(serialised).not.toContain(GOOD_KEY);
    expect(serialised).toContain("7f4A");
  });

  it("a failed save writes nothing at all — not even an attempt line", async () => {
    // A key that never verified was never stored, so there is nothing to have
    // a history of. An "attempted" line here would be a record of a secret the
    // tenant typed, kept after we refused it.
    verifyEngineKey.mockResolvedValue({ ok: false, status: "invalid_key" });

    expect((await saveEngineKeyAction(saveForm("openai", GOOD_KEY))).ok).toBe(false);

    expect(await events()).toEqual([]);
  });
});

describe("owner-only for writes", () => {
  // Decision 8: 4 of 5 BYOK products are workspace-scoped and admin-only
  // wherever documented, and AirOps — same audience, same product shape — gives
  // its marketer role zero access to keys. We adopt owner-only for write and
  // masked state visible to every member. `requireRole` throws, which is the
  // right shape: a member reaching these is a forged request or a stale tab
  // after a role change, not a state to render copy for.
  beforeEach(() => {
    currentRole = "member";
  });

  it("refuses every write", async () => {
    await expect(saveEngineKeyAction(saveForm("openai", GOOD_KEY))).rejects.toThrow(/owner/);
    await expect(recheckEngineKeyAction("openai")).rejects.toThrow(/owner/);
    await expect(toggleEngineKeyAction("openai", false)).rejects.toThrow(/owner/);
    await expect(removeEngineKeyAction("openai")).rejects.toThrow(/owner/);
    // Nothing was verified, and nothing was written.
    expect(verifyEngineKey).not.toHaveBeenCalled();
    expect(await events()).toEqual([]);
  });

  it("still lets a member READ the masked state", async () => {
    currentRole = "owner";
    await saveEngineKeyAction(saveForm("openai", GOOD_KEY));
    currentRole = "member";

    const [view] = await listEngineKeys(currentTenantId);
    expect(view.last4).toBe("7f4A");
    expect(view.status).toBe("verified");
  });
});
