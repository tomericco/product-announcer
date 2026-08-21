import { and, eq, inArray } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { aiVisibilityPrompts, aiVisibilityRuns, aiVisibilitySamples } from "@/db/schema";
import { getAiVisibilitySettings, ensureAiVisibilitySource } from "@/lib/ai-visibility/settings";
import { capExceeded } from "@/lib/ai-visibility/cost";
import type { EngineClient, EngineId } from "@/lib/ai-visibility/types";

/** Injected wall clock. Read repeatedly, never captured once — slices budget on it. */
export type Clock = () => Date;

export type RunDeps = {
  database?: typeof defaultDb;
  /** Overrides for `ENGINE_CLIENTS`. Tests always inject; nothing here reaches the network otherwise. */
  engines?: Partial<Record<EngineId, EngineClient>>;
};

export type PlanRunRefusal =
  | { ok: false; reason: "disabled" }
  | { ok: false; reason: "no_prompts" }
  | { ok: false; reason: "run_in_flight"; runId: string }
  | { ok: false; reason: "no_engines" }
  | { ok: false; reason: "cap_reached"; spentUsd: number; estimateUsd: number; capUsd: number };

export type PlanRunResult =
  | { ok: true; runId: string; plannedCalls: number; estimateUsd: number }
  | PlanRunRefusal;

/**
 * Sample rows are inserted in chunks so one plan cannot exceed the driver's
 * bind-parameter ceiling. 30 prompts x 4 engines x 3 samples is 360 rows and
 * roughly a dozen columns each — comfortably over 5,000 parameters in one
 * statement, which is the wrong thing to discover on a tenant's first run.
 */
const SAMPLE_INSERT_CHUNK = 200;

/** Statuses that mean "a run is already in flight for this tenant". */
const IN_FLIGHT: string[] = ["pending", "running"];

/**
 * Plans one run: every guard, then the run row and every `pending` sample row.
 *
 * Nothing here calls an engine. Planning is cheap and synchronous so the "Run
 * now" dialog can report a real `plannedCalls` immediately, and so a cron tick
 * that dies mid-slice leaves a complete, resumable work list behind rather than
 * a half-enumerated one. `runSlice` is the only thing that spends money.
 *
 * Returns a discriminated refusal instead of throwing: every refusal is a
 * reason a human needs to read on the Run-now button, and the sweep records
 * them on the source row.
 */
export async function planRun(
  tenantId: string,
  opts: { trigger: "scheduled" | "manual"; now: Clock },
  deps: RunDeps = {}
): Promise<PlanRunResult> {
  const database = deps.database ?? defaultDb;
  const now = opts.now();

  const settings = await getAiVisibilitySettings(tenantId, database);
  if (!settings.enabled) return { ok: false, reason: "disabled" };

  // `getAiVisibilitySettings` already coerces `engines` to `EngineId[]`, so this
  // is a length check, not a validation pass. The guard exists because a tenant
  // CAN turn every engine off in settings, and a run with no engines would plan
  // zero samples and then "finish" instantly with an empty dashboard.
  const engines = settings.engines;
  if (engines.length === 0) return { ok: false, reason: "no_engines" };

  const prompts = await database
    .select({
      id: aiVisibilityPrompts.id,
      intent: aiVisibilityPrompts.intent,
    })
    .from(aiVisibilityPrompts)
    .where(and(eq(aiVisibilityPrompts.tenantId, tenantId), eq(aiVisibilityPrompts.status, "active")));
  if (prompts.length === 0) return { ok: false, reason: "no_prompts" };

  const [inFlight] = await database
    .select({ id: aiVisibilityRuns.id })
    .from(aiVisibilityRuns)
    .where(and(eq(aiVisibilityRuns.tenantId, tenantId), inArray(aiVisibilityRuns.status, IN_FLIGHT)))
    .limit(1);
  if (inFlight) return { ok: false, reason: "run_in_flight", runId: inFlight.id };

  const cap = await capExceeded(tenantId, settings, now, database);
  if (cap.exceeded) {
    return {
      ok: false,
      reason: "cap_reached",
      spentUsd: cap.spentUsd,
      estimateUsd: cap.estimateUsd,
      capUsd: cap.capUsd,
    };
  }

  // Built before the run row so `plannedCalls` is exact at insert time rather
  // than patched in afterwards — the header reads "41 / 360 calls" off it, and a
  // run that briefly claims 0 planned calls renders as finished.
  const rows: (typeof aiVisibilitySamples.$inferInsert)[] = [];
  for (const prompt of prompts) {
    // Design §"Engines & run mechanics": brand-check prompts run once. They are
    // excluded from every rate anyway, so extra samples buy nothing but spend.
    const samples = prompt.intent === "brand_check" ? 1 : settings.samplesPerPrompt;
    for (const engine of engines) {
      for (let sampleIndex = 0; sampleIndex < samples; sampleIndex++) {
        rows.push({ runId: "", tenantId, promptId: prompt.id, engine, sampleIndex, status: "pending" });
      }
    }
  }

  const source = await ensureAiVisibilitySource(tenantId, database);

  const [run] = await database
    .insert(aiVisibilityRuns)
    .values({
      tenantId,
      sourceId: source.id,
      status: "pending",
      trigger: opts.trigger,
      engines,
      samplesPerPrompt: settings.samplesPerPrompt,
      plannedCalls: rows.length,
      startedAt: now,
    })
    .returning();

  for (let i = 0; i < rows.length; i += SAMPLE_INSERT_CHUNK) {
    await database
      .insert(aiVisibilitySamples)
      .values(rows.slice(i, i + SAMPLE_INSERT_CHUNK).map((r) => ({ ...r, runId: run.id })));
  }

  return { ok: true, runId: run.id, plannedCalls: rows.length, estimateUsd: cap.estimateUsd };
}
