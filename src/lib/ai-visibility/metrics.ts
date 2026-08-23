import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import {
  aiVisibilityAggregates,
  aiVisibilityCitations,
  aiVisibilityPrompts,
  aiVisibilityRuns,
  aiVisibilitySamples,
} from "@/db/schema";
import type { DomainClass } from "@/lib/ai-visibility/domains";
import { MIN_N_AGGREGATE, MIN_N_PROMPT } from "@/lib/ai-visibility/thresholds";
import {
  ENGINE_IDS,
  type EngineId,
  type EngineMetrics,
  type PromptIntent,
  type WindowCounts,
} from "@/lib/ai-visibility/types";

/** Design §Metrics: a rolling 4-run window, ~12 samples per prompt. */
export const WINDOW_RUNS = 4;
// The two display floors live in `./thresholds` so a client component can read
// them without pulling `@/db` into the browser bundle. Re-exported here because
// this is where every server-side caller already imports them from.
export { MIN_N_AGGREGATE, MIN_N_PROMPT };
/**
 * How many runs a trend plots. Design §UX calls it a "12-week sparkline", but
 * the unit is RUNS: cadence is a tenant setting and can be fortnightly, so
 * twelve of them is six months for some tenants. Anything that names this
 * number to a reader says "runs".
 */
export const HISTORY_RUNS = 12;
/** Design §Metrics: "Deltas are 30-day only". */
export const DELTA_DAYS = 30;

/** 95% two-sided normal quantile. */
const Z = 1.959963984540054;

/**
 * The 95% Wilson half-width for a proportion `p` observed over `n` independent
 * trials, in percentage points.
 *
 * Split out from `wilsonPp` because share of voice is a ratio whose numerator
 * and denominator are counted over DIFFERENT units: the numerator is mentions,
 * the denominator is mentions of every tracked brand — but the independent
 * observations are ANSWERS. See `toMetrics` for why that distinction is the
 * difference between a band that responds to evidence and one that responds to
 * how many competitors are typed into the settings page.
 */
function wilsonPpFromProportion(p: number, n: number): number | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  const clamped = Math.min(1, Math.max(0, p));
  const denominator = 1 + (Z * Z) / n;
  const half =
    (Z * Math.sqrt((clamped * (1 - clamped)) / n + (Z * Z) / (4 * n * n))) / denominator;
  return half * 100;
}

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
 * `±${value.toFixed(1)} pp` with no further arithmetic.
 *
 * CAUTION — the printed range can leave [0, 100]. The Wilson interval is not
 * symmetric about `p`: it is centred on the shrunk estimate
 * `(x + z²/2) / (n + z²)`, and only the half-width is returned here. At 0/30
 * this reports 5.7 pp against a rate of 0%, so a naive `p ± band` prints
 * [-5.7, +5.7] where the true Wilson interval is [0, 11.4] — the same width,
 * shifted. Anything rendering a RANGE rather than a `±` must pass through
 * `clampBand`, which at least refuses to print impossible values.
 */
export function wilsonPp(successes: number, n: number): number | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  return wilsonPpFromProportion(successes / n, n);
}

/**
 * The endpoints of a `rate ± band` range, clamped into [0, 100].
 *
 * Exported so no caller re-derives `Math.max(0, ...)` — a range that starts at
 * -5.7% is not a number anyone can read, and every surface that draws an error
 * bar or a "between x% and y%" string needs the same two lines.
 *
 * Honest about what it cannot do: clamping is not the same as recovering the
 * asymmetry described on `wilsonPp`. `clampBand(0, 5.7)` returns [0, 5.7],
 * whereas the exact Wilson interval for 0/30 is [0, 11.4]. The clamp removes
 * the impossible half of the range; it does not move the other half back out.
 * Reproducing the exact interval needs the successes and n, not the summarised
 * half-width, so a caller wanting that should build it from those directly.
 */
export function clampBand(sovPct: number, bandPp: number): { lowPp: number; highPp: number } {
  return {
    lowPp: Math.max(0, sovPct - bandPp),
    highPp: Math.min(100, sovPct + bandPp),
  };
}

const emptyCounts = (): WindowCounts => ({
  n: 0,
  nGrounded: 0,
  tenantMentions: 0,
  ownCitations: 0,
  recommendations: 0,
  competitorMentions: {},
});

/**
 * The run statuses every window on this page reads — the SETTLED ones.
 *
 * One list, used by both `windowRunIds` (the metrics window the tiles and the
 * benchmark sum) and `historyRuns` (the trend window the chart plots), because
 * they drifted apart once already and the result was a page arguing with
 * itself: `historyRuns` filtered `status = "complete"` alone, so a tenant whose
 * only run stopped at the cost cap read real numbers on every tile above a
 * chart that said "No runs yet".
 *
 * - No run still IN FLIGHT (`pending`, `running`): it has partial aggregates or
 *   none, and letting one in would make every number wobble for as long as the
 *   cron takes.
 * - `paused_by_cap` IS in, on both. It is terminal, not in flight — `runSlice`
 *   aggregates what it bought before the cap tripped and nothing ever resumes
 *   it — so excluding it throws away every answer the tenant paid for, which is
 *   the one outcome a cost cap must not have.
 * - `cancelled` IS in, for the same reason as `paused_by_cap` and by the same
 *   mechanism: a human pressing Stop ends the run where it stands, and
 *   `settleCancelledRun` aggregates the answers it had already bought. Those
 *   answers were paid for; `isEligible` has already dropped the errored and
 *   refused ones, so what is left is real. Excluding them would charge the
 *   tenant for measurements and then refuse to show them.
 * - `failed` is out: a run that never produced aggregates has nothing to plot.
 */
const SETTLED_RUN_STATUSES = ["complete", "paused_by_cap", "cancelled"] as const;

/** The ids of the last `runs` settled runs, newest first. */
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
        // See SETTLED_RUN_STATUSES: in flight is out, cap-paused is in.
        inArray(aiVisibilityRuns.status, [...SETTLED_RUN_STATUSES]),
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
      nGrounded: aiVisibilityAggregates.nGrounded,
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
    total.nGrounded += row.nGrounded;
    total.tenantMentions += row.tenantMentions;
    total.ownCitations += row.ownCitations;
    total.recommendations += row.recommendations;
    for (const [id, count] of Object.entries(row.competitorMentions ?? {})) {
      total.competitorMentions[id] = (total.competitorMentions[id] ?? 0) + count;
    }
  }
  return total;
}

/**
 * Total mentions of every tracked brand — the SOV denominator.
 *
 * Exported because the competitor bars are built from `listCompetitors`, and a
 * competitor deleted mid-window still has mentions in this total (deliberately:
 * a hard delete must not retroactively inflate the tenant's share). Without the
 * total, the bars silently sum to less than the headline and the missing slice
 * has no name. With it, the caller can draw the remainder as one "Other tracked
 * brands" bar.
 */
export function brandMentionTotal(counts: WindowCounts): number {
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
  // Citation rate is measured over the GROUNDED samples, so it gets the floor
  // applied to ITS OWN denominator rather than to `n`. Ungrounded answers cited
  // nothing, and folding them in as zeroes would deflate the rate by whatever
  // share of the window the engine chose not to search — the ungrounded-answers
  // design, decision 5. Null here renders as "—", not as 0%.
  const citationRate =
    counts.nGrounded < MIN_N_AGGREGATE ? null : (counts.ownCitations / counts.nGrounded) * 100;

  // Contract decision 8: below the threshold, every mention-family rate is null
  // and the tile reads "Collecting baseline". `n` is always real so the reader
  // can watch it grow.
  if (counts.n < MIN_N_AGGREGATE) {
    return {
      engine,
      n: counts.n,
      mentionRate: null,
      shareOfVoice: null,
      citationRate,
      recommendationRate: null,
      mentionWilsonPp: null,
      sovWilsonPp: null,
      deltaPp: null,
    };
  }
  return {
    engine,
    n: counts.n,
    mentionRate: (counts.tenantMentions / counts.n) * 100,
    shareOfVoice: shareOfVoicePct(counts),
    citationRate,
    recommendationRate: (counts.recommendations / counts.n) * 100,
    // The band the tile prints, and the one metric here that needs no
    // argument: mention rate is successes over trials in the same unit —
    // answers — so Wilson applies exactly as written. One mention per brand per
    // sample (design §Metrics) is what makes `tenantMentions` a count of
    // ANSWERS rather than of occurrences, and therefore <= n.
    mentionWilsonPp: wilsonPp(counts.tenantMentions, counts.n),
    // The estimand is the SOV proportion; the EVIDENCE is answers.
    //
    // Using total brand mentions as the trial count (the obvious reading of
    // "successes out of the denominator") makes the band a function of the
    // competitor roster rather than of the data: the same 84 answers and 26
    // mentions report ±9.5 pp against two competitors and ±4.5 pp against six,
    // so typing four names into settings appears to double the precision. It is
    // also not a binomial: one answer can contribute up to 1 + |competitors|
    // "trials", which are perfectly correlated within that answer, so the
    // variance is understated on top of the inflation.
    //
    // Anchoring n to answers fixes both. `min` because the mention total is
    // genuinely smaller than n whenever most answers name nobody, and the band
    // must not claim more evidence than there were brand mentions to observe.
    sovWilsonPp: wilsonPpFromProportion(
      (shareOfVoicePct(counts) ?? 0) / 100,
      Math.min(brandMentionTotal(counts), counts.n)
    ),
    deltaPp: deltaPpValue,
  };
}

/**
 * 30-day share-of-voice movement, in percentage points.
 *
 * Computed, and currently rendered nowhere: the overview tile printed it until
 * the damping described below was judged to outweigh what one number could add
 * beside a 12-week sparkline. Kept for a surface that can give it context.
 *
 * Read it as "versus what the window said 30 days ago", NOT as "this period
 * versus the previous period". The two windows are both the last four complete
 * runs as of their own cut date, so they OVERLAP: at fortnightly cadence a
 * 30-day-old window shares two of its four runs with the current one, and below
 * eight lifetime runs it shares almost all of them. That makes the delta a
 * damped, self-correlated figure — it moves later and smaller than a true
 * period-over-period comparison would. Disjoint windows were not chosen because
 * a tenant needs eight complete runs before either would be readable at all.
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

export type EngineMetricsResult = {
  /** One row per engine, then the pooled `"all"` row, in `ENGINE_IDS` order. */
  metrics: EngineMetrics[];
  /**
   * The CURRENT-window cuts those rows were computed from, keyed by engine plus
   * `"all"`.
   *
   * Handed back rather than discarded because the overview needs the raw counts
   * as well as the rates: `competitorMentions` is keyed by competitor id and is
   * what the benchmark card's bars are built from, and it survives nowhere on
   * `EngineMetrics` (share of voice is already collapsed to one number). The
   * page used to re-issue the same four cuts — eight queries, on the critical
   * path, for rows this function had already read.
   *
   * The delta cuts are deliberately NOT returned: nothing outside this module
   * has a use for a window that ends 30 days ago, and half a cache is worse
   * than none.
   */
  counts: Record<EngineId | "all", WindowCounts>;
};

/**
 * The three engine tiles plus the pooled "All engines" tile.
 *
 * The pooled row is summed samples, NOT an average of engine rates (design
 * §Metrics). With three engines whose `n` differ by an order of magnitude — they
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
): Promise<EngineMetricsResult> {
  const deltaBefore = new Date(now().getTime() - DELTA_DAYS * 24 * 60 * 60 * 1000);

  // Ten independent reads, issued together. Serially this is twenty round trips
  // (each `windowCounts` is two queries) on the page's critical path, for
  // numbers that share nothing and cannot disagree with each other.
  const [current, previous] = await Promise.all([
    Promise.all([
      ...ENGINE_IDS.map((engine) => windowCounts(tenantId, { engine }, database)),
      windowCounts(tenantId, {}, database),
    ]),
    Promise.all([
      ...ENGINE_IDS.map((engine) => windowCounts(tenantId, { engine, before: deltaBefore }, database)),
      windowCounts(tenantId, { before: deltaBefore }, database),
    ]),
  ]);

  const keys = [...ENGINE_IDS, "all" as const];
  return {
    metrics: keys.map((engine, i) => toMetrics(engine, current[i], deltaPp(current[i], previous[i]))),
    counts: Object.fromEntries(keys.map((engine, i) => [engine, current[i]])) as Record<
      EngineId | "all",
      WindowCounts
    >,
  };
}

export type PromptMatrixCell = {
  engine: EngineId;
  hits: number;
  n: number;
  /**
   * How many DISTINCT tracked competitors were named on this prompt/engine over
   * the window — the difference between the two findings a `0/3` used to
   * collapse into one cell.
   *
   * A `0/3` where three rivals were named is a gap to write against: the engine
   * answers this question with brands, and none of them is ours. A `0/3` where
   * nobody was named at all is the opposite — the engine answers without
   * naming anyone, and no comparison page will change that. They rendered
   * identically because `hits` counts us and nothing else.
   *
   * Distinct competitors rather than total competitor mentions: "3 rivals show
   * up here" is the fact a marketer acts on, and a mention total is a bigger
   * number over a different unit sitting in the same cell as "2 of 3 answers",
   * which is exactly the kind of quiet unit mismatch this feature keeps
   * arranging itself against. A competitor deleted from the profile mid-window
   * still counts, for the same reason `brandMentionTotal` keeps counting it.
   */
  competitorsNamed: number;
};
export type PromptMatrixRow = {
  promptId: string;
  text: string;
  intent: PromptIntent;
  branded: boolean;
  cells: PromptMatrixCell[];
};

/**
 * One row per active prompt, one cell per engine, over the rolling window.
 *
 * Returns raw `{ hits, n }` and applies NO threshold. The display rule ("2 of
 * 3 samples", hidden below MIN_N_PROMPT) belongs to the cell component, which
 * also has to distinguish a thin cut from an engine that failed — a decision
 * that needs `runEngineHealth`, not this. Returning null here would collapse
 * those two states into one.
 *
 * Every engine gets a cell whether or not it has data, so the matrix is
 * rectangular and the header never has to be derived from the rows.
 */
export async function promptMatrix(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<PromptMatrixRow[]> {
  const prompts = await database
    .select({
      id: aiVisibilityPrompts.id,
      text: aiVisibilityPrompts.text,
      intent: aiVisibilityPrompts.intent,
      branded: aiVisibilityPrompts.branded,
    })
    .from(aiVisibilityPrompts)
    .where(and(eq(aiVisibilityPrompts.tenantId, tenantId), eq(aiVisibilityPrompts.status, "active")))
    // `id` breaks the tie, and the tie is the common case rather than the edge
    // one: a generated set is a single batched INSERT, and Postgres `now()` is
    // the TRANSACTION timestamp, so all ~30 rows carry the same `created_at`.
    // Without the tiebreak the matrix reshuffles between page loads.
    .orderBy(asc(aiVisibilityPrompts.createdAt), asc(aiVisibilityPrompts.id));
  if (prompts.length === 0) return [];

  const runIds = await windowRunIds(tenantId, WINDOW_RUNS, undefined, database);
  // The competitor ids are accumulated as a SET per cell rather than as a
  // count: the same rival appears in every run of the window, and adding four
  // runs' keys together would report one competitor as four.
  const byKey = new Map<string, { hits: number; n: number; competitors: Set<string> }>();
  if (runIds.length > 0) {
    const rows = await database
      .select({
        promptId: aiVisibilityAggregates.promptId,
        engine: aiVisibilityAggregates.engine,
        n: aiVisibilityAggregates.n,
        tenantMentions: aiVisibilityAggregates.tenantMentions,
        competitorMentions: aiVisibilityAggregates.competitorMentions,
      })
      .from(aiVisibilityAggregates)
      .where(
        and(
          inArray(aiVisibilityAggregates.runId, runIds),
          inArray(
            aiVisibilityAggregates.promptId,
            prompts.map((p) => p.id)
          )
        )
      );
    for (const row of rows) {
      if (!row.promptId) continue;
      const key = `${row.promptId} ${row.engine}`;
      const cell = byKey.get(key) ?? { hits: 0, n: 0, competitors: new Set<string>() };
      cell.hits += row.tenantMentions;
      cell.n += row.n;
      for (const [id, count] of Object.entries(row.competitorMentions ?? {})) {
        // A key with a zero count is a competitor the aggregate wrote down and
        // did not observe; counting it would name a rival on a prompt where no
        // answer mentioned one.
        if (count > 0) cell.competitors.add(id);
      }
      byKey.set(key, cell);
    }
  }

  return prompts.map((prompt) => ({
    promptId: prompt.id,
    text: prompt.text,
    intent: prompt.intent as PromptIntent,
    branded: prompt.branded,
    cells: ENGINE_IDS.map((engine) => {
      const cell = byKey.get(`${prompt.id} ${engine}`);
      return {
        engine,
        hits: cell?.hits ?? 0,
        n: cell?.n ?? 0,
        competitorsNamed: cell?.competitors.size ?? 0,
      };
    }),
  }));
}

/**
 * Settled runs for a tenant, oldest first, most recent `HISTORY_RUNS` of them.
 *
 * The SAME status filter the metrics window uses — see `SETTLED_RUN_STATUSES`.
 * This used to read `status = "complete"` alone while `windowRunIds` also took
 * `paused_by_cap`, so the two windows could disagree about whether a tenant had
 * any runs at all.
 */
async function historyRuns(
  tenantId: string,
  database: typeof defaultDb
): Promise<{ id: string; startedAt: Date; modelIds: Record<string, string> }[]> {
  const rows = await database
    .select({
      id: aiVisibilityRuns.id,
      startedAt: aiVisibilityRuns.startedAt,
      modelIds: aiVisibilityRuns.modelIds,
    })
    .from(aiVisibilityRuns)
    .where(
      and(
        eq(aiVisibilityRuns.tenantId, tenantId),
        inArray(aiVisibilityRuns.status, [...SETTLED_RUN_STATUSES])
      )
    )
    .orderBy(desc(aiVisibilityRuns.startedAt))
    .limit(HISTORY_RUNS);
  // Newest-first for the LIMIT, oldest-first for the chart. Reversing here is
  // what keeps every caller from having to remember which way round it is.
  return rows.reverse().map((r) => ({ ...r, modelIds: r.modelIds ?? {} }));
}

export type PromptHistoryPoint = {
  runId: string;
  runDate: string;
  hits: number;
  n: number;
  modelId: string | null;
};

/**
 * One prompt's last 12 runs — the sparkline on the prompt detail page.
 *
 * `modelId` is null for `"all"`: three engines do not share a model, and
 * inventing one would put a false tick mark on the chart.
 *
 * `tenantId` is in the WHERE clause, not merely validated by the caller.
 * `promptId` arrives from the URL, and reading the tenant OFF the prompt row —
 * as this did — means any id that exists returns that owner's series to
 * whoever asked. The page's own ownership guard is not a substitute: this
 * function must be safe when called with an attacker-chosen id.
 */
export async function promptHistory(
  tenantId: string,
  promptId: string,
  engine: EngineId | "all",
  database: typeof defaultDb = defaultDb
): Promise<PromptHistoryPoint[]> {
  const [prompt] = await database
    .select({ tenantId: aiVisibilityPrompts.tenantId })
    .from(aiVisibilityPrompts)
    .where(and(eq(aiVisibilityPrompts.id, promptId), eq(aiVisibilityPrompts.tenantId, tenantId)));
  if (!prompt) return [];

  const runs = await historyRuns(prompt.tenantId, database);
  if (runs.length === 0) return [];

  const rows = await database
    .select({
      runId: aiVisibilityAggregates.runId,
      n: aiVisibilityAggregates.n,
      tenantMentions: aiVisibilityAggregates.tenantMentions,
    })
    .from(aiVisibilityAggregates)
    .where(
      and(
        inArray(
          aiVisibilityAggregates.runId,
          runs.map((r) => r.id)
        ),
        eq(aiVisibilityAggregates.promptId, promptId),
        ...(engine === "all" ? [] : [eq(aiVisibilityAggregates.engine, engine)])
      )
    );

  const byRun = new Map<string, { hits: number; n: number }>();
  for (const row of rows) {
    const point = byRun.get(row.runId) ?? { hits: 0, n: 0 };
    point.hits += row.tenantMentions;
    point.n += row.n;
    byRun.set(row.runId, point);
  }

  return runs.map((run) => {
    const point = byRun.get(run.id) ?? { hits: 0, n: 0 };
    return {
      runId: run.id,
      runDate: run.startedAt.toISOString(),
      hits: point.hits,
      n: point.n,
      modelId: engine === "all" ? null : (run.modelIds[engine] ?? null),
    };
  });
}

export type EngineHistoryPoint = {
  runId: string;
  runDate: string;
  /** The series the tile plots, because it is the series the tile headlines. */
  mentionPct: number | null;
  sovPct: number | null;
  modelId: string | null;
};

/**
 * One engine's last 12 runs — the tile sparkline.
 *
 * Both series, from the same counts and under the same rule. The sparkline
 * draws `mentionPct`: a tile whose big number is mention rate and whose line is
 * share of voice contradicts itself, and the two genuinely diverge — a tenant
 * can hold its mention rate while its share halves because a competitor started
 * appearing beside it. `sovPct` stays because it costs one division over counts
 * already summed here, and the benchmark card below the tiles is a share
 * surface with no history of its own yet.
 *
 * Both are null below MIN_N_AGGREGATE so the line BREAKS rather than dropping
 * to zero. A thin run rendered as 0% is the single most misleading thing this
 * chart could do: it looks exactly like losing every mention.
 */
export async function engineHistory(
  tenantId: string,
  engine: EngineId | "all",
  database: typeof defaultDb = defaultDb
): Promise<EngineHistoryPoint[]> {
  const runs = await historyRuns(tenantId, database);
  if (runs.length === 0) return [];

  const rows = await database
    .select({
      runId: aiVisibilityAggregates.runId,
      n: aiVisibilityAggregates.n,
      tenantMentions: aiVisibilityAggregates.tenantMentions,
      competitorMentions: aiVisibilityAggregates.competitorMentions,
    })
    .from(aiVisibilityAggregates)
    .where(
      and(
        inArray(
          aiVisibilityAggregates.runId,
          runs.map((r) => r.id)
        ),
        isNull(aiVisibilityAggregates.promptId),
        ...(engine === "all" ? [] : [eq(aiVisibilityAggregates.engine, engine)])
      )
    );

  const byRun = new Map<string, WindowCounts>();
  for (const row of rows) {
    const counts = byRun.get(row.runId) ?? emptyCounts();
    counts.n += row.n;
    counts.tenantMentions += row.tenantMentions;
    for (const [id, count] of Object.entries(row.competitorMentions ?? {})) {
      counts.competitorMentions[id] = (counts.competitorMentions[id] ?? 0) + count;
    }
    byRun.set(row.runId, counts);
  }

  return runs.map((run) => {
    const counts = byRun.get(run.id);
    const publishable = counts !== undefined && counts.n >= MIN_N_AGGREGATE;
    return {
      runId: run.id,
      runDate: run.startedAt.toISOString(),
      mentionPct: publishable ? (counts.tenantMentions / counts.n) * 100 : null,
      sovPct: publishable ? shareOfVoicePct(counts) : null,
      modelId: engine === "all" ? null : (run.modelIds[engine] ?? null),
    };
  });
}

export type RunEngineHealth = {
  engine: EngineId;
  totalSamples: number;
  okSamples: number;
  erroredSamples: number;
  refusedSamples: number;
  /** Distinct prompts with at least one errored sample — the number in "failed on 9 prompts". */
  erroredPrompts: number;
  /**
   * WHICH prompts those were.
   *
   * The count alone forced the matrix to dash a whole engine column: knowing
   * that Gemini failed on 9 of 30 prompts says nothing about which 9, so every
   * cell had to be treated as suspect and 21 good readings were erased with
   * them. The ids are already in hand here — `erroredPrompts` is this list's
   * length — so carrying them costs nothing and is the difference between
   * "this cell has no answer" and "this engine had a bad run".
   */
  erroredPromptIds: string[];
  lastError: string | null;
};

/**
 * Per-engine coverage for one run (design §States: "Partial failure").
 *
 * Errored and refused are counted separately because they are different facts
 * with the same consequence: an engine that rate-limited is broken, an engine
 * that declined to search answered honestly with nothing. Both are excluded
 * from rates; only one is worth telling the operator to go look at.
 *
 * `pending` rows are not counted at all — not as total, and not as a failure.
 * `planRun` inserts the entire grid up front, so a run one slice in has
 * hundreds of pending rows, and counting them would render an in-flight run as
 * "3 of 270 answered": a catastrophe line for a healthy run. Coverage here
 * means coverage of what has been ATTEMPTED.
 *
 * `tenantId` is in the WHERE clause for the same reason as `promptSamples`:
 * `runId` reaches this from a URL.
 */
export async function runEngineHealth(
  tenantId: string,
  runId: string,
  database: typeof defaultDb = defaultDb
): Promise<RunEngineHealth[]> {
  const rows = await database
    .select({
      engine: aiVisibilitySamples.engine,
      promptId: aiVisibilitySamples.promptId,
      status: aiVisibilitySamples.status,
      error: aiVisibilitySamples.error,
      askedAt: aiVisibilitySamples.askedAt,
    })
    .from(aiVisibilitySamples)
    .where(and(eq(aiVisibilitySamples.runId, runId), eq(aiVisibilitySamples.tenantId, tenantId)))
    .orderBy(asc(aiVisibilitySamples.askedAt));

  const byEngine = new Map<
    string,
    { total: number; ok: number; errored: number; refused: number; prompts: Set<string>; lastError: string | null }
  >();
  for (const row of rows) {
    // Not yet attempted, so it is neither coverage nor a gap in it.
    if (row.status === "pending") continue;
    const entry =
      byEngine.get(row.engine) ??
      { total: 0, ok: 0, errored: 0, refused: 0, prompts: new Set<string>(), lastError: null };
    entry.total += 1;
    if (row.status === "ok") entry.ok += 1;
    if (row.status === "refused") entry.refused += 1;
    if (row.status === "error") {
      entry.errored += 1;
      entry.prompts.add(row.promptId);
      // Ordered by askedAt above, so the last one assigned is the most recent.
      if (row.error) entry.lastError = row.error;
    }
    byEngine.set(row.engine, entry);
  }

  return ENGINE_IDS.filter((engine) => byEngine.has(engine)).map((engine) => {
    const entry = byEngine.get(engine)!;
    return {
      engine,
      totalSamples: entry.total,
      okSamples: entry.ok,
      erroredSamples: entry.errored,
      refusedSamples: entry.refused,
      erroredPrompts: entry.prompts.size,
      erroredPromptIds: [...entry.prompts],
      lastError: entry.lastError,
    };
  });
}

export type PromptSampleCitation = { url: string; domain: string; domainClass: DomainClass; position: number };

export type PromptSample = {
  id: string;
  runId: string;
  engine: EngineId;
  sampleIndex: number;
  status: string;
  askedAt: Date | null;
  modelId: string | null;
  answerText: string | null;
  error: string | null;
  flagged: boolean;
  framing: string | null;
  quote: string | null;
  level: "absent" | "mentioned" | "described" | "recommended" | null;
  citations: PromptSampleCitation[];
};

/** How many samples per engine the prompt detail page stacks by default. */
const DEFAULT_PROMPT_SAMPLE_LIMIT = 12;

/**
 * The raw answers behind one prompt — section 2 of the prompt detail page.
 *
 * `tenantId` is the security boundary and is in the WHERE clause, not merely
 * validated: `promptId` arrives from the URL, and a tenant-less query would
 * hand any logged-in user any other tenant's raw answers.
 *
 * The limit applies PER ENGINE when no engine is given, so a three-tab strip
 * gets a full set for each tab rather than twelve rows that all belong to
 * whichever engine answered most recently.
 *
 * One bounded query PER ENGINE rather than one over-fetch of `limit × 4` rows
 * partitioned in JS. The over-fetch silently under-returns whenever one engine
 * owns more than its quarter of the newest rows — which is the normal case, not
 * a pathological one: at `samplesPerPrompt: 5` over several runs, one engine's
 * recent answers alone exceed the ceiling and the quieter engines come back
 * empty even though their rows exist. Three small indexed reads issued together
 * cost less than the one over-fetch did, and cannot lie.
 */
export async function promptSamples(
  tenantId: string,
  promptId: string,
  opts: { engine?: EngineId; limit?: number },
  database: typeof defaultDb = defaultDb
): Promise<PromptSample[]> {
  const limit = opts.limit ?? DEFAULT_PROMPT_SAMPLE_LIMIT;
  const engines = opts.engine ? [opts.engine] : ENGINE_IDS;

  const perEngineRows = await Promise.all(
    engines.map((engine) =>
      database
        .select({
          id: aiVisibilitySamples.id,
          runId: aiVisibilitySamples.runId,
          engine: aiVisibilitySamples.engine,
          sampleIndex: aiVisibilitySamples.sampleIndex,
          status: aiVisibilitySamples.status,
          askedAt: aiVisibilitySamples.askedAt,
          modelId: aiVisibilitySamples.modelId,
          answerText: aiVisibilitySamples.answerText,
          error: aiVisibilitySamples.error,
          flagged: aiVisibilitySamples.flagged,
          extraction: aiVisibilitySamples.extraction,
        })
        .from(aiVisibilitySamples)
        .where(
          and(
            eq(aiVisibilitySamples.tenantId, tenantId),
            eq(aiVisibilitySamples.promptId, promptId),
            eq(aiVisibilitySamples.engine, engine)
          )
        )
        // Newest first. NULLS LAST so a still-pending row does not head the list.
        .orderBy(
          sql`${aiVisibilitySamples.askedAt} DESC NULLS LAST`,
          asc(aiVisibilitySamples.sampleIndex)
        )
        .limit(limit)
    )
  );

  // Flattened back into one newest-first list so a caller that does not split
  // by engine still reads in a sensible order.
  const kept = perEngineRows.flat().sort((a, b) => {
    const at = a.askedAt?.getTime() ?? -Infinity;
    const bt = b.askedAt?.getTime() ?? -Infinity;
    return bt - at || a.sampleIndex - b.sampleIndex || a.engine.localeCompare(b.engine);
  });
  if (kept.length === 0) return [];

  const citations = await database
    .select({
      sampleId: aiVisibilityCitations.sampleId,
      url: aiVisibilityCitations.url,
      domain: aiVisibilityCitations.domain,
      domainClass: aiVisibilityCitations.domainClass,
      position: aiVisibilityCitations.position,
    })
    .from(aiVisibilityCitations)
    .where(
      inArray(
        aiVisibilityCitations.sampleId,
        kept.map((r) => r.id)
      )
    )
    .orderBy(asc(aiVisibilityCitations.position));

  const bySample = new Map<string, PromptSampleCitation[]>();
  for (const citation of citations) {
    const list = bySample.get(citation.sampleId) ?? [];
    list.push({
      url: citation.url,
      domain: citation.domain,
      domainClass: citation.domainClass as DomainClass,
      position: citation.position,
    });
    bySample.set(citation.sampleId, list);
  }

  return kept.map((row) => ({
    id: row.id,
    runId: row.runId,
    engine: row.engine as EngineId,
    sampleIndex: row.sampleIndex,
    status: row.status,
    askedAt: row.askedAt,
    modelId: row.modelId,
    answerText: row.answerText,
    error: row.error,
    flagged: row.flagged,
    framing: row.extraction?.judged?.framing ?? null,
    quote: row.extraction?.judged?.quote ?? null,
    level: row.extraction?.judged?.level ?? null,
    citations: bySample.get(row.id) ?? [],
  }));
}
