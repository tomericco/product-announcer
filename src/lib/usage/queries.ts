import { and, eq, gte, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { llmUsage } from "@/db/schema";
import { featureForOperation, byokEngineLabel, type FeatureKey } from "@/lib/usage/features";

/**
 * The usage tab's read side. Live GROUP BY over `llm_usage` — no rollup
 * tables, deliberately: the daily-only Hobby cron would make a rollup stale
 * by design, and the table is small and tenant-scoped (see the spec).
 *
 * CREDITS = COALESCE(total_tokens, 0), uniformly. Rows with
 * `operation = 'ai_visibility_engine'` are BYOK sweep tokens: excluded from
 * every credit aggregate here and selected exclusively by the byok*
 * functions. All bucketing is UTC; weeks are ISO Mondays.
 */

export type Granularity = "daily" | "weekly" | "monthly";
export type UsagePoint = { bucket: string; feature: FeatureKey; credits: number };

const BYOK_OPERATION = "ai_visibility_engine";

const TRUNC_UNIT: Record<Granularity, string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
};

/** "YYYY-MM-DD" for daily/weekly buckets, "YYYY-MM" for monthly. */
function keyFor(granularity: Granularity, date: Date): string {
  const iso = date.toISOString();
  return granularity === "monthly" ? iso.slice(0, 7) : iso.slice(0, 10);
}

/** UTC midnight of `date`'s ISO week's Monday. */
function isoWeekStart(date: Date): Date {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const back = (day.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  day.setUTCDate(day.getUTCDate() - back);
  return day;
}

export function windowStart(granularity: Granularity, now: Date): Date {
  if (granularity === "daily") {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    start.setUTCDate(start.getUTCDate() - 29);
    return start;
  }
  if (granularity === "weekly") {
    const start = isoWeekStart(now);
    start.setUTCDate(start.getUTCDate() - 11 * 7);
    return start;
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
}

/**
 * Every bucket key in the window, oldest first, current period last — the
 * zero-fill skeleton the chart plots over. Generated in code rather than SQL
 * so an empty week is a visible gap instead of a missing bar.
 */
export function bucketKeys(granularity: Granularity, now: Date): string[] {
  const keys: string[] = [];
  if (granularity === "daily") {
    const cursor = windowStart("daily", now);
    for (let i = 0; i < 30; i++) {
      keys.push(keyFor("daily", cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  } else if (granularity === "weekly") {
    const cursor = windowStart("weekly", now);
    for (let i = 0; i < 12; i++) {
      keys.push(keyFor("weekly", cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 7);
    }
  } else {
    for (let i = 11; i >= 0; i--) {
      keys.push(keyFor("monthly", new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
    }
  }
  return keys;
}

/**
 * `created_at` is timestamptz; truncating `created_at AT TIME ZONE 'UTC'`
 * pins the bucket boundary to UTC midnight regardless of the server TZ, and
 * `to_char` keys it as text so no Date round-trips through the driver.
 *
 * The unit and pattern are embedded as raw SQL text (not bound params) even
 * though they're both internally-controlled, typed constants (never user
 * input, so no injection risk): this same expression object is used in both
 * `.select()` and `.groupBy()` below, and Drizzle re-serializes it at each
 * call site with fresh `$n` placeholders. Two bound params holding the same
 * value are still distinct Param nodes to Postgres's GROUP BY validity
 * check, so parameterizing them made the select-list expression fail to
 * match its own group-by expression ("column ... must appear in the GROUP
 * BY clause"). Raw literal text is identical at every call site, so the
 * check passes.
 */
function bucketExpr(granularity: Granularity) {
  const unit = sql.raw(`'${TRUNC_UNIT[granularity]}'`);
  const pattern = sql.raw(`'${granularity === "monthly" ? "YYYY-MM" : "YYYY-MM-DD"}'`);
  return sql<string>`to_char(date_trunc(${unit}, ${llmUsage.createdAt} at time zone 'UTC'), ${pattern})`;
}

const creditsExpr = sql<number>`coalesce(sum(coalesce(${llmUsage.totalTokens}, 0)), 0)::int`;

/** bucket × feature credit sums over the granularity's window. Not zero-filled. */
export async function creditsByPeriod(
  tenantId: string,
  granularity: Granularity,
  now: Date = new Date()
): Promise<UsagePoint[]> {
  const bucket = bucketExpr(granularity);
  const rows = await db
    .select({ bucket, operation: llmUsage.operation, credits: creditsExpr })
    .from(llmUsage)
    .where(
      and(
        eq(llmUsage.tenantId, tenantId),
        ne(llmUsage.operation, BYOK_OPERATION),
        gte(llmUsage.createdAt, windowStart(granularity, now))
      )
    )
    .groupBy(bucket, llmUsage.operation);

  // Operations merge into features here, not in SQL — the map is TypeScript.
  const merged = new Map<string, UsagePoint>();
  for (const row of rows) {
    const feature = featureForOperation(row.operation);
    const key = `${row.bucket}|${feature}`;
    const existing = merged.get(key);
    if (existing) existing.credits += row.credits;
    else merged.set(key, { bucket: row.bucket, feature, credits: row.credits });
  }
  return [...merged.values()];
}

export async function creditsByFeature(
  tenantId: string,
  granularity: Granularity,
  now: Date = new Date()
): Promise<{ feature: FeatureKey; credits: number }[]> {
  const points = await creditsByPeriod(tenantId, granularity, now);
  const totals = new Map<FeatureKey, number>();
  for (const point of points) {
    totals.set(point.feature, (totals.get(point.feature) ?? 0) + point.credits);
  }
  return [...totals.entries()]
    .map(([feature, credits]) => ({ feature, credits }))
    .sort((a, b) => b.credits - a.credits);
}

export async function monthToDateCredits(tenantId: string, now: Date = new Date()): Promise<number> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [row] = await db
    .select({ credits: creditsExpr })
    .from(llmUsage)
    .where(
      and(
        eq(llmUsage.tenantId, tenantId),
        ne(llmUsage.operation, BYOK_OPERATION),
        gte(llmUsage.createdAt, monthStart)
      )
    );
  return row?.credits ?? 0;
}

export type ByokPoint = { bucket: string; engine: string; tokens: number };

/**
 * The BYOK channel: tokens the AI-visibility sweeps spent on the TENANT'S OWN
 * keys. Tracking only — never credits, never limited. Grouped by engine label
 * because `model` holds a snapshot id on success and the engine id on billed
 * failures; `byokEngineLabel` folds both onto one engine.
 */
export async function byokTokensByPeriod(
  tenantId: string,
  granularity: Granularity,
  now: Date = new Date()
): Promise<ByokPoint[]> {
  const bucket = bucketExpr(granularity);
  const rows = await db
    .select({
      bucket,
      model: llmUsage.model,
      tokens: sql<number>`coalesce(sum(coalesce(${llmUsage.totalTokens}, 0)), 0)::int`,
    })
    .from(llmUsage)
    .where(
      and(
        eq(llmUsage.tenantId, tenantId),
        eq(llmUsage.operation, BYOK_OPERATION),
        gte(llmUsage.createdAt, windowStart(granularity, now))
      )
    )
    .groupBy(bucket, llmUsage.model);

  const merged = new Map<string, ByokPoint>();
  for (const row of rows) {
    const engine = byokEngineLabel(row.model);
    const key = `${row.bucket}|${engine}`;
    const existing = merged.get(key);
    if (existing) existing.tokens += row.tokens;
    else merged.set(key, { bucket: row.bucket, engine, tokens: row.tokens });
  }
  return [...merged.values()];
}

export async function byokTokensMonthToDate(tenantId: string, now: Date = new Date()): Promise<number> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [row] = await db
    .select({ tokens: sql<number>`coalesce(sum(coalesce(${llmUsage.totalTokens}, 0)), 0)::int` })
    .from(llmUsage)
    .where(
      and(
        eq(llmUsage.tenantId, tenantId),
        eq(llmUsage.operation, BYOK_OPERATION),
        gte(llmUsage.createdAt, monthStart)
      )
    );
  return row?.tokens ?? 0;
}
