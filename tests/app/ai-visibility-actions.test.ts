import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { aiVisibilityPrompts, users } from "../../src/db/schema";
import { seedTenant, dropTenant } from "../helpers/fixtures";

const TENANT = "AI Visibility Actions Test Tenant";
const USER_EMAIL = "ai-visibility-actions@example.com";
let currentTenantId = "";
// A REAL user row, not the string "user-1" the plan's draft used:
// `approveProposals` writes `approvedBy`, which is a uuid FK to `users`, so a
// placeholder id fails on `invalid input syntax for type uuid` before the
// behaviour under test is reached.
let currentUserId = "";

vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: currentUserId } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { generatePromptSet, planRun, runSlice, finalizeRun, afterCallbacks } = vi.hoisted(() => ({
  generatePromptSet: vi.fn(async () => ({ ok: true as const, proposals: [] as unknown[] })),
  // Declared with their call signatures, so `mock.calls[0][1].budgetMs` below
  // is a real assertion rather than an index into an empty tuple.
  planRun: vi.fn<
    (tenantId: string, opts: { trigger: string; now: () => Date }) => Promise<{ ok: boolean; runId?: string }>
  >(async () => ({ ok: true, runId: "run-1", plannedCalls: 360, estimateUsd: 3.12 })),
  runSlice: vi.fn<
    (
      runId: string,
      opts: { budgetMs: number; concurrency: number; now: () => Date }
    ) => Promise<{ processed: number; remaining: number; budgetSpent: boolean; pausedByCap: boolean }>
  >(async () => ({ processed: 360, remaining: 0, budgetSpent: false, pausedByCap: false })),
  finalizeRun: vi.fn<(runId: string, opts: { budgetMs: number; now: () => Date }) => Promise<unknown>>(
    async () => ({})
  ),
  afterCallbacks: [] as (() => Promise<void>)[],
}));
vi.mock("../../src/lib/ai-visibility/generate-prompts", () => ({ generatePromptSet }));
vi.mock("../../src/lib/ai-visibility/run", () => ({ planRun, runSlice, finalizeRun }));
// `after` is captured, never auto-run: the tests invoke the callback by hand,
// which is exactly the "response already flushed" timing being pinned.
vi.mock("next/server", () => ({
  after: vi.fn((task: () => Promise<void>) => {
    afterCallbacks.push(task);
  }),
}));

import {
  approveProposalsAction,
  deletePromptAction,
  generatePromptSetAction,
  runNowAction,
  savePromptAction,
  togglePromptAction,
} from "../../src/app/(dashboard)/ai-visibility/actions";
import { revalidatePath } from "next/cache";

beforeEach(async () => {
  vi.clearAllMocks();
  afterCallbacks.length = 0;
  const tenant = await seedTenant(TENANT);
  currentTenantId = tenant.id;
  await db.delete(users).where(eq(users.email, USER_EMAIL));
  const [user] = await db.insert(users).values({ email: USER_EMAIL }).returning();
  currentUserId = user.id;
});

afterEach(async () => {
  await dropTenant(TENANT);
  await db.delete(users).where(eq(users.email, USER_EMAIL));
});

async function seedProposal(text: string) {
  const [row] = await db
    .insert(aiVisibilityPrompts)
    .values({ tenantId: currentTenantId, text, intent: "discovery", origin: "generated", status: "proposed" })
    .returning();
  return row;
}

describe("savePromptAction", () => {
  it("rejects an unknown intent instead of writing it to a text column", async () => {
    const form = new FormData();
    form.set("text", "best localization tools for design teams");
    form.set("intent", "'; drop table ai_visibility_prompts; --");

    expect(await savePromptAction(form)).toEqual({ ok: false, error: "Pick an intent for this prompt." });
    expect(
      await db.select().from(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.tenantId, currentTenantId))
    ).toHaveLength(0);
  });

  it("rejects an empty prompt and a two-sentence one", async () => {
    const empty = new FormData();
    empty.set("text", "   ");
    empty.set("intent", "discovery");
    expect(await savePromptAction(empty)).toEqual({ ok: false, error: "Write the prompt first." });

    const long = new FormData();
    long.set("text", `${"word ".repeat(30)}?`);
    long.set("intent", "discovery");
    expect((await savePromptAction(long)).ok).toBe(false);
  });

  it("creates an active user prompt and revalidates both surfaces", async () => {
    const form = new FormData();
    form.set("text", "best localization tools for design teams");
    form.set("intent", "discovery");

    const result = await savePromptAction(form);

    expect(result.ok).toBe(true);
    const [row] = await db
      .select()
      .from(aiVisibilityPrompts)
      .where(eq(aiVisibilityPrompts.tenantId, currentTenantId));
    expect(row.origin).toBe("user");
    expect(row.status).toBe("active");
    expect(row.tenantId).toBe(currentTenantId);
    expect(revalidatePath).toHaveBeenCalledWith("/ai-visibility/prompts");
    expect(revalidatePath).toHaveBeenCalledWith("/ai-visibility");
  });

  it("editing supersedes: a new prompt is created and the old one is paused", async () => {
    const original = await seedProposal("best localisation tools");
    await db
      .update(aiVisibilityPrompts)
      .set({ status: "active" })
      .where(eq(aiVisibilityPrompts.id, original.id));

    const form = new FormData();
    form.set("promptId", original.id);
    form.set("text", "best localization tools for design teams");
    form.set("intent", "discovery");

    const result = await savePromptAction(form);

    expect(result).toMatchObject({ ok: true, superseded: true });
    const rows = await db
      .select()
      .from(aiVisibilityPrompts)
      .where(eq(aiVisibilityPrompts.tenantId, currentTenantId));
    expect(rows).toHaveLength(2);
    const [old] = rows.filter((row) => row.id === original.id);
    expect(old.status).toBe("paused");
    const [fresh] = rows.filter((row) => row.id !== original.id);
    expect(fresh.supersedesId).toBe(original.id);
  });

  it("reports a whitespace-only edit as NOT superseded — there is no second row to go looking for", async () => {
    const original = await seedProposal("best localization tools");
    await db
      .update(aiVisibilityPrompts)
      .set({ status: "active" })
      .where(eq(aiVisibilityPrompts.id, original.id));

    const form = new FormData();
    form.set("promptId", original.id);
    form.set("text", "  best   localization tools  ");

    expect(await savePromptAction(form)).toEqual({ ok: true, promptId: original.id, superseded: false });
  });

  it("refuses to add past the active cap rather than silently overspending", async () => {
    for (let index = 0; index < 30; index += 1) {
      const row = await seedProposal(`prompt number ${index}`);
      await db
        .update(aiVisibilityPrompts)
        .set({ status: "active" })
        .where(eq(aiVisibilityPrompts.id, row.id));
    }

    const form = new FormData();
    form.set("text", "one prompt too many for the cap");
    form.set("intent", "discovery");

    expect(await savePromptAction(form)).toEqual({
      ok: false,
      error: "You're at the 30 active prompt limit. Pause one first.",
    });
  });
});

describe("approveProposalsAction", () => {
  it("approves the checked rows, rejects the rest, and applies inline edits", async () => {
    const keep = await seedProposal("best localization tools");
    const edited = await seedProposal("localization tools pricing");
    const dropped = await seedProposal("versional pricing");

    const form = new FormData();
    form.append("approve", keep.id);
    form.append("approve", edited.id);
    form.set(`text:${edited.id}`, "how much do localization tools cost");
    form.append("reject", dropped.id);

    const result = await approveProposalsAction(form);

    expect(result).toMatchObject({ ok: true, approved: 2, rejected: 1 });
    const rows = await db
      .select()
      .from(aiVisibilityPrompts)
      .where(eq(aiVisibilityPrompts.tenantId, currentTenantId));
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(keep.id)?.status).toBe("active");
    expect(byId.get(edited.id)?.text).toBe("how much do localization tools cost");
    expect(byId.get(dropped.id)?.status).toBe("rejected");
  });

  it("ignores an id that is not this tenant's", async () => {
    const other = await seedTenant(`${TENANT} Other`);
    const [foreign] = await db
      .insert(aiVisibilityPrompts)
      .values({ tenantId: other.id, text: "not ours", intent: "discovery", origin: "generated" })
      .returning();

    const form = new FormData();
    form.append("approve", foreign.id);
    await approveProposalsAction(form);

    const [row] = await db.select().from(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.id, foreign.id));
    expect(row.status).toBe("proposed");
    await dropTenant(`${TENANT} Other`);
  });

  it("refuses an empty batch rather than reporting a no-op as a success", async () => {
    expect(await approveProposalsAction(new FormData())).toEqual({ ok: false, error: "Nothing selected." });
  });
});

describe("togglePromptAction and deletePromptAction", () => {
  it("refuses a non-uuid id rather than handing it to Postgres", async () => {
    expect(await togglePromptAction("not-a-uuid", true)).toEqual({ ok: false, error: "Unknown prompt." });
    expect(await deletePromptAction(42)).toEqual({ ok: false, error: "Unknown prompt." });
  });

  it("pauses and resumes", async () => {
    const prompt = await seedProposal("best localization tools");
    // A proposal is not resumable; approve it into the active set first.
    await db
      .update(aiVisibilityPrompts)
      .set({ status: "paused" })
      .where(eq(aiVisibilityPrompts.id, prompt.id));

    await togglePromptAction(prompt.id, true);
    let [row] = await db.select().from(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.id, prompt.id));
    expect(row.status).toBe("active");

    await togglePromptAction(prompt.id, false);
    [row] = await db.select().from(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.id, prompt.id));
    expect(row.status).toBe("paused");
  });

  it("deletes a prompt that has never run", async () => {
    const prompt = await seedProposal("best localization tools");

    expect(await deletePromptAction(prompt.id)).toEqual({ ok: true });
    expect(
      await db.select().from(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.id, prompt.id))
    ).toHaveLength(0);
  });
});

describe("runNowAction", () => {
  it("turns every refusal into a sentence, and never into a thrown error", async () => {
    // `no_engines` is deliberately absent: `planRun`'s refusal union has no
    // such arm (`getAiVisibilitySettings` substitutes the full engine list for
    // an empty one), so a branch for it here would be dead code pretending to
    // be a state.
    const cases = [
      [{ ok: false, reason: "disabled" }, "AI visibility is off — turn it on in Company."],
      [{ ok: false, reason: "no_prompts" }, "Approve some prompts first."],
      [{ ok: false, reason: "run_in_flight", runId: "run-0" }, "A run is already in progress."],
      [
        { ok: false, reason: "cap_reached", spentUsd: 19.4, estimateUsd: 3.1, capUsd: 20 },
        "Monthly cap reached ($19.40 of $20.00) — raise it in Settings, or wait for next month.",
      ],
    ] as const;

    for (const [refusal, message] of cases) {
      planRun.mockResolvedValueOnce(refusal as never);
      expect(await runNowAction()).toEqual({ ok: false, error: message });
    }
  });

  it("does not gate the run itself — planRun is the single authority", async () => {
    // No pre-check here: a second gate would be a check-then-act across an
    // await, and two tabs could both pass it. `planRun` refuses atomically.
    await runNowAction();
    expect(planRun).toHaveBeenCalledTimes(1);
    expect(planRun.mock.calls[0][0]).toBe(currentTenantId);
    expect(planRun.mock.calls[0][1]).toMatchObject({ trigger: "manual" });
    expect(typeof planRun.mock.calls[0][1].now).toBe("function");
  });

  it("starts a run and revalidates both surfaces that show run state", async () => {
    expect(await runNowAction()).toEqual({ ok: true, runId: "run-1" });
    expect(revalidatePath).toHaveBeenCalledWith("/ai-visibility");
    expect(revalidatePath).toHaveBeenCalledWith("/company");
  });

  it("drives the run to complete after the response, without waiting for the daily cron", async () => {
    expect(await runNowAction()).toEqual({ ok: true, runId: "run-1" });
    // Nothing has run yet — `after` defers past the response flush, so the
    // human is never kept waiting on 360 engine calls.
    expect(runSlice).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);

    await afterCallbacks[0]();

    expect(runSlice).toHaveBeenCalled();
    expect(runSlice.mock.calls[0][0]).toBe("run-1");
    expect(typeof runSlice.mock.calls[0][1].budgetMs).toBe("number");
    expect(typeof runSlice.mock.calls[0][1].concurrency).toBe("number");
    expect(finalizeRun).toHaveBeenCalledTimes(1);
    expect(finalizeRun.mock.calls[0][0]).toBe("run-1");
  });

  it("keeps slicing until no pending samples remain, then finalizes once", async () => {
    runSlice
      .mockResolvedValueOnce({ processed: 200, remaining: 160, budgetSpent: true, pausedByCap: false })
      .mockResolvedValueOnce({ processed: 160, remaining: 0, budgetSpent: false, pausedByCap: false });

    await runNowAction();
    await afterCallbacks[0]();

    expect(runSlice).toHaveBeenCalledTimes(2);
    expect(finalizeRun).toHaveBeenCalledTimes(1);
  });

  it("stops without finalizing when the cap pauses the run mid-slice", async () => {
    runSlice.mockResolvedValueOnce({ processed: 12, remaining: 300, budgetSpent: false, pausedByCap: true });

    await runNowAction();
    await afterCallbacks[0]();

    // `runSlice` already set `paused_by_cap` and the source's lastError;
    // finalizing a capped run would judge and aggregate a half-run.
    expect(finalizeRun).not.toHaveBeenCalled();
  });

  it("schedules no background work for a refused run", async () => {
    planRun.mockResolvedValueOnce({ ok: false, reason: "disabled" } as never);
    await runNowAction();
    expect(afterCallbacks).toHaveLength(0);
  });

  it("never lets the background callback throw — the daily sweep resumes whatever is left", async () => {
    runSlice.mockRejectedValueOnce(new Error("engine down"));
    await runNowAction();
    await expect(afterCallbacks[0]()).resolves.toBeUndefined();
    expect(finalizeRun).not.toHaveBeenCalled();
  });
});

describe("generatePromptSetAction", () => {
  it("counts what the core persisted rather than assuming the batch size", async () => {
    generatePromptSet.mockResolvedValueOnce({ ok: true, proposals: [{}, {}, {}] });

    expect(await generatePromptSetAction()).toEqual({ ok: true, proposed: 3 });
  });

  it("sends an unconfigured profile to /company instead of a generic failure", async () => {
    generatePromptSet.mockResolvedValueOnce({ ok: false, error: "disabled" } as never);

    expect(await generatePromptSetAction()).toEqual({
      ok: false,
      error: "Add a category and positioning on Company first.",
    });
  });

  it("reports a model failure as a readable message, and does not leak the provider's own", async () => {
    generatePromptSet.mockResolvedValueOnce({
      ok: false,
      error: "generation_failed",
      message: "429 rate limited",
    } as never);

    expect(await generatePromptSetAction()).toEqual({
      ok: false,
      error: "Couldn't draft prompts just now — try again.",
    });
  });

  it("does not throw into the client when the core throws", async () => {
    generatePromptSet.mockRejectedValueOnce(new Error("boom"));

    expect(await generatePromptSetAction()).toEqual({
      ok: false,
      error: "Couldn't draft prompts just now — try again.",
    });
  });
});
