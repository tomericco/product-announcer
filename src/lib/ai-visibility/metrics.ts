import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { aiVisibilityAggregates, aiVisibilityRuns } from "@/db/schema";
import {
  ENGINE_IDS,
  type EngineId,
  type EngineMetrics,
  type WindowCounts,
} from "@/lib/ai-visibility/types";

/** Design §Metrics: a rolling 4-run window, ~12 samples per prompt. */
export const WINDOW_RUNS = 4;
/** Contract decision 8: an engine aggregate is hidden below this. */
export const MIN_N_AGGREGATE = 30;
/** Contract decision 8: a per-prompt cell is hidden below this. */
export const MIN_N_PROMPT = 3;
/** How many runs a sparkline plots. Design §UX: "12-week sparkline". */
export const HISTORY_RUNS = 12;
/** Design §Metrics: "Deltas are 30-day only". */
export const DELTA_DAYS = 30;

/** 95% two-sided normal quantile. */
const Z = 1.959963984540054;

/**
 * The 95% Wilson interval's half-width, in percentage points.
 *
 * Wilson rather than the normal approximation because the normal one is
 * embarrassing exactly where this feature lives: at n = 30 with p near 0 or 1
 * it produces intervals that cross zero or exceed 100. Design §Metrics puts
 * "±x pp" on every headline tile precisely so a reader can see that a 4-point
 * move is inside the noise.
 *
 * Returns the HALF-WIDTH, already multiplied by 100, so the caller renders
 * `±${value.toFixed(1)} pp` with no further arithmetic. Note the interval is
 * not symmetric about p — this is the half-width of the Wilson interval, which
 * is what "±" means on a tile and is what every vendor reports.
 */
export function wilsonPp(successes: number, n: number): number | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  const p = Math.min(1, Math.max(0, successes / n));
  const denominator = 1 + (Z * Z) / n;
  const half = (Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n))) / denominator;
  return half * 100;
}

const emptyCounts = (): WindowCounts => ({
  n: 0,
  tenantMentions: 0,
  ownCitations: 0,
  recommendations: 0,
  competitorMentions: {},
});

/** The ids of the last `runs` complete runs, newest first. */
async function windowRunIds(
  tenantId: string,
  runs: number,
  before: Date | undefined,
  database: typeof defaultDb
): Promise<string[]> {
  const rows = await database
    .select({ id: aiVisibilityRuns.id })
    .from(aiVisibilityRuns)
    .where(
      and(
        eq(aiVisibilityRuns.tenantId, tenantId),
        // Only complete runs. A run still in flight has partial aggregates or
        // none, and letting one into the window would make every number wobble
        // for as long as the cron takes.
        eq(aiVisibilityRuns.status, "complete"),
        ...(before ? [lt(aiVisibilityRuns.startedAt, before)] : [])
      )
    )
    .orderBy(desc(aiVisibilityRuns.startedAt))
    .limit(runs);
  return rows.map((r) => r.id);
}

/**
 * Sums aggregate COUNT rows over the last N complete runs.
 *
 * A sum, not an average — that is the whole reason aggregates store counts
 * (contract decision 4). `competitorMentions` is a jsonb map, so it is summed
 * in JS; at 4 runs x 4 engines x up to 31 rows that is a few hundred rows, well
 * inside what one query and one loop should do.
 *
 * Engine-level rows (`promptId IS NULL`) and prompt-level rows are never mixed:
 * asking for a prompt returns that prompt's rows, asking for none returns the
 * engine-level rows. Summing both would double every count.
 */
export async function windowCounts(
  tenantId: string,
  opts: { engine?: EngineId; promptId?: string | null; runs?: number; before?: Date },
  database: typeof defaultDb = defaultDb
): Promise<WindowCounts> {
  const runIds = await windowRunIds(tenantId, opts.runs ?? WINDOW_RUNS, opts.before, database);
  if (runIds.length === 0) return emptyCounts();

  const rows = await database
    .select({
      n: aiVisibilityAggregates.n,
      tenantMentions: aiVisibilityAggregates.tenantMentions,
      competitorMentions: aiVisibilityAggregates.competitorMentions,
      ownCitations: aiVisibilityAggregates.ownCitations,
      recommendations: aiVisibilityAggregates.recommendations,
    })
    .from(aiVisibilityAggregates)
    .where(
      and(
        inArray(aiVisibilityAggregates.runId, runIds),
        ...(opts.engine ? [eq(aiVisibilityAggregates.engine, opts.engine)] : []),
        opts.promptId
          ? eq(aiVisibilityAggregates.promptId, opts.promptId)
          : isNull(aiVisibilityAggregates.promptId)
      )
    );

  const total = emptyCounts();
  for (const row of rows) {
    total.n += row.n;
    total.tenantMentions += row.tenantMentions;
    total.ownCitations += row.ownCitations;
    total.recommendations += row.recommendations;
    for (const [id, count] of Object.entries(row.competitorMentions ?? {})) {
      total.competitorMentions[id] = (total.competitorMentions[id] ?? 0) + count;
    }
  }
  return total;
}

/** Total mentions of every tracked brand — the SOV denominator. */
function brandMentionTotal(counts: WindowCounts): number {
  return (
    counts.tenantMentions +
    Object.values(counts.competitorMentions).reduce((sum, c) => sum + c, 0)
  );
}

function shareOfVoicePct(counts: WindowCounts): number | null {
  const total = brandMentionTotal(counts);
  // Nobody named at all is not "0% share" — it is a question with no brands in
  // its answers, which is a different fact and belongs in the bad-prompt check,
  // not on the tile as a zero.
  if (total === 0) return null;
  return (counts.tenantMentions / total) * 100;
}

function toMetrics(engine: EngineId | "all", counts: WindowCounts, deltaPpValue: number | null): EngineMetrics {
  // Contract decision 8: below the threshold, every rate is null and the tile
  // reads "Collecting baseline". `n` is always real so the reader can watch it
  // grow.
  if (counts.n < MIN_N_AGGREGATE) {
    return {
      engine,
      n: counts.n,
      mentionRate: null,
      shareOfVoice: null,
      citationRate: null,
      recommendationRate: null,
      wilsonPp: null,
      deltaPp: null,
    };
  }
  return {
    engine,
    n: counts.n,
    mentionRate: (counts.tenantMentions / counts.n) * 100,
    shareOfVoice: shareOfVoicePct(counts),
    citationRate: (counts.ownCitations / counts.n) * 100,
    recommendationRate: (counts.recommendations / counts.n) * 100,
    // The interval is on the SOV proportion, so its denominator is total brand
    // mentions, not n. Getting this wrong understates the band on exactly the
    // engines where the tenant is rarely named.
    wilsonPp: wilsonPp(counts.tenantMentions, brandMentionTotal(counts)),
    deltaPp: deltaPpValue,
  };
}

/**
 * 30-day share-of-voice movement, in percentage points.
 *
 * Null unless BOTH windows clear the display threshold: a delta against a
 * window nobody was allowed to see is a number the reader cannot check, and
 * design §Metrics is explicit that deltas are muted and never coloured
 * precisely because they are the easiest thing on the page to over-read.
 */
function deltaPp(current: WindowCounts, previous: WindowCounts): number | null {
  if (current.n < MIN_N_AGGREGATE || previous.n < MIN_N_AGGREGATE) return null;
  const now = shareOfVoicePct(current);
  const then = shareOfVoicePct(previous);
  if (now === null || then === null) return null;
  return now - then;
}

/**
 * The four engine tiles plus the pooled "All engines" tile.
 *
 * The pooled row is summed samples, NOT an average of engine rates (design
 * §Metrics). With four engines whose `n` differ by an order of magnitude — they
 * do, because engines fail unevenly — an average of rates is a number that
 * describes no population.
 */
export async function engineMetrics(
  tenantId: string,
  database: typeof defaultDb = defaultDb,
  // The same injectable-clock seam as run.ts. The 30-day delta is the only
  // wall-clock-dependent number in this module; a bare `new Date()` in the
  // body would make every delta test rot as the calendar advances (the repo
  // has been bitten by exactly this class of flake before).
  now: () => Date = () => new Date()
): Promise<EngineMetrics[]> {
  const deltaBefore = new Date(now().getTime() - DELTA_DAYS * 24 * 60 * 60 * 1000);

  const out: EngineMetrics[] = [];
  for (const engine of ENGINE_IDS) {
    const counts = await windowCounts(tenantId, { engine }, database);
    const previous = await windowCounts(tenantId, { engine, before: deltaBefore }, database);
    out.push(toMetrics(engine, counts, deltaPp(counts, previous)));
  }

  const pooled = await windowCounts(tenantId, {}, database);
  const pooledPrevious = await windowCounts(tenantId, { before: deltaBefore }, database);
  out.push(toMetrics("all", pooled, deltaPp(pooled, pooledPrevious)));

  return out;
}
