import { eq, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { aiVisibilitySettings, sources, type Source } from "@/db/schema";
import { ENGINE_IDS, type EngineId } from "@/lib/ai-visibility/types";
import { roundUsd } from "@/lib/ai-visibility/money";

export const CADENCES = ["weekly", "fortnightly", "off"] as const;
export type Cadence = (typeof CADENCES)[number];

/** 3 is the floor at which "0 of 3" and "3 of 3" mean anything (spec, Decisions log). */
export const SAMPLE_CHOICES = [1, 3, 5] as const;
export type SamplesPerPrompt = (typeof SAMPLE_CHOICES)[number];

export const MIN_MONTHLY_CAP_USD = 1;
export const MAX_MONTHLY_CAP_USD = 500;

export type AiVisibilitySettingsValues = {
  enabled: boolean;
  cadence: Cadence;
  /** 0 = Sunday, UTC. */
  dayOfWeek: number;
  engines: EngineId[];
  samplesPerPrompt: SamplesPerPrompt;
  monthlyCapUsd: number;
};

export type SettingsField = "cadence" | "dayOfWeek" | "engines" | "samplesPerPrompt" | "monthlyCapUsd";

export type SaveSettingsResult =
  | { ok: true; settings: AiVisibilitySettingsValues }
  | { ok: false; error: SettingsField };

/**
 * What a tenant with no row gets. Mirrors the column defaults in
 * `ai_visibility_settings`; if you change one, change both — `getAiVisibilitySettings`
 * must answer the same thing before and after the first save.
 */
export const DEFAULT_AI_VISIBILITY_SETTINGS: AiVisibilitySettingsValues = {
  enabled: false,
  cadence: "weekly",
  dayOfWeek: 1,
  engines: [...ENGINE_IDS],
  samplesPerPrompt: 3,
  monthlyCapUsd: 20,
};

function isEngineId(value: string): value is EngineId {
  return (ENGINE_IDS as readonly string[]).includes(value);
}

/**
 * Reads a row back through the same vocabulary the writer enforces.
 *
 * Deliberately forgiving in one direction only: a value the column holds but
 * the code no longer recognises — an engine we dropped, a cadence from a
 * hand-edited row — is coerced to the default rather than thrown on. The
 * settings page must render, and a run must be able to decide what to do,
 * even for a row nobody in this deployment ever wrote.
 */
export async function getAiVisibilitySettings(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<AiVisibilitySettingsValues> {
  const [row] = await database
    .select()
    .from(aiVisibilitySettings)
    .where(eq(aiVisibilitySettings.tenantId, tenantId))
    .limit(1);

  // Fresh arrays every call: the defaults object is module-scoped, and a
  // caller who sorted or spliced the engines list would corrupt every later
  // read in the same process.
  if (!row) return { ...DEFAULT_AI_VISIBILITY_SETTINGS, engines: [...ENGINE_IDS] };

  const cadence = (CADENCES as readonly string[]).includes(row.cadence)
    ? (row.cadence as Cadence)
    : DEFAULT_AI_VISIBILITY_SETTINGS.cadence;
  const samples = (SAMPLE_CHOICES as readonly number[]).includes(row.samplesPerPrompt)
    ? (row.samplesPerPrompt as SamplesPerPrompt)
    : DEFAULT_AI_VISIBILITY_SETTINGS.samplesPerPrompt;
  const dayOfWeek =
    Number.isInteger(row.dayOfWeek) && row.dayOfWeek >= 0 && row.dayOfWeek <= 6
      ? row.dayOfWeek
      : DEFAULT_AI_VISIBILITY_SETTINGS.dayOfWeek;

  // Filtering can empty the list — a row written when we supported an engine we
  // have since dropped. `saveAiVisibilitySettings` refuses to write an empty
  // list precisely because an enabled feature with zero engines plans zero
  // calls behind a green badge, so the read must not hand one back either:
  // read and write have to agree on what a legal row is.
  // Deduped for the same reason the write path dedupes: a row holding
  // ["openai","openai"] would make `planRun` plan that engine's calls twice.
  const filtered = [...new Set(row.engines.filter(isEngineId))];
  const engines = filtered.length > 0 ? filtered : [...ENGINE_IDS];

  // Clamped like its neighbours, and rounded because the column is float4 —
  // see `roundUsd`. Without the rounding a cap saved as 20.10 reads back as
  // 20.100000381469727 and shows up in the settings field that way.
  const monthlyCapUsd = Number.isFinite(row.monthlyCapUsd)
    ? Math.min(MAX_MONTHLY_CAP_USD, Math.max(MIN_MONTHLY_CAP_USD, roundUsd(row.monthlyCapUsd)))
    : DEFAULT_AI_VISIBILITY_SETTINGS.monthlyCapUsd;

  return {
    enabled: row.enabled,
    cadence,
    dayOfWeek,
    engines,
    samplesPerPrompt: samples,
    monthlyCapUsd,
  };
}

/** Accepts a number or the numeric string a form field submits. */
function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Persists the four settings the /settings card owns.
 *
 * Takes `unknown` and validates by hand, like every other write in this repo
 * that sits behind a Server Action: the caller's argument is client input
 * whatever TypeScript says about it.
 *
 * Does NOT write `enabled`. That switch lives on the /company card and goes
 * through `setAiVisibilityEnabled`, which also flips the source row — saving
 * the settings form must never be able to silently turn the feature on or off.
 *
 * `engines` must be a NON-EMPTY subset of `ENGINE_IDS`. An empty array would
 * leave an enabled feature silently measuring nothing — every run would plan
 * zero calls behind a green badge. "Stop running" is spelled `cadence: "off"`
 * or the /company switch, both of which say so in the UI.
 */
export async function saveAiVisibilitySettings(
  tenantId: string,
  input: unknown,
  database: typeof defaultDb = defaultDb
): Promise<SaveSettingsResult> {
  const raw = (input ?? {}) as Record<string, unknown>;

  const cadence = raw.cadence;
  if (typeof cadence !== "string" || !(CADENCES as readonly string[]).includes(cadence)) {
    return { ok: false, error: "cadence" };
  }

  const dayOfWeek = toNumber(raw.dayOfWeek);
  if (dayOfWeek === null || !Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
    return { ok: false, error: "dayOfWeek" };
  }

  if (!Array.isArray(raw.engines)) return { ok: false, error: "engines" };
  const engines: EngineId[] = [];
  for (const entry of raw.engines) {
    if (typeof entry !== "string" || !isEngineId(entry)) return { ok: false, error: "engines" };
    if (!engines.includes(entry)) engines.push(entry);
  }
  // Non-empty, not merely a subset: an enabled feature with zero engines
  // would plan zero calls behind a green badge. See the function comment.
  if (engines.length === 0) return { ok: false, error: "engines" };

  const samples = toNumber(raw.samplesPerPrompt);
  if (samples === null || !(SAMPLE_CHOICES as readonly number[]).includes(samples)) {
    return { ok: false, error: "samplesPerPrompt" };
  }

  const cap = toNumber(raw.monthlyCapUsd);
  if (cap === null || cap < MIN_MONTHLY_CAP_USD || cap > MAX_MONTHLY_CAP_USD) {
    return { ok: false, error: "monthlyCapUsd" };
  }

  const values = {
    cadence,
    dayOfWeek,
    engines,
    samplesPerPrompt: samples as SamplesPerPrompt,
    // Rounded on the way in so the value we store, return, and later read back
    // through `getAiVisibilitySettings` are the same number. Without it a cap
    // saved as 20.999 renders as 20.999 now and 21 on the next load.
    monthlyCapUsd: roundUsd(cap),
  };

  const [row] = await database
    .insert(aiVisibilitySettings)
    .values({ tenantId, ...values })
    .onConflictDoUpdate({
      target: aiVisibilitySettings.tenantId,
      set: { ...values, updatedAt: new Date() },
    })
    .returning();

  return {
    ok: true,
    settings: {
      enabled: row.enabled,
      cadence: values.cadence as Cadence,
      dayOfWeek: values.dayOfWeek,
      engines: values.engines,
      samplesPerPrompt: values.samplesPerPrompt,
      monthlyCapUsd: values.monthlyCapUsd,
    },
  };
}

export const AI_VISIBILITY_SOURCE_LABEL = "AI visibility";

/**
 * The one `sources` row this feature reports its health on, so
 * `SourceStatusBadge`, `lastRunAt` and `lastError` work on /company exactly as
 * they do for news and competitor pages.
 *
 * It has no URL — there is no page to poll — which puts it on the null-url
 * half of the `sources` table. Identity therefore comes from
 * `sources_tenant_type_null_url_unique` (tenant + type, where url IS NULL),
 * the same partial index `setNewsWatching` conflicts on. `onConflictDoUpdate`
 * rather than `onConflictDoNothing` so a row always comes back to return.
 */
export async function ensureAiVisibilitySource(
  tenantId: string,
  database: typeof defaultDb = defaultDb,
  // Applied to both halves of the upsert, so a caller that wants to create the
  // row AND set its health does it in one statement rather than an insert
  // followed by an update that can fail on its own.
  overrides: Partial<Pick<typeof sources.$inferInsert, "status" | "lastError">> = {}
): Promise<Source> {
  const [row] = await database
    .insert(sources)
    .values({
      tenantId,
      type: "ai_visibility",
      url: null,
      label: AI_VISIBILITY_SOURCE_LABEL,
      ...overrides,
    })
    .onConflictDoUpdate({
      target: [sources.tenantId, sources.type],
      targetWhere: sql`${sources.url} IS NULL`,
      // `label` alone is a no-op whose only job is to make the statement
      // RETURNING-able when there are no overrides.
      set: { label: AI_VISIBILITY_SOURCE_LABEL, ...overrides },
    })
    .returning();
  return row;
}

/**
 * The /company switch. Writes both halves of "is this feature on": the
 * settings row the sweep gates on, and the source row the badge reads.
 *
 * Disabling never deletes: history, `lastRunAt` and `lastError` all survive so
 * a tenant who turns it back on has their prompts and their sparklines intact.
 */
export async function setAiVisibilityEnabled(
  tenantId: string,
  enabled: boolean,
  database: typeof defaultDb = defaultDb
): Promise<void> {
  await database
    .insert(aiVisibilitySettings)
    .values({ tenantId, enabled })
    .onConflictDoUpdate({
      target: aiVisibilitySettings.tenantId,
      // Only `enabled`. Everything else on this row belongs to the settings
      // card, and toggling the feature must not reset a tenant's cadence.
      set: { enabled, updatedAt: new Date() },
    });

  // One statement, not an upsert followed by an update: a failure between the
  // two would leave `settings.enabled = true` beside a `disabled` source row,
  // and the badge would contradict the switch until someone toggled it again.
  // Same shape as `setNewsWatching`.
  await ensureAiVisibilitySource(tenantId, database, {
    status: enabled ? "active" : "disabled",
    // Enabling clears the stale complaint — the common path is reading
    // "Paused — monthly cap reached", raising the cap, and re-toggling.
    // Disabling leaves it: that is exactly when an operator needs to see
    // the last failure.
    ...(enabled ? { lastError: null } : {}),
  });
}
