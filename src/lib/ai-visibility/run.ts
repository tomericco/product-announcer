import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import {
  aiVisibilityPrompts,
  aiVisibilityRuns,
  aiVisibilitySamples,
  sources,
  type AiVisibilityRun,
} from "@/db/schema";
import { getAiVisibilitySettings, ensureAiVisibilitySource } from "@/lib/ai-visibility/settings";
import { computeAggregates } from "@/lib/ai-visibility/aggregate";
import { capExceeded } from "@/lib/ai-visibility/cost";
import { ENGINE_CLIENTS } from "@/lib/ai-visibility/engines";
import { extractSample, loadBrandTargets, type ExtractSampleDeps } from "@/lib/ai-visibility/extract";
import { judgeRun } from "@/lib/ai-visibility/judge";
import { mapWithConcurrency } from "@/lib/concurrency";
import type { EngineClient, EngineId } from "@/lib/ai-visibility/types";

/** Injected wall clock. Read repeatedly, never captured once — slices budget on it. */
export type Clock = () => Date;

export type RunDeps = {
  database?: typeof defaultDb;
  /** Overrides for `ENGINE_CLIENTS`. Tests always inject; nothing here reaches the network otherwise. */
  engines?: Partial<Record<EngineId, EngineClient>>;
  /** Redirect resolution's network seam, passed through to extraction. */
  fetchImpl?: typeof fetch;
  /** Injected only by tests that assert the slice does not extract; production always uses the real one. */
  extract?: (sampleId: string, deps?: ExtractSampleDeps) => Promise<void>;
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
  const extract = deps.extract ?? extractSample;
  // Loaded ONCE per slice: extraction needs the same brand aliases for every
  // row, and re-reading three tables per sample would be ~1,400 identical
  // queries on a 360-call run. `extractSample`'s standalone default still
  // re-reads, for the operator "re-extract after an alias fix" path.
  const brandContext = await loadBrandTargets(run.tenantId, database);
  // Shared across the slice: a Gemini grounding handle cited by many samples
  // resolves over the network once, not once per citation.
  const redirectCache = new Map<string, string>();
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
            raw: { engine: result.raw, citations: result.citations } as Record<string, unknown>,
            costUsd: result.costUsd,
            error: null,
            askedAt: opts.now(),
          })
          .where(eq(aiVisibilitySamples.id, row.id));

        // Extraction is part of answering, not of finalizing: a run that never
        // reaches finalizeRun (budget, cap, a dead cron) still has usable
        // mention data, and the answer text is already in hand exactly once.
        await extract(row.id, { database, brandContext, redirectCache, fetchImpl: deps.fetchImpl });

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

export type FinalizeDeps = RunDeps & {
  judge?: typeof judgeRun;
  aggregate?: typeof computeAggregates;
  emit?: (
    runId: string,
    opts: { now: Clock },
    deps?: { database?: typeof defaultDb }
  ) => Promise<{ written: number; considered: number }>;
};

/**
 * Per-engine failure summary for the source row's `lastError`.
 *
 * Reads like the news agent's partial-failure line, and for the same reason: a
 * run where Perplexity rate-limited nine prompts did its job, and the operator
 * needs the sentence rather than a red badge.
 */
async function engineFailureSummary(
  database: typeof defaultDb,
  runId: string
): Promise<{ message: string | null; okSamples: number; totalSamples: number }> {
  const rows = await database
    .select({
      engine: aiVisibilitySamples.engine,
      status: aiVisibilitySamples.status,
      error: aiVisibilitySamples.error,
    })
    .from(aiVisibilitySamples)
    .where(eq(aiVisibilitySamples.runId, runId));

  const byEngine = new Map<string, { total: number; failed: number; lastError: string | null }>();
  let okSamples = 0;
  for (const row of rows) {
    const entry = byEngine.get(row.engine) ?? { total: 0, failed: 0, lastError: null };
    entry.total += 1;
    if (row.status === "ok") okSamples += 1;
    else {
      entry.failed += 1;
      if (row.error) entry.lastError = row.error;
    }
    byEngine.set(row.engine, entry);
  }

  const parts: string[] = [];
  for (const [engine, entry] of byEngine) {
    if (entry.failed === 0) continue;
    parts.push(
      `${engine} failed on ${entry.failed} of ${entry.total} calls${entry.lastError ? ` — ${entry.lastError}` : ""}`
    );
  }

  return {
    message: parts.length > 0 ? parts.join("; ") : null,
    okSamples,
    totalSamples: rows.length,
  };
}

/**
 * Records the outcome of a run on the `sources` row.
 *
 * Copied from `news-agent.ts`'s `finish()` deliberately, including its ruling:
 * `productive` — not "were there any errors" — decides the badge, so the shared
 * `SourceStatusBadge` means the same thing on the AI-visibility card as on the
 * news card. `failing` is advisory, never terminal; only a human setting
 * `disabled` retires a source.
 */
async function finish(
  database: typeof defaultDb,
  sourceId: string | null,
  now: Date,
  error: string | null,
  productive: boolean
): Promise<void> {
  if (!sourceId) return;
  await database
    .update(sources)
    .set({
      lastRunAt: now,
      lastSuccessAt: productive ? now : undefined,
      lastError: error,
      status: productive ? "active" : "failing",
    })
    .where(eq(sources.id, sourceId));
}

/**
 * Closes out a run whose samples are all answered.
 *
 * Order is load-bearing and asserted by the tests: judge, then aggregate, then
 * emit signals, then mark complete. Aggregates read the judge's `recommended`
 * level and its `flagged` rows, and signals read the aggregates — running any
 * of them early produces numbers that are quietly wrong rather than absent.
 *
 * Resumable at the judge step only. If the judge budget runs out the run stays
 * `running` and nothing downstream happens, because a partial judge pass would
 * make `n` smaller than it really is and every rate correspondingly noisier —
 * and those aggregates are then the permanent record for that run.
 *
 * Never throws. A run is a scheduled background job; a failure has to land on
 * the run row and the source badge where a human can see it, not in a cron log.
 */
export async function finalizeRun(
  runId: string,
  opts: { budgetMs: number; now: Clock },
  deps: FinalizeDeps = {}
): Promise<{ status: "complete" | "running" | "failed"; judged: number; signals: number }> {
  const database = deps.database ?? defaultDb;
  const judge = deps.judge ?? judgeRun;
  const aggregate = deps.aggregate ?? computeAggregates;
  // Stubbed until Task F2 lands; Step 4 below replaces the default with the
  // real `emitSignals`.
  const emit = deps.emit ?? (async () => ({ written: 0, considered: 0 }));

  const [run] = await database.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
  if (!run) return { status: "failed", judged: 0, signals: 0 };
  // Finalizing twice would emit a second set of signals for the same run. The
  // externalId dedupe would absorb most of them, but "most" is not a guarantee
  // worth relying on when the check is one comparison.
  if (run.status === "complete") return { status: "complete", judged: 0, signals: 0 };

  try {
    const judged = await judge(runId, { budgetMs: opts.budgetMs, now: opts.now }, { database });
    if (judged.remaining > 0) {
      // Deliberately leaves the run `running`: the next cron tick — or an
      // earlier manual "Run now", which also drives in-flight runs — resumes
      // here.
      return { status: "running", judged: judged.judged, signals: 0 };
    }

    await aggregate(runId, database);
    const emitted = await emit(runId, { now: opts.now }, { database });

    const summary = await engineFailureSummary(database, runId);
    const errorText = [summary.message, ...judged.errors].filter(Boolean).join("; ") || null;

    await database
      .update(aiVisibilityRuns)
      .set({ status: "complete", finishedAt: opts.now(), error: errorText })
      .where(eq(aiVisibilityRuns.id, runId));

    // Productive = the run got at least one usable answer. A run where every
    // engine failed is genuinely `failing`; one where three of four answered is
    // not, however loud its lastError.
    await finish(database, run.sourceId, opts.now(), errorText, summary.okSamples > 0);

    return { status: "complete", judged: judged.judged, signals: emitted.written };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await database
        .update(aiVisibilityRuns)
        .set({ status: "failed", error: message, finishedAt: opts.now() })
        .where(eq(aiVisibilityRuns.id, runId));
      await finish(database, run.sourceId, opts.now(), message, false);
    } catch (secondary) {
      console.error(`[ai-visibility] could not record finalize failure for run ${runId}:`, secondary);
    }
    return { status: "failed", judged: 0, signals: 0 };
  }
}

/**
 * The tenant's most recent run, whatever its status.
 *
 * Any status on purpose: the overview header has to render "Running… 41 / 360
 * calls" and "Paused — monthly cap reached" off this row, and filtering to
 * `complete` would make both states invisible on the one page that exists to
 * show them.
 */
export async function latestRun(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<AiVisibilityRun | null> {
  const [run] = await database
    .select()
    .from(aiVisibilityRuns)
    .where(eq(aiVisibilityRuns.tenantId, tenantId))
    .orderBy(desc(aiVisibilityRuns.startedAt))
    .limit(1);
  return run ?? null;
}
