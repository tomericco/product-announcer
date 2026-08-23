import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { isUniqueViolation } from "@/db/errors";
import {
  aiVisibilityPrompts,
  aiVisibilityRuns,
  aiVisibilitySamples,
  sources,
  type AiVisibilityRun,
} from "@/db/schema";
import { getAiVisibilitySettings, ensureAiVisibilitySource } from "@/lib/ai-visibility/settings";
import { computeAggregates } from "@/lib/ai-visibility/aggregate";
import { capExceeded, capPausedMessage } from "@/lib/ai-visibility/cost";
import { roundUsd } from "@/lib/ai-visibility/money";
import { ENGINE_CLIENTS } from "@/lib/ai-visibility/engines";
import { extractSample, loadBrandTargets, type ExtractSampleDeps } from "@/lib/ai-visibility/extract";
import { judgeRun } from "@/lib/ai-visibility/judge";
import { emitSignals } from "@/lib/ai-visibility/signals";
import { MAX_ACTIVE_PROMPTS, RUNNABLE_ORDER } from "@/lib/ai-visibility/prompts";
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
  | { ok: false; reason: "cap_reached"; spentUsd: number; estimateUsd: number; capUsd: number };

export type PlanRunResult =
  | { ok: true; runId: string; plannedCalls: number; estimateUsd: number }
  | PlanRunRefusal;

/**
 * Sample rows are inserted in chunks so one plan cannot exceed the driver's
 * bind-parameter ceiling. The chunk long predates `MAX_ACTIVE_PROMPTS = 5` —
 * at 5 prompts x 3 engines x 3 samples a plan is 45 rows and never chunks at
 * all — and stays because the ceiling it guards is the driver's, not the
 * cap's: raising the cap back toward 30 (270 rows, roughly a dozen columns
 * each, comfortably over 3,000 parameters in one statement) must not be the
 * commit that discovers this.
 */
const SAMPLE_INSERT_CHUNK = 200;

/** Statuses that mean "a run is already in flight for this tenant". */
const IN_FLIGHT: string[] = ["pending", "running"];

/**
 * How many times an engine is asked one question before the sample is written
 * off as an error.
 *
 * DELIBERATELY the same give-up shape as the judge's `MAX_JUDGE_ATTEMPTS`, and
 * the same number: a counter on the row, a ceiling, and the last message kept.
 * One idiom for "retry the transient, give up on the permanent" in this
 * feature, not two — the judge's version is the one this was copied from.
 *
 * Three, for the same reasons it gives: a 429 or a provider 5xx clears in
 * seconds, and anything still failing on the third ask is not transient. Only
 * retryable failures consume an attempt (see `EngineError.retryable`); a
 * refusal, a truncated answer or a 401 lands as its final status immediately.
 */
export const MAX_SAMPLE_ATTEMPTS = 3;

/**
 * How long a sample waits after its Nth retryable failure, indexed from 0.
 *
 * Measured against the real numbers rather than picked round: the engine
 * timeout is 60s, a Run-now slice budget is 60s inside a 240s total, and a
 * sweep source gets 120s.
 *
 * 30s then 60s means the whole retry ladder for one sample is 90s of waiting —
 * comfortably inside the 240s Run-now drive, so on an ordinary run BOTH retries
 * land in the same invocation the human started. They land in a LATER BATCH,
 * which is the intent: the other 14 samples of that engine keep the wave busy
 * for far longer than 30s, so by the time the queue drains the backoff has
 * elapsed and the row is simply picked up again.
 *
 * The alternative — a backoff shorter than a wave — buys nothing, because the
 * batch query is what re-picks the row and it only runs between waves. A
 * backoff LONGER than a slice budget would also have been defensible (the retry
 * lands on the next slice, or on the sweep); it was not chosen because a run
 * whose last few rows are all in backoff stops driving and then waits for a
 * human's Resume or the daily cron, and 90s of total wait keeps that rare.
 */
const SAMPLE_RETRY_BACKOFF_MS = [30_000, 60_000] as const;

/** The wait after `attempts` retryable failures. Clamped, so a ladder change cannot index off the end. */
export function sampleBackoffMs(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), SAMPLE_RETRY_BACKOFF_MS.length) - 1;
  return SAMPLE_RETRY_BACKOFF_MS[index];
}

/**
 * What a stopped run says about itself.
 *
 * Written on the run row so the header can explain the terminal status without
 * composing a second wording of the same fact — the same rule `paused_by_cap`
 * follows with `capPausedMessage`.
 */
export function stoppedMessage(completedCalls: number, plannedCalls: number): string {
  return `Stopped after ${completedCalls} of ${plannedCalls} calls. What ran is kept and counted.`;
}

/**
 * Slack added to a driver's wall-clock budget when it takes the slice lease.
 *
 * The budget bounds when a slice STOPS handing out new work; the engine calls
 * already in flight when it stops still have to land, and an engine client
 * waits up to its own timeout. A lease that expired the instant the budget did
 * would be free for a second driver to take while the first was still writing
 * sample rows — which is the exact double-spend the lease exists to stop.
 */
const LEASE_GRACE_MS = 5 * 60_000;

/**
 * Claims exclusive right to drive this run, or reports that someone else has it.
 *
 * One compare-and-swap: the lease is taken only if it is unset or has lapsed.
 * Deliberately NOT `SELECT ... FOR UPDATE SKIP LOCKED` — a row lock lives and
 * dies with its transaction, and a slice holds its claim across minutes of
 * engine HTTP calls that cannot be made inside an open transaction. An expiry
 * timestamp survives the process that set it, so a driver killed mid-slice
 * releases the run by lapsing rather than stranding it forever.
 */
async function acquireSliceLease(
  database: typeof defaultDb,
  runId: string,
  now: Date,
  budgetMs: number
): Promise<string | null> {
  // A token, not a flag. Without it "am I still the holder?" is unanswerable,
  // and a driver whose lease lapsed mid-slice would renew straight over the top
  // of the successor that legitimately took the run — two drivers holding what
  // each believes is an exclusive claim, which is worse than no lease at all
  // because both of them think they are safe.
  const owner = crypto.randomUUID();
  const claimed = await database
    .update(aiVisibilityRuns)
    .set({ sliceLeaseUntil: leaseUntil(now, budgetMs), sliceLeaseOwner: owner })
    .where(
      and(
        eq(aiVisibilityRuns.id, runId),
        or(
          isNull(aiVisibilityRuns.sliceLeaseUntil),
          lt(aiVisibilityRuns.sliceLeaseUntil, now)
        )
      )
    )
    .returning({ id: aiVisibilityRuns.id });
  return claimed.length > 0 ? owner : null;
}

function leaseUntil(now: Date, budgetMs: number): Date {
  return new Date(now.getTime() + Math.max(0, budgetMs) + LEASE_GRACE_MS);
}

/**
 * Pushes the lease out for another batch, and reports whether we still hold it.
 *
 * `false` means our lease lapsed and somebody else took the run. The only
 * correct response is to stop handing out work immediately: every sample the
 * new holder has claimed is one we would be paying for twice.
 */
async function renewSliceLease(
  database: typeof defaultDb,
  runId: string,
  owner: string,
  now: Date,
  budgetMs: number
): Promise<boolean> {
  const renewed = await database
    .update(aiVisibilityRuns)
    .set({ sliceLeaseUntil: leaseUntil(now, budgetMs) })
    .where(and(eq(aiVisibilityRuns.id, runId), eq(aiVisibilityRuns.sliceLeaseOwner, owner)))
    .returning({ id: aiVisibilityRuns.id });
  return renewed.length > 0;
}

/**
 * Hands the run back, so the next tick can pick it up immediately instead of
 * waiting out a lease nobody is using.
 *
 * Owner-scoped like the renewal: a driver that lost the race must not clear the
 * lease its successor is currently working under.
 */
async function releaseSliceLease(
  database: typeof defaultDb,
  runId: string,
  owner: string
): Promise<void> {
  await database
    .update(aiVisibilityRuns)
    .set({ sliceLeaseUntil: null, sliceLeaseOwner: null })
    .where(and(eq(aiVisibilityRuns.id, runId), eq(aiVisibilityRuns.sliceLeaseOwner, owner)));
}

/** The tenant's in-flight run, if any. Takes a `tx` so the plan can re-check inside its transaction. */
async function findInFlightRun(
  database: typeof defaultDb | Parameters<Parameters<typeof defaultDb.transaction>[0]>[0],
  tenantId: string
): Promise<string | null> {
  const [row] = await database
    .select({ id: aiVisibilityRuns.id })
    .from(aiVisibilityRuns)
    .where(and(eq(aiVisibilityRuns.tenantId, tenantId), inArray(aiVisibilityRuns.status, IN_FLIGHT)))
    .limit(1);
  return row?.id ?? null;
}

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

  // Never empty, and deliberately not guarded here. `getAiVisibilitySettings`
  // substitutes the full engine list for one that filters down to nothing, and
  // `saveAiVisibilitySettings` refuses to write an empty list in the first
  // place — so the only way to reach this line with zero engines is a
  // hand-written row, and Phase A's ruling is that measuring all three beats
  // measuring none. A refusal arm for it would be a state the UI must branch
  // on and can never see.
  const engines = settings.engines;

  // At most `MAX_ACTIVE_PROMPTS`, in `RUNNABLE_ORDER` — see `runnablePrompts`.
  // Lowering the cap does not deactivate anything, so a tenant seeded under an
  // older, higher ceiling still has more `active` rows than a run may ask; the
  // LIMIT here is what makes the cap a cost cut rather than a note on a form.
  // The ORDER BY is the load-bearing half: it is creation order, so every run
  // asks the SAME prompts, and the trend chart's series stays comparable to
  // itself. `capExceeded` reads the same slice, so the estimate quoted before
  // the click is the plan that follows it.
  const prompts = await database
    .select({
      id: aiVisibilityPrompts.id,
      intent: aiVisibilityPrompts.intent,
    })
    .from(aiVisibilityPrompts)
    .where(and(eq(aiVisibilityPrompts.tenantId, tenantId), eq(aiVisibilityPrompts.status, "active")))
    .orderBy(...RUNNABLE_ORDER)
    .limit(MAX_ACTIVE_PROMPTS);
  if (prompts.length === 0) return { ok: false, reason: "no_prompts" };

  const inFlightBefore = await findInFlightRun(database, tenantId);
  if (inFlightBefore) return { ok: false, reason: "run_in_flight", runId: inFlightBefore };

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
  // than patched in afterwards — the header reads "41 / 270 calls" off it, and a
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

  try {
    // One transaction for the run row AND its whole work list. A plan is not
    // useful in halves: a run row whose sample grid was only partly inserted
    // reports `plannedCalls: 270`, is driven to "completion" against however
    // many rows landed, and freezes that short count into the permanent
    // aggregates. The in-flight re-check joins the transaction so the read and
    // the insert cannot be separated by another driver's insert.
    type Planned = { planned: true; id: string } | { planned: false; conflictId: string };
    const outcome: Planned = await database.transaction(async (tx): Promise<Planned> => {
      const contender = await findInFlightRun(tx, tenantId);
      if (contender) return { planned: false, conflictId: contender };

      const [run] = await tx
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
          // Stamped at plan time so a run is never stale by construction: the
          // window between this insert and the driver's first slice is the one
          // a lease-presence test used to report as "Stalled" to the very
          // person who had just pressed Run now.
          lastActivityAt: now,
        })
        .returning();

      for (let i = 0; i < rows.length; i += SAMPLE_INSERT_CHUNK) {
        await tx
          .insert(aiVisibilitySamples)
          .values(rows.slice(i, i + SAMPLE_INSERT_CHUNK).map((r) => ({ ...r, runId: run.id })));
      }
      return { planned: true, id: run.id };
    });

    if (!outcome.planned) return { ok: false, reason: "run_in_flight", runId: outcome.conflictId };
    return { ok: true, runId: outcome.id, plannedCalls: rows.length, estimateUsd: cap.estimateUsd };
  } catch (error) {
    // `ai_visibility_runs_tenant_in_flight_unique`. Two drivers reaching the
    // insert at the same instant is exactly what that index is for: the check
    // above is the readable path, this is the one that actually holds. Narrowed
    // with `isUniqueViolation` so a deadlock or a lost connection is not
    // reported to the user as "a run is already going".
    if (isUniqueViolation(error)) {
      const contender = await findInFlightRun(database, tenantId);
      if (contender) return { ok: false, reason: "run_in_flight", runId: contender };
    }
    throw error;
  }
}

export type RunSliceResult = {
  processed: number;
  remaining: number;
  budgetSpent: boolean;
  pausedByCap: boolean;
  /**
   * The run was stopped by a human — terminal, and NOT something to finalize,
   * resume or retry. Every driver has to branch on this separately from
   * `remaining`, because a cancelled run still has pending samples by
   * definition: `remaining > 0` on a run nobody will ever drive again.
   */
  cancelled: boolean;
};

/** How many pending rows one batch claims. One batch is one full concurrency wave. */
function batchSize(concurrency: number): number {
  return Math.max(1, concurrency);
}

/**
 * Spends part of a run's work list, bounded by wall clock.
 *
 * The whole point of slicing is that one cron tick has a deadline and a run has
 * up to 270 engine calls in it. Everything survivable is recorded rather than
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
    return {
      processed: 0,
      remaining: 0,
      budgetSpent: false,
      pausedByCap: false,
      cancelled: run?.status === "cancelled",
    };
  }

  // Two drivers reach this run in production: the daily cron sweep, and the
  // `after()` loop of the manual "Run now" that started it — which keeps
  // slicing for its own budget while the next cron tick can arrive on top of
  // it. (A second "Run now" is not one of them: `planRun` refuses with
  // `run_in_flight` and the action reports "A run is already in progress.")
  // Without the lease they both select the same `pending` rows and both pay for
  // them — the tenant is billed twice, `completedCalls` over-counts, extraction
  // doubles every citation row into the leaderboard, and two `computeAggregates`
  // collide on the partial unique index so a perfectly good run is recorded as
  // `failed`. Losing the race is a no-op, not an error: the holder is already
  // doing this work.
  const lease = await acquireSliceLease(database, runId, opts.now(), opts.budgetMs);
  if (!lease) {
    return { processed: 0, remaining: 0, budgetSpent: false, pausedByCap: false, cancelled: false };
  }

  // Claiming the run IS activity, and stamping it here is what keeps a driver
  // that is still inside its first wave from looking abandoned: the first batch
  // UPDATE is up to a full `ENGINE_REQUEST_TIMEOUT_MS` away, and on a resumed
  // run the previous stamp may already be arbitrarily old. Folded into the
  // pending -> running flip so this costs no extra statement on the first slice
  // and one cheap one on later slices.
  await database
    .update(aiVisibilityRuns)
    .set({ lastActivityAt: opts.now(), ...(run.status === "pending" ? { status: "running" as const } : {}) })
    .where(eq(aiVisibilityRuns.id, runId));

  const settings = await getAiVisibilitySettings(run.tenantId, database);
  const extract = deps.extract ?? extractSample;
  // Loaded ONCE per slice: extraction needs the same brand aliases for every
  // row, and re-reading three tables per sample would be ~1,400 identical
  // queries on a 270-call run. `extractSample`'s standalone default still
  // re-reads, for the operator "re-extract after an alias fix" path.
  const brandContext = await loadBrandTargets(run.tenantId, database);
  // Shared across the slice: a Gemini grounding handle cited by many samples
  // resolves over the network once, not once per citation.
  const redirectCache = new Map<string, string>();
  const modelIds: Record<string, string> = { ...(run.modelIds ?? {}) };
  let processed = 0;
  let budgetSpent = false;
  let pausedByCap = false;
  let leaseLost = false;
  let cancelled = false;

  while (true) {
    if (opts.now().getTime() - startedAt >= opts.budgetMs) {
      budgetSpent = true;
      break;
    }

    // Re-read between batches for the same reason the cap is, and this is what
    // makes "Stop" a real stop rather than a relabelled row: the wave already
    // handed to the engines finishes and is paid for — nothing here aborts an
    // HTTP call in flight — and then no further work is claimed. `status` is
    // re-read rather than trusted from `run` above, which was loaded before any
    // of this slice's minutes of engine calls.
    const [current] = await database
      .select({ status: aiVisibilityRuns.status })
      .from(aiVisibilityRuns)
      .where(eq(aiVisibilityRuns.id, runId));
    if (!current || !IN_FLIGHT.includes(current.status)) {
      cancelled = current?.status === "cancelled";
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
        askAttempts: aiVisibilitySamples.askAttempts,
      })
      .from(aiVisibilitySamples)
      .innerJoin(aiVisibilityPrompts, eq(aiVisibilitySamples.promptId, aiVisibilityPrompts.id))
      .where(
        and(
          eq(aiVisibilitySamples.runId, runId),
          eq(aiVisibilitySamples.status, "pending"),
          // The backoff filter, and it is load-bearing rather than tidy. A
          // retryable failure leaves the row `pending`, so without this the
          // very next batch selects the same row — the identical 429 comes
          // back, the row goes round again, and the slice hot-loops through
          // its whole budget on one rate-limited sample while every other
          // pending row waits behind it. NULL is "no wait": that is how every
          // row is planned, so a first attempt is never delayed.
          or(
            isNull(aiVisibilitySamples.nextAttemptAt),
            lte(aiVisibilitySamples.nextAttemptAt, opts.now())
          )
        )
      )
      // Stable order so a resumed run is deterministic and a starved tail is a
      // policy rather than an accident of the planner.
      .orderBy(asc(aiVisibilitySamples.id))
      .limit(batchSize(opts.concurrency));

    // Nothing to hand out. Either the work list is finished, or everything left
    // is waiting out a backoff — in which case the slice ends with
    // `remaining > 0` and a later driver (the next slice, the sweep, or a
    // human's Resume) picks the rows up once their timestamps come due. That is
    // the whole reason this is a `break` and not a spin.
    if (batch.length === 0) break;

    // Pushed out per batch rather than held for the whole slice, so a slice
    // that outlives its budget keeps its claim while it finishes — and checked,
    // because the answer can be no. If our lease lapsed and another driver took
    // the run, every sample it has claimed is one we would pay for twice. Stop
    // handing out work; the holder finishes it.
    if (!(await renewSliceLease(database, runId, lease, opts.now(), opts.budgetMs))) {
      leaseLost = true;
      break;
    }

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

          // A retryable failure — a 429, a 5xx, a timeout — is a moment, not a
          // verdict. Written back `pending` with the attempt counted and a
          // backoff stamped, so the row keeps its place in the work list
          // instead of costing the engine a data point outright. `error` is
          // still stored on the way past: if this turns out to be the last
          // attempt, the message a human reads is the last thing that went
          // wrong, exactly as it was before.
          const attempts = row.askAttempts + 1;
          const retrying = result.retryable === true && attempts < MAX_SAMPLE_ATTEMPTS;

          await database
            .update(aiVisibilitySamples)
            .set({
              status: retrying ? "pending" : result.kind === "refused" ? "refused" : "error",
              error: result.message,
              // ACCUMULATED, not assigned. Every attempt the provider billed is
              // real money, and `reconcileRunCounters` re-derives the run's
              // total from these rows at finalize — an assignment here would
              // quietly forget the earlier attempts' spend and under-count the
              // monthly cap by however many retries happened.
              costUsd: sql`${aiVisibilitySamples.costUsd} + ${knownCost}`,
              askAttempts: attempts,
              nextAttemptAt: retrying
                ? new Date(opts.now().getTime() + sampleBackoffMs(attempts))
                : null,
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
            // Accumulated for the same reason the failure path is: a sample
            // that 429'd twice before answering was billed for whatever those
            // attempts cost, and this row is what the run's final spend is
            // summed from. Identical to an assignment on the ordinary path,
            // where the row is still at its 0 default.
            costUsd: sql`${aiVisibilitySamples.costUsd} + ${result.costUsd}`,
            error: null,
            nextAttemptAt: null,
            askedAt: opts.now(),
          })
          .where(eq(aiVisibilitySamples.id, row.id));

        // Extraction is part of answering, not of finalizing: a run that never
        // reaches finalizeRun (budget, cap, a dead cron) still has usable
        // mention data, and the answer text is already in hand exactly once.
        //
        // Its OWN try/catch, deliberately outside the per-row one: the answer
        // above is already bought and already stored, and letting an extraction
        // failure fall through would rewrite this `ok` row as `error` — a
        // fabricated coverage gap whose real cost never reaches the run total.
        // Extraction reads three tables and can fail for reasons that have
        // nothing to do with the answer: a DB blip, a competitor deleted
        // mid-slice (brandContext is loaded once, at slice start), a citation
        // position outside smallint. `extractSample` is idempotent, so the row
        // can simply be re-extracted later.
        try {
          await extract(row.id, { database, brandContext, redirectCache, fetchImpl: deps.fetchImpl });
        } catch (error) {
          console.error(`[ai-visibility] extraction failed for sample ${row.id}:`, error);
        }

        return { costUsd: result.costUsd, engine: row.engine, modelId: result.modelId };
      } catch (error) {
        // Per-row try/catch: one hostile or broken engine response must not cost
        // the other 359 samples their slice.
        //
        // TERMINAL, and not retried. `ask()` promises never to throw, and every
        // failure it knows how to classify comes back as an `EngineError` — a
        // throw escaping it is our bug (a shape we read wrong, a TypeError in a
        // parser), which asking the provider again cannot fix. Retrying it
        // would pay three times for the same crash.
        try {
          await database
            .update(aiVisibilitySamples)
            .set({ status: "error", error: String(error), nextAttemptAt: null, askedAt: opts.now() })
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
        // Folded into the batch counters rather than written separately: this
        // statement already marks the one moment in the slice where real work
        // demonstrably landed, and a second UPDATE per batch would be a second
        // round trip saying the same thing.
        lastActivityAt: opts.now(),
      })
      .where(eq(aiVisibilityRuns.id, runId));
  }

  // Handed back the moment this driver stops, so the next tick starts
  // immediately rather than waiting out a lease nobody is holding. Owner-scoped,
  // so a driver that already lost the lease cannot free its successor's claim.
  if (!leaseLost) await releaseSliceLease(database, runId, lease);

  const [pending] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(aiVisibilitySamples)
    .where(and(eq(aiVisibilitySamples.runId, runId), eq(aiVisibilitySamples.status, "pending")));
  const remaining = pending?.count ?? 0;

  if (cancelled) {
    // Settled HERE as well as in `cancelRun`, and deliberately: the cancel
    // lands while this driver is mid-wave, so the samples that wave buys are
    // written AFTER `cancelRun` has already aggregated. Re-aggregating once the
    // wave is done is the only thing that gets them into the record — and
    // `computeAggregates` deletes this run's rows before it rewrites them, so
    // doing it twice costs a query rather than a double count.
    await settleCancelledRun(runId, { now: opts.now }, deps);
  }

  if (pausedByCap) {
    // A cap pause is TERMINAL: `finalizeRun` refuses a `paused_by_cap` run and
    // the sweep never resumes one, so this is the run's only chance to record
    // what it already bought. Without it every answer paid for before the gate
    // tripped is orphaned — never aggregated, invisible to every metric and
    // every signal — while its cost still counts against month-to-date spend.
    //
    // Safe on a partial run precisely because aggregates are counts, not rates
    // (contract decision 4): a short run contributes a small `n` that sums
    // correctly into the window, and the n >= 30 display thresholds already
    // decide what a thin window is allowed to say.
    //
    // Logged rather than thrown: the pause itself is the thing that must not be
    // lost. Leaving the run `running` because aggregation failed would block
    // every future run behind `run_in_flight` with the cap still tripped.
    try {
      await computeAggregates(runId, database);
    } catch (error) {
      console.error(`[ai-visibility] could not aggregate cap-paused run ${runId}:`, error);
    }

    const cap = await capExceeded(run.tenantId, settings, opts.now(), database);
    const message = capPausedMessage(cap.spentUsd, cap.capUsd);
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

  return { processed, remaining, budgetSpent, pausedByCap, cancelled };
}

/**
 * `paused_by_cap` is a status of its own, not a flavour of `running`.
 *
 * A cap-paused run needs "raise your cap or wait for the reset" on the page and
 * no further work from the sweep; a running one needs a spinner and another
 * tick. Collapsing the two would make both callers guess, and guess differently.
 */
export type FinalizeRunResult = {
  status: "complete" | "running" | "paused_by_cap" | "cancelled" | "failed";
  judged: number;
  signals: number;
};

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
 * run where Gemini rate-limited nine prompts did its job, and the operator
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
 * Re-derives a run's spend and call count from its own sample rows.
 *
 * `runSlice` posts both as per-batch increments, which is right for a live
 * progress header and wrong as a final record: a tick killed between a sample
 * write and its batch total loses that batch's spend forever, and a batch
 * driven twice counts it twice. The sample rows are what actually happened.
 *
 * Rounded to cents like every other USD value that gets compared or displayed
 * — this number is what the monthly cap is summed from.
 */
async function reconcileRunCounters(database: typeof defaultDb, runId: string): Promise<void> {
  const [totals] = await database
    .select({
      cost: sql<number>`coalesce(sum(${aiVisibilitySamples.costUsd}), 0)::float8`,
      completed: sql<number>`count(*) filter (where ${aiVisibilitySamples.status} <> 'pending')::int`,
    })
    .from(aiVisibilitySamples)
    .where(eq(aiVisibilitySamples.runId, runId));

  await database
    .update(aiVisibilityRuns)
    .set({
      costUsd: roundUsd(Number(totals?.cost ?? 0)),
      completedCalls: totals?.completed ?? 0,
    })
    .where(eq(aiVisibilityRuns.id, runId));
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
): Promise<FinalizeRunResult> {
  const database = deps.database ?? defaultDb;
  const judge = deps.judge ?? judgeRun;
  const aggregate = deps.aggregate ?? computeAggregates;
  const emit = deps.emit ?? emitSignals;

  const [run] = await database.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
  if (!run) return { status: "failed", judged: 0, signals: 0 };
  // Finalizing twice would emit a second set of signals for the same run. The
  // externalId dedupe would absorb most of them, but "most" is not a guarantee
  // worth relying on when the check is one comparison.
  if (run.status === "complete") return { status: "complete", judged: 0, signals: 0 };
  // Every OTHER non-in-flight status is equally not-finalizable, and `complete`
  // alone was too narrow a guard: a `paused_by_cap` run would be un-paused
  // here, its remaining samples judged, and judge tokens spent for a run the
  // cap stopped on purpose; a `failed` one would be quietly resurrected.
  // Reported rather than thrown — these are states a caller polls, and none of
  // them is this function's own failure.
  if (run.status === "paused_by_cap") return { status: "paused_by_cap", judged: 0, signals: 0 };
  // A stopped run IS finalized — its answers are admitted to the window like a
  // cap-paused run's — but not by the pipeline below. `settleCancelledRun` is
  // the whole of it, and it deliberately does not judge: the judge is more
  // model calls, and spending them after a human pressed Stop is the one thing
  // Stop exists to prevent. Called rather than merely reported because nothing
  // else will ever reach this run — the sweep only picks up `pending`/`running`
  // — so "leave it to the next tick" means "never".
  if (run.status === "cancelled") {
    await settleCancelledRun(runId, { now: opts.now }, deps);
    return { status: "cancelled", judged: 0, signals: 0 };
  }
  if (!IN_FLIGHT.includes(run.status)) {
    return { status: run.status === "failed" ? "failed" : "running", judged: 0, signals: 0 };
  }

  // The same lease `runSlice` takes, for the same reason: a cron tick and a
  // manual Run-now finalizing the same run concurrently run `computeAggregates`
  // twice, and the second collides with the partial unique index — which the
  // catch below would record as a FAILED run that in fact succeeded.
  const lease = await acquireSliceLease(database, runId, opts.now(), opts.budgetMs);
  if (!lease) {
    return { status: "running", judged: 0, signals: 0 };
  }

  // Finalizing is progress too, and the judge pass below can run for minutes
  // without touching the run row. A run left `running` because the judge budget
  // ran out is genuinely stalled and should surface as such — but only from
  // when the judge stopped, not from the last sample batch before it.
  await database
    .update(aiVisibilityRuns)
    .set({ lastActivityAt: opts.now() })
    .where(eq(aiVisibilityRuns.id, runId));

  try {
    const judged = await judge(runId, { budgetMs: opts.budgetMs, now: opts.now }, { database });
    if (judged.remaining > 0) {
      // Deliberately leaves the run `running`: the next cron tick resumes
      // here. Nothing else will — a manual "Run now" is refused outright while
      // a run is in flight, and its own `after()` loop has already returned by
      // the time the judge budget runs out.
      //
      // The judge's errors are written to the run row rather than dropped. A
      // run that cannot finish is the one state where the reason has to be
      // readable: without this the header says "Running…" beside a green badge
      // for as long as the chunk keeps failing, and the only symptom anybody
      // sees is that next week's run never starts.
      if (judged.errors.length > 0) {
        await database
          .update(aiVisibilityRuns)
          .set({ error: judged.errors.join("; ") })
          .where(eq(aiVisibilityRuns.id, runId));
      }
      // Handed back like every other exit takes care to do. Holding it would
      // make the run unresumable until the lease expires — and the budget this
      // lease was sized from is the one that just ran out.
      await releaseSliceLease(database, runId, lease);
      return { status: "running", judged: judged.judged, signals: 0 };
    }

    // Aggregates are the permanent record for this run — nothing recomputes
    // them later — so they must not be written off a work list that is still
    // being filled. A sample still `pending` means an engine has not answered
    // yet; aggregating now freezes a small `n` and a rate computed from it.
    const [stillPending] = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(aiVisibilitySamples)
      .where(and(eq(aiVisibilitySamples.runId, runId), eq(aiVisibilitySamples.status, "pending")));
    if ((stillPending?.count ?? 0) > 0) {
      await releaseSliceLease(database, runId, lease);
      return { status: "running", judged: judged.judged, signals: 0 };
    }

    // Finding 8: the counters are re-derived from the sample rows before they
    // are frozen. `completedCalls` and `costUsd` are incremented per batch, so
    // a driver that dies between writing a sample and posting its batch total
    // under-reports spend permanently — and a double-driven batch over-reports
    // it. The sample rows are the source of truth for both.
    await reconcileRunCounters(database, runId);

    await aggregate(runId, database);
    const emitted = await emit(runId, { now: opts.now }, { database });

    const summary = await engineFailureSummary(database, runId);
    const errorText = [summary.message, ...judged.errors].filter(Boolean).join("; ") || null;

    await database
      .update(aiVisibilityRuns)
      .set({ status: "complete", finishedAt: opts.now(), error: errorText })
      .where(eq(aiVisibilityRuns.id, runId));

    // Productive = the run got at least one usable answer. A run where every
    // engine failed is genuinely `failing`; one where two of three answered is
    // not, however loud its lastError.
    await finish(database, run.sourceId, opts.now(), errorText, summary.okSamples > 0);
    await releaseSliceLease(database, runId, lease);

    return { status: "complete", judged: judged.judged, signals: emitted.written };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await database
        .update(aiVisibilityRuns)
        .set({ status: "failed", error: message, finishedAt: opts.now() })
        .where(eq(aiVisibilityRuns.id, runId));
      await finish(database, run.sourceId, opts.now(), message, false);
      await releaseSliceLease(database, runId, lease);
    } catch (secondary) {
      console.error(`[ai-visibility] could not record finalize failure for run ${runId}:`, secondary);
    }
    return { status: "failed", judged: 0, signals: 0 };
  }
}

/**
 * Closes out a run a human stopped.
 *
 * Same admission rule as `paused_by_cap` (design contract decision 4, and the
 * ungrounded-answers ruling behind it): the samples that already landed are
 * real answers that were really paid for, `isEligible` already excludes the
 * errored and refused ones, and throwing the rest away would make the tenant
 * pay for measurements they are then not allowed to see. Aggregates are summed
 * COUNTS, so a thin run contributes proportionally little, and the n-floors
 * decide what a thin window may say.
 *
 * No judge pass, unlike `finalizeRun`. Judging is more model calls, and the
 * point of Stop is that no more money is spent — the cost is that
 * `recommendations` is understated for this run, exactly as it already is for
 * every cap-paused one.
 *
 * Never throws, and idempotent by construction. It runs twice on the ordinary
 * path — once from `cancelRun`, once from the driver that was mid-wave when the
 * stop landed — so `computeAggregates` (delete-then-insert per run) and
 * `emitSignals` (`onConflictDoNothing` on the weekly externalId) are both
 * relied on to absorb the second pass.
 */
async function settleCancelledRun(
  runId: string,
  opts: { now: Clock },
  deps: FinalizeDeps = {}
): Promise<void> {
  const database = deps.database ?? defaultDb;
  const aggregate = deps.aggregate ?? computeAggregates;
  const emit = deps.emit ?? emitSignals;

  try {
    const [run] = await database
      .select({
        status: aiVisibilityRuns.status,
        sourceId: aiVisibilityRuns.sourceId,
        plannedCalls: aiVisibilityRuns.plannedCalls,
      })
      .from(aiVisibilityRuns)
      .where(eq(aiVisibilityRuns.id, runId));
    // Guarded rather than assumed: a driver reaching here on a run somebody
    // has since re-planned must not rewrite that run's counters.
    if (!run || run.status !== "cancelled") return;

    // The per-batch increments are not the record — see `reconcileRunCounters`.
    // Doubly true here: a stop lands mid-wave, so the last batch's totals are
    // the ones most likely never to have been posted.
    await reconcileRunCounters(database, runId);
    await aggregate(runId, database);
    await emit(runId, { now: opts.now }, { database });

    const [totals] = await database
      .select({ completed: aiVisibilityRuns.completedCalls })
      .from(aiVisibilityRuns)
      .where(eq(aiVisibilityRuns.id, runId));
    const message = stoppedMessage(totals?.completed ?? 0, run.plannedCalls);
    await database
      .update(aiVisibilityRuns)
      .set({ error: message, finishedAt: opts.now() })
      .where(eq(aiVisibilityRuns.id, runId));

    if (run.sourceId) {
      const summary = await engineFailureSummary(database, runId);
      // NOT `finish()`. That helper paints the source `failing` whenever the run
      // was unproductive, and a run somebody stopped one second after starting
      // it is unproductive by their own choice — a red source badge would report
      // the operator's decision as an outage. A stop that did get answers is an
      // ordinary success; a stop that got none leaves `status` exactly as it was.
      await database
        .update(sources)
        .set({
          lastRunAt: opts.now(),
          lastError: message,
          ...(summary.okSamples > 0 ? { lastSuccessAt: opts.now(), status: "active" as const } : {}),
        })
        .where(eq(sources.id, run.sourceId));
    }
  } catch (error) {
    // The status flip is the load-bearing part and has already happened. A
    // failure here costs this run its aggregates, not the tenant's ability to
    // start another one.
    console.error(`[ai-visibility] could not settle cancelled run ${runId}:`, error);
  }
}

/**
 * How long a run may go without writing progress before it is called stalled.
 *
 * It has to exceed the longest quiet stretch a HEALTHY run can legitimately
 * have, and the two candidates are measured, not guessed:
 *
 *  - ONE WAVE OF TIMEOUTS. `lastActivityAt` is stamped at slice start and then
 *    once per batch, so the widest healthy gap is a whole concurrency wave in
 *    which every engine burns the full `ENGINE_REQUEST_TIMEOUT_MS` — 60s — plus
 *    the extraction and the batch UPDATE that follow it.
 *  - A BACKOFF. When the last pending rows are waiting out a retry, the batch
 *    query hands out nothing, `driveRun` returns on `processed === 0`, and the
 *    run goes genuinely quiet with nobody driving it. The longest single step
 *    of `SAMPLE_RETRY_BACKOFF_MS` is 60s. The LADDER does not accumulate here:
 *    each retry that fires is itself a batch, and writes a new stamp — so the
 *    quiet window is one step, not 30s + 60s.
 *
 * Both are 60s, and they are alternatives rather than a sum (the batch UPDATE
 * that ends a wave of timeouts is the same write that starts the backoff's
 * quiet window). 180s is therefore three times the requirement: 60s of wave,
 * 60s of backoff added anyway as if they stacked, and 60s of slack for
 * extraction's redirect resolution, DB round trips and clock skew.
 *
 * Erring long is the safe direction. Too long only delays how quickly a stall
 * surfaces — and 3 minutes against the 24-hour cron this feature replaced is
 * noise. Too short is the bug being fixed: Resume offered on a healthy run.
 *
 * The number also has to be long enough that a Resume, once offered, can
 * actually do something. It clears the 60s backoff step, so by the time the
 * button appears the rows that went quiet are due to be picked up again.
 */
export const STALL_AFTER_MS = 180_000;

/**
 * Whether a run is in flight with nobody driving it.
 *
 * Two conjuncts, and both are load-bearing:
 *
 *  - NO PROGRESS SINCE `STALL_AFTER_MS`. This is the honest signal — a
 *    timestamp of work actually done. It replaced a lease-presence test, which
 *    reported "Stalled" in the sub-second window between every pair of slices
 *    of a perfectly healthy Run-now, because `releaseSliceLease` hands the run
 *    back at the end of each one.
 *  - NO LIVE LEASE. A live `sliceLeaseUntil` means a driver holds this run
 *    right now, and it VETOES "stalled" whatever the timestamp says: a wave
 *    slower than the threshold is slow, not abandoned, and a second driver
 *    would claim samples the first is already paying for.
 *
 * A driver that dies mid-wave therefore surfaces as stalled once BOTH pass —
 * its lease outlives it by `LEASE_GRACE_MS` on top of its slice budget, which
 * is the price of not resuming over the top of a driver that is merely slow.
 *
 * Exported because the page and the resume action must agree on the word
 * "stalled" — the button appears under precisely the condition the action
 * enforces, so the control cannot be offered for a run that then refuses it.
 */
export function runIsStalled(
  run: { status: string; sliceLeaseUntil: Date | null; lastActivityAt: Date },
  now: Date
): boolean {
  if (!IN_FLIGHT.includes(run.status)) return false;
  if (now.getTime() - run.lastActivityAt.getTime() < STALL_AFTER_MS) return false;
  return run.sliceLeaseUntil === null || run.sliceLeaseUntil.getTime() <= now.getTime();
}

export type ResumeRunTarget =
  | { ok: true; runId: string }
  | { ok: false; reason: "not_in_flight" }
  | { ok: false; reason: "lease_held" };

/**
 * The tenant's in-flight run, if it is stalled and nobody else is driving it.
 *
 * Takes a TENANT, never a run id, for the reason `cancelRun` and `runNowAction`
 * do: the partial unique index guarantees at most one in-flight run per tenant,
 * so the target is derivable server-side and there is nothing a client could
 * substitute for somebody else's run.
 *
 * Two refusals rather than one because they are two different sentences for the
 * operator: nothing is running, versus something is running and does not need
 * help. Neither is an error.
 *
 * This is advisory, not the enforcement: nothing holds a lock between this read
 * and the driver that follows it. The enforcement is `runSlice`'s lease CAS,
 * which lets exactly one driver win and makes the loser a no-op. What this
 * buys is a clean answer instead of a second driver quietly doing nothing.
 */
export async function findResumableRun(
  tenantId: string,
  opts: { now: Clock },
  deps: RunDeps = {}
): Promise<ResumeRunTarget> {
  const database = deps.database ?? defaultDb;
  const now = opts.now();

  const [row] = await database
    .select({
      id: aiVisibilityRuns.id,
      status: aiVisibilityRuns.status,
      sliceLeaseUntil: aiVisibilityRuns.sliceLeaseUntil,
      lastActivityAt: aiVisibilityRuns.lastActivityAt,
    })
    .from(aiVisibilityRuns)
    .where(and(eq(aiVisibilityRuns.tenantId, tenantId), inArray(aiVisibilityRuns.status, IN_FLIGHT)))
    .limit(1);

  if (!row) return { ok: false, reason: "not_in_flight" };
  if (!runIsStalled(row, now)) return { ok: false, reason: "lease_held" };
  return { ok: true, runId: row.id };
}

export type DriveRunOptions = {
  /** Wall clock for the whole drive, slices and finalize together. */
  totalBudgetMs: number;
  /** Ceiling on any one slice, so the lease and the cap are re-checked regularly. */
  sliceBudgetMs: number;
  /** Floor handed to `finalizeRun` when the total is nearly gone — it is resumable anyway. */
  finalizeMinBudgetMs: number;
  concurrency: number;
  now: Clock;
};

export type DriveRunDeps = FinalizeDeps & {
  slice?: typeof runSlice;
  finalize?: typeof finalizeRun;
};

/**
 * Slices a run until it is finished, stopped, paused, or out of budget.
 *
 * ONE copy of this loop, called by "Run now" and by "Resume". It was extracted
 * rather than copied the second time it was needed: every branch below is a
 * rule about money or about concurrency — a cap pause is terminal, a stop must
 * not be finalized, a lost lease must not be driven over — and two versions of
 * those rules would be one version and one bug.
 *
 * Never throws, like the sweep's per-source arm: `runSlice` and `finalizeRun`
 * both record their own expected failures on the run row, so anything reaching
 * the catch is exceptional. Callers run it inside `after()`, where a rejection
 * has nowhere to go.
 */
export async function driveRun(
  runId: string,
  opts: DriveRunOptions,
  deps: DriveRunDeps = {}
): Promise<void> {
  const slice = deps.slice ?? runSlice;
  const finalize = deps.finalize ?? finalizeRun;
  const { now } = opts;

  try {
    const startedAt = now().getTime();
    const remainingMs = () => opts.totalBudgetMs - (now().getTime() - startedAt);

    for (;;) {
      const outcome = await slice(
        runId,
        {
          budgetMs: Math.min(opts.sliceBudgetMs, Math.max(remainingMs(), 1)),
          concurrency: opts.concurrency,
          now,
        },
        deps
      );
      // The cap gate already set `paused_by_cap` and the source's lastError;
      // finalizing here would judge and aggregate a half-run.
      if (outcome.pausedByCap) return;
      // Somebody pressed Stop. `cancelRun` has already settled the run, so
      // there is nothing left to drive OR to finalize — and this must be
      // checked before `remaining`, because a stopped run's pending samples
      // stay pending, so `remaining` never reaches 0 and the loop would spin on
      // a `runSlice` that returns immediately until the budget lapsed.
      if (outcome.cancelled) return;
      if (outcome.remaining === 0) break;
      // Work is left, but the slice handed out nothing: every pending row is
      // waiting out a retry backoff (or another driver holds the lease).
      // Looping would re-query the work list as fast as this loop can run for
      // the rest of the budget — the outer twin of the hot loop the batch
      // query's backoff filter stops. The run stays `running`, and the sweep or
      // a human's Resume picks it up.
      if (outcome.processed === 0) return;
      if (remainingMs() <= 0) return; // still `running`; the sweep resumes it
    }

    // `finalizeRun` is itself resumable, so a short remainder is fine — it
    // leaves the run `running` for the sweep rather than half-marking it.
    await finalize(
      runId,
      { budgetMs: Math.max(remainingMs(), opts.finalizeMinBudgetMs), now },
      deps
    );
  } catch (error) {
    console.error(`[ai-visibility] driving run ${runId} failed:`, error);
  }
}

export type CancelRunResult =
  | { ok: true; runId: string; completedCalls: number; plannedCalls: number }
  | { ok: false; reason: "not_in_flight" };

/**
 * Stops the tenant's in-flight run.
 *
 * Takes a TENANT, never a run id: the run to stop is derived server-side from
 * the partial unique index that already guarantees there is at most one, which
 * is the same reason `runNowAction` refuses to accept an id from the client.
 *
 * The flip is one conditional UPDATE, so two operators pressing Stop together
 * produce one cancellation and one `not_in_flight` rather than two settlements.
 * `cancelled` is not in `IN_FLIGHT`, so the moment it lands the tenant is free
 * to plan a new run — which is most of what Stop is for.
 *
 * The slice lease is cleared in the same statement. Nothing should wait out a
 * lease on a run that will never resume, and it has a second effect worth
 * having: a driver still mid-slice fails its next `renewSliceLease` and stops
 * even if it somehow misses the status check.
 *
 * `lastActivityAt` is deliberately NOT stamped, here or in
 * `settleCancelledRun`. `cancelled` is terminal and outside `IN_FLIGHT`, so
 * `runIsStalled` is already false for this run whatever the timestamp says —
 * writing one would only invite a reader to believe it is load-bearing.
 */
export async function cancelRun(
  tenantId: string,
  opts: { now: Clock },
  deps: FinalizeDeps = {}
): Promise<CancelRunResult> {
  const database = deps.database ?? defaultDb;
  const now = opts.now();

  const [cancelled] = await database
    .update(aiVisibilityRuns)
    .set({
      status: "cancelled",
      finishedAt: now,
      error: "Stopped.",
      sliceLeaseUntil: null,
      sliceLeaseOwner: null,
    })
    .where(
      and(eq(aiVisibilityRuns.tenantId, tenantId), inArray(aiVisibilityRuns.status, IN_FLIGHT))
    )
    .returning({ id: aiVisibilityRuns.id, plannedCalls: aiVisibilityRuns.plannedCalls });
  if (!cancelled) return { ok: false, reason: "not_in_flight" };

  // Inline, not left to the sweep: the sweep only ever looks at `pending` and
  // `running` runs, so for a cancelled one "the next tick" never comes. It is
  // DB-only work — no engine calls, no judge — so it costs the operator's click
  // a few queries and hands back a page that is already correct.
  await settleCancelledRun(cancelled.id, opts, deps);

  const [row] = await database
    .select({ completedCalls: aiVisibilityRuns.completedCalls })
    .from(aiVisibilityRuns)
    .where(eq(aiVisibilityRuns.id, cancelled.id));

  return {
    ok: true,
    runId: cancelled.id,
    completedCalls: row?.completedCalls ?? 0,
    plannedCalls: cancelled.plannedCalls,
  };
}

/**
 * The tenant's most recent run, whatever its status.
 *
 * Any status on purpose: the overview header has to render "Running… 41 / 270
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
