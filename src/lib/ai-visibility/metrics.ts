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
import {
  ENGINE_IDS,
  type EngineId,
  type EngineMetrics,
  type PromptIntent,
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

export type PromptMatrixCell = { engine: EngineId; hits: number; n: number };
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
    .orderBy(asc(aiVisibilityPrompts.createdAt));
  if (prompts.length === 0) return [];

  const runIds = await windowRunIds(tenantId, WINDOW_RUNS, undefined, database);
  const byKey = new Map<string, { hits: number; n: number }>();
  if (runIds.length > 0) {
    const rows = await database
      .select({
        promptId: aiVisibilityAggregates.promptId,
        engine: aiVisibilityAggregates.engine,
        n: aiVisibilityAggregates.n,
        tenantMentions: aiVisibilityAggregates.tenantMentions,
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
      const cell = byKey.get(key) ?? { hits: 0, n: 0 };
      cell.hits += row.tenantMentions;
      cell.n += row.n;
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
      return { engine, hits: cell?.hits ?? 0, n: cell?.n ?? 0 };
    }),
  }));
}

/** Complete runs for a tenant, oldest first, most recent `HISTORY_RUNS` of them. */
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
    .where(and(eq(aiVisibilityRuns.tenantId, tenantId), eq(aiVisibilityRuns.status, "complete")))
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
 * `modelId` is null for `"all"`: four engines do not share a model, and
 * inventing one would put a false tick mark on the chart.
 */
export async function promptHistory(
  promptId: string,
  engine: EngineId | "all",
  database: typeof defaultDb = defaultDb
): Promise<PromptHistoryPoint[]> {
  const [prompt] = await database
    .select({ tenantId: aiVisibilityPrompts.tenantId })
    .from(aiVisibilityPrompts)
    .where(eq(aiVisibilityPrompts.id, promptId));
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
  sovPct: number | null;
  modelId: string | null;
};

/**
 * One engine's last 12 runs of share of voice — the tile sparkline.
 *
 * `sovPct` is null below MIN_N_AGGREGATE so the line BREAKS rather than
 * dropping to zero. A thin run rendered as 0% is the single most misleading
 * thing this chart could do: it looks exactly like losing every mention.
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
    return {
      runId: run.id,
      runDate: run.startedAt.toISOString(),
      sovPct: counts && counts.n >= MIN_N_AGGREGATE ? shareOfVoicePct(counts) : null,
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
  lastError: string | null;
};

/**
 * Per-engine coverage for one run (design §States: "Partial failure").
 *
 * Errored and refused are counted separately because they are different facts
 * with the same consequence: an engine that rate-limited is broken, an engine
 * that declined to search answered honestly with nothing. Both are excluded
 * from rates; only one is worth telling the operator to go look at.
 */
export async function runEngineHealth(
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
    .where(eq(aiVisibilitySamples.runId, runId))
    .orderBy(asc(aiVisibilitySamples.askedAt));

  const byEngine = new Map<
    string,
    { total: number; ok: number; errored: number; refused: number; prompts: Set<string>; lastError: string | null }
  >();
  for (const row of rows) {
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
 * The limit applies PER ENGINE when no engine is given, so a four-tab strip
 * gets a full set for each tab rather than twelve rows that all belong to
 * whichever engine answered most recently.
 *
 * Two queries, never N+1: the samples, then their citations in one `inArray`.
 */
export async function promptSamples(
  tenantId: string,
  promptId: string,
  opts: { engine?: EngineId; limit?: number },
  database: typeof defaultDb = defaultDb
): Promise<PromptSample[]> {
  const limit = opts.limit ?? DEFAULT_PROMPT_SAMPLE_LIMIT;

  const rows = await database
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
        ...(opts.engine ? [eq(aiVisibilitySamples.engine, opts.engine)] : [])
      )
    )
    // Newest first. NULLS LAST so a still-pending row does not head the list.
    .orderBy(sql`${aiVisibilitySamples.askedAt} DESC NULLS LAST`, asc(aiVisibilitySamples.sampleIndex))
    // Bounded generously, then cut per engine below — one query beats four.
    .limit(limit * ENGINE_IDS.length);

  const perEngine = new Map<string, number>();
  const kept = rows.filter((row) => {
    const seen = perEngine.get(row.engine) ?? 0;
    if (seen >= limit) return false;
    perEngine.set(row.engine, seen + 1);
    return true;
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
