import { eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { aiVisibilitySettings } from "@/db/schema";
import { ENGINE_IDS, type EngineId } from "@/lib/ai-visibility/types";

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

  return {
    enabled: row.enabled,
    cadence,
    dayOfWeek,
    engines: row.engines.filter(isEngineId),
    samplesPerPrompt: samples,
    monthlyCapUsd: row.monthlyCapUsd,
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
    monthlyCapUsd: cap,
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
