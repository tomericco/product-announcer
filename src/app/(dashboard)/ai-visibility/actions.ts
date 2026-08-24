"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireSession } from "@/lib/workspace/session";
import {
  MAX_ACTIVE_PROMPTS,
  approveProposals,
  createPrompt,
  deletePrompt,
  editPrompt,
  pausePrompt,
  resumePrompt,
} from "@/lib/ai-visibility/prompts";
// `countActivePrompts` is deliberately NOT imported here: every cap check
// lives inside the core call that would breach it, so this file cannot
// check-then-write across an await and let two tabs both squeeze past 30.
import { generatePromptSet } from "@/lib/ai-visibility/generate-prompts";
import { cancelRun, driveRun, findResumableRun, planRun } from "@/lib/ai-visibility/run";
import { getAiVisibilitySettings } from "@/lib/ai-visibility/settings";
import { PROMPT_INTENTS, type PromptIntent } from "@/lib/ai-visibility/types";

/**
 * Every action's return shape: a discriminated union, never a throw.
 *
 * The default payload is `unknown` rather than the plan's `Record<string,
 * never>` — that type carries an index signature whose values must be `never`,
 * so `{ ok: true } & Record<string, never>` is uninhabited and even a bare
 * `return { ok: true }` fails to type-check.
 */
export type ActionResult<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// "Run now" drives the run inside this invocation, after the response has
// flushed. ~240s total keeps comfortably inside the platform's function
// ceiling; whatever is left over stays `running` and the daily sweep — which
// resumes in-flight runs on any day — completes it.
const RUN_NOW_TOTAL_BUDGET_MS = 240_000;
const RUN_NOW_SLICE_BUDGET_MS = 60_000;
const RUN_NOW_FINALIZE_MIN_MS = 10_000;
/**
 * The FALLBACK, used only when the tenant's own setting cannot be read.
 *
 * The knob is `ai_visibility_settings.concurrency`, defaulting to 3 — see
 * `SWEEP_CONCURRENCY` in `sweep.ts` for the TPM arithmetic that makes 12
 * unsafe for a new provider account. This constant used to BE that default and
 * is kept only so an operator has a lever if the read fails.
 *
 * `positiveNumberFromEnv`-style parsing rather than bare `Number()`: an empty
 * `AI_VISIBILITY_CONCURRENCY=` is `Number("") === 0`, and a concurrency of 0
 * makes `batchSize` clamp to 1 — a 270-call run served one at a time.
 */
function fallbackConcurrency(): number {
  const parsed = Number(process.env.AI_VISIBILITY_CONCURRENCY);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
}

/** The tenant's own setting, or the fallback if the row cannot be read. */
async function concurrencyFor(tenantId: string): Promise<number> {
  try {
    return (await getAiVisibilitySettings(tenantId)).concurrency;
  } catch {
    return fallbackConcurrency();
  }
}

/** Both surfaces show prompt state, so every write revalidates both. */
function revalidateAll() {
  revalidatePath("/ai-visibility");
  revalidatePath("/ai-visibility/prompts");
}

function uuidOrNull(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

/**
 * The prompt-text rules the design calls "bad-prompt checks", enforced at
 * the only point a human can type one. The generator applies the same rules
 * to its own output; this is the manual path's copy of them, deliberately
 * duplicated rather than imported, because `generate-prompts` is a model
 * module and this action must stay cheap.
 */
function validatePromptText(raw: unknown): { ok: true; text: string } | { ok: false; error: string } {
  const text = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!text) return { ok: false, error: "Write the prompt first." };
  if (text.split(" ").length > 25) {
    return { ok: false, error: "Keep it under 25 words — long prompts measure noise." };
  }
  if ((text.match(/\?/g) ?? []).length > 1) {
    return { ok: false, error: "Ask one question per prompt." };
  }
  return { ok: true, text };
}

function parseIntent(raw: unknown): PromptIntent | null {
  return typeof raw === "string" && (PROMPT_INTENTS as readonly string[]).includes(raw)
    ? (raw as PromptIntent)
    : null;
}

/**
 * Drafts a proposed prompt set from the company profile. Costs one model
 * call, which is why it is a click and never a page load (design: "Generation
 * happens on click (it costs a call)").
 */
export async function generatePromptSetAction(): Promise<ActionResult<{ proposed: number }>> {
  const session = await requireSession();
  try {
    // `generatePromptSet` persists the proposals itself and hands them back,
    // so this counts what actually landed rather than the batch size it
    // asked for — a partially-parsed model response writes fewer.
    const result = await generatePromptSet(session.user.tenantId);
    if (!result.ok) {
      if (result.error === "disabled") {
        return { ok: false, error: "Add a category and positioning on Company first." };
      }
      if (result.error === "cap") {
        return { ok: false, error: `You're at the ${MAX_ACTIVE_PROMPTS} active prompt limit. Pause one first.` };
      }
      // `result.message` is the provider's own — a 429 or a parse error.
      // Deliberately not surfaced: it is not actionable, and the design's
      // story 1 asks only that the empty state stay put and retry work.
      return { ok: false, error: "Couldn't draft prompts just now — try again." };
    }
    revalidateAll();
    return { ok: true, proposed: result.proposals.length };
  } catch {
    return { ok: false, error: "Couldn't draft prompts just now — try again." };
  }
}

/**
 * Commits one batch review: checked rows become active (with any inline edit
 * applied), unchecked ones are stored as `rejected` so the next generation
 * gets them as negatives. Batch-with-exclusions, not one-by-one — 30
 * individual accepts is the complaint the design is answering.
 *
 * FormData shape: repeated `approve` and `reject` fields carrying prompt ids,
 * plus optional `text:<id>` fields carrying an edited wording.
 */
export async function approveProposalsAction(
  formData: FormData
): Promise<ActionResult<{ approved: number; rejected: number }>> {
  const session = await requireSession();

  const approveIds = formData.getAll("approve").map(uuidOrNull).filter((id): id is string => id !== null);
  const rejectIds = formData.getAll("reject").map(uuidOrNull).filter((id): id is string => id !== null);

  const edits: { promptId: string; text: string }[] = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("text:")) continue;
    const promptId = uuidOrNull(key.slice("text:".length));
    if (!promptId || !approveIds.includes(promptId)) continue;
    const checked = validatePromptText(value);
    if (!checked.ok) return checked;
    edits.push({ promptId, text: checked.text });
  }

  if (approveIds.length === 0 && rejectIds.length === 0) {
    return { ok: false, error: "Nothing selected." };
  }

  // `approveProposals` is tenant-scoped, so an id belonging to another
  // tenant simply matches no row rather than being an error to report —
  // the same undistinguished handling `readSignalEvidence` documents. The
  // cap is re-checked inside it too; its `available`/`requested` are what
  // turn the refusal into an instruction instead of a wall.
  const result = await approveProposals(session.user.tenantId, {
    approveIds,
    rejectIds,
    edits,
    approvedBy: session.user.id,
  });
  if (!result.ok) {
    if (result.error === "cap") {
      return {
        ok: false,
        error: `That would pass the ${MAX_ACTIVE_PROMPTS} active prompt limit — uncheck ${
          result.requested - result.available
        } more.`,
      };
    }
    // A retyped wording can collide with a prompt the tenant already has —
    // a real outcome of editing in the review list, and a different problem
    // from "that isn't a usable prompt", so it gets its own sentence.
    return {
      ok: false,
      error:
        result.error === "duplicate"
          ? "One of your edits matches a prompt you already have."
          : "One of your edits isn't a usable prompt — check the wording.",
    };
  }
  revalidateAll();
  return { ok: true, approved: result.approved, rejected: result.rejected };
}

/**
 * Creates a prompt, or supersedes one.
 *
 * Editing wording NEVER updates in place: `editPrompt` creates a new row
 * with `supersedesId` set and pauses the old one, because the twelve weeks
 * of history behind the old wording are not history of the new question. The
 * editor shows that as a note before the human commits. `editPrompt` takes
 * only the text for the same reason — intent/persona/competitor describe the
 * question, and a different question is a different prompt.
 */
export async function savePromptAction(
  formData: FormData
): Promise<ActionResult<{ promptId: string; superseded: boolean }>> {
  const session = await requireSession();

  const checked = validatePromptText(formData.get("text"));
  if (!checked.ok) return checked;

  const promptId = uuidOrNull(formData.get("promptId"));

  if (promptId) {
    const edited = await editPrompt(session.user.tenantId, promptId, checked.text);
    if (!edited.ok) {
      if (edited.error === "duplicate") {
        return { ok: false, error: "You already have a prompt with that wording." };
      }
      if (edited.error === "invalid") return { ok: false, error: "Write the prompt first." };
      return { ok: false, error: "Unknown prompt." };
    }
    revalidateAll();
    // Compared, not assumed: `editPrompt` normalizes whitespace and treats a
    // whitespace-only change as a no-op, returning the SAME row. Reporting
    // "replaced" there would send someone hunting for a second prompt that
    // was never created.
    return { ok: true, promptId: edited.prompt.id, superseded: edited.prompt.id !== promptId };
  }

  const intent = parseIntent(formData.get("intent"));
  if (!intent) return { ok: false, error: "Pick an intent for this prompt." };

  const personaRaw = formData.get("persona");
  const persona = typeof personaRaw === "string" && personaRaw.trim() ? personaRaw.trim() : null;
  const competitorId = uuidOrNull(formData.get("competitorId"));

  const created = await createPrompt(session.user.tenantId, {
    text: checked.text,
    intent,
    persona,
    competitorId,
    origin: "user",
    status: "active",
  });
  if (!created.ok) {
    if (created.error === "cap") {
      return { ok: false, error: `You're at the ${MAX_ACTIVE_PROMPTS} active prompt limit. Pause one first.` };
    }
    if (created.error === "duplicate") {
      return { ok: false, error: "You already have a prompt with that wording." };
    }
    return { ok: false, error: "Write the prompt first." };
  }
  revalidateAll();
  return { ok: true, promptId: created.prompt.id, superseded: false };
}

/**
 * Pause/resume. Pausing keeps history and excludes the prompt from runs and
 * from current SOV; resuming can hit the active cap, which is reported as
 * the instruction rather than as a silent no-op.
 */
export async function togglePromptAction(promptId: unknown, active: unknown): Promise<ActionResult> {
  const session = await requireSession();
  const id = uuidOrNull(promptId);
  if (!id) return { ok: false, error: "Unknown prompt." };
  if (typeof active !== "boolean") return { ok: false, error: "Unknown state." };

  const result = active
    ? await resumePrompt(session.user.tenantId, id)
    : await pausePrompt(session.user.tenantId, id);
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.error === "cap"
          ? `You're at the ${MAX_ACTIVE_PROMPTS} active prompt limit. Pause one first.`
          : "Unknown prompt.",
    };
  }
  revalidateAll();
  return { ok: true };
}

/**
 * Delete, allowed only while a prompt has never been sampled. Anything with
 * runs behind it is paused instead — deleting would take twelve weeks of a
 * competitor comparison with it.
 */
export async function deletePromptAction(promptId: unknown): Promise<ActionResult> {
  const session = await requireSession();
  const id = uuidOrNull(promptId);
  if (!id) return { ok: false, error: "Unknown prompt." };

  const result = await deletePrompt(session.user.tenantId, id);
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.error === "has_samples"
          ? "This prompt has run before — pause it instead, so its history stays."
          : "Unknown prompt.",
    };
  }
  revalidateAll();
  return { ok: true };
}

/**
 * "Run now".
 *
 * Deliberately gate-free: `planRun` checks enabled, prompts, an in-flight run
 * and the cost cap atomically, and refuses with a `reason`. Re-checking any of
 * that here would be a check-then-act across an await — two tabs could both
 * pass it — and would put two sources of truth behind one button. This
 * function's job is turning each `reason` into a sentence a human can act on —
 * and, on success, driving the run it just planned.
 *
 * `no_engines` IS a reachable refusal under BYOK, and on ship day it is the
 * common one: `effectiveEngines` intersects the tenant's chosen engines with
 * the engines holding a verified key of their own and — unlike
 * `normalizeSettingsRow` — does not fall back to all three when that is empty.
 * The page renders its own empty state for this, so a reader normally never
 * meets the sentence below; it is here for the stale tab that clicks anyway.
 *
 * The run id this drives is the one `planRun` just created FOR THIS SESSION'S
 * TENANT — it is never read from a request, a form field or a URL, which is
 * what makes `runSlice(runId, …)` (tenant-blind by signature, since a run id
 * is only ever produced by a tenant-scoped plan) safe to call here. Do not add
 * a parameter to this action without adding an ownership read to match.
 *
 * The driving happens via `after()` so the response returns immediately:
 * `planRun` only inserts pending rows, and the only other caller of
 * `runSlice`/`finalizeRun` is the once-daily cron sweep — without this, a
 * manual run would sit `pending` until tomorrow 09:00 UTC under a header
 * claiming "Running…". Slices loop until the run drains, the cap pauses it,
 * or ~240s is spent; a cut-short run stays `running` and the daily sweep
 * (which resumes in-flight runs on any day) finishes it.
 */
export async function runNowAction(): Promise<ActionResult<{ runId: string }>> {
  const session = await requireSession();

  const planned = await planRun(session.user.tenantId, { trigger: "manual", now: () => new Date() });
  if (!planned.ok) {
    switch (planned.reason) {
      case "disabled":
        return { ok: false, error: "AI visibility is off — turn it on in Company." };
      case "no_engines":
        return {
          ok: false,
          error: "No AI engine keys connected — add one in Settings to start measuring.",
        };
      case "no_prompts":
        return { ok: false, error: "Approve some prompts first." };
      case "run_in_flight":
        return { ok: false, error: "A run is already in progress." };
      case "cap_reached":
        return {
          ok: false,
          error: `Monthly cap reached ($${planned.spentUsd.toFixed(2)} of $${planned.capUsd.toFixed(
            2
          )}) — raise it in Settings, or wait for next month.`,
        };
    }
  }

  const runId = planned.runId;

  // Drive the run AFTER the response, through the one drive loop "Resume"
  // also uses. `driveRun` never throws: the three run functions record their
  // own expected failures on the run row, so anything reaching its catch is
  // exceptional — logged, swallowed, and the daily sweep resumes whatever is
  // left `running`.
  const concurrency = await concurrencyFor(session.user.tenantId);
  after(() =>
    driveRun(runId, {
      totalBudgetMs: RUN_NOW_TOTAL_BUDGET_MS,
      sliceBudgetMs: RUN_NOW_SLICE_BUDGET_MS,
      finalizeMinBudgetMs: RUN_NOW_FINALIZE_MIN_MS,
      concurrency,
      now: () => new Date(),
    })
  );

  // Both surfaces show run state: the overview's header and the Company
  // card's "last ran" line.
  revalidatePath("/ai-visibility");
  revalidatePath("/company");
  return { ok: true, runId };
}

/**
 * "Stop" — halts the tenant's in-flight run.
 *
 * Takes no argument, for the same reason `runNowAction` takes none: the run is
 * derived from the session's tenant server-side, so there is no id a client
 * could substitute for somebody else's. `cancelRun` does the whole job in one
 * conditional UPDATE, which is also what makes a double-click safe — the second
 * press finds nothing in flight and says so.
 *
 * The stop is real rather than cosmetic: the driver re-reads the run's status
 * between batches, so the wave already handed to the engines lands (it is
 * bought either way) and nothing further is claimed. What ran is aggregated and
 * counted like a cap-paused run's; the rest never happens.
 */
export async function cancelRunAction(): Promise<ActionResult<{ runId: string; completedCalls: number }>> {
  const session = await requireSession();

  const result = await cancelRun(session.user.tenantId, { now: () => new Date() });
  if (!result.ok) {
    // The honest sentence for the only refusal there is: the run finished, or
    // another tab already stopped it, between the page render and this click.
    return { ok: false, error: "No run is in progress." };
  }

  // Same two surfaces `runNowAction` revalidates: the overview header and the
  // Company card's "last ran" line.
  revalidatePath("/ai-visibility");
  revalidatePath("/company");
  return { ok: true, runId: result.runId, completedCalls: result.completedCalls };
}

/**
 * "Resume" — picks a stalled run back up.
 *
 * A run whose driver ran out of budget with samples still pending stays
 * `running`, which is correct, and until this existed the ONLY thing that
 * resumed it was the 09:00 UTC sweep. So the page could show "Running…" for up
 * to a day while the partial unique index refused every new run with "A run is
 * already in progress." — indistinguishable, to the person looking at it, from
 * a run that was working.
 *
 * Takes no argument, like the other two: the run is derived from the session's
 * tenant server-side. Guarded by `findResumableRun`, which refuses a run that
 * still holds a live slice lease — a driver is already working through it, and
 * a second one would claim samples the first is paying for. That guard is the
 * same predicate the header uses to decide whether to show this button at all,
 * so the control is never offered for a run that would refuse it.
 *
 * Nothing here spends money on its own account: the work was already planned
 * and authorised, and the cap is re-checked between batches like every other
 * slice. There is no confirmation dialog for that reason.
 */
export async function resumeRunAction(): Promise<ActionResult<{ runId: string }>> {
  const session = await requireSession();

  const target = await findResumableRun(session.user.tenantId, { now: () => new Date() });
  if (!target.ok) {
    return {
      ok: false,
      error:
        target.reason === "not_in_flight"
          ? "No run is in progress."
          : // Not an error, and worth saying plainly: the run has a driver, and
            // starting a second one would buy the same samples twice.
            "This run is already being worked on — give it a minute.",
    };
  }

  const runId = target.runId;
  const concurrency = await concurrencyFor(session.user.tenantId);
  after(() =>
    driveRun(runId, {
      totalBudgetMs: RUN_NOW_TOTAL_BUDGET_MS,
      sliceBudgetMs: RUN_NOW_SLICE_BUDGET_MS,
      finalizeMinBudgetMs: RUN_NOW_FINALIZE_MIN_MS,
      concurrency,
      now: () => new Date(),
    })
  );

  revalidatePath("/ai-visibility");
  revalidatePath("/company");
  return { ok: true, runId };
}
