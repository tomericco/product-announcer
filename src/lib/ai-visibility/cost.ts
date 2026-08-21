import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { aiVisibilityPrompts, aiVisibilityRuns } from "@/db/schema";
import { engineCost } from "@/lib/ai-visibility/engines";
import { roundUsd } from "@/lib/ai-visibility/money";
import { ENGINE_IDS, type EngineId } from "@/lib/ai-visibility/types";

/**
 * What one run would cost at list prices.
 *
 * Deliberately flat — `promptCount × engines × samplesPerPrompt` — because the
 * settings card recomputes it live as the user toggles engines and samples, and
 * that surface has no prompt intents to hand. The brand-check exception (one
 * sample, never `samplesPerPrompt`) is applied by the caller composing two
 * calls; `capExceeded` below is the reference for how.
 *
 * Unknown engine ids contribute nothing rather than NaN. `settings.engines` is
 * a `text[]`, so a stale or hand-edited value can reach here, and a NaN
 * estimate would make every comparison against the cap false — the cap would
 * silently stop working, which is the one failure this module must not have.
 */
export function estimateRunCost(a: {
  promptCount: number;
  engines: EngineId[];
  samplesPerPrompt: number;
}): number {
  const calls = Math.max(0, a.promptCount) * Math.max(0, a.samplesPerPrompt);
  if (calls === 0) return 0;
  const perCall = a.engines
    .filter((e): e is EngineId => (ENGINE_IDS as readonly string[]).includes(e))
    .reduce((sum, e) => sum + engineCost(e), 0);
  return calls * perCall;
}

/** First instant of `now`'s calendar month, UTC. The cap is a calendar-month cap. */
export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** First instant of the following calendar month, UTC. Rolls the year in December. */
export function nextMonthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * This tenant's spend so far in `now`'s calendar month.
 *
 * Bounded on both sides rather than just `>= monthStart`: tests (and a clock
 * skew in production) can leave a run row dated after `now`, and a cap that
 * counted next month's runs against this month's budget would pause a tenant
 * for a reason nobody could find.
 *
 * `sum` over a `real` column comes back as `double precision`; the cast and the
 * `coalesce` keep an empty month at `0` instead of `null`.
 *
 * Rounded to cents on the way out. Summing float4 sample costs produces values
 * like 0.036000000312924385, and this number is both compared against a cap
 * that IS rounded (`getAiVisibilitySettings` rounds it) and rendered verbatim
 * on the settings card as "Spent this month $X of $Y". Rounding one side and
 * not the other is how a tenant ends up a fraction of a cent the wrong side of
 * their own cap, with fifteen decimal places on screen explaining it.
 */
export async function monthToDateSpendUsd(
  tenantId: string,
  now: Date,
  database: typeof defaultDb = defaultDb
): Promise<number> {
  const [row] = await database
    .select({ total: sql<number>`coalesce(sum(${aiVisibilityRuns.costUsd}), 0)::float8` })
    .from(aiVisibilityRuns)
    .where(
      and(
        eq(aiVisibilityRuns.tenantId, tenantId),
        gte(aiVisibilityRuns.startedAt, monthStartUtc(now)),
        lt(aiVisibilityRuns.startedAt, nextMonthStartUtc(now))
      )
    );
  return roundUsd(Number(row?.total ?? 0));
}

export type CapState = {
  spentUsd: number;
  estimateUsd: number;
  capUsd: number;
  /** Pre-run gate: this month's spend plus the next run would cross the cap. */
  exceeded: boolean;
  /** Mid-run gate: spend alone is already at or over the cap. */
  reached: boolean;
};

/**
 * The hard cost gate (design §"Cost cap": a hard pause, never a warning).
 *
 * `exceeded` and `reached` are different questions on purpose — see the module
 * note in the plan. `planRun` refuses on `exceeded`; `runSlice` pauses a
 * running run on `reached`, because by then the run's own spend is inside
 * `spentUsd` and the pre-run predicate would be self-fulfilling.
 *
 * Prompts are counted here rather than passed in so there is exactly one place
 * that knows brand-check prompts cost one sample.
 */
export async function capExceeded(
  tenantId: string,
  settings: { engines: string[]; samplesPerPrompt: number; monthlyCapUsd: number },
  now: Date,
  database: typeof defaultDb = defaultDb
): Promise<CapState> {
  const engines = settings.engines.filter((e): e is EngineId =>
    (ENGINE_IDS as readonly string[]).includes(e)
  );

  const [counts] = await database
    .select({
      branded: sql<number>`count(*) filter (where ${aiVisibilityPrompts.intent} = 'brand_check')::int`,
      other: sql<number>`count(*) filter (where ${aiVisibilityPrompts.intent} <> 'brand_check')::int`,
    })
    .from(aiVisibilityPrompts)
    .where(and(eq(aiVisibilityPrompts.tenantId, tenantId), eq(aiVisibilityPrompts.status, "active")));

  const estimateUsd =
    estimateRunCost({ promptCount: counts?.other ?? 0, engines, samplesPerPrompt: settings.samplesPerPrompt }) +
    estimateRunCost({ promptCount: counts?.branded ?? 0, engines, samplesPerPrompt: 1 });

  const spentUsd = await monthToDateSpendUsd(tenantId, now, database);
  const capUsd = settings.monthlyCapUsd;

  return {
    spentUsd,
    estimateUsd,
    capUsd,
    exceeded: spentUsd + estimateUsd > capUsd,
    reached: spentUsd >= capUsd,
  };
}
