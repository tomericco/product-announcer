import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { aiVisibilityPrompts, aiVisibilityRuns, aiVisibilitySamples, sources } from "@/db/schema";
import { getAiVisibilitySettings, ensureAiVisibilitySource } from "@/lib/ai-visibility/settings";
import { capExceeded } from "@/lib/ai-visibility/cost";
import { ENGINE_CLIENTS } from "@/lib/ai-visibility/engines";
import { mapWithConcurrency } from "@/lib/concurrency";
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

export type RunSliceResult = {
  processed: number;
  remaining: number;
  budgetSpent: boolean;
  pausedByCap: boolean;
};

/** How many pending rows one batch claims. One batch is one full concurrency wave. */
function batchSize(concurrency: number): number {
  return Math.max(1, concurrency);
}

/**
 * Spends part of a run's work list, bounded by wall clock.
 *
 * The whole point of slicing is that one cron tick has a deadline and a run has
 * up to 360 engine calls in it. Everything survivable is recorded rather than
 * thrown: an engine that refuses, errors, or hangs up costs its own sample row
 * a status and nothing else. The slice returns what it did so the caller can
 * decide whether to finalize now or come back next tick.
 *
 * The clock is read before every batch, not once — that is what makes the
 * budget testable against a fake clock and honest against a slow engine.
 */
export async function runSlice(
  runId: string,
  opts: { budgetMs: number; concurrency: number; now: Clock },
  deps: RunDeps = {}
): Promise<RunSliceResult> {
  const database = deps.database ?? defaultDb;
  const clients: Record<string, EngineClient | undefined> = { ...ENGINE_CLIENTS, ...(deps.engines ?? {}) };
  const startedAt = opts.now().getTime();

  const [run] = await database.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
  if (!run || !IN_FLIGHT.includes(run.status)) {
    return { processed: 0, remaining: 0, budgetSpent: false, pausedByCap: false };
  }
  if (run.status === "pending") {
    await database.update(aiVisibilityRuns).set({ status: "running" }).where(eq(aiVisibilityRuns.id, runId));
  }

  const settings = await getAiVisibilitySettings(run.tenantId, database);
  const modelIds: Record<string, string> = { ...(run.modelIds ?? {}) };
  let processed = 0;
  let budgetSpent = false;
  let pausedByCap = false;

  while (true) {
    if (opts.now().getTime() - startedAt >= opts.budgetMs) {
      budgetSpent = true;
      break;
    }

    // Re-checked between batches, not just before the run: an engine that costs
    // more than estimated must not be able to run past the cap for the rest of
    // the work list. `reached`, not `exceeded` — see cost.ts.
    const cap = await capExceeded(run.tenantId, settings, opts.now(), database);
    if (cap.reached) {
      pausedByCap = true;
      break;
    }

    const batch = await database
      .select({
        id: aiVisibilitySamples.id,
        engine: aiVisibilitySamples.engine,
        promptText: aiVisibilityPrompts.text,
      })
      .from(aiVisibilitySamples)
      .innerJoin(aiVisibilityPrompts, eq(aiVisibilitySamples.promptId, aiVisibilityPrompts.id))
      .where(and(eq(aiVisibilitySamples.runId, runId), eq(aiVisibilitySamples.status, "pending")))
      // Stable order so a resumed run is deterministic and a starved tail is a
      // policy rather than an accident of the planner.
      .orderBy(asc(aiVisibilitySamples.id))
      .limit(batchSize(opts.concurrency));

    if (batch.length === 0) break;

    const results = await mapWithConcurrency(batch, batchSize(opts.concurrency), async (row) => {
      const failed = { costUsd: 0, engine: row.engine, modelId: null as string | null };
      try {
        const client = clients[row.engine];
        if (!client) {
          await database
            .update(aiVisibilitySamples)
            .set({ status: "error", error: `no client for engine "${row.engine}"`, askedAt: opts.now() })
            .where(eq(aiVisibilitySamples.id, row.id));
          return failed;
        }

        const result = await client.ask(row.promptText);

        // `EngineError` is the only branch carrying `kind`; `EngineAnswer` has none.
        if ("kind" in result) {
          // A failure is not free. A refusal, or an answer truncated at the
          // token ceiling, ran the model to completion and is billed in full,
          // and the client reports that as `costUsd` when the provider told it
          // enough to say. Undefined means UNKNOWN, not zero — we bank what we
          // know rather than pretending the sample was free, which is the only
          // direction of error the cap can survive.
          const knownCost = result.costUsd ?? 0;
          await database
            .update(aiVisibilitySamples)
            .set({
              status: result.kind === "refused" ? "refused" : "error",
              error: result.message,
              costUsd: knownCost,
              askedAt: opts.now(),
            })
            .where(eq(aiVisibilitySamples.id, row.id));
          return { costUsd: knownCost, engine: row.engine, modelId: null };
        }

        await database
          .update(aiVisibilitySamples)
          .set({
            status: "ok",
            answerText: result.text,
            modelId: result.modelId,
            searchUsed: result.searchUsed,
            searchQueries: result.searchQueries,
            raw: result.raw as Record<string, unknown>,
            costUsd: result.costUsd,
            error: null,
            askedAt: opts.now(),
          })
          .where(eq(aiVisibilitySamples.id, row.id));

        return { costUsd: result.costUsd, engine: row.engine, modelId: result.modelId };
      } catch (error) {
        // Per-row try/catch: one hostile or broken engine response must not cost
        // the other 359 samples their slice.
        try {
          await database
            .update(aiVisibilitySamples)
            .set({ status: "error", error: String(error), askedAt: opts.now() })
            .where(eq(aiVisibilitySamples.id, row.id));
        } catch {
          // The row stays pending and is retried next slice. Nothing better to do.
        }
        return failed;
      }
    });

    processed += results.length;
    const batchCost = results.reduce((sum, r) => sum + r.costUsd, 0);
    for (const r of results) if (r.modelId) modelIds[r.engine] = r.modelId;

    await database
      .update(aiVisibilityRuns)
      .set({
        completedCalls: sql`${aiVisibilityRuns.completedCalls} + ${results.length}`,
        costUsd: sql`${aiVisibilityRuns.costUsd} + ${batchCost}`,
        // Design §"Model-version annotation": the run remembers which model each
        // engine actually answered with, so a jump can be annotated rather than
        // mistaken for a change in visibility.
        modelIds,
      })
      .where(eq(aiVisibilityRuns.id, runId));
  }

  const [pending] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(aiVisibilitySamples)
    .where(and(eq(aiVisibilitySamples.runId, runId), eq(aiVisibilitySamples.status, "pending")));
  const remaining = pending?.count ?? 0;

  if (pausedByCap) {
    const cap = await capExceeded(run.tenantId, settings, opts.now(), database);
    const message = `Paused — monthly cap reached ($${cap.spentUsd.toFixed(2)} of $${cap.capUsd.toFixed(2)}).`;
    await database
      .update(aiVisibilityRuns)
      .set({ status: "paused_by_cap", error: message, finishedAt: opts.now() })
      .where(eq(aiVisibilityRuns.id, runId));
    if (run.sourceId) {
      // Design decision: a hard pause is visible in the same health block every
      // other source uses, not only inside the run row.
      await database
        .update(sources)
        .set({ status: "failing", lastError: message, lastRunAt: opts.now() })
        .where(eq(sources.id, run.sourceId));
    }
  }

  return { processed, remaining, budgetSpent, pausedByCap };
}
