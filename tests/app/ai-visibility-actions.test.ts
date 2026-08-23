import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { aiVisibilityPrompts, users } from "../../src/db/schema";
import { MAX_ACTIVE_PROMPTS } from "../../src/lib/ai-visibility/prompts";
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

const { generatePromptSet, planRun, driveRun, findResumableRun, cancelRun, afterCallbacks } = vi.hoisted(() => ({
  generatePromptSet: vi.fn(async () => ({ ok: true as const, proposals: [] as unknown[] })),
  // Declared with their call signatures, so `mock.calls[0][1].budgetMs` below
  // is a real assertion rather than an index into an empty tuple.
  planRun: vi.fn<
    (tenantId: string, opts: { trigger: string; now: () => Date }) => Promise<{ ok: boolean; runId?: string }>
  >(async () => ({ ok: true, runId: "run-1", plannedCalls: 270, estimateUsd: 3.12 })),
  // The slice loop itself is `driveRun`'s, and is tested against the real
  // thing in tests/lib/ai-visibility/resume.test.ts — cap pause, stop, budget,
  // backoff and its never-throws contract. What these tests own is the ACTION:
  // that it defers the drive past the response, and hands it the right run and
  // the right budgets.
  driveRun: vi.fn<
    (
      runId: string,
      opts: {
        totalBudgetMs: number;
        sliceBudgetMs: number;
        finalizeMinBudgetMs: number;
        concurrency: number;
        now: () => Date;
      }
    ) => Promise<void>
  >(async () => {}),
  findResumableRun: vi.fn<
    (
      tenantId: string,
      opts: { now: () => Date }
    ) => Promise<
      { ok: true; runId: string } | { ok: false; reason: "not_in_flight" | "lease_held" }
    >
  >(async () => ({ ok: true, runId: "run-1" })),
  cancelRun: vi.fn<
    (
      tenantId: string,
      opts: { now: () => Date }
    ) => Promise<
      | { ok: true; runId: string; completedCalls: number; plannedCalls: number }
      | { ok: false; reason: "not_in_flight" }
    >
  >(async () => ({ ok: true, runId: "run-1", completedCalls: 41, plannedCalls: 270 })),
  afterCallbacks: [] as (() => Promise<void>)[],
}));
vi.mock("../../src/lib/ai-visibility/generate-prompts", () => ({ generatePromptSet }));
vi.mock("../../src/lib/ai-visibility/run", () => ({ planRun, driveRun, findResumableRun, cancelRun }));
// `after` is captured, never auto-run: the tests invoke the callback by hand,
// which is exactly the "response already flushed" timing being pinned.
vi.mock("next/server", () => ({
  after: vi.fn((task: () => Promise<void>) => {
    afterCallbacks.push(task);
  }),
}));

import {
  approveProposalsAction,
  cancelRunAction,
  resumeRunAction,
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
    for (let index = 0; index < MAX_ACTIVE_PROMPTS; index += 1) {
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
      error: `You're at the ${MAX_ACTIVE_PROMPTS} active prompt limit. Pause one first.`,
    });
  });
});

describe("savePromptAction — the refusal arms", () => {
  it("names a duplicate wording as a duplicate, not as an unusable prompt", async () => {
    const first = new FormData();
    first.set("text", "best localization tools for design teams");
    first.set("intent", "discovery");
    expect((await savePromptAction(first)).ok).toBe(true);

    const again = new FormData();
    again.set("text", "best localization tools for design teams");
    again.set("intent", "discovery");
    expect(await savePromptAction(again)).toEqual({
      ok: false,
      error: "You already have a prompt with that wording.",
    });
  });

  it("reports an edit that collides with an existing prompt separately from a bad wording", async () => {
    const existing = await seedProposal("best localization tools");
    const target = await seedProposal("localization tools pricing");
    // `editPrompt` supersedes an approved prompt; a proposal is edited inside
    // the review batch instead.
    await db
      .update(aiVisibilityPrompts)
      .set({ status: "active" })
      .where(eq(aiVisibilityPrompts.tenantId, currentTenantId));

    const form = new FormData();
    form.set("promptId", target.id);
    form.set("text", existing.text);
    expect(await savePromptAction(form)).toEqual({
      ok: false,
      error: "You already have a prompt with that wording.",
    });
  });

  it("refuses to edit a prompt that is not this tenant's, undistinguished from one that does not exist", async () => {
    const other = await seedTenant(`${TENANT} Edit Foreign`);
    const [foreign] = await db
      .insert(aiVisibilityPrompts)
      .values({ tenantId: other.id, text: "not ours", intent: "discovery", origin: "generated" })
      .returning();

    const form = new FormData();
    form.set("promptId", foreign.id);
    form.set("text", "a rewritten question about localization");
    expect(await savePromptAction(form)).toEqual({ ok: false, error: "Unknown prompt." });

    const [row] = await db.select().from(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.id, foreign.id));
    expect(row.text).toBe("not ours");
    await dropTenant(`${TENANT} Edit Foreign`);
  });

  it("validates the text before it ever looks at the prompt id", async () => {
    const form = new FormData();
    form.set("promptId", "00000000-0000-4000-8000-000000000000");
    form.set("text", "   ");
    expect(await savePromptAction(form)).toEqual({ ok: false, error: "Write the prompt first." });
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

  it("commits a whole batch of rejections — every unchecked row becomes a negative", async () => {
    // Review is EXCLUSION: a rejected proposal is remembered so the next
    // generation does not offer it again. Dropping the rows instead would
    // make "Suggest more" hand back the same thirty prompts.
    const first = await seedProposal("best localization tools");
    const second = await seedProposal("localization tools pricing");

    const form = new FormData();
    form.append("reject", first.id);
    form.append("reject", second.id);

    expect(await approveProposalsAction(form)).toMatchObject({ ok: true, approved: 0, rejected: 2 });
    const rows = await db
      .select()
      .from(aiVisibilityPrompts)
      .where(eq(aiVisibilityPrompts.tenantId, currentTenantId));
    expect(rows.map((row) => row.status)).toEqual(["rejected", "rejected"]);
  });

  it("refuses the batch on an unusable edit rather than approving the rest around it", async () => {
    const good = await seedProposal("best localization tools");
    const bad = await seedProposal("localization tools pricing");

    const form = new FormData();
    form.append("approve", good.id);
    form.append("approve", bad.id);
    form.set(`text:${bad.id}`, "which tool is best? and what does it cost?");

    expect(await approveProposalsAction(form)).toEqual({ ok: false, error: "Ask one question per prompt." });
    // Nothing was written: a partial commit would leave the reviewer unable to
    // tell which half of their batch landed.
    const rows = await db
      .select()
      .from(aiVisibilityPrompts)
      .where(eq(aiVisibilityPrompts.tenantId, currentTenantId));
    expect(rows.every((row) => row.status === "proposed")).toBe(true);
  });

  it("ignores a text: field for a row that is not being approved", async () => {
    const keep = await seedProposal("best localization tools");
    const dropped = await seedProposal("localization tools pricing");

    const form = new FormData();
    form.append("approve", keep.id);
    form.append("reject", dropped.id);
    // A stale edit box for a row the reviewer then unchecked. It must not be
    // validated (and refuse the batch) nor written to a rejected row.
    form.set(`text:${dropped.id}`, `${"word ".repeat(30)}`);

    expect(await approveProposalsAction(form)).toMatchObject({ ok: true, approved: 1, rejected: 1 });
    const [row] = await db.select().from(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.id, dropped.id));
    expect(row.text).toBe("localization tools pricing");
  });

  it("turns the cap into an instruction with a number, not a wall", async () => {
    await db.insert(aiVisibilityPrompts).values(
      Array.from({ length: MAX_ACTIVE_PROMPTS - 1 }, (_, index) => ({
        tenantId: currentTenantId,
        text: `active prompt number ${index}`,
        intent: "discovery" as const,
        origin: "generated" as const,
        status: "active" as const,
      }))
    );
    const first = await seedProposal("best localization tools");
    const second = await seedProposal("localization tools pricing");
    const third = await seedProposal("versional pricing");

    const form = new FormData();
    for (const proposal of [first, second, third]) form.append("approve", proposal.id);

    expect(await approveProposalsAction(form)).toEqual({
      ok: false,
      error: `That would pass the ${MAX_ACTIVE_PROMPTS} active prompt limit — uncheck 2 more.`,
    });
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

  it("refuses a state that is not a boolean rather than guessing which way to flip", async () => {
    const prompt = await seedProposal("best localization tools");

    expect(await togglePromptAction(prompt.id, "true")).toEqual({ ok: false, error: "Unknown state." });
    const [row] = await db.select().from(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.id, prompt.id));
    expect(row.status).toBe("proposed");
  });

  it("reports resuming past the cap as the instruction, not as a silent no-op", async () => {
    await db.insert(aiVisibilityPrompts).values(
      Array.from({ length: MAX_ACTIVE_PROMPTS }, (_, index) => ({
        tenantId: currentTenantId,
        text: `active prompt number ${index}`,
        intent: "discovery" as const,
        origin: "generated" as const,
        status: "active" as const,
      }))
    );
    const paused = await seedProposal("best localization tools");
    await db.update(aiVisibilityPrompts).set({ status: "paused" }).where(eq(aiVisibilityPrompts.id, paused.id));

    expect(await togglePromptAction(paused.id, true)).toEqual({
      ok: false,
      error: `You're at the ${MAX_ACTIVE_PROMPTS} active prompt limit. Pause one first.`,
    });
    const [row] = await db.select().from(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.id, paused.id));
    expect(row.status).toBe("paused");
  });

  it("never acts on another tenant's prompt, and says only 'Unknown prompt.'", async () => {
    const other = await seedTenant(`${TENANT} Foreign`);
    const [foreign] = await db
      .insert(aiVisibilityPrompts)
      .values({ tenantId: other.id, text: "not ours", intent: "discovery", origin: "generated", status: "active" })
      .returning();

    expect(await togglePromptAction(foreign.id, false)).toEqual({ ok: false, error: "Unknown prompt." });
    expect(await deletePromptAction(foreign.id)).toEqual({ ok: false, error: "Unknown prompt." });

    const [row] = await db.select().from(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.id, foreign.id));
    expect(row.status).toBe("active");
    await dropTenant(`${TENANT} Foreign`);
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

  it("drives the run after the response, without waiting for the daily cron", async () => {
    expect(await runNowAction()).toEqual({ ok: true, runId: "run-1" });
    // Nothing has run yet — `after` defers past the response flush, so the
    // human is never kept waiting on 270 engine calls.
    expect(driveRun).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);

    await afterCallbacks[0]();

    expect(driveRun).toHaveBeenCalledTimes(1);
    expect(driveRun.mock.calls[0][0]).toBe("run-1");
    const opts = driveRun.mock.calls[0][1];
    // The slice ceiling has to sit under the total, or the loop gets one slice
    // and a finalize instead of the four it is budgeted for.
    expect(opts.sliceBudgetMs).toBeLessThan(opts.totalBudgetMs);
    expect(opts.finalizeMinBudgetMs).toBeGreaterThan(0);
    expect(typeof opts.concurrency).toBe("number");
    expect(typeof opts.now).toBe("function");
  });

  it("schedules no background work for a refused run", async () => {
    planRun.mockResolvedValueOnce({ ok: false, reason: "disabled" } as never);
    await runNowAction();
    expect(afterCallbacks).toHaveLength(0);
  });

  // "the background callback never throws" moved with the loop: `driveRun`
  // swallows and logs, and resume.test.ts asserts it against the real function
  // rather than against a mock that could only ever prove itself.
});

describe("resumeRunAction", () => {
  it("drives the stalled run the guard handed back, and revalidates both surfaces", async () => {
    expect(await resumeRunAction()).toEqual({ ok: true, runId: "run-1" });
    // Derived server-side from the session's tenant — no run id from a client,
    // for the same reason "Run now" and "Stop" take none.
    expect(findResumableRun.mock.calls[0][0]).toBe(currentTenantId);
    expect(revalidatePath).toHaveBeenCalledWith("/ai-visibility");
    expect(revalidatePath).toHaveBeenCalledWith("/company");

    expect(driveRun).not.toHaveBeenCalled();
    await afterCallbacks[0]();
    expect(driveRun.mock.calls[0][0]).toBe("run-1");
  });

  it("refuses when nothing is in flight, and schedules no work", async () => {
    findResumableRun.mockResolvedValueOnce({ ok: false, reason: "not_in_flight" });

    expect(await resumeRunAction()).toEqual({ ok: false, error: "No run is in progress." });
    expect(afterCallbacks).toHaveLength(0);
  });

  it("refuses a run somebody is already driving — a second driver buys the same samples twice", async () => {
    findResumableRun.mockResolvedValueOnce({ ok: false, reason: "lease_held" });

    expect(await resumeRunAction()).toEqual({
      ok: false,
      error: "This run is already being worked on — give it a minute.",
    });
    expect(afterCallbacks).toHaveLength(0);
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

describe("cancelRunAction", () => {
  it("derives the run from the session tenant and never from the caller", async () => {
    // The same rule `runNowAction` follows: no id crosses the wire, so there is
    // nothing for a client to substitute with another tenant's run.
    expect(await cancelRunAction()).toEqual({ ok: true, runId: "run-1", completedCalls: 41 });
    expect(cancelRun).toHaveBeenCalledTimes(1);
    expect(cancelRun.mock.calls[0][0]).toBe(currentTenantId);
    expect(typeof cancelRun.mock.calls[0][1].now).toBe("function");
  });

  it("revalidates both surfaces that show run state", async () => {
    await cancelRunAction();
    expect(revalidatePath).toHaveBeenCalledWith("/ai-visibility");
    expect(revalidatePath).toHaveBeenCalledWith("/company");
  });

  it("refuses cleanly when there is nothing in flight", async () => {
    // The run finished, or another tab already stopped it, between the render
    // that drew the button and the click on it.
    cancelRun.mockResolvedValueOnce({ ok: false, reason: "not_in_flight" });

    expect(await cancelRunAction()).toEqual({ ok: false, error: "No run is in progress." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
